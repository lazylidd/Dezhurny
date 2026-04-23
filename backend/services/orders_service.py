from __future__ import annotations

import io
import json
import logging
import time
from datetime import datetime, date as date_type
from typing import Any, Dict, List, Optional

import warnings
import pandas as pd
from sqlalchemy import func as sqlfunc
from sqlalchemy.orm import Session

from models.order import Order
from models.product import Product
from models.product_match import ProductMatch
from models.store import Store
from services.yam_client import get_client_for_store

logger = logging.getLogger(__name__)

warnings.filterwarnings("ignore", category=UserWarning, module="openpyxl.styles.stylesheet")


def _parse_ym_date(raw: str) -> Optional[date_type]:
    """Парсит дату из YM API (DD-MM-YYYY или DD-MM-YYYY HH:MM:SS или YYYY-MM-DD) → date."""
    raw = raw.strip()
    # DD-MM-YYYY HH:MM:SS (19 chars) или DD-MM-YYYY (10 chars)
    if len(raw) >= 10 and raw[2:3] == "-" and raw[5:6] == "-":
        for fmt, length in [("%d-%m-%Y %H:%M:%S", 19), ("%d-%m-%Y", 10)]:
            try:
                return datetime.strptime(raw[:length], fmt).date()
            except ValueError:
                pass
    # YYYY-MM-DD (ISO)
    if len(raw) >= 10:
        try:
            return datetime.strptime(raw[:10], "%Y-%m-%d").date()
        except ValueError:
            pass
    return None


# ---------- ПАРСЕР ----------

def _normalize_col(col: Any) -> str:
    s = str(col).strip()
    if "/" in s:
        s = s.split("/", 1)[1].strip()
    return s


def _find_col(columns: List[Any], substring: str) -> Optional[str]:
    sub_l = substring.lower()
    for col in columns:
        if sub_l in _normalize_col(col).lower():
            return col
    return None


def _build_header(df_raw: pd.DataFrame) -> Optional[pd.DataFrame]:
    if df_raw is None or df_raw.empty:
        return None
    header_idx = None
    for i in range(min(30, df_raw.shape[0])):
        if df_raw.iloc[i].astype(str).str.contains("Номер заказа", case=False, na=False).any():
            header_idx = i
            break
    if header_idx is None:
        if df_raw.shape[0] < 2:
            return None
        top, second = df_raw.iloc[0].fillna(""), df_raw.iloc[1].fillna("")
        cols = [
            f"{str(t).strip()}/{str(s).strip()}" if (str(t).strip() and str(s).strip())
            else (str(s).strip() or str(t).strip())
            for t, s in zip(top, second)
        ]
        df = df_raw.iloc[2:].copy()
        df.columns = cols
        return df
    top_idx = max(0, header_idx - 1)
    top = df_raw.iloc[top_idx].fillna("")
    second = df_raw.iloc[header_idx].fillna("")
    cols = [
        f"{str(t).strip()}/{str(s).strip()}" if (str(t).strip() and str(s).strip())
        else (str(s).strip() or str(t).strip())
        for t, s in zip(top, second)
    ]
    df = df_raw.iloc[header_idx + 1:].copy()
    df.columns = cols
    return df


def _build_promo_discount_map(xls: pd.ExcelFile) -> Dict[str, float]:
    """
    Читает лист 'Транзакции по заказам и товарам' и возвращает
    маппинг order_id -> сумма 'Другие скидки маркета' (скидка за совместные акции).
    """
    sheet_name = next(
        (n for n in xls.sheet_names
         if "транзакции по заказам и товарам" in str(n).lower()
         or "транзакции по заказам" in str(n).lower()
         or "orders_and_offers_transactions" in str(n).lower()),
        None,
    )
    if not sheet_name:
        return {}
    try:
        df_raw = xls.parse(sheet_name, header=None)
    except Exception:
        return {}
    df = _build_header(df_raw)
    if df is None or df.empty:
        return {}
    cols = list(df.columns)
    order_col = _find_col(cols, "номер заказа")
    disc_col = _find_col(cols, "другие скидки маркета")
    if not (order_col and disc_col):
        return {}
    sub = df[[order_col, disc_col]].copy()
    sub.columns = ["order_id", "discount"]
    sub["order_id"] = sub["order_id"].astype(str).str.strip().str.replace(r"\.0$", "", regex=True)
    sub["discount"] = pd.to_numeric(sub["discount"], errors="coerce").fillna(0.0)
    sub = sub[(sub["order_id"] != "") & (sub["order_id"].str.lower() != "nan")]
    result: Dict[str, float] = {}
    for oid, val in sub.groupby("order_id")["discount"].sum().items():
        result[str(oid)] = float(val)
    return result


