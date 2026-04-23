import json
import logging
from collections import defaultdict
from datetime import date as date_cls
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import get_db
from models.order import Order as OrderModel
from models.product import Product
from models.store import Store

logger = logging.getLogger(__name__)
router = APIRouter(tags=["orders"])


class SyncOrdersRequest(BaseModel):
    date_from: str
    date_to: str


@router.post("/stores/{store_id}/sync-orders")
def sync_orders(store_id: int, body: SyncOrdersRequest, db: Session = Depends(get_db)):
    from services.orders_service import sync_orders_for_store
    _store = db.query(Store).filter(Store.id == store_id).first()
    if not _store:
        raise HTTPException(status_code=404, detail="Store not found")
    try:
        count = sync_orders_for_store(store_id, _store.name, body.date_from, body.date_to, db)
    except Exception as e:
        logger.error("sync-orders error: %s", e)
        raise HTTPException(status_code=502, detail=str(e))
    return {"added": count}


def _build_order_row(o, store, db) -> dict:
    buyer_price = float(o.buyer_payment or 0.0)
    promo = float(o.promo_discount or 0.0)
    revenue = buyer_price + promo

    if o.order_kind == "nonpickup":
        ym_status = getattr(o, "ym_status", None) or "NONPICKUP"
        return {
            "id": o.id,
            "store_id": store.id,
            "store_name": getattr(store, "display_name", None) or store.name,
            "order_id": o.order_id,
            "offer_name": o.offer_name,
            "sku": o.sku,
            "order_kind": o.order_kind,
            "ym_status": ym_status,
            "quantity": getattr(o, "quantity", 1) or 1,
            "order_date": (getattr(o, "shipment_date", None) or o.order_date or None) and (getattr(o, "shipment_date", None) or o.order_date).isoformat(),
            "market_price": o.market_price,
            "buyer_payment": buyer_price,
            "promo_discount": promo,
            "revenue": 0.0,
            "all_services_fee": o.all_services_fee,
            "fees_total": 0.0,
            "fee_details": [],
            "is_forecast": False,
            "supplier_price": o.supplier_price,
            "supplier_price_matched": o.supplier_price_matched,
            "supplier_price_is_manual": bool(o.supplier_price_is_manual),
            "commission_amount": None,
            "tax_amount": None,
            "profit": None,
            "ros": None,
            "roi": None,
            "margin_pct": None,
            "payment_date": getattr(o, "payment_date", None) and o.payment_date.isoformat(),
            "serial_number": getattr(o, "serial_number", None),
            "shipment_date": getattr(o, "shipment_date", None) and o.shipment_date.isoformat(),
        }

    active_statuses = {"PROCESSING", "READY_TO_SHIP", "DELIVERY", "PICKUP"}
    ym_services_abs = abs(float(o.all_services_fee or 0.0))
    fee_rate = (ym_services_abs / revenue) if revenue else 0
    is_forecast = (o.order_kind == "normal" and (ym_services_abs == 0 or fee_rate < 0.04)) \
                  or (getattr(o, "ym_status", None) in active_statuses)

    if is_forecast:
        product = (
            db.query(Product).filter(Product.store_id == o.store_id, Product.sku == o.sku).first()
            if o.sku else None
        )
        tax_rate = float(getattr(store, "tax_rate", None) or 0.06)
        if product and product.ym_variable_rate is not None:
            ym_var_rate = float(product.ym_variable_rate)
            ym_fix = float(product.ym_fixed_fee or 0)
        else:
            ym_var_rate = float(product.commission or 0) / 100 if product and product.commission else 0.0
            ym_fix = 0.0
        ym_var_amount = round(revenue * ym_var_rate, 2)
        ym_fix_amount = round(ym_fix, 2)
        tax_fee = round(buyer_price * tax_rate, 2)
        fees_total = round(ym_var_amount + ym_fix_amount + tax_fee, 2)
        fee_details = []
        if ym_var_amount:
            fee_details.append({"type": "FEE", "label": "Комиссия ЯМ (прогноз)", "amount": ym_var_amount, "pct": round(ym_var_rate * 100, 2)})
        if ym_fix_amount:
            fee_details.append({"type": "FIXED", "label": "Доставка/фикс. (прогноз)", "amount": ym_fix_amount, "pct": round(ym_fix_amount / revenue * 100, 2) if revenue else 0})
        fee_details.append({"type": "TAX", "label": f"Налог (УСН {round(tax_rate * 100)}%)", "amount": tax_fee, "pct": round(tax_rate * 100, 1)})
        if promo:
            fee_details.append({"type": "SUBSIDY", "label": "Субсидия ЯМ", "amount": round(promo, 2), "pct": round(promo / revenue * 100, 2) if revenue else 0})
    else:
        import json as _json
        tax_fee_actual = float(o.tax_amount or 0.0)

        stored_fb: dict = {}
        if getattr(o, "fee_breakdown", None):
            try:
                stored_fb = _json.loads(o.fee_breakdown)
            except Exception:
                pass

        bonus_deducted = float(stored_fb.get("bonus_deducted", 0.0)) if stored_fb else 0.0
        fees_total = round(ym_services_abs + tax_fee_actual + bonus_deducted, 2)

        _LABEL = {
            "fee_placement": ("Комиссия за размещение", "FEE"),
            "fee_logistics":  ("Логистика",              "FIXED"),
            "fee_payment":    ("Перевод платежа",        "FIXED"),
            "fee_other":      ("Прочие услуги",          "FIXED"),
            "fee_auction":    ("Продвижение в поиске",   "FIXED"),
            "fee_sorting":    ("Сортировка",             "FIXED"),
            "fee_loyalty":    ("Программа лояльности",   "FIXED"),
            "fee_storage":    ("Хранение возвратов",     "FIXED"),
        }
        fee_details = []
        if stored_fb:
            for key, (label, tp) in _LABEL.items():
                amt = stored_fb.get(key, 0.0)
                if amt:
                    fee_details.append({"type": tp, "label": label, "amount": round(amt, 2), "pct": round(amt / revenue * 100, 2) if revenue else 0})
            if bonus_deducted:
                fee_details.append({"type": "BONUS", "label": "Списанные баллы", "amount": round(bonus_deducted, 2), "pct": round(bonus_deducted / revenue * 100, 2) if revenue else 0})
        else:
            if ym_services_abs:
                fee_details.append({"type": "FEE", "label": "Услуги ЯМ", "amount": ym_services_abs, "pct": round(ym_services_abs / revenue * 100, 2) if revenue else 0})

        if tax_fee_actual:
            fee_details.append({"type": "TAX", "label": "Налог (УСН)", "amount": tax_fee_actual, "pct": round(tax_fee_actual / buyer_price * 100, 2) if buyer_price else 0})
        if promo:
            fee_details.append({"type": "SUBSIDY", "label": "Субсидия ЯМ", "amount": round(promo, 2), "pct": round(promo / revenue * 100, 2) if revenue else 0})

    supplier_cost = float(o.supplier_price or 0.0)
    profit = None
    if o.supplier_price is not None and revenue:
        profit = round(revenue - fees_total - supplier_cost, 2)
    ros = round(profit / revenue, 4) if (profit is not None and revenue > 0) else None
    roi = round(profit / supplier_cost, 4) if (profit is not None and supplier_cost > 0) else None
    margin_pct = round(profit / revenue * 100, 1) if (profit is not None and revenue > 0) else None

    ym_status = getattr(o, "ym_status", None)
    if not ym_status:
        ym_status = {"normal": "DELIVERED", "nonpickup": "NONPICKUP", "return": "RETURNED"}.get(
            o.order_kind or "normal", "DELIVERED"
        )

    return {
        "id": o.id,
        "store_id": store.id,
        "store_name": getattr(store, "display_name", None) or store.name,
        "order_id": o.order_id,
        "offer_name": o.offer_name,
        "sku": o.sku,
        "order_kind": o.order_kind,
        "ym_status": ym_status,
        "quantity": getattr(o, "quantity", 1) or 1,
        "order_date": (getattr(o, "shipment_date", None) or o.order_date or None) and (getattr(o, "shipment_date", None) or o.order_date).isoformat(),
        "market_price": o.market_price,
        "buyer_payment": buyer_price,
        "promo_discount": promo,
        "revenue": round(revenue, 2),
        "all_services_fee": o.all_services_fee,
        "fees_total": fees_total,
        "fee_details": fee_details,
        "is_forecast": is_forecast,
        "supplier_price": o.supplier_price,
        "supplier_price_matched": o.supplier_price_matched,
        "supplier_price_is_manual": bool(o.supplier_price_is_manual),
        "commission_amount": o.commission_amount,
        "tax_amount": o.tax_amount,
        "profit": profit,
        "ros": ros,
        "roi": roi,
        "margin_pct": margin_pct,
        "payment_date": getattr(o, "payment_date", None) and o.payment_date.isoformat(),
        "serial_number": getattr(o, "serial_number", None),
        "shipment_date": getattr(o, "shipment_date", None) and o.shipment_date.isoformat(),
    }


