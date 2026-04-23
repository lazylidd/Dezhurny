import os

from sqlalchemy.orm import Session

from models.product import Product
from services.yam_client import chunked, get_client_for_store
from utils.commission import (
    build_category_maps,
    find_commission_for_category,
    load_commission_paths_from_excel,
)
from utils.normalizer import normalize_name

COMMISSIONS_XLSX = os.path.join(os.path.dirname(__file__), "..", "data", "commissions_fbs.xlsx")

# Приоритет статусов: PUBLISHED лучший, дальше по убыванию
_STATUS_PRIORITY = ["PUBLISHED", "CHECKING", "NO_STOCKS", "HIDDEN", "SUSPENDED", "DISABLED", "REJECTED"]


def _aggregate_campaign_status(campaigns: list) -> str:
    """Возвращает наилучший статус из всех кампаний товара."""
    statuses = {c.get("status") for c in campaigns if c.get("status")}
    for s in _STATUS_PRIORITY:
        if s in statuses:
            return s
    return next(iter(statuses), "")


def sync_assortment(store_name: str, store_id: int, db: Session) -> int:
    """
    Синхронизирует ассортимент магазина из API ЯМ в таблицу products.
    Возвращает количество обработанных товаров.
    """
    client, business_id, campaign_ids = get_client_for_store(store_name, db=db)

    commission_by_path = load_commission_paths_from_excel(COMMISSIONS_XLSX)
    categories_tree = client.get_categories_tree()
    categories_by_id, full_path_by_id, norm_full_path_by_id = build_category_maps(categories_tree)

    mappings = client.iter_offer_mappings(business_id)

    offer_ids = []
    base_rows = []

    for m in mappings:
        offer = m.get("offer") or {}
        mapping = m.get("mapping") or {}

        sku = offer.get("offerId") or offer.get("id")
        if not sku:
            continue

        market_category_id = mapping.get("marketCategoryId") or ""
        commission, _, _ = find_commission_for_category(
            market_category_id, categories_by_id, norm_full_path_by_id, commission_by_path
        )

        category_path = ""
        if market_category_id not in ("", None):
            try:
                category_path = full_path_by_id.get(int(market_category_id), "")
            except Exception:
                pass

        dims = offer.get("weightDimensions") or {}

        offer_ids.append(str(sku))
        offer_name = offer.get("name") or ""
        base_rows.append({
            "sku": str(sku),
            "name": offer_name,
            "normalized_name": normalize_name(offer_name),
            "category": category_path,
            "category_id": str(market_category_id) if market_category_id else "",
            "commission": float(commission) if commission not in ("", None) else None,
            "vendor": offer.get("vendor") or "",
            "weight": float(dims["weight"]) if dims.get("weight") is not None else None,
            "length": float(dims["length"]) if dims.get("length") is not None else None,
            "width": float(dims["width"]) if dims.get("width") is not None else None,
            "height": float(dims["height"]) if dims.get("height") is not None else None,
            "ym_availability": _aggregate_campaign_status(offer.get("campaigns") or []),
            "ym_processing_status": offer.get("cardStatus") or "",
        })

    # Fallback commission: для товаров с REJECTED_BY_MARKET нет marketCategoryId.
    # Если у того же вендора есть другой товар с комиссией — используем её.
    vendor_commission: dict = {}
    for row in base_rows:
        if row["commission"] is not None and row["vendor"]:
            vendor_commission.setdefault(row["vendor"], row["commission"])
    for row in base_rows:
        if row["commission"] is None and row["vendor"] and row["vendor"] in vendor_commission:
            row["commission"] = vendor_commission[row["vendor"]]

    # Цены берём из первой кампании (одинаковы для всех складов)
    primary_campaign = campaign_ids[0]
    prices: dict = {}
    for part in chunked(offer_ids, 2000):
        prices.update(client.get_prices(primary_campaign, part))

    # Остатки суммируем по всем складам
    stocks: dict = {}
    for campaign_id in campaign_ids:
        for part in chunked(offer_ids, 500):
            for sku, count in client.get_stocks(campaign_id, part).items():
                stocks[sku] = stocks.get(sku, 0) + count

    # Upsert в таблицу products
    existing = {p.sku: p for p in db.query(Product).filter(Product.store_id == store_id).all()}

    for row in base_rows:
        sku = row["sku"]
        price_obj = prices.get(sku) or {}
        price = price_obj.get("value")
        stock = stocks.get(sku, 0)

        if sku in existing:
            p = existing[sku]
            p.name = row["name"]
            p.normalized_name = row["normalized_name"]
            p.category = row["category"]
            p.category_id = row["category_id"]
            p.commission = row["commission"]
            p.vendor = row["vendor"]
            p.weight = row["weight"]
            p.length = row["length"]
            p.width = row["width"]
            p.height = row["height"]
            p.ym_availability = row["ym_availability"]
            p.ym_processing_status = row["ym_processing_status"]
            if price is not None:
                p.price = float(price)
            if sku in stocks:
                p.stock = stock
        else:
            p = Product(
                store_id=store_id,
                sku=sku,
                name=row["name"],
                normalized_name=row["normalized_name"],
                category=row["category"],
                category_id=row["category_id"],
                commission=row["commission"],
                vendor=row["vendor"],
                weight=row["weight"],
                length=row["length"],
                width=row["width"],
                height=row["height"],
                ym_availability=row["ym_availability"],
                ym_processing_status=row["ym_processing_status"],
                price=float(price) if price is not None else None,
                stock=stock,
                enabled=True,
                status="active",
            )
            db.add(p)

    db.commit()
    return len(base_rows)