def _build_order_offer_map(xls: pd.ExcelFile) -> Dict[str, str]:
    """
    Читает лист 'Транзакции по заказам и товарам' и возвращает
    маппинг order_id -> offer_name (первый встреченный товар).
    """
    sheet_name = next(
        (n for n in xls.sheet_names
         if "транзакции по заказам и товарам" in str(n).lower()
         or "транзакции по заказам" in str(n).lower()
         or "orders_and_offers_transactions" in str(n).lower()),
        None,
    )
    if not sheet_name:
        return {}
    try:
        df_raw = xls.parse(sheet_name, header=None)
    except Exception:
        return {}
    df = _build_header(df_raw)
    if df is None or df.empty:
        return {}
    cols = list(df.columns)
    order_col = _find_col(cols, "номер заказа")
    offer_col = _find_col(cols, "название товара")
    if not (order_col and offer_col):
        return {}
    sub = df[[order_col, offer_col]].dropna(subset=[order_col, offer_col]).copy()
    sub.columns = ["order_id", "offer_name"]
    sub["order_id"] = sub["order_id"].astype(str).str.strip().str.replace(r"\.0$", "", regex=True)
    sub["offer_name"] = sub["offer_name"].astype(str).str.strip()
    sub = sub[(sub["order_id"] != "") & (sub["order_id"].str.lower() != "nan")
              & (sub["offer_name"] != "") & (sub["offer_name"].str.lower() != "nan")]
    result: Dict[str, str] = {}
    for _, row in sub.iterrows():
        oid = str(row["order_id"])
        if oid not in result:
            result[oid] = str(row["offer_name"])
    return result


def _parse_marketplace_services_bonus(content: bytes) -> Dict[str, float]:
    """
    Парсит отчёт united-marketplace-services и возвращает {order_id: bonus_deducted}.
    bonus_deducted = gross_fee - net_fee из листа 'Размещение товаров на витрине'.
    """
    try:
        xls = pd.ExcelFile(io.BytesIO(content), engine="openpyxl")
    except Exception as e:
        logger.error("Ошибка открытия marketplace-services XLSX: %s", e)
        return {}

    sheet_name = next(
        (n for n in xls.sheet_names if "размещение" in str(n).lower()),
        None,
    )
    if not sheet_name:
        logger.warning("Лист 'Размещение' не найден. Доступные: %s", xls.sheet_names)
        return {}

    try:
        df_raw = xls.parse(sheet_name, header=None)
    except Exception as e:
        logger.error("Ошибка чтения листа размещения: %s", e)
        return {}

    # Ищем строку с заголовками (содержит "Номер заказа")
    header_idx = None
    for i in range(min(20, df_raw.shape[0])):
        row_str = df_raw.iloc[i].astype(str).str.lower()
        if row_str.str.contains("номер заказа").any():
            header_idx = i
            break
    if header_idx is None:
        logger.warning("Заголовок 'Номер заказа' не найден в листе размещения")
        return {}

    df = df_raw.iloc[header_idx + 1:].copy()
    df.columns = df_raw.iloc[header_idx].values

    # Ищем нужные колонки
    cols = [str(c) for c in df.columns]
    order_col_idx = next((i for i, c in enumerate(cols) if "номер заказа" in c.lower()), None)
    gross_col_idx = next((i for i, c in enumerate(cols) if "без скидок" in c.lower() and "стоимость" in c.lower()), None)
    net_col_idx = next((i for i, c in enumerate(cols) if "стоимость услуги" in c.lower() and "без скидок" not in c.lower() and "=" in c), None)

    if order_col_idx is None or gross_col_idx is None or net_col_idx is None:
        logger.warning("Нужные колонки не найдены: order=%s gross=%s net=%s", order_col_idx, gross_col_idx, net_col_idx)
        return {}

    result: Dict[str, float] = {}
    for _, row in df.iterrows():
        try:
            oid = str(row.iloc[order_col_idx]).strip().replace(".0", "")
            if not oid or oid.lower() == "nan":
                continue
            gross = float(row.iloc[gross_col_idx]) if pd.notna(row.iloc[gross_col_idx]) else 0.0
            net = float(row.iloc[net_col_idx]) if pd.notna(row.iloc[net_col_idx]) else 0.0
            bonus = round(gross - net, 2)
            if bonus > 0:
                # Если заказ уже есть — суммируем (несколько строк на заказ с разными SKU)
                result[oid] = round(result.get(oid, 0.0) + bonus, 2)
        except Exception:
            continue

    logger.info("marketplace-services bonus: %d заказов с bonus_deducted", len(result))
    return result


