from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import get_db, require_admin
from auth import hash_password
from models.store import Store

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


# ─── Users ───────────────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    login: str
    password: str
    display_name: str
    comment: str = ""
    payment_due_date: str = ""
    is_admin: bool = False


class UserUpdate(BaseModel):
    login: str = None
    password: str = None
    display_name: str = None
    comment: str = None
    payment_due_date: str = None
    paid_at: str = None
    is_active: bool = None
    is_admin: bool = None


@router.get("/users")
def admin_list_users(db: Session = Depends(get_db)):
    from models.user import User
    from models.user_store import UserStore
    users = db.query(User).all()
    result = []
    for u in users:
        store_rows = db.query(UserStore).filter(UserStore.user_id == u.id).all()
        result.append({
            "id": u.id,
            "login": u.login,
            "display_name": u.display_name,
            "comment": u.comment,
            "payment_due_date": u.payment_due_date,
            "paid_at": u.paid_at,
            "is_active": u.is_active,
            "is_admin": u.is_admin,
            "created_at": u.created_at.isoformat() if u.created_at else None,
            "store_ids": [r.store_id for r in store_rows],
        })
    return result


@router.post("/users")
def admin_create_user(data: UserCreate, db: Session = Depends(get_db)):
    from models.user import User
    existing = db.query(User).filter(User.login == data.login).first()
    if existing:
        raise HTTPException(status_code=400, detail="Логин уже занят")
    user = User(
        login=data.login,
        password_hash=hash_password(data.password),
        display_name=data.display_name,
        comment=data.comment or None,
        payment_due_date=data.payment_due_date or None,
        is_active=True,
        is_admin=data.is_admin,
        created_at=datetime.utcnow(),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return {"id": user.id, "login": user.login, "display_name": user.display_name}


@router.patch("/users/{user_id}")
def admin_update_user(user_id: int, data: UserUpdate, db: Session = Depends(get_db)):
    from models.user import User
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    if data.login is not None:
        existing = db.query(User).filter(User.login == data.login, User.id != user_id).first()
        if existing:
            raise HTTPException(status_code=400, detail="Логин уже занят")
        user.login = data.login
    if data.password is not None:
        user.password_hash = hash_password(data.password)
    if data.display_name is not None:
        user.display_name = data.display_name
    if data.comment is not None:
        user.comment = data.comment
    if data.payment_due_date is not None:
        user.payment_due_date = data.payment_due_date or None
    if data.paid_at is not None:
        user.paid_at = data.paid_at or None
    if data.is_active is not None:
        user.is_active = data.is_active
    if data.is_admin is not None:
        user.is_admin = data.is_admin
    db.commit()
    return {"ok": True}


@router.delete("/users/{user_id}")
def admin_delete_user(user_id: int, db: Session = Depends(get_db)):
    from models.user import User
    from models.user_store import UserStore
    db.query(UserStore).filter(UserStore.user_id == user_id).delete()
    db.query(User).filter(User.id == user_id).delete()
    db.commit()
    return {"ok": True}


# ─── User → Stores ───────────────────────────────────────────────────────────

@router.get("/users/{user_id}/stores")
def admin_get_user_stores(user_id: int, db: Session = Depends(get_db)):
    from models.user_store import UserStore
    rows = db.query(UserStore).filter(UserStore.user_id == user_id).all()
    return [{"id": r.id, "store_id": r.store_id} for r in rows]


@router.post("/users/{user_id}/stores")
def admin_add_user_store(user_id: int, body: dict, db: Session = Depends(get_db)):
    from models.user_store import UserStore
    store_id = body.get("store_id")
    if not store_id:
        raise HTTPException(status_code=400, detail="store_id required")
    existing = db.query(UserStore).filter(
        UserStore.user_id == user_id, UserStore.store_id == store_id
    ).first()
    if existing:
        return {"ok": True}
    db.add(UserStore(user_id=user_id, store_id=store_id))
    db.commit()
    return {"ok": True}


@router.delete("/users/{user_id}/stores/{store_id}")
def admin_remove_user_store(user_id: int, store_id: int, db: Session = Depends(get_db)):
    from models.user_store import UserStore
    db.query(UserStore).filter(
        UserStore.user_id == user_id, UserStore.store_id == store_id
    ).delete()
    db.commit()
    return {"ok": True}


# ─── Stores ──────────────────────────────────────────────────────────────────

class StoreCreate(BaseModel):
    name: str
    platform: str
    default_roi: float = 0.2
    tax_rate: float = 0.06
    api_key: str = ""
    business_id: str = ""
    campaign_ids: str = ""


@router.post("/stores")
def admin_create_store(data: StoreCreate, db: Session = Depends(get_db)):
    store = Store(
        name=data.name,
        platform=data.platform,
        default_roi=data.default_roi,
        tax_rate=data.tax_rate,
        api_key=data.api_key or None,
        business_id=data.business_id or None,
        campaign_ids=data.campaign_ids or None,
    )
    db.add(store)
    db.commit()
    db.refresh(store)
    return {"id": store.id, "name": store.name, "platform": store.platform}


@router.patch("/stores/{store_id}")
def admin_update_store(store_id: int, body: dict, db: Session = Depends(get_db)):
    store = db.query(Store).filter(Store.id == store_id).first()
    if not store:
        raise HTTPException(status_code=404, detail="Магазин не найден")
    for field in ("api_key", "business_id", "campaign_ids", "name", "platform", "default_roi", "tax_rate"):
        if field in body:
            setattr(store, field, body[field] or None)
    db.commit()
    return {"ok": True}
