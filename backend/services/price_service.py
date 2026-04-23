import logging
import random
import time
from datetime import datetime
from typing import Optional

import api.state as state
from database.db import SessionLocal
from models.price_update import PriceUpdate
from models.product import Product
from models.product_match import ProductMatch
from models.store import Store
from services.promo_service import sync_promos_for_store
from services.yam_client import get_client_for_store
from sqlalchemy.orm import Session
from utils.settings import get_setting

logger = logging.getLogger(__name__)


def apply_one_store(sid: int, store_updates: list[PriceUpdate], db: Session) -> tuple[int, list[dict]]:
    applied = 0
    errors = []
    store_obj = db.query(Store).filter(Store.id == sid).first()
    store_name = store_obj.name if store_obj else state.STORES.get(sid)
    if not store_name:
        return 0, [{"sku": "?", "error": f"Unknown store {sid}"}]

    auto_promo_sync = store_obj.auto_promo_sync if store_obj else False
    client, business_id, campaign_ids = get_client_for_store(store_name, db)

    sku_prices = {pu.sku: pu.new_price for pu in store_updates}
    old_prices = {pu.sku: pu.old_price for pu in store_updates}
    sku_discount_bases = {sku: round(price * 1.2) for sku, price in sku_prices.items()}
    client.update_prices_business_batch(business_id, sku_prices, sku_discount_bases=sku_discount_bases)

    price_stock_delay = int(get_setting("price_stock_jitter_min"))
    price_stock_delay_max = int(get_setting("price_stock_jitter_max"))
    time.sleep(random.randint(price_stock_delay, price_stock_delay_max))

    store_obj = db.query(Store).filter(Store.id == sid).first()
    s_min = (store_obj.stock_min or 20) if store_obj else 20
    s_max = (store_obj.stock_max or 50) if store_obj else 50
    s_min, s_max = min(s_min, s_max), max(s_min, s_max)
    stock_pool = list(range(s_min, s_max + 1))
    random.shuffle(stock_pool)
    sku_stocks = {pu.sku: stock_pool[i % len(stock_pool)] for i, pu in enumerate(store_updates)}

    for campaign_id in campaign_ids:
        try:
            client.update_stocks_batch(campaign_id, sku_stocks)
        except Exception as e:
            logger.warning("Не удалось обновить остатки campaign %s: %s", campaign_id, e)

    now = datetime.now()
    for pu in store_updates:
        product = db.query(Product).filter(Product.store_id == sid, Product.sku == pu.sku).first()
        if product:
            pu.old_stock = product.stock
            pu.new_stock = sku_stocks[pu.sku]
            product.price = pu.new_price
            product.stock = sku_stocks[pu.sku]
            product.last_price_update = now
            product.status = "updated"
        pu.status = "applied"
        applied += 1

    confirmed_skus = {
        m.sku for m in db.query(ProductMatch.sku)
        .filter(ProductMatch.store_id == sid, ProductMatch.status == "confirmed")
        .all()
        if m.sku
    }
    unmatched = (
        db.query(Product)
        .filter(
            Product.store_id == sid,
            Product.enabled == True,  # noqa: E712
            Product.sku.notin_(confirmed_skus),
        )
        .all()
    )
    if unmatched:
        zero_stocks = {p.sku: 0 for p in unmatched}
        for campaign_id in campaign_ids:
            try:
                client.update_stocks_batch(campaign_id, zero_stocks)
            except Exception as e:
                logger.warning("Не удалось обнулить остатки campaign %s: %s", campaign_id, e)
        for p in unmatched:
            old_s = p.stock
            p.stock = 0
            p.last_price_update = now
            db.add(PriceUpdate(
                store_id=sid,
                sku=p.sku,
                old_price=p.price,
                new_price=p.price or 0,
                old_stock=old_s,
                new_stock=0,
                status="zeroed",
                requires_confirmation=False,
            ))

    if auto_promo_sync:
        try:
            all_products = (
                db.query(Product)
                .filter(Product.store_id == sid, Product.enabled == True, Product.price != None)  # noqa: E712
                .all()
            )
            all_sku_prices = {p.sku: p.price for p in all_products if p.price}
            all_old_prices = {p.sku: p.price for p in all_products if p.price}
            all_old_prices.update(old_prices)
            sync_promos_for_store(client, business_id, sid, all_sku_prices, all_old_prices, db)
        except Exception as e:
            logger.warning("[promo_sync] store %s: %s", sid, e)
    else:
        logger.info("[promo_sync] store %s: auto_promo_sync=False, пропущено", sid)

    return applied, errors


def run_apply_background(filter_store_id: Optional[int] = None) -> None:
    s = state._apply_state
    db = None
    try:
        db = SessionLocal()

        delay_min = int(get_setting("apply_inter_store_delay_min"))
        delay_max = int(get_setting("apply_inter_store_delay_max"))

        wz_q = db.query(PriceUpdate).filter(PriceUpdate.status == "will_zero")
        if filter_store_id:
            wz_q = wz_q.filter(PriceUpdate.store_id == filter_store_id)
        wz_q.delete()
        db.flush()

        q = db.query(PriceUpdate).filter(
            PriceUpdate.status == "calculated",
            PriceUpdate.requires_confirmation == False,  # noqa: E712
        )
        if filter_store_id:
            q = q.filter(PriceUpdate.store_id == filter_store_id)

        by_store: dict[int, list] = {}
        for pu in q.all():
            by_store.setdefault(pu.store_id, []).append(pu)

        store_ids = sorted(by_store.keys())
        total_applied = 0
        total_errors: list = []

        for i, sid in enumerate(store_ids):
            if s.get("stop_requested"):
                s["status"] = "error"
                s["error"] = "Остановлено пользователем"
                return

            store_name = db.query(Store.name).filter(Store.id == sid).scalar() or state.STORES.get(sid, str(sid))
            s["phase"] = "applying_store"
            s["current_store"] = store_name

            try:
                applied, errors = apply_one_store(sid, by_store[sid], db)
                db.commit()
                total_applied += applied
                total_errors.extend(errors)
            except Exception as e:
                db.rollback()
                for pu in by_store[sid]:
                    pu.status = "error"
                    total_errors.append({"sku": pu.sku, "error": str(e)})
                db.commit()
                logger.exception("Apply error store %s: %s", sid, e)

            s["applied"] = total_applied

            if i < len(store_ids) - 1 and not s.get("stop_requested"):
                next_name = (
                    db.query(Store.name).filter(Store.id == store_ids[i + 1]).scalar()
                    or state.STORES.get(store_ids[i + 1], str(store_ids[i + 1]))
                )
                delay = random.randint(delay_min, delay_max)
                s["phase"] = "waiting"
                s["next_store"] = next_name
                s["wait_total"] = delay
                deadline = time.time() + delay
                while time.time() < deadline:
                    if s.get("stop_requested"):
                        s["status"] = "error"
                        s["error"] = "Остановлено пользователем"
                        return
                    s["wait_remaining"] = max(0, int(deadline - time.time()))
                    time.sleep(3)

        s["status"] = "done"
        s["result"] = {"applied": total_applied, "errors": total_errors}

    except Exception as e:
        logger.exception("Apply background error: %s", e)
        s["status"] = "error"
        s["error"] = str(e)
    finally:
        if db:
            db.close()
