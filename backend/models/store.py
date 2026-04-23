from sqlalchemy import Column, DateTime, Float, Integer, String, Boolean

from database.db import Base


class Store(Base):
    __tablename__ = "stores"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String)
    display_name = Column(String, nullable=True)
    platform = Column(String)
    default_roi = Column(Float)
    tax_rate = Column(Float)
    early_ship_discount = Column(Float)   # скидка за раннюю отгрузку (п.п., напр. 7.0)
    selling_program = Column(String, default="FBS")       # FBS | FBY | DBS
    payout_frequency = Column(String, default="MONTHLY")  # DAILY | WEEKLY | BIWEEKLY | MONTHLY
    stock_min = Column(Integer, default=20)
    stock_max = Column(Integer, default=50)
    last_sync_at = Column(DateTime, nullable=True)
    auto_promo_sync = Column(Boolean, default=False)   # автосинхронизация с акциями ЯМ
    # API credentials (optional — if set, takes priority over .env)
    api_key = Column(String, nullable=True)
    business_id = Column(String, nullable=True)        # хранится как строка, конвертируем при использовании
    campaign_ids = Column(String, nullable=True)       # через запятую
