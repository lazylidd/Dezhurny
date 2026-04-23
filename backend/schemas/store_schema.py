from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, ConfigDict, field_serializer


class StoreOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    display_name: Optional[str] = None
    platform: Optional[str] = None
    default_roi: Optional[float] = None
    tax_rate: Optional[float] = None
    early_ship_discount: Optional[float] = None
    selling_program: Optional[str] = None
    payout_frequency: Optional[str] = None
    stock_min: Optional[int] = None
    stock_max: Optional[int] = None
    auto_promo_sync: Optional[bool] = None
    last_sync_at: Optional[datetime] = None

    @field_serializer('last_sync_at')
    def serialize_last_sync_at(self, v: Optional[datetime]) -> Optional[str]:
        if v is None:
            return None
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        return v.isoformat()


class StoreUpdate(BaseModel):
    display_name: Optional[str] = None
    default_roi: Optional[float] = None
    tax_rate: Optional[float] = None
    early_ship_discount: Optional[float] = None
    selling_program: Optional[str] = None
    payout_frequency: Optional[str] = None
    stock_min: Optional[int] = None
    stock_max: Optional[int] = None
    auto_promo_sync: Optional[bool] = None
