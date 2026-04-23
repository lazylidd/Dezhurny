import pytest
import auth


class TestPasswordHashing:
    def test_roundtrip(self):
        stored = auth.hash_password("secret123")
        assert auth.verify_password("secret123", stored)

    def test_wrong_password_fails(self):
        stored = auth.hash_password("correct")
        assert not auth.verify_password("wrong", stored)

    def test_different_hashes_same_password(self):
        # Salt is random → two hashes of same password must differ
        h1 = auth.hash_password("pass")
        h2 = auth.hash_password("pass")
        assert h1 != h2

    def test_empty_password(self):
        stored = auth.hash_password("")
        assert auth.verify_password("", stored)
        assert not auth.verify_password(" ", stored)

    def test_malformed_stored_returns_false(self):
        assert not auth.verify_password("any", "notahash")
        assert not auth.verify_password("any", "")
        assert not auth.verify_password("any", ":")


class TestSessions:
    def setup_method(self):
        # Isolate: clear session store before each test
        auth._sessions.clear()

    def test_create_and_get(self):
        token = auth.create_session(user_id=42, is_admin=True, from_db=True)
        info = auth.get_session_info(token)
        assert info == {"user_id": 42, "is_admin": True, "from_db": True}

    def test_get_unknown_token_returns_none(self):
        assert auth.get_session_info("nonexistent") is None

    def test_delete_session(self):
        token = auth.create_session(user_id=1)
        auth.delete_session(token)
        assert auth.get_session_info(token) is None

    def test_delete_nonexistent_is_noop(self):
        auth.delete_session("ghost")  # must not raise

    def test_is_valid_session(self):
        token = auth.create_session()
        assert auth.is_valid_session(token)
        auth.delete_session(token)
        assert not auth.is_valid_session(token)

    def test_tokens_are_unique(self):
        tokens = {auth.create_session() for _ in range(50)}
        assert len(tokens) == 50

    def test_multiple_sessions_independent(self):
        t1 = auth.create_session(user_id=1, is_admin=False)
        t2 = auth.create_session(user_id=2, is_admin=True)
        assert auth.get_session_info(t1)["user_id"] == 1
        assert auth.get_session_info(t2)["user_id"] == 2
        auth.delete_session(t1)
        assert auth.get_session_info(t2) is not None
