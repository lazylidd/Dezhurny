"""
PDF-парсер прайсов поставщиков.

Поддерживаемые форматы:
- 3-колоночный (ТХЛС и аналогичные): 3 повторения заголовка «Наименование / Цена / Страна»
  на одной строке — границы колонок определяются по позициям заголовков.
- 2-колоночный: один «Наименование» + «Цена» на строке заголовка.
- Fallback (без заголовка): строки где есть ₽.

Ключевое правило: ₽ ОБЯЗАТЕЛЕН. Строки без ₽ не парсятся.
Это отсекает строки-разделители («— iPhone 17 Pro Max —») и текстовые блоки.
"""
from __future__ import annotations

import re
from typing import Optional

import pdfplumber

RUB_MARK = "₽"
RE_NUM = re.compile(r"^\d+$")
RE_COUNTRY = re.compile(r"^[A-Z0-9]{1,4}/[A-Z0-9]{1,4}$")


# ─── публичный API ─────────────────────────────────────────────────────────────

def parse_pdf(pdf_path: str) -> list[dict]:
    """
    Парсит PDF-прайс и возвращает список товаров.
    Возвращает: [{"name": str, "price": float}, ...]
    """
    items: list[dict] = []

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            words = page.extract_words(use_text_flow=True)
            if not words:
                continue

            header = _detect_header(words)
            if header is None:
                # Страница без таблицы (условия, гарантия и т.п.) — пропускаем
                continue

            header_top, col_bounds = header
            body_words = [w for w in words if w["top"] > header_top + 5]
            lines = _group_words_into_lines(body_words, tol=2.0)

            for line in lines:
                if col_bounds:
                    # Многоколоночный: разбиваем по границам
                    columns = _split_line(line, col_bounds)
                    for tokens in columns:
                        item = _parse_tokens(tokens)
                        if item:
                            items.append(item)
                else:
                    # Одноколоночный
                    tokens = [w["text"].strip() for w in line if w["text"].strip()]
                    item = _parse_tokens(tokens)
                    if item:
                        items.append(item)

    # Дедупликация по (name, price)
    seen: set = set()
    result = []
    for it in items:
        key = (it["name"].lower(), it["price"])
        if key not in seen:
            seen.add(key)
            result.append(it)

    return result


# ─── определение структуры страницы ──────────────────────────────────────────

def _detect_header(words: list[dict]) -> Optional[tuple[float, Optional[list[float]]]]:
    """
    Ищет строку заголовка таблицы по слову «Наименование».

    Возвращает (header_top, col_bounds) где:
    - col_bounds — список X-границ между колонками (None для одноколоночного).

    Логика: собираем все «Наименование» на одной Y-строке.
    - 1 штука → одноколоночный, col_bounds = None
    - 2+ штуки → многоколоночный, col_bounds = [mid_x1, mid_x2, ...]
    """
    candidates = [w for w in words if w["text"].lower() in ("наименование", "название", "товар")]
    if not candidates:
        return None

    # Ищем первую строку с заголовком (самая верхняя группа)
    candidates.sort(key=lambda w: w["top"])
    first_top = candidates[0]["top"]

    # Собираем все заголовочные слова на этой строке (допуск ±3)
    same_row = [c for c in candidates if abs(c["top"] - first_top) <= 3]

    # Проверяем что рядом есть «Цена» — это точно таблица прайса
    same_row_all = [w for w in words if abs(w["top"] - first_top) <= 3]
    texts_on_row = {w["text"].lower() for w in same_row_all}
    if not ({"цена", "стоимость", "прайс"} & texts_on_row):
        return None

    same_row.sort(key=lambda w: w["x0"])

    if len(same_row) <= 1:
        return first_top, None

    # Многоколоночный: границы = x0 следующего заголовка минус буфер 3px
    xs = [h["x0"] for h in same_row]
    bounds: list[float] = []
    for i in range(len(xs) - 1):
        bounds.append(xs[i + 1] - 3)

    return first_top, bounds


def _group_words_into_lines(words: list[dict], tol: float = 2.0) -> list[list[dict]]:
    """Группирует слова в строки по Y-координате."""
    words_sorted = sorted(words, key=lambda w: (w["top"], w["x0"]))
    lines: list[list[dict]] = []
    current: list[dict] = []
    current_top: Optional[float] = None

    for w in words_sorted:
        if current_top is None:
            current_top = w["top"]
            current = [w]
            continue
        if abs(w["top"] - current_top) <= tol:
            current.append(w)
        else:
            lines.append(sorted(current, key=lambda x: x["x0"]))
            current_top = w["top"]
            current = [w]

    if current:
        lines.append(sorted(current, key=lambda x: x["x0"]))

    return lines


def _split_line(line: list[dict], bounds: list[float]) -> list[list[str]]:
    """
    Разбивает одну строку на N+1 колонок по N границам bounds.
    Возвращает список списков токенов — по одному на каждую колонку.
    """
    n = len(bounds) + 1
    cols: list[list[str]] = [[] for _ in range(n)]

    for w in line:
        t = w["text"].strip()
        if not t:
            continue
        x = w["x0"]
        # Определяем индекс колонки
        col_idx = n - 1
        for i, b in enumerate(bounds):
            if x < b:
                col_idx = i
                break
        cols[col_idx].append(t)

    return cols


# ─── парсинг одной колонки ────────────────────────────────────────────────────

def _is_valid_money_groups(groups: list[str]) -> bool:
    """
    Проверяет валидность групп разрядов числа (напр. ['177', '000']).
    - 1 группа: 1–9 цифр
    - 2+ группы: первая 1–3 цифры, остальные строго 3 цифры
    """
    if not groups:
        return False
    if len(groups) == 1:
        return groups[0].isdigit() and 1 <= len(groups[0]) <= 9
    if not (groups[0].isdigit() and 1 <= len(groups[0]) <= 3):
        return False
    return all(g.isdigit() and len(g) == 3 for g in groups[1:])


def _parse_tokens(tokens: list[str]) -> Optional[dict]:
    """
    Разбирает токены одной колонки.

    ОБЯЗАТЕЛЬНО наличие ₽ — без него строка игнорируется.
    Это предотвращает ложные срабатывания на строках-разделителях
    и токенах вида «17» в модели «iPhone 17».
    """
    if not tokens:
        return None

    # ₽ обязателен — без него не парсим
    rub_idx = next((i for i, t in enumerate(tokens) if RUB_MARK in t), None)
    if rub_idx is None:
        return None

    # Собираем разрядные группы цены: идём справа налево от ₽
    groups_rev: list[str] = []
    j = rub_idx - 1

    while j >= 0 and RE_NUM.match(tokens[j]):
        candidate = list(reversed(groups_rev + [tokens[j]]))
        if _is_valid_money_groups(candidate):
            groups_rev.append(tokens[j])
            j -= 1
        else:
            break

    if not groups_rev:
        return None

    price_str = "".join(reversed(groups_rev))
    name_tokens = tokens[: j + 1]

    # Убираем страновой код в конце имени (KH/A, ZA/A, J/A и т.п.)
    if name_tokens and RE_COUNTRY.match(name_tokens[-1]):
        name_tokens = name_tokens[:-1]

    name = " ".join(name_tokens).strip()

    # Убираем ведущие/хвостовые тире-разделители (« — iPhone — »)
    name = re.sub(r"^[—\-–\s]+|[—\-–\s]+$", "", name).strip()

    if not name:
        return None

    try:
        price = float(price_str)
    except ValueError:
        return None

    if price <= 0:
        return None

    return {"name": name, "price": price}
