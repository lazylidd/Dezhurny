"""
Сервис авто-матчинга поставщик → SKU.

Стратегия (по приоритету):
1. Точное совпадение normalize(sku) == supplier_normalized → auto, 1.0
2. Высокое сходство по SKU (≥ 0.75) → auto
3. Кандидаты по SKU (≥ 0.15) → список для ручного выбора
4. Если кандидатов по SKU нет — ищем по product.normalized_name (name-based fallback)

Расчёт сходства: max(Jaccard, subset_coverage) с бонусом за совпадение числовых токенов.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from sqlalchemy.orm import Session

from models.product import Product
from models.product_match import ProductMatch
from models.supplier_price import SupplierPrice
from utils.normalizer import normalize_name
from utils.settings import get_setting

# Порог авто-подтверждения при поиске по SKU (токены)
AUTO_CONFIRM_THRESHOLD = 0.85
# Минимальный порог для кандидата (токены)
CANDIDATE_THRESHOLD = 0.15

# Пороги для эмбеддинг-based матчинга (cosine similarity)
EMB_AUTO_THRESHOLD = 0.88
EMB_CANDIDATE_THRESHOLD = 0.70

EmbIndex = Dict[Tuple[str, int], List[float]]


def _cosine(a: List[float], b: List[float]) -> float:
    """Косинусное сходство двух векторов (numpy)."""
    va, vb = np.array(a, dtype=np.float32), np.array(b, dtype=np.float32)
    denom = np.linalg.norm(va) * np.linalg.norm(vb)
    return float(np.dot(va, vb) / denom) if denom > 0 else 0.0


def _load_emb(raw: Optional[str]) -> Optional[List[float]]:
    """Десериализовать эмбеддинг из JSON-строки."""
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def _build_emb_index(products: List[Product]) -> EmbIndex:
    """Построить индекс (sku, store_id) → embedding для списка продуктов."""
    idx: EmbIndex = {}
    for p in products:
        emb = _load_emb(p.name_embedding)
        if emb:
            idx[(p.sku, p.store_id)] = emb
    return idx


def _normalize_sku(sku: str) -> str:
    return normalize_name(sku) if sku else ""


def _score(query_tokens: set[str], target_tokens: set[str]) -> float:
    """
    Возвращает сходство двух наборов токенов [0, 1].

    Учитывает:
    - Jaccard: |A∩B| / |A∪B|
    - Coverage: сколько % меньшего набора покрыто бо́льшим
    - Bonus за совпадение числовых токенов (модель/объём/версия)
    """
    if not query_tokens or not target_tokens:
        return 0.0

    common = query_tokens & target_tokens
    if not common:
        return 0.0

    jaccard = len(common) / len(query_tokens | target_tokens)

    # coverage: берём долю совпадений из меньшего набора
    smaller = min(len(query_tokens), len(target_tokens))
    coverage = len(common) / smaller

    # Бонус за числовые токены (256gb, m50x, 16, s25 и т.д.)
    num_re = re.compile(r'\d')
    num_q = {t for t in query_tokens if num_re.search(t)}
    num_t = {t for t in target_tokens if num_re.search(t)}
    if num_q and num_t:
        num_coverage = len(num_q & num_t) / max(len(num_q), len(num_t))
    else:
        num_coverage = 0.0

    base = max(jaccard, coverage * 0.85)
    bonus = num_coverage * 0.15
    return min(1.0, base + bonus)


def _score_str(a: str, b: str) -> float:
    return _score(set(a.split()), set(b.split()))


def get_candidates(
    supplier_normalized: str,
    products: list[Product],
    top_n: int = 5,
    sup_emb: Optional[List[float]] = None,
    emb_index: Optional[EmbIndex] = None,
) -> list[dict]:
    """
    Возвращает топ-N кандидатов для supplier_normalized.

    Шаг 1: SKU-first (токен-based — эмбеддинги здесь не помогают).
    Шаг 2: Name fallback — cosine similarity если эмбеддинги доступны, иначе токены.
    """
    sup_tokens = set(supplier_normalized.split())
    if not sup_tokens:
        return []

    seen_sku: set[tuple] = set()
    scored: list[dict] = []

    # ── 1. SKU-first (токен-based) ────────────────────────────────────────
    for p in products:
        sku_norm = _normalize_sku(p.sku)
        if not sku_norm:
            continue
        score = _score(sup_tokens, set(sku_norm.split()))
        if score >= CANDIDATE_THRESHOLD:
            key = (p.sku, p.store_id)
            if key not in seen_sku:
                seen_sku.add(key)
                scored.append({
                    "sku": p.sku,
                    "store_id": p.store_id,
                    "product_name": p.name or p.sku,
                    "score": round(score, 3),
                    "match_by": "sku",
                })

    # ── 2. Name fallback ──────────────────────────────────────────────────
    if len(scored) < 3:
        use_emb = sup_emb is not None and emb_index is not None
        threshold = EMB_CANDIDATE_THRESHOLD if use_emb else CANDIDATE_THRESHOLD
        for p in products:
            name_norm = p.normalized_name or normalize_name(p.name or "")
            if not name_norm:
                continue
            p_emb = emb_index.get((p.sku, p.store_id)) if use_emb else None
            if use_emb and p_emb:
                score = _cosine(sup_emb, p_emb)  # type: ignore[arg-type]
            else:
                score = _score(sup_tokens, set(name_norm.split()))
            if score >= threshold:
                key = (p.sku, p.store_id)
                if key not in seen_sku:
                    seen_sku.add(key)
                    scored.append({
                        "sku": p.sku,
                        "store_id": p.store_id,
                        "product_name": p.name or p.sku,
                        "score": round(score, 3),
                        "match_by": "name_emb" if (use_emb and p_emb) else "name",
                    })

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_n]


def run_auto_matching(supplier: str, db: Session) -> dict[str, int]:
    """
    Запускает авто-матчинг для всех позиций поставщика.
    Возвращает статистику: {auto_confirmed, pending, skipped}.
    """
    supplier_prices = db.query(SupplierPrice).filter(SupplierPrice.supplier == supplier).all()
    products = db.query(Product).all()

    # Индекс SKU → продукт (приоритет store_id=1 при дублях)
    sku_index: dict[str, Product] = {}
    for p in products:
        sku_norm = _normalize_sku(p.sku)
        if sku_norm and (sku_norm not in sku_index or p.store_id == 1):
            sku_index[sku_norm] = p

    # Name-index (запасной)
    name_index: dict[str, Product] = {}
    for p in products:
        name_norm = p.normalized_name or normalize_name(p.name or "")
        if name_norm and (name_norm not in name_index or p.store_id == 1):
            name_index[name_norm] = p

    # Существующие матчи
    existing: dict[str, ProductMatch] = {
        m.supplier_normalized: m
        for m in db.query(ProductMatch)
        .filter(ProductMatch.supplier == supplier)
        .all()
    }

    global_auto = get_setting("auto_match_enabled")
    stats = {"auto_confirmed": 0, "pending": 0, "skipped": 0, "auto_review": 0}

    # Строим индекс эмбеддингов продуктов
    emb_index = _build_emb_index(products)

    for sp in supplier_prices:
        norm = sp.normalized_name
        if not norm:
            continue

        sup_emb = _load_emb(sp.name_embedding)

        if norm in existing:
            m = existing[norm]
            m.supplier_price = sp.price
            if m.status == "awaiting_price":
                m.status = "confirmed"
                stats["auto_confirmed"] += 1
                continue
            if m.status in ("confirmed", "stoplist"):
                stats["skipped"] += 1
                continue
            if m.status == "auto_review":
                stats["auto_review"] += 1
                continue
            if m.auto_match is False:
                stats["pending"] += 1
                continue
            _try_auto_confirm(m, norm, sku_index, name_index, global_auto=global_auto,
                              sup_emb=sup_emb, emb_index=emb_index)
            if m.status == "confirmed":
                stats["auto_confirmed"] += 1
            elif m.status == "auto_review":
                stats["auto_review"] += 1
            else:
                stats["pending"] += 1
        else:
            m = ProductMatch(
                supplier=supplier,
                supplier_name=sp.name,
                supplier_normalized=norm,
                supplier_price=sp.price,
                status="pending",
            )
            _try_auto_confirm(m, norm, sku_index, name_index, global_auto=global_auto,
                              sup_emb=sup_emb, emb_index=emb_index)
            db.add(m)
            existing[norm] = m
            if m.status == "confirmed":
                stats["auto_confirmed"] += 1
            elif m.status == "auto_review":
                stats["auto_review"] += 1
            else:
                stats["pending"] += 1

    db.commit()
    return stats


def _try_auto_confirm(
    m: ProductMatch,
    norm: str,
    sku_index: dict[str, Product],
    name_index: dict[str, Product],
    global_auto: bool = True,
    sup_emb: Optional[List[float]] = None,
    emb_index: Optional[EmbIndex] = None,
) -> None:
    """Пробует авто-подтвердить матч по SKU (приоритет) или имени.

    SKU-first: токен-based (эмбеддинги не помогают для кодов).
    Name fallback: cosine similarity если эмбеддинги доступны, иначе токены.
    """
    sup_tokens = set(norm.split())
    use_emb = sup_emb is not None and emb_index is not None

    # ── SKU-first (токен-based) ────────────────────────────────────────────
    best_score = 0.0
    best_product: Product | None = None
    exact_product: Product | None = None

    for sku_norm, p in sku_index.items():
        if sku_norm == norm:
            exact_product = p
            break
        score = _score(sup_tokens, set(sku_norm.split()))
        if score > best_score:
            best_score = score
            best_product = p

    def _is_blocked(p: Product) -> bool:
        return bool(m.blocked_sku and m.blocked_store_id
                    and p.sku == m.blocked_sku and p.store_id == m.blocked_store_id)

    if exact_product and not _is_blocked(exact_product):
        m.best_score = 1.0
        if global_auto:
            _fill_confirmed(m, exact_product, "auto")
        else:
            _fill_auto_review(m, exact_product, match_type="exact")
        return

    if best_product and best_score >= AUTO_CONFIRM_THRESHOLD and not _is_blocked(best_product):
        m.best_score = round(best_score, 3)
        _fill_auto_review(m, best_product)
        return

    # ── Name fallback (cosine similarity если доступно) ───────────────────
    name_best = 0.0
    name_product: Product | None = None
    name_exact: Product | None = None
    auto_threshold = EMB_AUTO_THRESHOLD if use_emb else AUTO_CONFIRM_THRESHOLD

    for name_norm, p in name_index.items():
        if name_norm == norm:
            name_exact = p
            break
        p_emb = emb_index.get((p.sku, p.store_id)) if use_emb else None
        if use_emb and p_emb:
            score = _cosine(sup_emb, p_emb)  # type: ignore[arg-type]
        else:
            score = _score(sup_tokens, set(name_norm.split()))
        if score > name_best:
            name_best = score
            name_product = p

    if name_exact and not _is_blocked(name_exact):
        m.best_score = 1.0
        if global_auto:
            _fill_confirmed(m, name_exact, "auto")
        else:
            _fill_auto_review(m, name_exact, match_type="exact")
        return

    m.best_score = round(max(best_score, name_best), 3)

    if name_product and name_best >= auto_threshold and not _is_blocked(name_product):
        _fill_auto_review(m, name_product)


def _fill_confirmed(m: ProductMatch, p: Product, match_type: str) -> None:
    m.sku = p.sku
    m.store_id = p.store_id
    m.product_name = p.name or p.sku
    m.status = "confirmed"
    m.match_type = match_type
    if match_type == "auto":
        m.confirmed_at = datetime.utcnow()


def _fill_auto_review(m: ProductMatch, p: Product, match_type: str = "auto") -> None:
    """Заполняет предложенный матч — ждёт ручного апрува."""
    m.sku = p.sku
    m.store_id = p.store_id
    m.product_name = p.name or p.sku
    m.status = "auto_review"
    m.match_type = match_type  # "auto" или "exact"


def get_supplier_similar(
    supplier_normalized: str,
    supplier: str,
    db: Session,
    top_n: int = 6,
    min_score: float = 0.2,
) -> list[dict]:
    """
    Находит похожие позиции в текущем прайсе того же поставщика.
    Используется для вкладки «Пропали из прайса».
    """
    prices = db.query(SupplierPrice).filter(SupplierPrice.supplier == supplier).all()
    scored = []
    for sp in prices:
        if not sp.normalized_name:
            continue
        score = _score_str(supplier_normalized, sp.normalized_name)
        if score >= min_score:
            scored.append({
                "name": sp.name,
                "normalized_name": sp.normalized_name,
                "price": sp.price,
                "score": round(score, 3),
            })
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_n]


def enrich_with_candidates(matches: list[ProductMatch], db: Session) -> list[dict[str, Any]]:
    """Добавляет поле candidates к pending-матчам."""
    products = db.query(Product).all()
    emb_index = _build_emb_index(products)

    # Кеш эмбеддингов поставщиков (supplier_normalized → embedding)
    sup_emb_cache: dict[str, Optional[List[float]]] = {}
    for m in matches:
        if m.status == "pending" and m.supplier_normalized not in sup_emb_cache:
            sp = db.query(SupplierPrice).filter(
                SupplierPrice.supplier == m.supplier,
                SupplierPrice.normalized_name == m.supplier_normalized,
            ).first()
            sup_emb_cache[m.supplier_normalized] = _load_emb(sp.name_embedding) if sp else None

    result = []
    for m in matches:
        d = {
            "id": m.id,
            "supplier": m.supplier,
            "supplier_name": m.supplier_name,
            "supplier_normalized": m.supplier_normalized,
            "supplier_price": m.supplier_price,
            "sku": m.sku,
            "store_id": m.store_id,
            "product_name": m.product_name,
            "status": m.status,
            "match_type": m.match_type,
            "created_at": m.created_at.isoformat() if m.created_at else None,
            "candidates": (
                get_candidates(
                    m.supplier_normalized, products,
                    sup_emb=sup_emb_cache.get(m.supplier_normalized),
                    emb_index=emb_index,
                )
                if m.status == "pending"
                else []
            ),
        }
        result.append(d)
    return result
