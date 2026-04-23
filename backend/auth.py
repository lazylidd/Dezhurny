import binascii
import hashlib
import os
import secrets
from datetime import date
from typing import Optional

from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

# token → {user_id, is_admin, from_db}
_sessions: dict[str, dict] = {}


# ---------- password hashing ----------

def hash_password(password: str) -> str:
    salt = os.urandom(16)
    key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100_000)
    return binascii.hexlify(salt).decode() + ":" + binascii.hexlify(key).decode()


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, key_hex = stored.split(":")
        salt = binascii.unhexlify(salt_hex)
        key = binascii.unhexlify(key_hex)
        new_key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100_000)
        return key == new_key
    except Exception:
        return False


# ---------- session ----------

def create_session(user_id: Optional[int] = None, is_admin: bool = False, from_db: bool = False) -> str:
    token = secrets.token_urlsafe(32)
    _sessions[token] = {"user_id": user_id, "is_admin": is_admin, "from_db": from_db}
    return token


def delete_session(token: str):
    _sessions.pop(token, None)


def get_session_info(token: str) -> Optional[dict]:
    return _sessions.get(token)


def is_valid_session(token: str) -> bool:
    return token in _sessions


# ---------- credentials ----------

def check_env_credentials(login: str, password: str) -> bool:
    expected_login = (os.getenv("AUTH_LOGIN", "admin") or "admin").strip()
    if login != expected_login:
        return False
    # Проверяем хэш из настроек (если пароль менялся через UI)
    from utils.settings import get_setting
    stored_hash = get_setting("admin_password_hash")
    if stored_hash:
        return verify_password(password, stored_hash)
    # Иначе сравниваем с .env
    expected_password = (os.getenv("AUTH_PASSWORD", "admin") or "admin").strip()
    return password == expected_password


def check_db_credentials(login: str, password: str, db) -> Optional["User"]:  # noqa: F821
    from models.user import User
    user = db.query(User).filter(User.login == login).first()
    if not user:
        return None
    if not verify_password(password, user.password_hash):
        return None
    return user


def check_and_auto_block(user, db) -> bool:
    """Возвращает True если пользователь активен. Автоблокирует по просроченной оплате."""
    if not user.is_active:
        return False
    if user.payment_due_date and not user.paid_at:
        if user.payment_due_date < date.today().isoformat():
            user.is_active = False
            db.commit()
            return False
    return True
