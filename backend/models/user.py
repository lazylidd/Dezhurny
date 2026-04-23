from sqlalchemy import Boolean, Column, DateTime, Integer, String
from database.db import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    login = Column(String, unique=True, nullable=False)
    password_hash = Column(String, nullable=False)
    display_name = Column(String, nullable=False)
    comment = Column(String, nullable=True)
    payment_due_date = Column(String, nullable=True)   # ISO date "YYYY-MM-DD"
    paid_at = Column(String, nullable=True)             # ISO date, set manually by admin
    is_active = Column(Boolean, default=True)
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime, nullable=True)
