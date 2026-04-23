import json as _json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed as _as_completed

import api.state as state
from database.db import SessionLocal
from models.price_update import PriceUpdate
from models.product import Product
from models.product_match import ProductMatch
from models.store import Store
from price_engine.calculator import calculate_shelf_price
from services.yam_client import get_client_for_store

logger = logging.getLogger(__name__)


def run_recalc_background(store_id: int) -> None:
    s = state._recalc_state[store_id]
    db = None
    try:
        db = SessionLocal()
        store = db.query(Store).filter(Store.id == store_id).first()
        if not store:
            s["status"] = "error"
            s["error"] = "Store not found"
            return

        client, _, _ = get_client_for_store(store.name, db=db)

        sku_supplier: dict = {}
        for m in db.query(ProductMatch).filter(
            ProductMatch.store_id == store_id, ProductMatch.status == "confirmed"
        ).all():
            if not m.sku or not m.supplier_price:
                continue
            cur = sku_supplier.get(m.sku)
            if cur is None or m.supplier_price < cur[0]:
                sku_supplier[m.sku] = (m.supplier_price, m.supplier or "")

        matched_skus = list(sku_supplier.keys())
        if not matched_skus:
            s["status"] = "done"
            s["result"] = {"calculated": 0, "no_match": 0, "errors": [], "api_calls": 0}
            return

        products_orm = (
            db.query(Product)
            .filter(
                Product.store_id == store_id,
                Product.enabled == True,  # noqa: E712
                Product.sku.in_(matched_skus),
            )
            .all()
        )

        store_data = {
            "default_roi": store.default_roi,
            "tax_rate": store.tax_rate,
            "early_ship_discount": store.early_ship_discount,
            "selling_program": store.selling_program,
            "payout_frequency": store.payout_frequency,
        }

        class _Store:
            def __init__(self, d):
                self.__dict__.update(d)

        class _Product:
            def __init__(self, p):
                self.sku = p.sku
                self.roi = p.roi
                self.commission = p.commission
                self.category_id = p.category_id
                self.weight = p.weight
                self.length = p.length
                self.width = p.width
                self.height = p.height
                self.price = p.price

        store_snap = _Store(store_data)
        products_snap = [_Product(p) for p in products_orm]

        def _has_dims(p) -> bool:
            return all(v is not None and v > 0 for v in [p.weight, p.length, p.width, p.height])

        missing_dims = [p for p in products_snap if not _has_dims(p) and p.category_id]
        if missing_dims:
            category_ids = list({p.category_id for p in missing_dims})
            dim_donors = (
                db.query(Product.category_id, Product.weight, Product.length, Product.width, Product.height)
                .filter(
                    Product.category_id.in_(category_ids),
                    Product.weight.isnot(None), Product.weight > 0,
                    Product.length.isnot(None), Product.length > 0,
                    Product.width.isnot(None),  Product.width > 0,
                    Product.height.isnot(None), Product.height > 0,
                )
                .all()
            )
            category_dims: dict = {}
            for row in dim_donors:
                if row.category_id not in category_dims:
                    category_dims[row.category_id] = (row.weight, row.length, row.width, row.height)

            for p in missing_dims:
                dims = category_dims.get(p.category_id)
                if dims:
                    p.weight, p.length, p.width, p.height = dims

            for p in [p for p in missing_dims if not _has_dims(p)]:
                p.weight, p.length, p.width, p.height = (0.5, 20.0, 15.0, 5.0)

        db.query(PriceUpdate).filter(
            PriceUpdate.store_id == store_id,
            PriceUpdate.status.in_(["calculated", "will_zero"]),
        ).delete()
        db.commit()
        db.close()
        db = None

        tariff_cache: dict = {}
        calc_results = []
        done_counter = [0]
        counter_lock = threading.Lock()
        tax_rate = store_snap.tax_rate or 0.06

        s["total"] = len(products_snap)
        s["done"] = 0
        s["api_calls"] = 0

        def calc_one(product):
            supplier_price, supplier_name = sku_supplier[product.sku]
            shelf_price, error, tariffs, effective_rate = calculate_shelf_price(
                client, product, supplier_price, store_snap, tariff_cache
            )
            with counter_lock:
                done_counter[0] += 1

            profit = actual_roi = tariffs_json = ym_variable_rate = ym_fixed_fee = None

            if shelf_price and effective_rate is not None:
                fee_discount_pp = store_snap.early_ship_discount or 0.0

                def _rescale(t_list, price):
                    out = []
                    for t in t_list:
                        params = {x["name"]: x["value"] for x in t.get("parameters", [])}
                        pct_val = float(params.get("value", 0)) if params.get("valueType") == "relative" else None
                        if pct_val is not None:
                            amount = round(pct_val / 100 * price, 2)
                            max_val = params.get("maxValue")
                            if max_val:
                                amount = min(amount, float(max_val))
                            pct = round(amount / price * 100, 2) if price else pct_val
                        else:
                            amount = t["amount"]
                            pct = round(amount / price * 100, 2) if price else 0
                        out.append({"type": t["type"], "amount": amount, "pct": pct})
                    return out

                display_tariffs = _rescale(tariffs, shelf_price) if tariffs else [
                    {"type": "FEE", "amount": round(shelf_price * effective_rate, 2), "pct": round(effective_rate * 100, 2)}
                ]
                display_tariffs.append({"type": "TAX", "amount": round(shelf_price * tax_rate, 2), "pct": round(tax_rate * 100, 1)})
                if fee_discount_pp > 0:
                    discount_amount = round(shelf_price * fee_discount_pp / 100.0, 2)
                    display_tariffs.append({"type": "FEE_DISCOUNT", "amount": -discount_amount, "pct": -round(fee_discount_pp, 2)})

                total_costs = sum(t["amount"] for t in display_tariffs)
                profit = round(shelf_price - total_costs - supplier_price, 2)
                actual_roi = round((profit / supplier_price) * 100, 1) if supplier_price > 0 else None
                tariffs_json = _json.dumps(display_tariffs)

                if tariffs:
                    variable_amount = fixed_amount = 0.0
                    for t in tariffs:
                        params = {x["name"]: x["value"] for x in t.get("parameters", [])}
                        if params.get("valueType") == "relative":
                            pct = float(params.get("value", 0)) / 100
                            amt = pct * shelf_price
                            max_val = params.get("maxValue")
                            if max_val:
                                amt = min(amt, float(max_val))
                            variable_amount += amt
                        else:
                            fixed_amount += float(t.get("amount") or 0)
                    if fee_discount_pp > 0:
                        variable_amount -= shelf_price * fee_discount_pp / 100.0
                    ym_variable_rate = round(variable_amount / shelf_price, 6) if shelf_price > 0 else 0.0
                    ym_fixed_fee = round(fixed_amount, 2)
                else:
                    ym_variable_rate = round(effective_rate, 6)
                    ym_fixed_fee = 0.0

            return {
                "sku": product.sku,
                "supplier": supplier_name,
                "supplier_price": supplier_price,
                "old_price": product.price or 0.0,
                "new_price": shelf_price,
                "profit": profit,
                "actual_roi": actual_roi,
                "tariffs_json": tariffs_json,
                "ym_variable_rate": ym_variable_rate,
                "ym_fixed_fee": ym_fixed_fee,
                "error": error,
            }

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = {executor.submit(calc_one, p): p.sku for p in products_snap}
            for future in _as_completed(futures):
                if s.get("stop_requested"):
                    executor.shutdown(wait=False, cancel_futures=True)
                    s["status"] = "error"
                    s["error"] = "Остановлено пользователем"
                    return
                calc_results.append(future.result())
                with counter_lock:
                    s["done"] = done_counter[0]
                s["api_calls"] = len(tariff_cache)

        calculated = 0
        errors = []
        db2 = SessionLocal()
        try:
            for r in calc_results:
                if r["error"] or r["new_price"] is None:
                    errors.append({"sku": r["sku"], "error": r["error"] or "цена не рассчитана"})
                    continue
                old_price = r["old_price"]
                shelf_price = r["new_price"]
                diff = round(shelf_price - old_price, 2)
                diff_pct = round(abs(diff) / old_price * 100, 1) if old_price > 0 else 100.0
                db2.add(PriceUpdate(
                    store_id=store_id,
                    sku=r["sku"],
                    supplier=r["supplier"],
                    supplier_price=r["supplier_price"],
                    old_price=old_price,
                    new_price=shelf_price,
                    difference=diff,
                    difference_pct=diff_pct,
                    profit=r["profit"],
                    actual_roi=r["actual_roi"],
                    tariffs_json=r["tariffs_json"],
                    requires_confirmation=diff_pct > 5.0,
                    status="calculated",
                ))
                if r.get("ym_variable_rate") is not None:
                    prod = db2.query(Product).filter(
                        Product.store_id == store_id, Product.sku == r["sku"]
                    ).first()
                    if prod:
                        prod.ym_variable_rate = r["ym_variable_rate"]
                        prod.ym_fixed_fee = r["ym_fixed_fee"]
                calculated += 1

            for p in db2.query(Product).filter(
                Product.store_id == store_id,
                Product.enabled == True,  # noqa: E712
                Product.sku.notin_(matched_skus),
            ).all():
                db2.add(PriceUpdate(
                    store_id=store_id,
                    sku=p.sku,
                    old_price=p.price or 0.0,
                    new_price=p.price or 0.0,
                    old_stock=p.stock,
                    new_stock=0,
                    requires_confirmation=False,
                    status="will_zero",
                ))

            db2.commit()
        except Exception as db_err:
            db2.rollback()
            raise RuntimeError(f"Ошибка записи в БД: {db_err}") from db_err
        finally:
            db2.close()

        s["status"] = "done"
        s["result"] = {
            "calculated": calculated,
            "no_match": 0,
            "errors": errors,
            "api_calls": len(tariff_cache),
        }

    except Exception as e:
        logger.exception("Recalculate error store %s: %s", store_id, e)
        s["status"] = "error"
        s["error"] = str(e)
    finally:
        if db:
            db.close()