def _parse_united_orders_bytes(content: bytes) -> List[Dict[str, Any]]:
    """Парсит XLSX united_orders из bytes. Возвращает список строк-заказов."""
    try:
        xls = pd.ExcelFile(io.BytesIO(content), engine="openpyxl")
    except Exception as e:
        logger.error("Ошибка открытия XLSX: %s", e)
        return []

    sheet_name = next(
        (n for n in xls.sheet_names if "услуги и маржа по заказам" in str(n).lower()),
        None,
    )
    if not sheet_name:
        logger.error("Лист 'Услуги и маржа по заказам' не найден. Доступные: %s", xls.sheet_names)
        return []

    try:
        df_raw = xls.parse(sheet_name, header=None)
    except Exception as e:
        logger.error("Ошибка чтения листа: %s", e)
        return []

    df = _build_header(df_raw)
    if df is None or df.empty:
        logger.error("Не удалось построить заголовки")
        return []

    cols = list(df.columns)

    order_col = _find_col(cols, "номер заказа")
    offer_col = _find_col(cols, "название товара")
    status_col = _find_col(cols, "статус заказа")
    price_col = _find_col(cols, "цена продажи")
    buyer_col = _find_col(cols, "платёж покупателя") or _find_col(cols, "платеж покупателя")
    fees_col = _find_col(cols, "все услуги маркета за заказы")
    qty_col = _find_col(cols, "количество")

    # Детализация комиссий
    placement_col = _find_col(cols, "комиссия за размещение")
    logistics_col = (_find_col(cols, "логистика") or _find_col(cols, "приём и передача")
                     or _find_col(cols, "доставка до"))
    payment_col = _find_col(cols, "перевод платежа") or _find_col(cols, "эквайринг")
    # Баллы ЯМ (Яндекс Плюс баллы, списанные с продавца)
    bonus_col = (_find_col(cols, "баллы яндекс") or _find_col(cols, "баллы плюс")
                 or _find_col(cols, "яндекс плюс") or _find_col(cols, "баллы ")
                 or _find_col(cols, "списание баллов"))
    other_col = _find_col(cols, "прочие") or _find_col(cols, "другие услуги")

    order_date_col = None
    for c in cols:
        norm = _normalize_col(c).lower()
        if "дата" in norm and ("заказ" in norm or "отгруз" in norm):
            order_date_col = c
            break
    if not order_date_col:
        order_date_col = next((c for c in cols if "дата" in _normalize_col(c).lower()), None)

    # Защита от ложных совпадений: "баллы" может встретиться в названии колонки buyer_col
    # ("Платёж покупателя, не включает скидки Маркета и баллы Плюса, ₽")
    if bonus_col and bonus_col in (buyer_col, fees_col, price_col, order_col):
        bonus_col = None

    if not (order_col and status_col and price_col):
        logger.error("Базовые колонки не найдены. Доступные: %s", [str(c) for c in cols[:20]])
        return []

    detail_cols = [c for c in [placement_col, logistics_col, payment_col, bonus_col, other_col] if c]
    _seen: set = set()
    take = []
    for c in [order_col, offer_col, status_col, price_col, buyer_col, fees_col, order_date_col, qty_col] + detail_cols:
        if c and c not in _seen:
            _seen.add(c)
            take.append(c)
    sub = df[take].copy()

    rename: Dict[str, str] = {}
    if order_col: rename[order_col] = "order_id"
    if offer_col: rename[offer_col] = "offer_name"
    if status_col: rename[status_col] = "status"
    if price_col: rename[price_col] = "market_price"
    if buyer_col: rename[buyer_col] = "buyer_payment"
    if fees_col: rename[fees_col] = "all_services_fee"
    if order_date_col: rename[order_date_col] = "order_date"
    if qty_col: rename[qty_col] = "quantity"
    if placement_col: rename[placement_col] = "fee_placement"
    if logistics_col: rename[logistics_col] = "fee_logistics"
    if payment_col: rename[payment_col] = "fee_payment"
    if bonus_col: rename[bonus_col] = "fee_bonus"
    if other_col: rename[other_col] = "fee_other"
    sub = sub.rename(columns=rename)

    status_lower = sub["status"].astype(str).str.lower()
    mask = (
        status_lower.str.contains("доставлен")
        | status_lower.str.contains("невыкуп принят на складе")
        | status_lower.str.contains("полный возврат принят на складе")
    )
    sub = sub[mask]
    if sub.empty:
        logger.info("Нет строк со статусами доставлен/невыкуп/возврат")
        return []

    def _kind(s: str) -> str:
        s = str(s).lower()
        if "невыкуп" in s:
            return "nonpickup"
        if "возврат" in s:
            return "return"
        return "normal"

    def _ym_status(s: str) -> str:
        s = str(s).lower()
        if "невыкуп" in s:
            return "NONPICKUP"
        if "возврат" in s:
            return "RETURNED"
        return "DELIVERED"

    sub["order_kind"] = status_lower.apply(_kind)
    sub["ym_status"] = status_lower.apply(_ym_status)

    sub["order_id"] = sub["order_id"].astype(str).str.strip().str.replace(r"\.0$", "", regex=True)
    if "offer_name" in sub.columns:
        sub["offer_name"] = sub["offer_name"].astype(str).str.strip()
    else:
        sub["offer_name"] = ""

    sub = sub[(sub["order_id"] != "") & (sub["order_id"].str.lower() != "nan")]

    for col in ["market_price", "buyer_payment", "all_services_fee",
                "fee_placement", "fee_logistics", "fee_payment", "fee_bonus", "fee_other"]:
        if col in sub.columns:
            sub[col] = pd.to_numeric(sub[col], errors="coerce").fillna(0.0)
        else:
            sub[col] = 0.0

    # Fallback: если offer_name не нашлось в основном листе — тянем из транзакций
    order_to_offer = _build_order_offer_map(xls)
    logger.info("Маппинг order→offer из транзакций: %d записей", len(order_to_offer))

    # Скидки за совместные акции из транзакций
    promo_discount_map = _build_promo_discount_map(xls)
    logger.info("Скидки за акции: %d записей", len(promo_discount_map))

    rows: List[Dict[str, Any]] = []
    for _, row in sub.iterrows():
        order_date = None
        if "order_date" in row.index:
            try:
                dt = pd.to_datetime(row["order_date"], dayfirst=True, errors="coerce")
                if not pd.isna(dt):
                    order_date = dt.date()
            except Exception:
                pass

        oid = str(row["order_id"])
        offer_name = str(row.get("offer_name", "")).strip()
        if not offer_name or offer_name.lower() == "nan":
            offer_name = order_to_offer.get(oid, "")

        try:
            qty = int(float(row["quantity"])) if "quantity" in row.index and not pd.isna(row["quantity"]) else 1
        except Exception:
            qty = 1
        # Детальная разбивка комиссий из excel (значения хранятся отрицательными → abs)
        breakdown: Dict[str, float] = {}
        for key in ["fee_placement", "fee_logistics", "fee_payment", "fee_bonus", "fee_other"]:
            val = float(row.get(key, 0.0))
            if val != 0.0:
                breakdown[key] = abs(val)

        rows.append({
            "order_id": oid,
            "offer_name": offer_name,
            "market_price": float(row.get("market_price", 0.0)),
            "buyer_payment": float(row.get("buyer_payment", 0.0)),
            "all_services_fee": float(row.get("all_services_fee", 0.0)),
            "order_kind": str(row.get("order_kind", "normal")),
            "ym_status": str(row.get("ym_status", "DELIVERED")),
            "order_date": order_date,
            "promo_discount": promo_discount_map.get(oid),
            "quantity": qty,
            "fee_breakdown": breakdown,
        })

    logger.info("Распарсили %d строк из united_orders", len(rows))
    return rows


