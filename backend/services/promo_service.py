"""
Сервис синхронизации товаров с акциями Яндекс Маркета.

Логика (per SKU, per прomo):
  - get_promo_offers возвращает ВСЕ офферы акции с полем status:
      PARTICIPATING      — уже в акции
      NOT_PARTICIPATING  — eligible, но ещё не добавлен

  Для PARTICIPATING:
    - catalog_price > max_promo_price → удаляем из акции (нельзя участвовать без убытка)
    - catalog_price ≤ max_promo_price → обновляем promo_price = catalog_price
      (если ЯМ отклоняет — удаляем)

  Для NOT_PARTICIPATING (eligible):
    - catalog_price ≤ max_promo_price → добавляем по каталожной цене
    - catalog_price > max_promo_price → пропускаем

Фильтрация акций:
  - participating=True → обрабатываем (уже в акции, нужно синкать цены)
  - participating=False + акция уже началась (dateTimeFrom ≤ now ≤ dateTimeTo) → обрабатываем (можно добавить)
  - участие=False + акция ещё не началась → пропускаем (UPCOMING)
"""

import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Коды ошибок ЯМ, при которых нужно удалять товар из акции
_REMOVE_ERRORS = {
    "MAX_PROMO_PRICE_EXCEEDED",
    "PROMO_PRICE_BIGGER_THAN_MAX",
    "PROMO_PRICE_SMALLER_THAN_MIN",
    "DEADLINE_FOR_FOCUS_PROMOS_EXCEEDED",
    "OFFER_NOT_ELIGIBLE_FOR_PROMO",
}


def _make_price_obj(value: float) -> Dict[str, Any]:
    return {"value": int(round(value)), "currencyId": "RUR"}


def _promo_is_active_or_participating(promo: Dict[str, Any]) -> bool:
    """True если акция сейчас активна ИЛИ мы в ней уже участвуем."""
    if promo.get("participating"):
        return True
    period = promo.get("period") or {}
    dt_from_str = period.get("dateTimeFrom")
    dt_to_str = period.get("dateTimeTo")
    if not dt_from_str or not dt_to_str:
        return False
    try:
        now = datetime.now(timezone.utc)
        dt_from = datetime.fromisoformat(dt_from_str)
        dt_to = datetime.fromisoformat(dt_to_str)
        # Приводим к UTC если нужно
        if dt_from.tzinfo is None:
            dt_from = dt_from.replace(tzinfo=timezone.utc)
        if dt_to.tzinfo is None:
            dt_to = dt_to.replace(tzinfo=timezone.utc)
        return dt_from <= now <= dt_to
    except Exception:
        return False


def _fmt_period(promo: Dict[str, Any]) -> str:
    period = promo.get("period") or {}
    df = period.get("dateTimeFrom", "")
    dt = period.get("dateTimeTo", "")
    try:
        df = datetime.fromisoformat(df).strftime("%d.%m")
        dt = datetime.fromisoformat(dt).strftime("%d.%m.%Y")
        return f"{df}–{dt}"
    except Exception:
        return f"{df} – {dt}"


def _get_currently_in_promo_skus(store_id: int, db) -> set:
    """Возвращает множество SKU, у которых последнее действие в promo_log = ADDED или PRICE_UPDATED."""
    from sqlalchemy import text
    rows = db.execute(text("""
        SELECT DISTINCT l.sku
        FROM promo_sync_log l
        JOIN (
            SELECT sku, store_id, MAX(timestamp) AS max_ts
            FROM promo_sync_log
            WHERE store_id = :sid
            GROUP BY sku, store_id
        ) latest ON l.sku = latest.sku AND l.store_id = latest.store_id AND l.timestamp = latest.max_ts
        WHERE l.action IN ('ADDED', 'PRICE_UPDATED') AND l.store_id = :sid
    """), {"sid": store_id}).fetchall()
    return {row[0] for row in rows}


