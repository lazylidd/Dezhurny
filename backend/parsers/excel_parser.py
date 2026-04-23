"""
Excel-парсер прайсов поставщиков.

Поддерживаемые форматы:
- Двухколоночный: Model | Прайс  (формат «Полный прайс-лист.xlsx»)
  Название может быть в формате «Категория/Бренд/Модель» — берём последнюю часть.
- Общий fallback: первая текстовая колонка как название, первая числовая как цена.
"""
from __future__ import annotations

import re
from typing import Optional

import openpyxl


def parse_excel(file_path: str) -> list[dict]:
    """
    Парсит Excel-прайс и возвращает список товаров.

    Возвращает: [{"name": str, "price": float}, ...]
    """
    wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
    ws = wb.active

    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return []

    # Определяем индексы колонок по заголовку (первая строка)
    header = [str(c).strip().lower() if c is not None else "" for c in rows[0]]
    name_col, price_col = _detect_columns(header)

    items: list[dict] = []
    for row in rows[1:]:
        if not row or all(c is None for c in row):
            continue

        name_raw = row[name_col] if name_col < len(row) else None
        price_raw = row[price_col] if price_col < len(row) else None

        name = _extract_name(name_raw)
        price = _extract_price(price_raw)

        if name and price and price > 0:
            items.append({"name": name, "price": price})

    wb.close()

    # Дедупликация по (name, price)
    seen: set = set()
    result = []
    for item in items:
        key = (item["name"].lower(), item["price"])
        if key not in seen:
            seen.add(key)
            result.append(item)

    return result


def _detect_columns(header: list[str]) -> tuple[int, int]:
    """
    Определяет индексы колонок названия и цены по заголовку.
    Возвращает (name_col_index, price_col_index).
    """
    name_keywords = {"model", "наименование", "название", "товар", "продукт", "позиция"}
    price_keywords = {"прайс", "цена", "стоимость", "price"}

    name_col = next((i for i, h in enumerate(header) if h in name_keywords), None)
    price_col = next((i for i, h in enumerate(header) if h in price_keywords), None)

    # Fallback: первая и вторая колонки
    if name_col is None:
        name_col = 0
    if price_col is None:
        price_col = 1

    return name_col, price_col


def _extract_name(value) -> Optional[str]:
    """
    Извлекает название товара из ячейки.
    Если значение содержит «/», берёт последнюю часть (формат Категория/Бренд/Модель).
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None

    if "/" in s:
        parts = [p.strip() for p in s.split("/") if p.strip()]
        # Берём бренд + модель (последние две части, если есть)
        if len(parts) >= 2:
            return " ".join(parts[-2:])
        return parts[-1]

    return s


def _extract_price(value) -> Optional[float]:
    """Извлекает цену из ячейки."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    # Убираем пробелы-разряды и валютные символы
    s_clean = re.sub(r"[₽$€руб\s]", "", s, flags=re.IGNORECASE).replace(",", ".")
    try:
        return float(s_clean)
    except ValueError:
        return None
