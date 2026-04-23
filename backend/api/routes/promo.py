from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from api.deps import get_db
from models.product import Product
from models.promo_sync_log import PromoSyncLog
from models.store import Store
from services.promo_service import sync_promos_for_store
from services.yam_client import get_client_for_store

router = APIRouter(tags=["promo"])


@router.post("/stores/{store_id}/promo-sync-debug")
def promo_sync_debug(store_id: int, db: Session = Depends(get_db)):
    store_obj = db.query(Store).filter(Store.id == store_id).first()
    if not store_obj:
        raise HTTPException(status_code=404, detail="Store not found")
    try:
        client, business_id, _ = get_client_for_store(store_obj.name, db)
    except Exception as e:
        return {"error": f"Не удалось получить клиент для магазина: {e}", "log": []}
    products = db.query(Product).filter(
        Product.store_id == store_id,
        Product.price.isnot(None),
        Product.enabled == True,  # noqa: E712
    ).all()
    sku_prices = {p.sku: p.price for p in products if p.price}
    if not sku_prices:
        return {"error": "Нет товаров с ценами в БД", "log": [], "sku_count": 0}
    try:
        promos = client.get_promos(business_id)
    except Exception as e:
        return {"error": f"get_promos ОШИБКА: {e}", "log": [], "sku_count": len(sku_prices)}
    if not promos:
        return {
            "error": None,
            "message": "get_promos вернул пустой список — активных акций нет",
            "log": [], "sku_count": len(sku_prices), "business_id": business_id,
        }
    log_entries = sync_promos_for_store(client, business_id, store_id, sku_prices, {}, db)
    db.commit()
    return {
        "error": None,
        "sku_count": len(sku_prices), "promo_count": len(promos),
        "promo_ids": [p.get("id") for p in promos],
        "business_id": business_id,
        "log_count": len(log_entries), "log": log_entries,
    }


@router.get("/promo-sync-log")
def get_promo_sync_log(store_id: Optional[int] = None, limit: int = 200, db: Session = Depends(get_db)):
    q = db.query(PromoSyncLog).order_by(PromoSyncLog.timestamp.desc())
    if store_id is not None:
        q = q.filter(PromoSyncLog.store_id == store_id)
    rows = q.limit(limit).all()
    return [
        {
            "id": r.id, "store_id": r.store_id,
            "timestamp": r.timestamp.isoformat() if r.timestamp else None,
            "sku": r.sku, "promo_id": r.promo_id, "promo_name": r.promo_name,
            "action": r.action,
            "old_catalog_price": r.old_catalog_price, "new_catalog_price": r.new_catalog_price,
            "old_promo_price": r.old_promo_price, "new_promo_price": r.new_promo_price,
            "reason": r.reason,
        }
        for r in rows
    ]


@router.get("/promo-sync-stats")
def get_promo_sync_stats(store_id: Optional[int] = None, db: Session = Depends(get_db)):
    outer_filter = "AND l.store_id = :store_id" if store_id else ""
    inner_filter = "AND store_id = :store_id" if store_id else ""
    sql = text(f"""
        SELECT
            COUNT(DISTINCT l.sku) AS in_promo,
            COUNT(DISTINCT CASE WHEN COALESCE(p.stock, 0) > 0 THEN l.sku END) AS in_promo_with_stock
        FROM promo_sync_log l
        JOIN (
            SELECT sku, store_id, MAX(timestamp) AS max_ts
            FROM promo_sync_log
            WHERE 1=1 {inner_filter}
            GROUP BY sku, store_id
        ) latest ON l.sku = latest.sku AND l.store_id = latest.store_id AND l.timestamp = latest.max_ts
        LEFT JOIN products p ON p.sku = l.sku AND p.store_id = l.store_id
        WHERE l.action IN ('ADDED', 'PRICE_UPDATED')
        {outer_filter}
    """)
    params = {"store_id": store_id} if store_id else {}
    row = db.execute(sql, params).fetchone()
    return {"in_promo": row[0] if row else 0, "in_promo_with_stock": row[1] if row else 0}