def sync_promos_for_store(
    client,
    business_id: int,
    store_id: int,
    sku_prices: Dict[str, float],  # sku → новая каталожная цена
    old_prices: Dict[str, Optional[float]],  # sku → старая цена (может быть None)
    db,
) -> List[Dict[str, Any]]:
    from models.promo_sync_log import PromoSyncLog

    log_entries: List[Dict[str, Any]] = []

    logger.warning("[promo_sync] store_id=%s business_id=%s | Старт. SKU в пересчёте: %d",
                store_id, business_id, len(sku_prices))

    if not sku_prices:
        return log_entries

    # Получаем SKU, которые сейчас считаются «в акции» по логу —
    # чтобы логировать REMOVED для тех, чьи акции закончились
    previously_in_promo = _get_currently_in_promo_skus(store_id, db)
    processed_in_active_promo: set = set()  # SKU, обработанные в ходе этого синка

    # 1. Получаем список акций
    try:
        promos = client.get_promos(business_id)
        logger.warning("[promo_sync] store_id=%s | Акций всего: %d → %s",
                    store_id, len(promos), [p.get("id") for p in promos])
    except Exception as e:
        logger.warning("[promo_sync] store_id=%s | get_promos ОШИБКА: %s", store_id, e)
        return log_entries

    if not promos:
        logger.warning("[promo_sync] store_id=%s | Активных акций нет", store_id)
        return log_entries

    for promo in promos:
        promo_id: str = promo.get("id", "")
        promo_name: str = promo.get("name", promo_id)
        promo_period: str = _fmt_period(promo)
        participating: bool = bool(promo.get("participating"))
        if not promo_id:
            continue

        # Фильтр: обрабатываем только активные акции или те, в которых уже участвуем
        if not _promo_is_active_or_participating(promo):
            logger.warning("[promo_sync] store_id=%s | ПРОПУСК акции %s (%s) %s — не активна и не участвуем",
                           store_id, promo_id, promo_name, promo_period)
            continue

        assortment = promo.get("assortmentInfo", {}) or {}
        logger.warning("[promo_sync] store_id=%s | === Акция: %s (%s) %s | participating=%s active=%s potential=%s ===",
                    store_id, promo_id, promo_name, promo_period,
                    participating, assortment.get("activeOffers"), assortment.get("potentialOffers"))

        time.sleep(0.3)

        # 2. Получаем ВСЕ офферы акции с их статусом (PARTICIPATING / NOT_PARTICIPATING)
        try:
            all_offers = client.get_promo_offers(business_id, promo_id)
            logger.warning("[promo_sync] store_id=%s promo=%s | Офферов от ЯМ: %d",
                           store_id, promo_id, len(all_offers))
        except Exception as e:
            logger.warning("[promo_sync] store_id=%s promo=%s | get_promo_offers ОШИБКА: %s",
                           store_id, promo_id, e)
            continue

        # Строим карты: sku → max_promo_price для каждого статуса
        # Фильтруем только те SKU, которые есть в нашем sku_prices
        participating_map: Dict[str, float] = {}   # sku → max_promo_price
        eligible_map: Dict[str, float] = {}         # sku → max_promo_price

        for offer in all_offers:
            sku = offer.get("offerId", "")
            if not sku or sku not in sku_prices:
                continue
            status = offer.get("status", "")
            params = offer.get("params", {}) or {}
            discount_params = params.get("discountParams", {}) or {}
            max_promo_price = discount_params.get("maxPromoPrice")
            if max_promo_price is None:
                continue
            max_promo_price = float(max_promo_price)

            if status in ("PARTICIPATING", "MANUAL", "AUTO"):
                participating_map[sku] = max_promo_price
            elif status == "NOT_PARTICIPATING":
                eligible_map[sku] = max_promo_price

        logger.warning("[promo_sync] store_id=%s promo=%s | Участвуют (наших): %d, eligible (наших): %d",
                    store_id, promo_id, len(participating_map), len(eligible_map))

        # 3. Обрабатываем участвующих
        to_update: List[Tuple[str, float]] = []   # (sku, new_promo_price)
        to_remove_direct: List[str] = []           # удалить сразу без попытки обновить

        # Трекаем все SKU этой акции как обработанные в активном промо
        for sku in participating_map:
            processed_in_active_promo.add(sku)
        for sku in eligible_map:
            processed_in_active_promo.add(sku)

        for sku, max_promo_price in participating_map.items():
            catalog_price = sku_prices[sku]
            old_catalog = old_prices.get(sku)

            if catalog_price > max_promo_price:
                logger.warning("[promo_sync] SKU=%s promo=%s | catalog=%s > maxPromo=%s → удаляем",
                            sku, promo_id, catalog_price, max_promo_price)
                to_remove_direct.append(sku)
                _append_log(log_entries, store_id, sku, promo_id, promo_name, "REMOVED",
                            old_catalog, catalog_price, max_promo_price, None,
                            f"catalog_price {catalog_price} > maxPromoPrice {max_promo_price}")
            else:
                logger.warning("[promo_sync] SKU=%s promo=%s | catalog=%s <= maxPromo=%s → обновляем",
                            sku, promo_id, catalog_price, max_promo_price)
                to_update.append((sku, catalog_price))

        # 4. Удаляем тех, кто сразу не проходит по цене
        if to_remove_direct:
            _try_delete(client, business_id, promo_id, to_remove_direct)

        # 5. Обновляем promo_price для участвующих (батчами по 500)
        for chunk in _chunks(to_update, 500):
            offers_payload = [
                {"offerId": sku, "price": _make_price_obj(new_price)}
                for sku, new_price in chunk
            ]
            try:
                time.sleep(0.3)
                result = client.update_promo_offers(business_id, promo_id, offers_payload)
                rejected = {
                    r["offerId"]: r.get("reason", "UNKNOWN")
                    for r in ((result.get("result") or {}).get("rejectedOffers") or [])
                }
                if rejected:
                    logger.warning("[promo_sync] store_id=%s promo=%s | ЯМ отклонил %d: %s",
                                store_id, promo_id, len(rejected), rejected)
                needs_discount_base: Dict[str, float] = {}  # sku → promo_price для retry через discountBase
                for sku, new_price in chunk:
                    old_catalog = old_prices.get(sku)
                    max_pp = participating_map[sku]
                    if sku in rejected:
                        reason = rejected[sku]
                        if reason == "EMPTY_OLD_PRICE":
                            # Нет зачёркнутой цены — ставим discountBase и ЯМ добавит автоматически
                            logger.warning("[promo_sync] SKU=%s | EMPTY_OLD_PRICE → ставим discountBase=%s", sku, max_pp)
                            needs_discount_base[sku] = new_price
                        elif reason in _REMOVE_ERRORS:
                            logger.warning("[promo_sync] SKU=%s | Отклонён (%s) → удаляем", sku, reason)
                            _try_delete(client, business_id, promo_id, [sku])
                            _append_log(log_entries, store_id, sku, promo_id, promo_name, "REMOVED",
                                        old_catalog, new_price, max_pp, None, reason)
                        else:
                            _append_log(log_entries, store_id, sku, promo_id, promo_name, "SKIPPED",
                                        old_catalog, new_price, max_pp, None, reason)

                # Для EMPTY_OLD_PRICE ставим discountBase = maxPromoPrice → ЯМ добавит AUTO
                if needs_discount_base:
                    db_bases = {sku: participating_map[sku] for sku in needs_discount_base}
                    try:
                        time.sleep(0.3)
                        client.update_prices_business_batch(business_id, needs_discount_base, sku_discount_bases=db_bases)
                        logger.warning("[promo_sync] promo=%s | EMPTY_OLD_PRICE: discountBase установлен для %d товаров", promo_id, len(needs_discount_base))
                        for sku, new_price in needs_discount_base.items():
                            _append_log(log_entries, store_id, sku, promo_id, promo_name, "ADDED",
                                        old_prices.get(sku), new_price, participating_map[sku], new_price, "via_discount_base")
                    except Exception as e:
                        logger.warning("[promo_sync] promo=%s | EMPTY_OLD_PRICE discountBase ОШИБКА: %s", promo_id, e)
                        for sku, new_price in needs_discount_base.items():
                            _append_log(log_entries, store_id, sku, promo_id, promo_name, "SKIPPED",
                                        old_prices.get(sku), new_price, participating_map.get(sku), None, str(e))
                    else:
                        logger.warning("[promo_sync] SKU=%s | Цена обновлена → %s", sku, new_price)
                        _append_log(log_entries, store_id, sku, promo_id, promo_name, "PRICE_UPDATED",
                                    old_catalog, new_price, max_pp, new_price, None)
            except Exception as e:
                logger.warning("[promo_sync] promo=%s | update ОШИБКА: %s", promo_id, e)
                for sku, new_price in chunk:
                    _append_log(log_entries, store_id, sku, promo_id, promo_name, "SKIPPED",
                                old_prices.get(sku), new_price, participating_map.get(sku), None, str(e))

        # 6. Добавляем eligible (NOT_PARTICIPATING) у которых catalog <= maxPromoPrice
        to_add: List[Tuple[str, float]] = []
        for sku, max_promo_price in eligible_map.items():
            catalog_price = sku_prices[sku]
            if catalog_price <= max_promo_price:
                logger.warning("[promo_sync] SKU=%s promo=%s | eligible, catalog=%s <= maxPromo=%s → добавляем",
                            sku, promo_id, catalog_price, max_promo_price)
                to_add.append((sku, catalog_price))
            else:
                logger.warning("[promo_sync] SKU=%s promo=%s | eligible, catalog=%s > maxPromo=%s → пропуск",
                            sku, promo_id, catalog_price, max_promo_price)

        # 6б. Для eligible (NOT_PARTICIPATING) устанавливаем discountBase = maxPromoPrice.
        # ЯМ автоматически добавляет товар в акцию (статус AUTO) при наличии зачёркнутой цены.
        # update_promo_offers для них не нужен — он возвращает EMPTY_OLD_PRICE.
        if to_add:
            discount_bases = {sku: eligible_map[sku] for sku, _ in to_add}
            add_prices = {sku: price for sku, price in to_add}
            try:
                time.sleep(0.3)
                client.update_prices_business_batch(
                    business_id, add_prices, sku_discount_bases=discount_bases
                )
                logger.warning("[promo_sync] promo=%s | discountBase установлен для %d товаров → ЯМ добавит автоматически",
                               promo_id, len(to_add))
                for sku, price in to_add:
                    _append_log(log_entries, store_id, sku, promo_id, promo_name, "ADDED",
                                old_prices.get(sku), price, eligible_map[sku], price, None)
            except Exception as e:
                logger.warning("[promo_sync] promo=%s | Ошибка установки discountBase: %s", promo_id, e)
                for sku, price in to_add:
                    _append_log(log_entries, store_id, sku, promo_id, promo_name, "SKIPPED",
                                old_prices.get(sku), price, eligible_map.get(sku), None, str(e))

        logger.warning("[promo_sync] store_id=%s promo=%s | Итог: REMOVED=%d PRICE_UPDATED=%d ADDED=%d SKIPPED=%d",
                    store_id, promo_id,
                    sum(1 for e in log_entries if e["action"] == "REMOVED" and e["promo_id"] == promo_id),
                    sum(1 for e in log_entries if e["action"] == "PRICE_UPDATED" and e["promo_id"] == promo_id),
                    sum(1 for e in log_entries if e["action"] == "ADDED" and e["promo_id"] == promo_id),
                    sum(1 for e in log_entries if e["action"] == "SKIPPED" and e["promo_id"] == promo_id))

    # 7. Логируем REMOVED для SKU, которые были «в акции» по логу, но не попали ни в одну активную акцию
    # (акции истекли естественным образом без нашего вмешательства)
    expired_skus = previously_in_promo - processed_in_active_promo
    if expired_skus:
        logger.warning("[promo_sync] store_id=%s | SKU из истёкших акций (→ REMOVED): %d", store_id, len(expired_skus))
        for sku in expired_skus:
            _append_log(log_entries, store_id, sku, "EXPIRED", "Акция завершена", "REMOVED",
                        old_prices.get(sku), sku_prices.get(sku), None, None, "promo_expired")

    # 8. Сохраняем лог
    try:
        for entry in log_entries:
            db.add(PromoSyncLog(**entry))
        db.flush()
        logger.warning("[promo_sync] store_id=%s | Лог сохранён: %d записей", store_id, len(log_entries))
    except Exception as e:
        logger.warning("[promo_sync] store_id=%s | Ошибка сохранения лога: %s", store_id, e)

    return log_entries


def _try_delete(client, business_id: int, promo_id: str, offer_ids: List[str]) -> None:
    try:
        time.sleep(0.2)
        client.delete_promo_offers(business_id, promo_id, offer_ids)
        logger.warning("[promo_sync] delete_promo_offers promo=%s | Удалено: %s", promo_id, offer_ids)
    except Exception as e:
        logger.warning("[promo_sync] delete_promo_offers promo=%s ОШИБКА: %s", promo_id, e)


def _append_log(entries, store_id, sku, promo_id, promo_name, action,
                old_catalog_price, new_catalog_price,
                old_promo_price, new_promo_price, reason):
    entries.append({
        "store_id": store_id,
        "sku": sku,
        "promo_id": promo_id,
        "promo_name": promo_name,
        "action": action,
        "old_catalog_price": old_catalog_price,
        "new_catalog_price": new_catalog_price,
        "old_promo_price": old_promo_price,
        "new_promo_price": new_promo_price,
        "reason": reason,
    })


def _chunks(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]
