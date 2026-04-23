from sqlalchemy import Column, DateTime, Float, Integer, String
from sqlalchemy.sql import func

from database.db import Base


class PromoSyncLog(Base):
    __tablename__ = "promo_sync_log"

    id = Column(Integer, primary_key=True, index=True)
    store_id = Column(Integer, nullable=False, index=True)
    timestamp = Column(DateTime, server_default=func.now(), nullable=False)
    sku = Column(String, nullable=False)
    promo_id = Column(String, nullable=False)
    promo_name = Column(String, nullable=True)
    action = Column(String, nullable=False)
    old_catalog_price = Column(Float, nullable=True)
    new_catalog_price = Column(Float, nullable=True)
    old_promo_price = Column(Float, nullable=True)
    new_promo_price = Column(Float, nullable=True)
    reason = Column(String, nullable=True)
