from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from auth import delete_session, get_session_info
from database.db import SessionLocal


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def require_admin(request: Request):
    token = request.cookies.get("session")
    info = get_session_info(token) if token else None
    if not info or not info.get("is_admin"):
        raise HTTPException(status_code=403, detail="Требуются права администратора")


def get_current_info(request: Request) -> dict:
    token = request.cookies.get("session")
    info = get_session_info(token) if token else None
    if not info:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return info


def _can_manage_store(store_id: int, info: dict, db: Session) -> bool:
    if info.get("is_admin"):
        return True
    user_id = info.get("user_id")
    if not user_id:
        return False
    from models.user_store import UserStore
    return db.query(UserStore).filter(
        UserStore.user_id == user_id, UserStore.store_id == store_id
    ).first() is not None
