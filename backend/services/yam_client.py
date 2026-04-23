import io
import logging
import os
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import requests

BASE_URL = "https://api.partner.market.yandex.ru"
logger = logging.getLogger(__name__)


def _parse_ym_date_str(raw: str) -> Optional[str]:
    """Парсит дату из YM API (DD-MM-YYYY или DD-MM-YYYY HH:MM:SS или YYYY-MM-DD) → 'YYYY-MM-DD'."""
    raw = raw.strip()
    # DD-MM-YYYY HH:MM:SS (19 chars) или DD-MM-YYYY (10 chars)
    if len(raw) >= 10 and raw[2:3] == "-" and raw[5:6] == "-":
        for fmt, length in [("%d-%m-%Y %H:%M:%S", 19), ("%d-%m-%Y", 10)]:
            try:
                return datetime.strptime(raw[:length], fmt).strftime("%Y-%m-%d")
            except ValueError:
                pass
    # YYYY-MM-DD (ISO)
    if len(raw) >= 10:
        try:
            datetime.strptime(raw[:10], "%Y-%m-%d")
            return raw[:10]
        except ValueError:
            pass
    return None


class YMError(RuntimeError):
    pass


def _merge_pdfs(pdfs: List[bytes]) -> bytes:
    """Слить несколько PDF в один. Пробует pypdf, потом pdfplumber+Pillow."""
    if not pdfs:
        return b""
    if len(pdfs) == 1:
        return pdfs[0]

    # Вариант 1: pypdf
    try:
        from pypdf import PdfReader, PdfWriter
        writer = PdfWriter()
        for i, pdf_bytes in enumerate(pdfs):
            try:
                reader = PdfReader(io.BytesIO(pdf_bytes))
                if reader.is_encrypted:
                    reader.decrypt("")
                for page in reader.pages:
                    writer.add_page(page)
            except Exception as e:
                logger.warning("PDF merge pypdf: пропуск PDF #%d: %s", i, e)
        if len(writer.pages) > 0:
            buf = io.BytesIO()
            writer.write(buf)
            logger.info("PDF merge: pypdf, %d стр.", len(writer.pages))
            return buf.getvalue()
    except ImportError:
        logger.warning("PDF merge: pypdf не установлен, пробуем pdfplumber")
    except Exception as e:
        logger.warning("PDF merge pypdf ошибка: %s", e)

    # Вариант 2: pdfplumber + Pillow (растровый PDF)
    try:
        import pdfplumber
        from PIL import Image as PILImage
        images = []
        for pdf_bytes in pdfs:
            with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
                for page in pdf.pages:
                    img = page.to_image(resolution=203).original  # 203 dpi — стандарт термопринтеров
                    if img.mode != 'RGB':
                        img = img.convert('RGB')
                    images.append(img)
        if images:
            buf = io.BytesIO()
            images[0].save(buf, format='PDF', save_all=True, append_images=images[1:])
            logger.info("PDF merge: pdfplumber+Pillow, %d стр.", len(images))
            return buf.getvalue()
    except Exception as e:
        logger.error("PDF merge pdfplumber ошибка: %s", e, exc_info=True)

    logger.error("PDF merge: оба способа не сработали, возвращаем первый PDF")
    return pdfs[0]


