import asyncio
import logging
import random

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from database.db import SessionLocal
from services.assortment_service import sync_assortment
from utils.settings import get_setting

logger = logging.getLogger(__name__)


def _get_stores_from_db() -> list[tuple[int, str]]:
    """Возвращает список (store_id, store_name) из БД."""
    from models.store import Store
    db = SessionLocal()
    try:
        stores = db.query(Store.id, Store.name).all()
        return [(s.id, s.name) for s in stores]
    except Exception:
        logger.exception("Не удалось загрузить магазины из БД")
        return []
    finally:
        db.close()


def _sync_store_sync(store_id: int, store_name: str) -> int:
    from datetime import datetime, timezone
    from models.store import Store
    db = SessionLocal()
    try:
        count = sync_assortment(store_name, store_id, db)
        store = db.query(Store).filter(Store.id == store_id).first()
        if store:
            store.last_sync_at = datetime.now(timezone.utc)
            db.commit()
        logger.info("Синхронизировано %d товаров для %s", count, store_name)
        return count
    except Exception:
        logger.exception("Ошибка синхронизации %s", store_name)
        return 0
    finally:
        db.close()


async def run_sequential_sync() -> None:
    """
    Синхронизирует магазины последовательно в случайном порядке.
    Перед стартом — случайный jitter, между магазинами — случайная пауза.
    Настройки читаются из settings.json в момент запуска.
    """
    loop = asyncio.get_event_loop()

    start_jitter_max = int(get_setting("sync_start_jitter_max"))
    inter_min = int(get_setting("sync_inter_store_delay_min"))
    inter_max = int(get_setting("sync_inter_store_delay_max"))

    start_jitter = random.randint(0, start_jitter_max)
    if start_jitter > 0:
        logger.info("Jitter перед синхронизацией: %d сек", start_jitter)
        await asyncio.sleep(start_jitter)

    stores = _get_stores_from_db()
    if not stores:
        logger.warning("Нет магазинов для синхронизации")
        return

    random.shuffle(stores)
    logger.info("Порядок синхронизации: %s", [s[1] for s in stores])

    for i, (store_id, store_name) in enumerate(stores):
        logger.info("Старт синхронизации %s", store_name)
        await loop.run_in_executor(None, _sync_store_sync, store_id, store_name)
        await loop.run_in_executor(None, _sync_orders_auto, store_id, store_name)
        await loop.run_in_executor(None, _sync_active_orders_auto, store_id, store_name)

        if i < len(stores) - 1:
            delay = random.randint(inter_min, inter_max)
            logger.info("Пауза %d сек перед следующим магазином", delay)
            await asyncio.sleep(delay)


def _sync_orders_auto(store_id: int, store_name: str) -> None:
    """Синхронизирует заказы за последние 30 дней для одного магазина."""
    from datetime import date, timedelta
    from services.orders_service import sync_orders_for_store

    date_to = date.today()
    date_from = date_to - timedelta(days=30)
    db = SessionLocal()
    try:
        result = sync_orders_for_store(store_id, store_name, date_from, date_to, db)
        logger.info("[orders_auto] %s — синхронизировано заказов: %s", store_name, result)
    except Exception:
        logger.exception("[orders_auto] Ошибка синхронизации заказов для %s", store_name)
    finally:
        db.close()


def _sync_active_orders_auto(store_id: int, store_name: str) -> None:
    """Синхронизирует активные заказы (PROCESSING/DELIVERY/PICKUP) из ЯМ API."""
    from services.orders_service import sync_active_orders_for_store
    db = SessionLocal()
    try:
        result = sync_active_orders_for_store(store_id, store_name, db)
        logger.info("[active_orders_auto] %s — активных заказов: %s", store_name, result)
    except Exception:
        logger.exception("[active_orders_auto] Ошибка для %s", store_name)
    finally:
        db.close()


def _run_promo_sync_for_store(store_id: int, store_name: str) -> None:
    """Запускает promo sync для одного магазина — используя текущие цены из БД."""
    from models.product import Product
    from models.store import Store
    from services.promo_service import sync_promos_for_store
    from services.yam_client import get_client_for_store

    db = SessionLocal()
    try:
        store = db.query(Store).filter(Store.id == store_id).first()
        if not store or not store.auto_promo_sync:
            logger.warning("[promo_daily] store_id=%s — auto_promo_sync выключен, пропуск", store_id)
            return

        try:
            client, business_id, _ = get_client_for_store(store_name, db)
        except Exception as e:
            logger.warning("[promo_daily] store_id=%s — не удалось получить credentials: %s", store_id, e)
            return

        products = db.query(Product).filter(
            Product.store_id == store_id,
            Product.enabled == True,
            Product.price != None,
        ).all()

        if not products:
            logger.warning("[promo_daily] store_id=%s — нет enabled товаров с ценой", store_id)
            return

        sku_prices = {p.sku: p.price for p in products if p.price}
        old_prices = {p.sku: p.price for p in products if p.price}

        logger.warning("[promo_daily] store_id=%s store=%s | Старт синка акций. Товаров: %d",
                       store_id, store_name, len(sku_prices))
        sync_promos_for_store(client, business_id, store_id, sku_prices, old_prices, db)
        db.commit()
        logger.warning("[promo_daily] store_id=%s | Синк акций завершён", store_id)
    except Exception:
        logger.exception("[promo_daily] store_id=%s — ошибка", store_id)
    finally:
        db.close()


async def run_daily_promo_sync() -> None:
    """Ежедневный синк акций для всех магазинов с auto_promo_sync=True."""
    loop = asyncio.get_event_loop()
    stores = _get_stores_from_db()
    if not stores:
        logger.warning("[promo_daily] Нет магазинов в БД")
        return

    for i, (store_id, store_name) in enumerate(stores):
        await loop.run_in_executor(None, _run_promo_sync_for_store, store_id, store_name)
        if i < len(stores) - 1:
            delay = random.randint(300, 600)  # 5–10 минут между магазинами
            logger.warning("[promo_daily] Пауза %d сек перед следующим магазином", delay)
            await asyncio.sleep(delay)


def reschedule_sync(scheduler: AsyncIOScheduler) -> None:
    """Пересоздаёт задачу с актуальными интервалами из settings."""
    interval_min = int(get_setting("sync_interval_min"))
    interval_max = int(get_setting("sync_interval_max"))
    mid = (interval_min + interval_max) // 2
    jitter = (interval_max - interval_min) // 2

    scheduler.add_job(
        run_sequential_sync,
        IntervalTrigger(seconds=mid, jitter=jitter),
        id="sync_assortment",
        replace_existing=True,
    )
    logger.info("Переплановано: каждые %d±%d сек", mid, jitter)


def create_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler()
    reschedule_sync(scheduler)
    # Ежедневный синк акций — каждый день в 10:00 МСК (UTC+3 → 07:00 UTC)
    scheduler.add_job(
        run_daily_promo_sync,
        CronTrigger(hour=7, minute=0, timezone="UTC"),
        id="daily_promo_sync",
        replace_existing=True,
    )
    logger.info("Ежедневный синк акций: каждый день в 10:00 МСК")
    return scheduler
