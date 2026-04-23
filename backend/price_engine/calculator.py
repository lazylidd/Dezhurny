import threading
import time
from typing import Any, Dict, List, Optional, Tuple

# Глобальный rate-limiter: не более 1 запроса к /tariffs/calculate в секунду
_tariff_lock = threading.Lock()
_tariff_last_call: List[float] = [0.0]

def _throttled_calculate_tariffs(client, **kwargs):
    with _tariff_lock:
        elapsed = time.monotonic() - _tariff_last_call[0]
        if elapsed < 1.0:
            time.sleep(1.0 - elapsed)
        _tariff_last_call[0] = time.monotonic()
    return client.calculate_tariffs(**kwargs)


PAYOUT_FREQUENCY_OPTIONS = [
    ("MONTHLY",   "Раз в неделю с отсрочкой на 4 недели — 1.6%"),
    ("BIWEEKLY",  "Раз в неделю с отсрочкой на 2 недели — 2.3%"),
    ("WEEKLY",    "Раз в неделю с отсрочкой на 1 неделю — 2.8%"),
    ("DAILY",     "Ежедневно — 3.3%"),
]

SELLING_PROGRAM_OPTIONS = ["FBS", "FBY"]


def _tariffs_total(tariffs: List[Dict[str, Any]], fee_discount_pp: float, price: float) -> float:
    """Суммирует все тарифы, применяя скидку за раннюю отгрузку к тарифу FEE."""
    total = 0.0
    fee_amount = 0.0
    for t in tariffs:
        ttype = (t.get("type") or "").upper()
        amt = float(t.get("amount") or 0.0)
        total += amt
        if ttype == "FEE":
            fee_amount += amt
    if fee_discount_pp > 0 and fee_amount > 0:
        total -= price * (fee_discount_pp / 100.0)
    return total


def calculate_shelf_price(
    client: Any,
    product: Any,
    supplier_price: float,
    store: Any,
    tariff_cache: Dict | None = None,
) -> Tuple[Optional[float], Optional[str], Optional[List[Dict]], Optional[float]]:
    """
    Рассчитывает розничную цену за ОДИН вызов API.

    Алгоритм:
    1. Вычисляем оценочную цену через commission из БД (уже близко к ответу).
    2. Один запрос к ЯМ API при оценочной цене → получаем все издержки в рублях.
    3. effective_rate = total_costs / estimated_price  (трактуем все издержки как % от цены).
    4. Аналитическое решение:
           shelf_price = supplier_price × (1 + roi) / (1 − effective_rate − tax_rate)

    Точность: фиксированные тарифы (доставка) слегка аппроксимируются как %,
    но погрешность мала (~5–15 руб), т.к. оценка уже близка к реальной цене.

    tariff_cache — shared dict между товарами.
    Ключ: (category_id, price_bucket_500, length, width, height, weight).
    Бакет 500 руб → высокая вероятность cache hit между товарами одной категории.
    """
    dims = [product.weight, product.length, product.width, product.height]
    has_dims = all(v is not None and v > 0 for v in dims)
    has_category = bool(product.category_id)

    # Fallback: нет габаритов или категории → используем commission из БД (нет API-запроса)
    if not has_dims or not has_category:
        commission_raw = product.commission
        if commission_raw is None:
            return None, "Нет габаритов и нет комиссии в БД — выполните синхронизацию ассортимента", None, None
        # В БД хранится процент (33.0 = 33%), нормализуем в долю
        commission = commission_raw / 100.0 if commission_raw > 1 else commission_raw
        target_roi = product.roi if product.roi is not None else (store.default_roi or 0.20)
        tax_rate = store.tax_rate or 0.06
        denom = 1.0 - commission - tax_rate
        if denom <= 0:
            return None, f"Комиссия ({commission:.0%}) + налог ({tax_rate:.0%}) ≥ 100%", None, None
        shelf_price = supplier_price * (1 + target_roi) / denom
        return round(shelf_price, 2), None, None, commission  # tariffs=None, effective_rate=commission (дробь)

    try:
        category_id = int(product.category_id)
    except (ValueError, TypeError):
        return None, f"Некорректный category_id: {product.category_id}", None, None

    target_roi = product.roi if product.roi is not None else (store.default_roi or 0.20)
    tax_rate = store.tax_rate or 0.06
    fee_discount_pp = store.early_ship_discount or 0.0
    selling_program = store.selling_program or "FBS"
    payout_frequency = store.payout_frequency or "MONTHLY"

    _cache = tariff_cache if tariff_cache is not None else {}

    # ── Шаг 1: оценочная цена через commission из БД ──────────────────────────
    # В БД хранится процент (33.0 = 33%), нормализуем в долю
    comm_raw = product.commission
    est_commission = (comm_raw / 100.0 if comm_raw and comm_raw > 1 else comm_raw) or 0.15
    # Формула: shelf = supplier * (1 + roi) / (1 - commission - tax)
    est_denom = 1.0 - est_commission - tax_rate
    estimated_price = supplier_price * (1 + target_roi) / est_denom if est_denom > 0 else supplier_price * 3

    # ── Шаг 2: один запрос к API (с кэшем) ────────────────────────────────────
    # Бакет 500 руб: товары с похожей ценой в одной категории разделяют ответ
    bucket = int(round(estimated_price / 1000)) * 1000
    key = (category_id, bucket, product.length, product.width, product.height, product.weight)

    if key not in _cache:
        _cache[key] = _throttled_calculate_tariffs(
            client,
            selling_program=selling_program,
            category_id=category_id,
            price=estimated_price,
            length_cm=product.length,
            width_cm=product.width,
            height_cm=product.height,
            weight_kg=product.weight,
            frequency=payout_frequency,
        )
    tariffs = _cache[key]

    # ── Шаг 3: effective_rate ──────────────────────────────────────────────────
    total_costs = _tariffs_total(tariffs, fee_discount_pp, estimated_price)
    if estimated_price <= 0:
        return None, "Некорректная оценочная цена", None, None

    effective_rate = total_costs / estimated_price

    # ── Шаг 4: аналитическое решение ──────────────────────────────────────────
    denom = 1.0 - effective_rate - tax_rate
    if denom <= 0:
        return None, (
            f"Издержки ЯМ ({effective_rate:.0%}) + налог ({tax_rate:.0%}) ≥ 100% — "
            "цена не может покрыть расходы"
        ), None, None

    shelf_price = supplier_price * (1 + target_roi) / denom

    if shelf_price <= supplier_price:
        return None, f"Целевой ROI {target_roi:.0%} недостижим: полученная цена ниже закупки", None, None

    return round(shelf_price, 2), None, tariffs, effective_rate
