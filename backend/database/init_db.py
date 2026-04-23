import os

from sqlalchemy import text

from database.db import Base, SessionLocal, engine
from models.order import Order  # noqa: F401
from models.price_update import PriceUpdate  # noqa: F401
from models.product import Product  # noqa: F401
from models.product_match import ProductMatch  # noqa: F401
from models.promo_sync_log import PromoSyncLog  # noqa: F401
from models.store import Store  # noqa: F401
from models.supplier_price import SupplierPrice  # noqa: F401
from models.user import User  # noqa: F401
from models.user_store import UserStore  # noqa: F401


def init_db():
    Base.metadata.create_all(bind=engine)
    _migrate()
    _seed_stores()


def _migrate():
    """Добавляет новые колонки в существующие таблицы (idempotent)."""
    migrations = [
        "ALTER TABLE stores ADD COLUMN early_ship_discount FLOAT",
        "ALTER TABLE stores ADD COLUMN payment_commission FLOAT",
        "ALTER TABLE stores ADD COLUMN selling_program VARCHAR DEFAULT 'FBS'",
        "ALTER TABLE stores ADD COLUMN payout_frequency VARCHAR DEFAULT 'MONTHLY'",
        "ALTER TABLE products ADD COLUMN vendor VARCHAR",
        "ALTER TABLE products ADD COLUMN weight FLOAT",
        "ALTER TABLE products ADD COLUMN length FLOAT",
        "ALTER TABLE products ADD COLUMN width FLOAT",
        "ALTER TABLE products ADD COLUMN height FLOAT",
        "ALTER TABLE products ADD COLUMN ym_availability VARCHAR",
        "ALTER TABLE products ADD COLUMN ym_processing_status VARCHAR",
        "ALTER TABLE stores ADD COLUMN IF NOT EXISTS stock_min INTEGER DEFAULT 20",
        "ALTER TABLE stores ADD COLUMN IF NOT EXISTS stock_max INTEGER DEFAULT 50",
        "ALTER TABLE product_matches ADD COLUMN IF NOT EXISTS best_score FLOAT",
        "ALTER TABLE price_updates ADD COLUMN IF NOT EXISTS supplier VARCHAR",
        "ALTER TABLE price_updates ADD COLUMN IF NOT EXISTS supplier_price FLOAT",
        "ALTER TABLE price_updates ADD COLUMN IF NOT EXISTS difference_pct FLOAT",
        "ALTER TABLE price_updates ADD COLUMN IF NOT EXISTS old_stock INTEGER",
        "ALTER TABLE price_updates ADD COLUMN IF NOT EXISTS new_stock INTEGER",
        # Удаляем дубли: строки с пустым offer_name, если для того же order_id есть строка с именем
        "DELETE FROM orders WHERE id IN (SELECT o1.id FROM orders o1 WHERE (o1.offer_name IS NULL OR o1.offer_name = '') AND EXISTS (SELECT 1 FROM orders o2 WHERE o2.store_id = o1.store_id AND o2.order_id = o1.order_id AND o2.offer_name IS NOT NULL AND o2.offer_name != '' AND o2.id != o1.id))",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission_amount FLOAT",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_discount FLOAT",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount FLOAT",
        "ALTER TABLE stores ADD COLUMN IF NOT EXISTS api_key VARCHAR",
        "ALTER TABLE stores ADD COLUMN IF NOT EXISTS business_id VARCHAR",
        "ALTER TABLE stores ADD COLUMN IF NOT EXISTS campaign_ids VARCHAR",
        "ALTER TABLE products ADD COLUMN IF NOT EXISTS name_embedding TEXT",
        "ALTER TABLE supplier_prices ADD COLUMN IF NOT EXISTS name_embedding TEXT",
        "ALTER TABLE stores ADD COLUMN IF NOT EXISTS auto_promo_sync BOOLEAN DEFAULT FALSE",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_price_is_manual BOOLEAN DEFAULT FALSE",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_price_matched FLOAT",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS ym_status VARCHAR",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipment_date DATE",
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_breakdown TEXT",
    ]
    with engine.connect() as conn:
        for sql in migrations:
            try:
                conn.execute(text(sql))
                conn.commit()
            except Exception:
                conn.rollback()  # сбрасываем aborted-транзакцию PostgreSQL


def _seed_stores():
    default_roi = float(os.getenv("DEFAULT_ROI", "0.2"))
    tax_rate = float(os.getenv("TAX_RATE", "0.06"))

    db = SessionLocal()
    try:
        for store_id, name in [(1, "yam16"), (2, "yam21")]:
            existing = db.query(Store).filter(Store.id == store_id).first()
            if not existing:
                db.add(Store(
                    id=store_id,
                    name=name,
                    platform="Yandex Market",
                    default_roi=default_roi,
                    tax_rate=tax_rate,
                ))
        db.commit()
    finally:
        db.close()
