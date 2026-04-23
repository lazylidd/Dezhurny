import json
from collections import defaultdict
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import cast, func
from sqlalchemy.orm import Session
from sqlalchemy.types import Date

from api.deps import get_db, get_current_info, _can_manage_store
from models.order import Order as OrderModel
from models.product import Product
from models.store import Store
from schemas.store_schema import StoreOut, StoreUpdate

router = APIRouter(tags=["stores"])


def _store_response(store: Store) -> dict:
    return {
        "id": store.id, "name": store.name, "display_name": store.display_name,
        "platform": store.platform, "api_key": store.api_key,
        "business_id": store.business_id, "campaign_ids": store.campaign_ids,
        "default_roi": store.default_roi, "tax_rate": store.tax_rate,
        "early_ship_discount": store.early_ship_discount,
        "selling_program": store.selling_program,
        "payout_frequency": store.payout_frequency,
        "stock_min": store.stock_min, "stock_max": store.stock_max,
        "last_sync_at": (
            store.last_sync_at.replace(tzinfo=__import__("datetime").timezone.utc).isoformat()
            if store.last_sync_at else None
        ),
    }


@router.get("/")
def health():
    return {"status": "ok"}


@router.get("/dashboard")
def get_dashboard(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    db: Session = Depends(get_db),
):
    today = date.today()
    period_start = date.fromisoformat(date_from) if date_from else today.replace(day=1)
    period_end = date.fromisoformat(date_to) if date_to else today
    days_90_ago = today - timedelta(days=90)

    stores_list = db.query(Store).all()

    combined_daily: dict = defaultdict(lambda: {"revenue": 0.0, "fees": 0.0, "profit": 0.0, "count": 0})
    combined_revenue = combined_fees = combined_supplier = combined_tax = 0.0
    combined_comm_actual = combined_rev_actual = 0.0
    combined_orders = combined_nonpickup = combined_return = combined_matched = 0
    turnover_days_list: list = []
    stores_out = []

    for store in stores_list:
        total = db.query(func.count(Product.id)).filter(Product.store_id == store.id).scalar() or 0
        enabled = db.query(func.count(Product.id)).filter(
            Product.store_id == store.id, Product.stock > 0,
        ).scalar() or 0
        zeroed = db.query(func.count(Product.id)).filter(
            Product.store_id == store.id, Product.status == "zeroed"
        ).scalar() or 0
        updated_today = db.query(func.count(Product.id)).filter(
            Product.store_id == store.id,
            cast(Product.last_price_update, Date) == today,
        ).scalar() or 0

        month_orders = db.query(OrderModel).filter(
            OrderModel.store_id == store.id,
            OrderModel.order_date >= period_start,
            OrderModel.order_date <= period_end,
        ).all()

        s_rev = s_fees = s_sup = s_tax = 0.0
        s_orders = s_nonpickup = s_return = s_matched = 0
        _active = {"PROCESSING", "READY_TO_SHIP", "DELIVERY", "PICKUP"}

        for o in month_orders:
            if o.order_kind == "nonpickup":
                s_nonpickup += 1; combined_nonpickup += 1; continue
            if o.order_kind == "return":
                s_return += 1; combined_return += 1; continue
            s_orders += 1; combined_orders += 1
            rev = (o.buyer_payment or 0.0) + (o.promo_discount or 0.0)
            _ym_abs = abs(o.all_services_fee or 0.0)
            _fee_rate = (_ym_abs / rev) if rev else 0
            _is_forecast = (o.order_kind == "normal" and (_ym_abs == 0 or _fee_rate < 0.04)) \
                           or (getattr(o, "ym_status", None) in _active)
            tax = o.tax_amount or 0.0
            if _is_forecast:
                fees = (o.commission_amount or 0.0) + tax
            else:
                fees = _ym_abs + tax
                try:
                    _fb = json.loads(o.fee_breakdown) if o.fee_breakdown else {}
                    fees += float(_fb.get("bonus_deducted", 0.0))
                except Exception:
                    pass
            sup = o.supplier_price or 0.0
            s_rev += rev; s_fees += fees; s_tax += tax
            combined_revenue += rev; combined_fees += fees; combined_tax += tax
            if not _is_forecast and rev > 0:
                combined_comm_actual += fees - tax
                combined_rev_actual += rev
            if o.supplier_price is not None:
                s_sup += sup; s_matched += 1
                combined_supplier += sup; combined_matched += 1
            if o.shipment_date and o.payment_date:
                try:
                    td = (o.payment_date - o.shipment_date).days
                    if 0 <= td <= 120:
                        turnover_days_list.append(td)
                except Exception:
                    pass

        s_profit = s_rev - s_fees - s_sup if s_matched > 0 else None
        s_roi = s_profit / s_sup if (s_profit is not None and s_sup > 0) else None
        stores_out.append({
            "id": store.id, "name": store.name,
            "total_products": total, "enabled_products": enabled,
            "zeroed_products": zeroed, "updated_today": updated_today,
            "revenue": round(s_rev, 2), "fees": round(s_fees, 2), "tax_sum": round(s_tax, 2),
            "profit": round(s_profit, 2) if s_profit is not None else None,
            "roi": round(s_roi, 4) if s_roi is not None else None,
            "orders": s_orders, "nonpickup_count": s_nonpickup, "return_count": s_return,
        })

        for o in db.query(OrderModel).filter(
            OrderModel.store_id == store.id,
            OrderModel.order_date >= days_90_ago,
            OrderModel.order_kind == "normal",
        ).all():
            day = o.order_date.isoformat() if o.order_date else None
            if not day:
                continue
            rev = (o.buyer_payment or 0.0) + (o.promo_discount or 0.0)
            _ym_abs = abs(o.all_services_fee or 0.0)
            _fee_rate = (_ym_abs / rev) if rev else 0
            _is_forecast = (o.order_kind == "normal" and (_ym_abs == 0 or _fee_rate < 0.04)) \
                           or (getattr(o, "ym_status", None) in _active)
            tax = float(o.tax_amount or 0.0)
            if _is_forecast:
                fees = (o.commission_amount or 0.0) + tax
            else:
                fees = _ym_abs + tax
                try:
                    _fb = json.loads(o.fee_breakdown) if o.fee_breakdown else {}
                    fees += float(_fb.get("bonus_deducted", 0.0))
                except Exception:
                    pass
            sup = o.supplier_price or 0.0
            combined_daily[day]["revenue"] += rev
            combined_daily[day]["fees"] += fees
            combined_daily[day]["profit"] += rev - fees - sup
            combined_daily[day]["count"] += 1

    total_profit = combined_revenue - combined_fees - combined_supplier if combined_matched > 0 else None
    total_roi = total_profit / combined_supplier if (total_profit is not None and combined_supplier > 0) else None
    np_pct = combined_nonpickup / (combined_orders + combined_nonpickup) if (combined_orders + combined_nonpickup) > 0 else None
    ret_pct = combined_return / (combined_orders + combined_return) if (combined_orders + combined_return) > 0 else None
    fees_actual_pct = combined_comm_actual / combined_rev_actual if combined_rev_actual > 0 else None
    avg_turnover = round(sum(turnover_days_list) / len(turnover_days_list)) if turnover_days_list else None

    return {
        "stores": stores_out,
        "combined": {
            "revenue": round(combined_revenue, 2), "fees": round(combined_fees, 2),
            "tax_sum": round(combined_tax, 2),
            "profit": round(total_profit, 2) if total_profit is not None else None,
            "roi": round(total_roi, 4) if total_roi is not None else None,
            "orders": combined_orders,
            "nonpickup_count": combined_nonpickup, "return_count": combined_return,
            "nonpickup_pct": round(np_pct, 4) if np_pct is not None else None,
            "return_pct": round(ret_pct, 4) if ret_pct is not None else None,
            "fees_actual_pct": round(fees_actual_pct, 4) if fees_actual_pct is not None else None,
            "avg_turnover": avg_turnover,
        },
        "chart": sorted(
            [{"date": k, **v} for k, v in combined_daily.items()],
            key=lambda x: x["date"],
        ),
    }