# ---------- СКАЧИВАНИЕ ОТЧЁТА ----------

def _generate_and_download_report(
    client,
    business_id: int,
    date_from: str,
    date_to: str,
    report_type: str = "united-orders",
) -> bytes:
    """Генерирует отчёт ЯМ, ждёт готовности, скачивает и возвращает содержимое."""
    data = client._request(
        "POST",
        f"/v2/reports/{report_type}/generate",
        json_body={"businessId": business_id, "dateFrom": date_from, "dateTo": date_to},
    )
    report_id = data["result"]["reportId"]
    logger.info("Отчёт %s создан: %s", report_type, report_id)

    for attempt in range(90):  # до 15 минут
        time.sleep(10)
        try:
            info = client._request("GET", f"/v2/reports/info/{report_id}")
            status = info.get("result", {}).get("status", "")
            logger.debug("Статус отчёта %s: %s (попытка %d)", report_id, status, attempt + 1)
            if status == "DONE":
                file_url = info["result"]["file"]
                logger.info("Отчёт готов, скачиваем: %s", file_url)
                r = client.session.get(file_url, headers=client._headers(), timeout=120)
                r.raise_for_status()
                return r.content
            if status == "FAILED":
                raise RuntimeError(f"Отчёт {report_id} завершился со статусом FAILED: {info}")
        except RuntimeError:
            raise
        except Exception as e:
            logger.warning("Ошибка проверки статуса (попытка %d): %s", attempt + 1, e)

    raise RuntimeError(f"Отчёт {report_id} не был готов в течение 15 минут")


