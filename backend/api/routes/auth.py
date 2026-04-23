from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import get_db, get_current_info
from auth import (
    check_and_auto_block, check_db_credentials, check_env_credentials,
    create_session, delete_session, get_session_info, hash_password,
)

router = APIRouter(tags=["auth"])


class LoginData(BaseModel):
    login: str
    password: str


class ChangePasswordData(BaseModel):
    current_password: str
    new_password: str


@router.post("/login")
def login(data: LoginData, response: Response, db: Session = Depends(get_db)):
    if check_env_credentials(data.login, data.password):
        token = create_session(user_id=None, is_admin=True, from_db=False)
        response.set_cookie(key="session", value=token, httponly=True, samesite="lax", max_age=30 * 24 * 3600)
        return {"ok": True, "is_admin": True}
    user = check_db_credentials(data.login, data.password, db)
    if not user:
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    if not check_and_auto_block(user, db):
        raise HTTPException(status_code=403, detail="Аккаунт заблокирован")
    token = create_session(user_id=user.id, is_admin=user.is_admin, from_db=True)
    response.set_cookie(key="session", value=token, httponly=True, samesite="lax", max_age=30 * 24 * 3600)
    return {"ok": True, "is_admin": user.is_admin}


@router.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get("session")
    if token:
        delete_session(token)
    response.delete_cookie("session")
    return {"ok": True}


@router.get("/me")
def me(request: Request, db: Session = Depends(get_db)):
    token = request.cookies.get("session")
    info = get_session_info(token) if token else None
    if not info:
        raise HTTPException(status_code=401, detail="Not authenticated")
    from models.user_store import UserStore
    is_admin = info.get("is_admin", False)
    display_name = None
    store_ids: list[int] = []
    if info.get("from_db") and info.get("user_id"):
        from models.user import User
        user = db.query(User).filter(User.id == info["user_id"]).first()
        if user:
            display_name = user.display_name
            rows = db.query(UserStore).filter(UserStore.user_id == user.id).all()
            store_ids = [r.store_id for r in rows]
    from_db = info.get("from_db", False)
    return {"ok": True, "is_admin": is_admin, "store_ids": store_ids, "display_name": display_name, "from_db": from_db}


@router.post("/me/change-password")
def change_password(data: ChangePasswordData, request: Request, db: Session = Depends(get_db)):
    import os as _os
    token = request.cookies.get("session")
    info = get_session_info(token) if token else None
    if not info:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if len(data.new_password) < 6:
        raise HTTPException(status_code=400, detail="Новый пароль должен быть не менее 6 символов")
    if not info.get("from_db"):
        env_login = (_os.getenv("AUTH_LOGIN", "admin") or "admin").strip()
        if not check_env_credentials(env_login, data.current_password):
            raise HTTPException(status_code=400, detail="Неверный текущий пароль")
        from utils.settings import set_setting
        set_setting("admin_password_hash", hash_password(data.new_password))
        return {"ok": True}
    from models.user import User
    user = db.query(User).filter(User.id == info["user_id"]).first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    if not check_db_credentials(user.login, data.current_password, db):
        raise HTTPException(status_code=400, detail="Неверный текущий пароль")
    user.password_hash = hash_password(data.new_password)
    db.commit()
    return {"ok": True}
