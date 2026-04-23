from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict


class ProductOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    store_id: int
    sku: str
    name: Optional[str] = None
    price: Optional[float] = None
    stock: Optional[int] = None
    category: Optional[str] = None
    category_id: Optional[str] = None
    commission: Optional[float] = None
    enabled: bool = True
    roi: Optional[float] = None
    status: Optional[str] = None
    last_price_update: Optional[datetime] = None
    ym_availability: Optional[str] = None
    ym_processing_status: Optional[str] = None
    supplier_price: Optional[float] = None
    profit: Optional[float] = None
    actual_roi: Optional[float] = None