# ---------- ОСНОВНАЯ ФУНКЦИЯ СИНХРОНИЗАЦИИ ----------

def sync_orders_for_store(
    store_id: int,
    store_name: str,
    date_from: str,
    date_to: str,
    db: Session,
) -> int:
    """
    Скачивает отчёт united_orders из ЯМ, парсит и сохраняет в БД.
    Возвращает количество новых добавленных строк.
    """
    client, business_id, campaign_ids = get_client_for_store(store_name, db=db)
    logger.info("Синхронизация заказов %s (%s — %s)", store_name, date_from, date_to)

    content = _generate_and_download_report(client, business_id, date_from, date_to)
    rows = _parse_united_orders_bytes(content)

    # Скачиваем отчёт о стоимости услуг для расчёта bonus_deducted.
    # API ЯМ ограничивает длину периода 3 месяцами — разбиваем на чанки.
    marketplace_bonus: Dict[str, float] = {}
    try:
        from datetime import datetime as _dt, timedelta as _td
        _df = _dt.strptime(date_from, "%Y-%m-%d").date()
        _dt_to = _dt.strptime(date_to, "%Y-%m-%d").date()
        _chunk_start = _df
        while _chunk_start <= _dt_to:
            # Конец чанка = через 3 месяца минус 1 день, но не позже date_to
            _m = _chunk_start.month + 3
            _y = _chunk_start.year + (_m - 1) // 12
            _m = (_m - 1) % 12 + 1
            import calendar as _cal
            _last_day = _cal.monthrange(_y, _m)[1]
            _raw_end = _chunk_start.replace(year=_y, month=_m, day=min(_chunk_start.day - 1 or _last_day, _last_day))
            if _raw_end < _chunk_start:
                _raw_end = _chunk_start
            _chunk_end = min(_raw_end, _dt_to)
            try:
                ms_content = _generate_and_download_report(
                    client, business_id, _chunk_start.isoformat(), _chunk_end.isoformat(),
                    report_type="united-marketplace-services"
                )
                chunk_bonus = _parse_marketplace_services_bonus(ms_content)
                for oid, val in chunk_bonus.items():
                    marketplace_bonus[oid] = round(marketplace_bonus.get(oid, 0.0) + val, 2)
                logger.info("marketplace-services %s—%s: %d записей", _chunk_start, _chunk_end, len(chunk_bonus))
            except Exception as _ce:
                logger.warning("Не удалось загрузить marketplace-services %s—%s: %s", _chunk_start, _chunk_end, _ce)
            _chunk_start = _chunk_end + _td(days=1)
        logger.info("marketplace-services bonus итого: %d заказов", len(marketplace_bonus))
    except Exception as e:
        logger.warning("Не удалось загрузить marketplace-services: %s", e)

    if not rows:
        return 0

    # Подтягиваем supplier_price и commission из матчинга/товаров
    products = db.query(Product).filter(Product.store_id == store_id).all()
    name_to_sku = {p.name: p.sku for p in products if p.name}
    sku_to_commission: Dict[str, Optional[float]] = {p.sku: p.commission for p in products if p.sku}

    matches = (
        db.query(ProductMatch.sku, sqlfunc.min(ProductMatch.supplier_price))
        .filter(ProductMatch.store_id == store_id, ProductMatch.status == "confirmed")
        .group_by(ProductMatch.sku)
        .all()
    )
    sku_to_price: Dict[str, float] = {m[0]: m[1] for m in matches}

    store = db.query(Store).filter(Store.id == store_id).first()
    tax_rate = store.tax_rate if store else 0.0

    # Upsert — ключ только по order_id (offer_name может меняться между синхронизациями)
    count_new = 0
    for row in rows:
        sku = name_to_sku.get(row["offer_name"])
        supplier_price = sku_to_price.get(sku) if sku else None
        commission_rate = sku_to_commission.get(sku) if sku else None
        buyer_payment = row["buyer_payment"]
        promo_discount = row.get("promo_discount")
        # Комиссия считается от полной выручки (покупатель + субсидия ЯМ)
        effective_revenue = buyer_payment + (float(promo_discount) if promo_discount is not None else 0.0)
        commission_amount = round(effective_revenue * commission_rate / 100, 2) if commission_rate else None
        # Налог считается только от платежа покупателя (без субсидии ЯМ)
        tax_amount = round(buyer_payment * tax_rate, 2) if tax_rate else None

        existing = (
            db.query(Order)
            .filter(
                Order.store_id == store_id,
                Order.order_id == row["order_id"],
            )
            .first()
        )

        fb = row.get("fee_breakdown") or {}
        fee_breakdown_json = json.dumps(fb, ensure_ascii=False) if fb else None

        if existing:
            existing.market_price = row["market_price"]
            existing.buyer_payment = buyer_payment
            existing.all_services_fee = row["all_services_fee"]
            existing.order_kind = row["order_kind"]
            existing.ym_status = row.get("ym_status", "DELIVERED")
            existing.order_date = row["order_date"]
            existing.quantity = row.get("quantity", 1)
            existing.sku = sku
            existing.fee_breakdown = fee_breakdown_json
            # Не перезаписывать вручную введённый закуп
            if not existing.supplier_price_is_manual:
                existing.supplier_price = supplier_price
            existing.supplier_price_matched = supplier_price
            existing.commission_amount = commission_amount
            existing.promo_discount = promo_discount
            existing.tax_amount = tax_amount
            if row["offer_name"]:
                existing.offer_name = row["offer_name"]
        else:
            db.add(Order(
                store_id=store_id,
                order_id=row["order_id"],
                offer_name=row["offer_name"],
                sku=sku,
                market_price=row["market_price"],
                buyer_payment=buyer_payment,
                all_services_fee=row["all_services_fee"],
                order_kind=row["order_kind"],
                ym_status=row.get("ym_status", "DELIVERED"),
                order_date=row["order_date"],
                quantity=row.get("quantity", 1),
                supplier_price=supplier_price,
                supplier_price_matched=supplier_price,
                supplier_price_is_manual=False,
                commission_amount=commission_amount,
                promo_discount=promo_discount,
                tax_amount=tax_amount,
                fee_breakdown=fee_breakdown_json,
            ))
            count_new += 1

    db.commit()
    logger.info("Заказов добавлено: %d / обновлено: %d", count_new, len(rows) - count_new)

    # Обогащение дат отгрузки через ЯМ API (из delivery.shipments)
    shipment_dates: Dict[str, str] = {}
    for campaign_id in campaign_ids:
        try:
            dates = client.get_orders_shipment_dates(campaign_id, date_from, date_to)
            shipment_dates.update(dates)
        except Exception as e:
            logger.warning("Не удалось получить даты отгрузки campaign=%s: %s", campaign_id, e)

    if shipment_dates:
        to_update = db.query(Order).filter(
            Order.store_id == store_id,
            Order.order_id.in_(list(shipment_dates.keys())),
        ).all()
        for o in to_update:
            sd = shipment_dates.get(o.order_id)
            if sd:
                parsed = _parse_ym_date(sd)
                if parsed:
                    o.shipment_date = parsed
        db.commit()
        logger.info("Дат отгрузки обновлено: %d", len(to_update))

    # Обогащение субсидиями и детализацией комиссий через stats/orders API
    all_order_ids = [r["order_id"] for r in rows]
    if all_order_ids:
        orders_to_enrich = {
            o.order_id: o
            for o in db.query(Order).filter(
                Order.store_id == store_id,
                Order.order_id.in_(all_order_ids),
            ).all()
        }
        for campaign_id in campaign_ids:
            try:
                stats = client.get_orders_stats(campaign_id, list(orders_to_enrich.keys()))
                _enrich_from_stats(stats, orders_to_enrich)
                logger.info("stats/orders campaign=%s: обогащено %d заказов", campaign_id, len(stats))
            except Exception as e:
                logger.warning("get_orders_stats campaign=%s: %s", campaign_id, e)

        # Применяем bonus_deducted из marketplace-services отчёта ко ВСЕМ заказам магазина.
        # bonus_deducted = скидка на комиссию за счёт SELLER-бонусов.
        # Если col47 ≈ promo_discount — это баллы ПОКУПАТЕЛЯ (уже в выручке), не добавляем.
        if marketplace_bonus:
            all_bonus_orders = {
                o.order_id: o
                for o in db.query(Order).filter(
                    Order.store_id == store_id,
                    Order.order_id.in_(list(marketplace_bonus.keys())),
                ).all()
            }
            applied = 0
            cleared = 0
            for oid, bonus in marketplace_bonus.items():
                order = all_bonus_orders.get(oid)
                if not order or bonus <= 0:
                    continue
                promo = float(order.promo_discount or 0.0)
                fb = json.loads(order.fee_breakdown) if order.fee_breakdown else {}
                # Если скидка на комиссию совпадает с promo_discount покупателя — это не seller-бонус
                if abs(bonus - promo) < 0.1:
                    if fb.get("bonus_deducted"):
                        fb.pop("bonus_deducted", None)
                        order.fee_breakdown = json.dumps(fb, ensure_ascii=False)
                        cleared += 1
                    continue
                if fb.get("bonus_deducted") != round(bonus, 2):
                    fb["bonus_deducted"] = round(bonus, 2)
                    order.fee_breakdown = json.dumps(fb, ensure_ascii=False)
                    applied += 1
            logger.info("bonus_deducted: применено %d, очищено (покупатель) %d", applied, cleared)

        db.commit()

    return count_new


