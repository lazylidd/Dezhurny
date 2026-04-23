import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

import api.state as state
from api.routes import (
    admin, assembly, assortment, auth, matching, orders,
    price_apply, price_updates, products, promo, recalculate, settings, stores,
)
from auth import check_and_auto_block, delete_session, get_session_info
from database.db import SessionLocal
from database.init_db import init_db
from tasks.scheduler import create_scheduler

logger = logging.getLogger(__name__)

_PUBLIC_PATHS = {"/", "/login", "/logout", "/me", "/matching/backfill-embeddings"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    from database.db import engine
    with engine.connect() as conn:
        try:
            conn.execute(text("ALTER TABLE stores ADD COLUMN IF NOT EXISTS display_name VARCHAR"))
            conn.execute(text("ALTER TABLE promo_sync_log ADD COLUMN IF NOT EXISTS promo_name VARCHAR"))
            conn.commit()
        except Exception:
            pass
    state._scheduler = create_scheduler()
    state._scheduler.start()
    yield
    state._scheduler.shutdown()


app = FastAPI(title="Dezhurny MVP", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174", "http://localhost:5175"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path in _PUBLIC_PATHS:
        return await call_next(request)
    token = request.cookies.get("session")
    info = get_session_info(token) if token else None
    if not info:
        return JSONResponse(status_code=401, content={"detail": "Not authenticated"})
    if info.get("from_db"):
        from models.user import User
        db = SessionLocal()
        try:
            user = db.query(User).filter(User.id == info["user_id"]).first()
            if not user or not check_and_auto_block(user, db):
                delete_session(token)
                return JSONResponse(status_code=401, content={"detail": "Account blocked"})
        finally:
            db.close()
    request.state.session_info = info
    return await call_next(request)


app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(stores.router)
app.include_router(assortment.router)
app.include_router(matching.router)
app.include_router(products.router)
app.include_router(price_updates.router)
app.include_router(price_apply.router)
app.include_router(recalculate.router)
app.include_router(promo.router)
app.include_router(assembly.router)
app.include_router(orders.router)
app.include_router(settings.router)
