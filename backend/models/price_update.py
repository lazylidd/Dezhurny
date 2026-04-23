from sqlalchemy import Boolean, Column, DateTime, Float, Integer, String, Text, func

from database.db import Base


class PriceUpdate(Base):
    __tablename__ = "price_updates"

    id = Column(Integer, primary_key=True, index=True)
    store_id = Column(Integer, nullable=False, index=True)
    sku = Column(String, nullable=False)
    supplier = Column(String)                      # имя поставщика
    supplier_price = Column(Float)                 # закупочная цена
    old_price = Column(Float)
    new_price = Column(Float, nullable=False)
    difference = Column(Float)
    difference_pct = Column(Float)                 # изменение в %
    profit = Column(Float)                         # прибыль в рублях
    actual_roi = Column(Float)                     # фактический ROI в %
    tariffs_json = Column(Text)                    # JSON-список тарифов ЯМ
    old_stock = Column(Integer)                    # остаток до применения
    new_stock = Column(Integer)                    # остаток после применения
    requires_confirmation = Column(Boolean, default=False)
    status = Column(String, default="calculated")  # calculated | applied | zeroed | error
    created_at = Column(DateTime(timezone=True), server_default=func.now())