_STATS_COMM_KEY: Dict[str, str] = {
    "FEE": "fee_placement",
    "DELIVERY_TO_CUSTOMER": "fee_logistics",
    "PAYMENT_TRANSFER": "fee_payment",
    "AGENCY": "fee_other",
    "AUCTION_PROMOTION": "fee_auction",
    "SORTING": "fee_sorting",
    "LOYALTY_PARTICIPATION_FEE": "fee_loyalty",
    "RETURNED_ORDERS_STORAGE": "fee_storage",
}


def _enrich_from_stats(stats: Dict[str, Any], orders_map: Dict[str, Any]) -> None:
    """Обновляет promo_discount, fee_breakdown и payment_date из данных stats/orders API.
    stats: {order_id_str: order_stats_dict} — результат get_orders_stats.
    """
    for oid, order_stats in stats.items():
        order = orders_map.get(oid)
        if not order:
            continue
        # Субсидии: ACCRUAL = начисленные (доход), DEDUCTION = списанные баллы (расход)
        subsidies = order_stats.get("subsidies") or []
        total_accrual = sum(float(s.get("amount", 0)) for s in subsidies if s.get("operationType") == "ACCRUAL")
        total_deduction = sum(float(s.get("amount", 0)) for s in subsidies if s.get("operationType") == "DEDUCTION")
        if total_accrual:
            order.promo_discount = round(total_accrual, 2)
        # Детализация комиссий
        commissions = order_stats.get("commissions") or []
        fb: Dict[str, float] = {}
        for c in commissions:
            tp = str(c.get("type", "")).upper()
            amt = float(c.get("actual") or 0)
            if amt <= 0:
                continue
            key = _STATS_COMM_KEY.get(tp, "fee_other")
            fb[key] = round(fb.get(key, 0) + amt, 2)
        # DEDUCTION субсидии — списанные баллы (расход продавца)
        if total_deduction:
            fb["bonus_deducted"] = round(total_deduction, 2)
        if fb:
            order.fee_breakdown = json.dumps(fb, ensure_ascii=False)
        # Дата выплаты из payments[].paymentOrder.date
        payments = order_stats.get("payments") or []
        for p in payments:
            po = p.get("paymentOrder") or {}
            raw_date = po.get("date")
            if raw_date:
                parsed = _parse_ym_date(str(raw_date))
                if parsed:
                    order.payment_date = parsed
                    break