class YMClient:
    def __init__(self, api_key: str, timeout: int = 30):
        self.api_key = api_key
        self.session = requests.Session()
        self.timeout = timeout

    def _headers(self) -> Dict[str, str]:
        return {
            "Api-Key": self.api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _request(self, method: str, path: str, *, params=None, json_body=None, _retries: int = 5) -> Dict[str, Any]:
        import ssl
        from requests.exceptions import SSLError as RequestsSSLError
        url = BASE_URL + path
        for attempt in range(_retries):
            try:
                r = self.session.request(
                    method=method,
                    url=url,
                    headers=self._headers(),
                    params=params,
                    json=json_body,
                    timeout=self.timeout,
                )
            except (RequestsSSLError, OSError) as exc:
                if attempt < _retries - 1:
                    time.sleep(5 * (attempt + 1))
                    continue
                raise YMError(f"Сетевая ошибка {url}: {exc}") from exc

            if r.status_code == 420:
                # Rate limit — ждём и повторяем
                wait = 15 * (attempt + 1)
                time.sleep(wait)
                continue

            try:
                data = r.json()
            except Exception:
                raise YMError(f"HTTP {r.status_code} {url}: не удалось распарсить JSON. Текст: {r.text[:300]}")

            if r.status_code >= 400:
                raise YMError(f"HTTP {r.status_code} {url}: {data}")

            if isinstance(data, dict) and data.get("status") == "ERROR":
                raise YMError(f"API ERROR {url}: {data}")

            return data

        raise YMError(f"Превышено число попыток ({_retries}) для {url}")

    def iter_offer_mappings(self, business_id: int, *, limit: int = 100) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        page_token: Optional[str] = None

        while True:
            params = {"limit": limit}
            if page_token:
                params["pageToken"] = page_token

            data = self._request(
                "POST",
                f"/v2/businesses/{business_id}/offer-mappings",
                params=params,
                json_body=None,
            )
            result = data.get("result", {})
            items = result.get("offerMappings", []) or []
            out.extend(items)

            paging = result.get("paging", {}) or {}
            page_token = paging.get("nextPageToken")
            if not page_token:
                break

            time.sleep(0.5)

        return out

    def get_prices(self, campaign_id: int, offer_ids: List[str]) -> Dict[str, Dict[str, Any]]:
        data = self._request(
            "POST",
            f"/v2/campaigns/{campaign_id}/offer-prices",
            json_body={"offerIds": offer_ids},
        )
        offers = (data.get("result", {}) or {}).get("offers", []) or []
        return {o["offerId"]: (o.get("price") or {}) for o in offers if "offerId" in o}

    def get_stocks(self, campaign_id: int, offer_ids: List[str]) -> Dict[str, int]:
        data = self._request(
            "POST",
            f"/v2/campaigns/{campaign_id}/offers/stocks",
            json_body={"offerIds": offer_ids},
        )
        offers = (data.get("result", {}) or {}).get("offers", []) or []

        out: Dict[str, int] = {}
        for o in offers:
            sku = o.get("offerId") or o.get("sku")
            if not sku:
                continue
            total = 0
            for it in (o.get("items") or []):
                if isinstance(it, dict) and it.get("type") == "FIT" and isinstance(it.get("count"), int):
                    total += it["count"]
            out[sku] = total

        return out

    def calculate_tariffs(
        self,
        selling_program: str,
        category_id: int,
        price: float,
        length_cm: float,
        width_cm: float,
        height_cm: float,
        weight_kg: float,
        frequency: str,
        quantity: int = 1,
    ) -> List[Dict[str, Any]]:
        body = {
            "parameters": {
                "sellingProgram": selling_program,
                "frequency": frequency,
                "currency": "RUR",
            },
            "offers": [{
                "categoryId": int(category_id),
                "price": float(price),
                "length": float(length_cm),
                "width": float(width_cm),
                "height": float(height_cm),
                "weight": float(weight_kg),
                "quantity": quantity,
            }],
        }
        data = self._request("POST", "/v2/tariffs/calculate", json_body=body)
        offers = (data.get("result", {}) or {}).get("offers", []) or []
        if not offers:
            return []
        return offers[0].get("tariffs", []) or []

    def update_price_business(self, business_id: int, sku: str, price_value: float, currency: str = "RUR") -> Dict[str, Any]:
        return self.update_prices_business_batch(business_id, {sku: price_value}, currency)

    def update_prices_business_batch(
        self,
        business_id: int,
        sku_prices: Dict[str, float],   # {sku: price}
        currency: str = "RUR",
        chunk_size: int = 500,
        sku_discount_bases: Optional[Dict[str, float]] = None,  # {sku: discountBase} — зачёркнутая цена
    ) -> Dict[str, Any]:
        """Батч-обновление цен. ЯМ принимает до 500 офферов за раз."""
        items = list(sku_prices.items())
        last: Dict[str, Any] = {}
        for chunk in chunked([i[0] for i in items], chunk_size):
            chunk_set = set(chunk)
            offers = []
            for sku, price in items:
                if sku not in chunk_set:
                    continue
                price_obj: Dict[str, Any] = {"value": float(price), "currencyId": currency}
                if sku_discount_bases and sku in sku_discount_bases:
                    base = sku_discount_bases[sku]
                    # ЯМ требует скидку от 5% до 99%: (base - price) / base >= 0.05
                    if base > price and (base - price) / base >= 0.05:
                        price_obj["discountBase"] = float(base)
                offers.append({"offerId": sku, "price": price_obj})
            last = self._request(
                "POST",
                f"/v2/businesses/{business_id}/offer-prices/updates",
                json_body={"offers": offers},
            )
        return last

    def update_stocks_batch(
        self,
        campaign_id: int,
        sku_counts: Dict[str, int],   # {sku: count}
        chunk_size: int = 500,
    ) -> Dict[str, Any]:
        """Батч-обновление остатков. ЯМ принимает до 500 SKU за раз."""
        items = list(sku_counts.items())
        last: Dict[str, Any] = {}
        for chunk in chunked([i[0] for i in items], chunk_size):
            chunk_set = set(chunk)
            skus = [
                {"sku": sku, "items": [{"count": cnt}]}
                for sku, cnt in items if sku in chunk_set
            ]
            last = self._request("PUT", f"/v2/campaigns/{campaign_id}/offers/stocks", json_body={"skus": skus})
        return last

    def get_categories_tree(self, language: str = "RU") -> Dict[str, Any]:
        return self._request(
            "POST",
            "/v2/categories/tree",
            json_body={"language": language},
        )

    def get_business_price_quarantine(self, business_id: int, offer_ids: List[str]) -> Dict[str, Any]:
        return self._request(
            "POST",
            f"/v2/businesses/{business_id}/price-quarantine",
            json_body={"offerIds": offer_ids},
        )

    def confirm_business_price_quarantine(self, business_id: int, offer_ids: List[str]) -> Dict[str, Any]:
        return self._request(
            "POST",
            f"/v2/businesses/{business_id}/price-quarantine/confirm",
            json_body={"offerIds": offer_ids},
        )

    def get_offer_mappings(self, business_id: int, offer_ids: List[str]) -> List[Dict[str, Any]]:
        data = self._request(
            "POST",
            f"/v2/businesses/{business_id}/offer-mappings",
            json_body={"offerIds": offer_ids},
        )
        result = data.get("result", {}) or {}
        return result.get("offerMappings", []) or []

    def update_stock(self, campaign_id: int, sku: str, count: int, updated_at: Optional[str] = None) -> Dict[str, Any]:
        item: Dict[str, Any] = {"count": int(count)}
        if updated_at:
            item["updatedAt"] = updated_at
        body = {"skus": [{"sku": sku, "items": [item]}]}
        return self._request("PUT", f"/v2/campaigns/{campaign_id}/offers/stocks", json_body=body)

    # ─── Акции ────────────────────────────────────────────────────────────────

    def get_promos(self, business_id: int) -> List[Dict[str, Any]]:
        """Возвращает акции бизнес-аккаунта (все статусы — фильтруем сами)."""
        out: List[Dict[str, Any]] = []
        page_token: Optional[str] = None
        while True:
            body: Dict[str, Any] = {}
            if page_token:
                body["pageToken"] = page_token
            data = self._request(
                "POST",
                f"/v2/businesses/{business_id}/promos",
                json_body=body if body else None,
            )
            result = (data.get("result", {}) or {})
            promos = result.get("promos", []) or []
            # Оставляем только активные и предстоящие
            for p in promos:
                status = p.get("status", "")
                if status in ("ACTIVE", "UPCOMING", ""):
                    out.append(p)
            paging = result.get("paging", {}) or {}
            page_token = paging.get("nextPageToken")
            if not page_token:
                break
        return out

    def get_promo_offers(
        self,
        business_id: int,
        promo_id: str,
    ) -> List[Dict[str, Any]]:
        """
        Возвращает ВСЕ офферы акции с полем status (PARTICIPATING / NOT_PARTICIPATING)
        и params.discountParams.maxPromoPrice. Фильтрация по нашим SKU — на стороне клиента.
        """
        body: Dict[str, Any] = {"promoId": promo_id}

        out: List[Dict[str, Any]] = []
        page_token: Optional[str] = None
        while True:
            if page_token:
                body["page_token"] = page_token
            data = self._request("POST", f"/v2/businesses/{business_id}/promos/offers", json_body=body)
            result = data.get("result", {}) or {}
            offers = result.get("offers", []) or []
            out.extend(offers)
            paging = result.get("paging", {}) or {}
            page_token = paging.get("nextPageToken")
            if not page_token:
                break
        return out

    def update_promo_offers(
        self,
        business_id: int,
        promo_id: str,
        offers: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Добавляет или обновляет цену товаров в акции.
        offers: [{"offerId": sku, "price": {"value": N, "currencyId": "RUR"}}]
        До 500 товаров за запрос.
        """
        return self._request(
            "POST",
            f"/v2/businesses/{business_id}/promos/offers/update",
            json_body={"promoId": promo_id, "offers": offers},
        )

    def delete_promo_offers(
        self,
        business_id: int,
        promo_id: str,
        offer_ids: List[str],
    ) -> Dict[str, Any]:
        """Удаляет товары из акции."""
        return self._request(
            "POST",
            f"/v2/businesses/{business_id}/promos/offers/delete",
            json_body={"promoId": promo_id, "offerIds": offer_ids},
        )

    def get_orders_for_assembly(self, campaign_id: int) -> List[Dict[str, Any]]:
        """Заказы в статусе PROCESSING (все активные, без фильтра по дате — supplierShipmentDate всегда None)."""
        out: List[Dict[str, Any]] = []
        page = 1
        while True:
            data = self._request(
                "GET",
                f"/v2/campaigns/{campaign_id}/orders",
                params={"status": "PROCESSING", "pageSize": 50, "page": page, "fake": "false"},
            )
            orders = data.get("orders", []) or []
            out.extend(orders)
            pager = data.get("pager", {}) or {}
            if page >= (pager.get("pagesCount") or 1):
                break
            page += 1
            time.sleep(0.2)
        return out

    def get_labels_pdf(self, campaign_id: int, order_ids: List[int]) -> bytes:
        """Скачать PDF-ярлыки для заказов и склеить в один PDF.
        Правильный эндпоинт: GET /v2/campaigns/{campaign_id}/orders/{order_id}/delivery/labels
        (один запрос на заказ, затем PDF-ы конкатенируются побайтово).
        """
        import io
        pdfs: List[bytes] = []
        for oid in order_ids:
            url = f"{BASE_URL}/v2/campaigns/{campaign_id}/orders/{oid}/delivery/labels"
            r = self.session.get(url, headers=self._headers(), timeout=60)
            if r.status_code >= 400:
                raise YMError(f"HTTP {r.status_code} labels order {oid}: {r.text[:300]}")
            pdfs.append(r.content)
        if not pdfs:
            return b""
        if len(pdfs) == 1:
            return pdfs[0]
        # Конкатенация PDF через pypdf
        return _merge_pdfs(pdfs)

    def get_shipments(self, campaign_id: int) -> List[Dict[str, Any]]:
        """Ближайшие отгрузки FBS."""
        from datetime import date, timedelta
        today = date.today().isoformat()
        in_week = (date.today() + timedelta(days=7)).isoformat()
        try:
            data = self._request(
                "GET",
                f"/v2/campaigns/{campaign_id}/first-mile/shipments",
                params={"dateFrom": today, "dateTo": in_week},
            )
            return (data.get("result", {}) or {}).get("shipments", []) or []
        except Exception:
            return []

    def set_order_ready(self, campaign_id: int, order_id) -> Dict[str, Any]:
        """Перевести заказ в статус READY_TO_SHIP (сдать на отгрузку)."""
        return self._request(
            "PUT",
            f"/v2/campaigns/{campaign_id}/orders/{order_id}/status",
            json_body={"order": {"status": "PROCESSING", "substatus": "READY_TO_SHIP"}},
        )

    def get_shipment_act(self, campaign_id: int, shipment_id) -> bytes:
        """Скачать акт отгрузки (PDF)."""
        url = f"{BASE_URL}/v2/campaigns/{campaign_id}/shipments/{shipment_id}/act"
        r = self.session.get(url, headers=self._headers(), timeout=60)
        if r.status_code >= 400:
            raise YMError(f"HTTP {r.status_code} act shipment {shipment_id}: {r.text[:300]}")
        return r.content

    def get_shipment_list_pdf(self, campaign_id: int, shipment_id: int = None, order_ids: List[str] = None) -> bytes:
        """Скачать лист сборки (PDF) — асинхронная генерация через reports API."""
        if shipment_id is not None:
            body = {"campaignId": campaign_id, "shipmentId": shipment_id}
        elif order_ids:
            body = {"campaignId": campaign_id, "orderIds": [int(x) for x in order_ids]}
        else:
            raise YMError("Нужен shipment_id или order_ids для листа сборки")
        # 1. Запросить генерацию
        data = self._request(
            "POST",
            "/v2/reports/documents/shipment-list/generate",
            json_body=body,
        )
        report_id = (data.get("result") or {}).get("reportId")
        if not report_id:
            raise YMError(f"Не получен reportId: {data}")

        # 2. Опрашиваем до готовности (макс 60 сек)
        for _ in range(20):
            time.sleep(3)
            info = self._request("GET", f"/v2/reports/info/{report_id}")
            result = info.get("result") or {}
            status = result.get("status")
            if status == "DONE":
                file_url = result.get("file")
                if not file_url:
                    raise YMError("Лист сборки готов, но URL файла отсутствует")
                r = self.session.get(file_url, timeout=60)
                if r.status_code >= 400:
                    raise YMError(f"HTTP {r.status_code} при скачивании листа сборки")
                return r.content
            if status == "FAILED":
                raise YMError(f"Генерация листа сборки завершилась ошибкой: {result}")

        raise YMError("Таймаут генерации листа сборки (60 сек)")

    def get_delivery_orders_today(self, campaign_id: int) -> List[Dict[str, Any]]:
        """Заказы в статусе DELIVERY/PICKUP (без фильтра по дате — все активные в доставке)."""
        out: List[Dict[str, Any]] = []
        page = 1
        while True:
            data = self._request(
                "GET",
                f"/v2/campaigns/{campaign_id}/orders",
                params={"status": "DELIVERY,PICKUP", "pageSize": 50, "page": page,
                        "fake": "false"},
            )
            orders = data.get("orders", []) or []
            out.extend(orders)
            pager = data.get("pager", {}) or {}
            if page >= (pager.get("pagesCount") or 1):
                break
            page += 1
            time.sleep(0.2)
        return out

    def get_billing_transactions(self, campaign_id: int, date_from: str, date_to: str) -> List[Dict[str, Any]]:
        """Биллинг-транзакции кампании за период. Включает детализацию комиссий и списание баллов."""
        out: List[Dict[str, Any]] = []
        page = 1
        while True:
            try:
                data = self._request(
                    "GET",
                    f"/v2/campaigns/{campaign_id}/billing/transactions",
                    params={"dateFrom": date_from, "dateTo": date_to, "pageSize": 200, "page": page},
                )
            except Exception as e:
                logger.warning("get_billing_transactions campaign=%s: %s", campaign_id, e)
                break
            items = data.get("transactions", []) or []
            out.extend(items)
            pager = data.get("pager", {}) or {}
            if page >= (pager.get("pagesCount") or 1):
                break
            page += 1
            time.sleep(0.3)
        return out

    def get_orders_stats(self, campaign_id: int, order_ids: List[str]) -> Dict[str, Any]:
        """Получает детальную статистику (комиссии, субсидии) по заказам через stats/orders API.
        Возвращает {order_id_str: order_stats_dict}.
        """
        result: Dict[str, Any] = {}
        if not order_ids:
            return result
        for chunk in chunked(order_ids, 200):
            try:
                data = self._request(
                    "POST",
                    f"/v2/campaigns/{campaign_id}/stats/orders",
                    json_body={"orders": [int(oid) for oid in chunk]},
                )
                for o in (data.get("result") or {}).get("orders") or []:
                    result[str(o["id"])] = o
            except Exception as e:
                logger.warning("get_orders_stats campaign=%s: %s", campaign_id, e)
            time.sleep(0.3)
        return result

    def get_orders_shipment_dates(self, campaign_id: int, date_from: str, date_to: str) -> Dict[str, str]:
        """Возвращает {order_id: shipment_date_iso} для заказов в периоде.
        Ищет дату в delivery.shipments[0].shipmentDate, потом realDeliveryDate, потом creationDate.
        date_from / date_to — формат YYYY-MM-DD, конвертируется в DD-MM-YYYY для API.
        API ограничивает интервал 30 днями — запрашиваем чанками.
        """
        from datetime import timedelta

        def _to_ym(iso: str) -> str:
            try:
                d = datetime.strptime(iso[:10], "%Y-%m-%d")
                return d.strftime("%d-%m-%Y")
            except Exception:
                return iso

        def _iter_date_ranges(start: str, end: str, chunk_days: int = 28):
            cur = datetime.strptime(start[:10], "%Y-%m-%d")
            end_d = datetime.strptime(end[:10], "%Y-%m-%d")
            while cur <= end_d:
                chunk_end = min(cur + timedelta(days=chunk_days), end_d)
                yield cur.strftime("%Y-%m-%d"), chunk_end.strftime("%Y-%m-%d")
                cur = chunk_end + timedelta(days=1)

        def _extract_ship(order: dict) -> Optional[str]:
            delivery = order.get("delivery") or {}
            shipments = delivery.get("shipments") or []
            if shipments:
                raw = shipments[0].get("shipmentDate")
                if raw:
                    return _parse_ym_date_str(str(raw))
            dates = delivery.get("dates") or {}
            raw = dates.get("realDeliveryDate")
            if raw:
                return _parse_ym_date_str(str(raw))
            raw = order.get("creationDate")
            if raw:
                return _parse_ym_date_str(str(raw))
            return None

        result: Dict[str, str] = {}
        for chunk_from, chunk_to in _iter_date_ranges(date_from, date_to):
            page = 1
            while True:
                try:
                    data = self._request(
                        "GET",
                        f"/v2/campaigns/{campaign_id}/orders",
                        params={
                            "fromDate": _to_ym(chunk_from),
                            "toDate": _to_ym(chunk_to),
                            "pageSize": 50,
                            "page": page,
                            "fake": "false",
                        },
                    )
                except Exception as e:
                    logger.warning("get_orders_shipment_dates campaign=%s chunk=%s/%s: %s", campaign_id, chunk_from, chunk_to, e)
                    break
                orders = data.get("orders", []) or []
                for order in orders:
                    oid = str(order.get("id", ""))
                    ship = _extract_ship(order)
                    if oid and ship:
                        result[oid] = ship
                pager = data.get("pager", {}) or {}
                if page >= (pager.get("pagesCount") or 1):
                    break
                page += 1
                time.sleep(0.2)
        return result

    def get_active_orders(self, campaign_id: int) -> List[Dict[str, Any]]:
        """Возвращает заказы в статусах DELIVERY и PICKUP (в пути / в ПВЗ)."""
        out: List[Dict[str, Any]] = []
        page = 1
        while True:
            data = self._request(
                "GET",
                f"/campaigns/{campaign_id}/orders",
                params={"status": "DELIVERY,PICKUP", "pageSize": 50, "page": page},
            )
            orders = data.get("orders", []) or []
            out.extend(orders)
            pager = data.get("pager", {}) or {}
            if page >= (pager.get("pagesCount") or 1):
                break
            page += 1
            time.sleep(0.3)
        return out


def chunked(xs: List[str], n: int) -> List[List[str]]:
    return [xs[i:i + n] for i in range(0, len(xs), n)]


def get_client_for_store(store_name: str, db=None) -> Tuple["YMClient", int, List[int]]:
    """Возвращает (client, business_id, campaign_ids) для указанного магазина.
    Если db передан и у магазина есть api_key в БД — использует БД, иначе .env."""
    if db is not None:
        try:
            from models.store import Store
            store = db.query(Store).filter(Store.name == store_name).first()
            if store and store.api_key and store.business_id:
                campaign_ids = [
                    int(x.strip())
                    for x in (store.campaign_ids or "").split(",")
                    if x.strip()
                ]
                return YMClient(store.api_key), int(store.business_id), campaign_ids
        except Exception:
            pass

    key = store_name.upper().replace("-", "")
    api_key = os.environ[f"{key}_API_KEY"]
    business_id = int(os.environ[f"{key}_BUSINESS_ID"])
    campaign_ids = [
        int(x.strip())
        for x in os.environ[f"{key}_CAMPAIGN_IDS"].split(",")
        if x.strip()
    ]
    return YMClient(api_key), business_id, campaign_ids
