from sqlalchemy import Column, ForeignKey, Integer
from database.db import Base


class UserStore(Base):
    __tablename__ = "user_stores"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    store_id = Column(Integer, ForeignKey("stores.id"), nullable=False)
