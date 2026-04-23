from sqlalchemy import Boolean, Column, DateTime, Float, Integer, String, func

from database.db import Base


class ProductMatch(Base):
    __tablename__ = "product_matches"

    id = Column(Integer, primary_key=True, index=True)
    supplier = Column(String, nullable=False, index=True)
    supplier_name = Column(String, nullable=False)          # оригинальное имя из прайса
    supplier_normalized = Column(String, nullable=False, index=True)
    supplier_price = Column(Float)                          # последняя загруженная цена
    sku = Column(String)                                    # NULL пока не сопоставлено
    store_id = Column(Integer)                              # NULL пока не сопоставлено
    product_name = Column(String)                           # кешированное имя товара
    status = Column(String, default="pending", index=True)  # pending | confirmed | stoplist
    match_type = Column(String)                             # auto | manual
    best_score = Column(Float)                              # лучший score из кандидатов
    blocked_sku = Column(String)                            # SKU, к которому нельзя авто-матчить
    blocked_store_id = Column(Integer)                      # store_id заблокированного SKU
    auto_match = Column(Boolean, default=True, nullable=False, server_default="true")  # разрешён ли авто-матчинг
    confirmed_at = Column(DateTime, nullable=True)              # время авто-подтверждения
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
