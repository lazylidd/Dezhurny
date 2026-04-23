from sqlalchemy import Boolean, Column, DateTime, Float, Integer, String

from database.db import Base


class Product(Base):
    __tablename__ = "products"

    id = Column(Integer, primary_key=True, index=True)
    store_id = Column(Integer, nullable=False, index=True)
    sku = Column(String, nullable=False, index=True)
    name = Column(String)
    normalized_name = Column(String)
    price = Column(Float)
    stock = Column(Integer)
    category = Column(String)
    category_id = Column(String)
    commission = Column(Float)
    vendor = Column(String)
    weight = Column(Float)   # кг
    length = Column(Float)   # см
    width = Column(Float)    # см
    height = Column(Float)   # см
    enabled = Column(Boolean, default=True)
    roi = Column(Float)  # кастомный ROI; None = использовать default_roi магазина
    status = Column(String, default="active")  # active | updated | zeroed | error
    last_price_update = Column(DateTime(timezone=True))
    ym_availability = Column(String)          # ACTIVE | INACTIVE (offer.availability из ЯМ API)
    ym_processing_status = Column(String)     # READY | IN_WORK | NEED_CONTENT | NEED_INFO | REJECTED | SUSPENDED | OTHER
    name_embedding = Column(String)           # JSON float array от nomic-embed-text (768 dim)
    ym_variable_rate = Column(Float)          # % от цены: комиссия категории + прочие relative тарифы
    ym_fixed_fee = Column(Float)              # фиксированные ₽: доставка, сортировка и т.д.
