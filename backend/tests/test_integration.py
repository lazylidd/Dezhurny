import pytest
from unittest.mock import MagicMock, patch
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

import auth as auth_module
import database.init_db  # side-effect: registers all models with Base.metadata


@pytest.fixture(scope="module")
def client():
    from database.db import Base
    from api.deps import get_db
    from main import app

    # StaticPool: all connections share one in-memory SQLite instance
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    _Session = sessionmaker(bind=engine)

    def _get_db():
        db = _Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _get_db

    with patch("main.init_db"), \
         patch("main.create_scheduler", return_value=MagicMock()):
        with TestClient(app) as c:
            yield c

    app.dependency_overrides.clear()


def test_health(client):
    r = client.get("/")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_protected_requires_auth(client):
    r = client.get("/stores")
    assert r.status_code == 401


def test_login_wrong_creds(client):
    r = client.post("/login", json={"login": "nobody", "password": "wrong"})
    assert r.status_code == 401


def test_session_cookie_grants_access(client):
    token = auth_module.create_session(is_admin=True, from_db=False)
    client.cookies.set("session", token)
    r = client.get("/stores")
    assert r.status_code == 200
    assert isinstance(r.json(), list)