@router.get("/stores", response_model=List[StoreOut])
def get_stores(request: Request, db: Session = Depends(get_db)):
    from models.user_store import UserStore
    info = getattr(request.state, "session_info", None) or {}
    if info.get("is_admin"):
        return db.query(Store).order_by(Store.name).all()
    if info.get("from_db") and info.get("user_id"):
        rows = db.query(UserStore).filter(UserStore.user_id == info["user_id"]).all()
        accessible = {r.store_id for r in rows}
        return db.query(Store).filter(Store.id.in_(accessible)).order_by(Store.name).all()
    return db.query(Store).order_by(Store.name).all()


@router.get("/stores/{store_id}", response_model=StoreOut)
def get_store(store_id: int, db: Session = Depends(get_db)):
    store = db.query(Store).filter(Store.id == store_id).first()
    if not store:
        raise HTTPException(status_code=404, detail="Store not found")
    return store


@router.patch("/stores/{store_id}", response_model=StoreOut)
def update_store(store_id: int, data: StoreUpdate, db: Session = Depends(get_db)):
    store = db.query(Store).filter(Store.id == store_id).first()
    if not store:
        raise HTTPException(status_code=404, detail="Store not found")
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(store, field, value)
    db.commit()
    db.refresh(store)
    return store


@router.get("/stores/{store_id}/stats")
def get_store_stats(store_id: int, db: Session = Depends(get_db)):
    total = db.query(func.count(Product.id)).filter(Product.store_id == store_id).scalar() or 0
    enabled = db.query(func.count(Product.id)).filter(
        Product.store_id == store_id, Product.stock > 0
    ).scalar() or 0
    zeroed = db.query(func.count(Product.id)).filter(
        Product.store_id == store_id, Product.status == "zeroed"
    ).scalar() or 0
    updated_today = db.query(func.count(Product.id)).filter(
        Product.store_id == store_id,
        cast(Product.last_price_update, Date) == date.today(),
    ).scalar() or 0
    return {
        "total_products": total, "enabled_products": enabled,
        "zeroed_products": zeroed, "updated_today": updated_today,
    }