@router.get("/stores/{store_id}/orders")
def get_orders(
    store_id: int,
    date_from: str = None,
    date_to: str = None,
    kind: str = None,
    limit: int = 500,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    store = db.query(Store).filter(Store.id == store_id).first()
    if not store:
        raise HTTPException(status_code=404, detail="Store not found")
    q = db.query(OrderModel).filter(OrderModel.store_id == store_id)
    if date_from:
        q = q.filter(OrderModel.order_date >= date_cls.fromisoformat(date_from))
    if date_to:
        q = q.filter(OrderModel.order_date <= date_cls.fromisoformat(date_to))
    if kind:
        q = q.filter(OrderModel.order_kind == kind)
    orders = q.order_by(OrderModel.order_date.desc()).offset(offset).limit(limit).all()
    return [_build_order_row(o, store, db) for o in orders]


@router.get("/orders")
def get_all_orders(
    date_from: str = None,
    date_to: str = None,
    kind: str = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
):
    from sqlalchemy import or_

    ACTIVE = ("PROCESSING", "READY_TO_SHIP", "DELIVERY", "PICKUP")

    q_active = db.query(OrderModel).filter(OrderModel.ym_status.in_(ACTIVE))
    if kind:
        q_active = q_active.filter(OrderModel.order_kind == kind)
    active_orders = q_active.all()
    active_ids = {o.id for o in active_orders}

    q_hist = db.query(OrderModel).filter(
        (OrderModel.ym_status.is_(None)) | (~OrderModel.ym_status.in_(ACTIVE + ("CANCELLED",)))
    )
    if date_from:
        q_hist = q_hist.filter(OrderModel.order_date >= date_cls.fromisoformat(date_from))
    if date_to:
        q_hist = q_hist.filter(OrderModel.order_date <= date_cls.fromisoformat(date_to))
    if kind:
        q_hist = q_hist.filter(OrderModel.order_kind == kind)
    hist_orders = q_hist.order_by(OrderModel.order_date.desc()).offset(offset).limit(limit).all()

    all_orders = list(active_orders) + [o for o in hist_orders if o.id not in active_ids]
    all_orders.sort(key=lambda o: (
        0 if getattr(o, "ym_status", None) in ACTIVE else 1,
        -(o.order_date.toordinal() if o.order_date else 0)
    ))
    all_orders = all_orders[:limit]

    store_cache: dict[int, Store] = {}
    result = []
    for o in all_orders:
        if o.store_id not in store_cache:
            store_cache[o.store_id] = db.query(Store).filter(Store.id == o.store_id).first()
        store = store_cache[o.store_id]
        if store:
            result.append(_build_order_row(o, store, db))
    return result


@router.post("/orders/sync-active")
def sync_active_orders_endpoint(db: Session = Depends(get_db)):
    from services.orders_service import sync_active_orders_for_store
    stores = db.query(Store).all()
    total = 0
    errors = []
    for store in stores:
        try:
            n = sync_active_orders_for_store(store.id, store.name, db)
            total += n
        except Exception as e:
            logger.error("sync-active-orders error store=%s: %s", store.name, e)
            errors.append(f"{store.name}: {str(e)[:100]}")
    return {"synced": total, "errors": errors}


class OrderSupplierPriceUpdate(BaseModel):
    supplier_price: Optional[float]


@router.patch("/stores/{store_id}/orders/{order_db_id}/supplier-price")
def update_order_supplier_price(
    store_id: int,
    order_db_id: int,
    body: OrderSupplierPriceUpdate,
    db: Session = Depends(get_db),
):
    o = db.query(OrderModel).filter(OrderModel.id == order_db_id, OrderModel.store_id == store_id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Order not found")
    o.supplier_price = body.supplier_price
    o.supplier_price_is_manual = True
    db.commit()
    return {"ok": True, "id": order_db_id, "supplier_price": body.supplier_price}


class OrderSerialNumberUpdate(BaseModel):
    serial_number: Optional[str]


@router.patch("/stores/{store_id}/orders/{order_db_id}/serial-number")
def update_order_serial_number(
    store_id: int,
    order_db_id: int,
    body: OrderSerialNumberUpdate,
    db: Session = Depends(get_db),
):
    o = db.query(OrderModel).filter(OrderModel.id == order_db_id, OrderModel.store_id == store_id).first()
    if not o:
        raise HTTPException(status_code=404, detail="Order not found")
    o.serial_number = body.serial_number
    db.commit()
    return {"ok": True, "id": order_db_id, "serial_number": body.serial_number}


@router.get("/stores/{store_id}/orders/summary")
def get_orders_summary(
    store_id: int,
    date_from: str = None,
    date_to: str = None,
    db: Session = Depends(get_db),
):
    q = db.query(OrderModel).filter(OrderModel.store_id == store_id)
    if date_from:
        q = q.filter(OrderModel.order_date >= date_cls.fromisoformat(date_from))
    if date_to:
        q = q.filter(OrderModel.order_date <= date_cls.fromisoformat(date_to))
    orders = q.all()

    total_revenue = total_fees = total_supplier = total_tax = 0.0
    matched_count = total_normal = nonpickup_count = return_count = 0
    daily: dict = defaultdict(lambda: {"revenue": 0.0, "fees": 0.0, "supplier": 0.0, "count": 0})

    _active = {"PROCESSING", "READY_TO_SHIP", "DELIVERY", "PICKUP"}

    for o in orders:
        if o.order_kind == "nonpickup":
            nonpickup_count += 1
            continue
        if o.order_kind == "return":
            return_count += 1
            continue
        total_normal += 1
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

        total_revenue += rev
        total_fees += fees
        total_tax += tax
        if o.supplier_price is not None:
            total_supplier += sup
            matched_count += 1

        day_key = o.order_date.isoformat() if o.order_date else "unknown"
        daily[day_key]["revenue"] += rev
        daily[day_key]["fees"] += fees
        daily[day_key]["supplier"] += sup
        daily[day_key]["count"] += 1

    total_profit = None
    roi = None
    if matched_count > 0:
        total_profit = total_revenue - total_fees - total_supplier
        if total_supplier > 0:
            roi = total_profit / total_supplier

    nonpickup_pct = nonpickup_count / (total_normal + nonpickup_count) if (total_normal + nonpickup_count) > 0 else None
    return_pct = return_count / (total_normal + return_count) if (total_normal + return_count) > 0 else None

    daily_list = sorted(
        [{"date": k, **v, "profit": v["revenue"] - v["fees"] - v["supplier"]} for k, v in daily.items()],
        key=lambda x: x["date"],
    )

    return {
        "total_orders": total_normal,
        "matched_orders": matched_count,
        "total_revenue": round(total_revenue, 2),
        "total_fees": round(total_fees, 2),
        "total_tax": round(total_tax, 2),
        "total_supplier_cost": round(total_supplier, 2) if matched_count > 0 else None,
        "total_profit": round(total_profit, 2) if total_profit is not None else None,
        "roi": round(roi, 4) if roi is not None else None,
        "nonpickup_count": nonpickup_count,
        "return_count": return_count,
        "nonpickup_pct": round(nonpickup_pct, 4) if nonpickup_pct is not None else None,
        "return_pct": round(return_pct, 4) if return_pct is not None else None,
        "daily": daily_list,
    }
