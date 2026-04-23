from sqlalchemy import Column, DateTime, Float, Integer, String, func

from database.db import Base


class SupplierPrice(Base):
    __tablename__ = "supplier_prices"

    id = Column(Integer, primary_key=True, index=True)
    supplier = Column(String, nullable=False)
    name = Column(String, nullable=False)
    normalized_name = Column(String, nullable=False, index=True)
    price = Column(Float, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    name_embedding = Column(String)           # JSON float array от nomic-embed-text (768 dim)
