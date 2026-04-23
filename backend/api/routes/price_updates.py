from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from api.deps import get_db
from models.price_update import PriceUpdate
from schemas.price_update_schema import PriceUpdateOut

router = APIRouter(tags=["price-updates"])


@router.get("/price-updates", response_model=list[PriceUpdateOut])
def get_price_updates(store_id: Optional[int] = None, sku: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(PriceUpdate)
    if store_id:
        q = q.filter(PriceUpdate.store_id == store_id)
    if sku:
        q = q.filter(PriceUpdate.sku.ilike(f"%{sku}%"))
    return q.order_by(PriceUpdate.created_at.desc()).all()


@router.patch("/price-updates/{update_id}/confirm", response_model=PriceUpdateOut)
def confirm_price_update(update_id: int, db: Session = Depends(get_db)):
    pu = db.query(PriceUpdate).filter(PriceUpdate.id == update_id).first()
    if not pu:
        raise HTTPException(status_code=404, detail="Not found")
    pu.requires_confirmation = False
    db.commit()
    db.refresh(pu)
    return pu


@router.post("/price-updates/confirm-all")
def confirm_all_price_updates(db: Session = Depends(get_db)):
    updated = (
        db.query(PriceUpdate)
        .filter(PriceUpdate.status == "calculated", PriceUpdate.requires_confirmation == True)  # noqa: E712
        .update({"requires_confirmation": False})
    )
    db.commit()
    return {"confirmed": updated}


@router.delete("/price-updates")
def reset_price_updates(store_id: Optional[int] = None, days: Optional[int] = None, db: Session = Depends(get_db)):
    from datetime import datetime, timedelta, timezone
    q = db.query(PriceUpdate)
    if store_id:
        q = q.filter(PriceUpdate.store_id == store_id)
    if days:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        q = q.filter(PriceUpdate.created_at <= cutoff)
    deleted = q.delete(synchronize_session=False)
    db.commit()
    return {"deleted": deleted}