# ---------- СИНХРОНИЗАЦИЯ АКТИВНЫХ ЗАКАЗОВ ----------

def sync_active_orders_for_store(store_id: int, store_name: str, db: Session) -> int:
    """
    Синхронизирует активные заказы (PROCESSING/READY_TO_SHIP/DELIVERY/PICKUP)
    из ЯМ API в БД. Не перезаписывает вручную введённые закупы.
    """
    from models.store import Store
    from models.product_match import ProductMatch

    client, _, campaign_ids = get_client_for_store(store_name, db=db)
    store = db.query(Store).filter(Store.id == store_id).first()
    tax_rate = float(store.tax_rate if store else 0.06)

    # Собираем заказы из всех кампаний (order_id → (order_dict, ym_status))
    orders_map: Dict[str, tuple] = {}
    for campaign_id in campaign_ids:
        try:
            for o in client.get_orders_for_assembly(campaign_id):
                oid = str(o.get("id"))
                substatus = o.get("substatus", "")
                status = "READY_TO_SHIP" if substatus == "READY_TO_SHIP" else "PROCESSING"
                if oid not in orders_map:
                    orders_map[oid] = (o, status)
        except Exception as e:
            logger.warning("[active_sync] PROCESSING store=%s campaign=%s: %s", store_name, campaign_id, e)
        try:
            for o in client.get_delivery_orders_today(campaign_id):
                oid = str(o.get("id"))
                if oid not in orders_map:
                    orders_map[oid] = (o, o.get("status", "DELIVERY"))
        except Exception as e:
            logger.warning("[active_sync] DELIVERY store=%s campaign=%s: %s", store_name, campaign_id, e)

    if not orders_map:
        return 0

    # Справочники
    products = db.query(Product).filter(Product.store_id == store_id).all()
    name_to_sku = {p.name: p.sku for p in products if p.name}
    sku_to_commission = {p.sku: p.commission for p in products if p.sku}
    matches = (
        db.query(ProductMatch.sku, sqlfunc.min(ProductMatch.supplier_price))
        .filter(ProductMatch.store_id == store_id, ProductMatch.status == "confirmed")
        .group_by(ProductMatch.sku)
        .all()
    )
    sku_to_price: Dict[str, float] = {m[0]: m[1] for m in matches}

    count_new = 0
    for order_id_str, (order, ym_status) in orders_map.items():
        items = order.get("items") or []
        if not items:
            continue

        total_buyer = 0.0
        total_subsidy = 0.0
        total_qty = 0
        offer_name = None
        sku = None
        for item in items:
            cnt = int(item.get("count") or 1)
            bp = float(item.get("buyerPrice") or item.get("price") or 0)
            subs = sum(float(s.get("amount", 0)) for s in (item.get("subsidies") or []))
            total_buyer += bp * cnt
            total_subsidy += subs * cnt
            total_qty += cnt
            if not offer_name:
                offer_name = item.get("offerName") or item.get("offer", {}).get("name") or None
            if not sku:
                sku = item.get("offerId") or item.get("sku") or None

        if not total_buyer:
            continue

        if not sku and offer_name:
            sku = name_to_sku.get(offer_name)

        order_date = None
        shipment_date = None
        # 1) supplierShipmentDate — план отгрузки (приоритет)
        raw_ship = order.get("supplierShipmentDate")
        if raw_ship:
            shipment_date = _parse_ym_date(str(raw_ship))
            if shipment_date:
                order_date = shipment_date
        # 2) delivery.shipments[0].shipmentDate
        if not shipment_date:
            delivery = order.get("delivery") or {}
            shipments = delivery.get("shipments") or []
            if shipments:
                raw_ship2 = shipments[0].get("shipmentDate")
                if raw_ship2:
                    shipment_date = _parse_ym_date(str(raw_ship2))
                    if shipment_date and not order_date:
                        order_date = shipment_date
        # 3) creationDate (DD-MM-YYYY HH:MM:SS)
        if not order_date:
            for date_key in ("creationDate", "statusUpdateDate", "updatedAt"):
                raw = order.get(date_key)
                if raw:
                    parsed = _parse_ym_date(str(raw))
                    if parsed:
                        order_date = parsed
                        break

        buyer_payment = round(total_buyer, 2)
        promo_discount = round(total_subsidy, 2) if total_subsidy else None
        revenue = buyer_payment + (float(promo_discount) if promo_discount else 0.0)
        commission_rate = sku_to_commission.get(sku) if sku else None
        supplier_price = sku_to_price.get(sku) if sku else None
        commission_amount = round(revenue * commission_rate / 100, 2) if commission_rate else None
        tax_amount = round(buyer_payment * tax_rate, 2) if tax_rate else None

        existing = db.query(Order).filter(
            Order.store_id == store_id,
            Order.order_id == order_id_str,
        ).first()

        if existing:
            existing.ym_status = ym_status
            existing.buyer_payment = buyer_payment
            existing.promo_discount = promo_discount
            existing.quantity = total_qty or 1
            if offer_name:
                existing.offer_name = offer_name
            if sku:
                existing.sku = sku
            if order_date:
                existing.order_date = order_date
            if shipment_date:
                existing.shipment_date = shipment_date
            if not existing.supplier_price_is_manual:
                existing.supplier_price = supplier_price
            existing.supplier_price_matched = supplier_price
            existing.commission_amount = commission_amount
            existing.tax_amount = tax_amount
        else:
            db.add(Order(
                store_id=store_id,
                order_id=order_id_str,
                offer_name=offer_name,
                sku=sku,
                market_price=revenue,
                buyer_payment=buyer_payment,
                all_services_fee=0.0,
                order_kind="normal",
                ym_status=ym_status,
                order_date=order_date,
                shipment_date=shipment_date,
                quantity=total_qty or 1,
                supplier_price=supplier_price,
                supplier_price_matched=supplier_price,
                supplier_price_is_manual=False,
                commission_amount=commission_amount,
                promo_discount=promo_discount,
                tax_amount=tax_amount,
            ))
            count_new += 1

    # Заказы, которые были в ACTIVE но исчезли из API → отменены до отгрузки
    ACTIVE_STATUSES = ("PROCESSING", "READY_TO_SHIP", "DELIVERY", "PICKUP")
    stale = db.query(Order).filter(
        Order.store_id == store_id,
        Order.ym_status.in_(ACTIVE_STATUSES),
        ~Order.order_id.in_(list(orders_map.keys())),
    ).all()
    for o in stale:
        o.ym_status = "CANCELLED"
        logger.info("[active_sync] %s — заказ %s помечен CANCELLED", store_name, o.order_id)

    db.commit()
    logger.info("[active_sync] %s — активных заказов: %d новых, %d обновлено, %d отменено",
                store_name, count_new, len(orders_map) - count_new, len(stale))
    return count_new
