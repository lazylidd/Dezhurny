from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict


class PriceUpdateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    store_id: int
    sku: str
    supplier: Optional[str] = None
    supplier_price: Optional[float] = None
    old_price: Optional[float] = None
    new_price: float
    difference: Optional[float] = None
    difference_pct: Optional[float] = None
    profit: Optional[float] = None
    actual_roi: Optional[float] = None
    tariffs_json: Optional[str] = None
    old_stock: Optional[int] = None
    new_stock: Optional[int] = None
    requires_confirmation: bool = False
    status: str
    created_at: Optional[datetime] = None