class StoreCreateUser(BaseModel):
    display_name: str
    name: str
    api_key: str = ""
    business_id: str = ""
    campaign_ids: str = ""


@router.post("/stores/create")
def user_create_store(data: StoreCreateUser, request: Request, db: Session = Depends(get_db)):
    info = get_current_info(request)
    store = Store(
        name=data.name, display_name=data.display_name or None,
        platform="yandex_market",
        api_key=data.api_key or None,
        business_id=data.business_id or None,
        campaign_ids=data.campaign_ids or None,
    )
    db.add(store)
    db.commit()
    db.refresh(store)
    user_id = info.get("user_id")
    if user_id:
        from models.user_store import UserStore
        db.add(UserStore(user_id=user_id, store_id=store.id))
        db.commit()
    return _store_response(store)


@router.patch("/stores/{store_id}/credentials")
def update_store_credentials(store_id: int, body: dict, request: Request, db: Session = Depends(get_db)):
    info = get_current_info(request)
    if not _can_manage_store(store_id, info, db):
        raise HTTPException(status_code=403, detail="Нет доступа к этому магазину")
    store = db.query(Store).filter(Store.id == store_id).first()
    if not store:
        raise HTTPException(status_code=404, detail="Магазин не найден")
    for field in ("display_name", "name", "api_key", "business_id", "campaign_ids"):
        if field in body:
            setattr(store, field, body[field] or None)
    db.commit()
    return _store_response(store)


@router.delete("/stores/{store_id}")
def delete_store(store_id: int, request: Request, db: Session = Depends(get_db)):
    info = get_current_info(request)
    if not _can_manage_store(store_id, info, db):
        raise HTTPException(status_code=403, detail="Нет доступа к этому магазину")
    store = db.query(Store).filter(Store.id == store_id).first()
    if not store:
        raise HTTPException(status_code=404, detail="Магазин не найден")
    from models.price_update import PriceUpdate
    from models.user_store import UserStore
    from models.product import Product as Prod
    db.query(PriceUpdate).filter(PriceUpdate.store_id == store_id).delete()
    db.query(Prod).filter(Prod.store_id == store_id).delete()
    db.query(UserStore).filter(UserStore.store_id == store_id).delete()
    db.delete(store)
    db.commit()
    return {"ok": True}


@router.get("/stores/{store_id}/receivables")
def get_receivables(store_id: int, db: Session = Depends(get_db)):
    store = db.query(Store).filter(Store.id == store_id).first()
    if not store:
        raise HTTPException(status_code=404, detail="Store not found")
    unpaid = db.query(OrderModel).filter(
        OrderModel.store_id == store_id,
        OrderModel.order_kind == "normal",
        OrderModel.shipment_date.isnot(None),
        OrderModel.payment_date.is_(None),
        OrderModel.ym_status.notin_(["CANCELLED", "PROCESSING", "READY_TO_SHIP"]),
    ).all()
    total = 0.0
    for o in unpaid:
        rev = (o.buyer_payment or 0.0) + (o.promo_discount or 0.0)
        if rev <= 0:
            continue
        _ym_abs = abs(o.all_services_fee or 0.0)
        _fee_rate = (_ym_abs / rev) if rev else 0
        _is_forecast = _ym_abs == 0 or _fee_rate < 0.04
        tax = o.tax_amount or 0.0
        if _is_forecast:
            fees_ex_tax = o.commission_amount or 0.0
        else:
            fees_ex_tax = _ym_abs - tax
            try:
                _fb = json.loads(o.fee_breakdown) if o.fee_breakdown else {}
                fees_ex_tax += float(_fb.get("bonus_deducted", 0.0))
            except Exception:
                pass
        total += rev - fees_ex_tax
    return {"total": round(total, 2), "adjusted": round(total, 2), "nonpickup_pct": 0.0}
