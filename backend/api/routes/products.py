import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from api.deps import get_db
from models.product import Product
from models.product_match import ProductMatch
from models.store import Store
from models.supplier_price import SupplierPrice
from schemas.product_schema import ProductOut
from services.matching_service import _score_str
from services.yam_client import get_client_for_store
from utils.normalizer import normalize_name

logger = logging.getLogger(__name__)
router = APIRouter(tags=["products"])


@router.patch("/products/{product_id}", response_model=ProductOut)
def update_product(
    product_id: int,
    enabled: Optional[bool] = None,
    roi: Optional[float] = None,
    stock: Optional[int] = None,
    db: Session = Depends(get_db),
):
    p = db.query(Product).filter(Product.id == product_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Product not found")
    was_enabled = p.enabled
    if enabled is not None:
        p.enabled = enabled
    if roi is not None:
        p.roi = roi
    if enabled is False and was_enabled:
        _store = db.query(Store).filter(Store.id == p.store_id).first()
        if _store:
            try:
                client, _, campaign_ids = get_client_for_store(_store.name, db=db)
                for campaign_id in campaign_ids:
                    client.update_stock(campaign_id, p.sku, 0)
                p.status = "zeroed"
                p.stock = 0
            except Exception as e:
                logger.error("Не удалось обнулить %s: %s", p.sku, e)
                p.status = "error"
    elif stock is not None:
        _store = db.query(Store).filter(Store.id == p.store_id).first()
        if _store:
            try:
                client, _, campaign_ids = get_client_for_store(_store.name, db=db)
                for campaign_id in campaign_ids:
                    client.update_stock(campaign_id, p.sku, stock)
                p.stock = stock
            except Exception as e:
                logger.error("Не удалось обновить остаток %s: %s", p.sku, e)
                raise HTTPException(status_code=502, detail=f"ЯМ API error: {e}")
        else:
            p.stock = stock
    db.commit()
    db.refresh(p)
    return p


@router.get("/products/unmatched")
def get_unmatched_products(db: Session = Depends(get_db)):
    matched_pairs = {
        (r.sku, r.store_id)
        for r in db.query(ProductMatch.sku, ProductMatch.store_id)
        .filter(
            ProductMatch.status.in_(["confirmed", "auto_review"]),
            ProductMatch.sku.isnot(None),
        ).all()
    }
    products = db.query(Product).filter(Product.enabled == True).all()  # noqa: E712
    return [
        {"store_id": p.store_id, "sku": p.sku, "name": p.name, "price": p.price, "category": p.category}
        for p in products if (p.sku, p.store_id) not in matched_pairs
    ]


@router.get("/products/{store_id}/{sku}/supplier-candidates")
def get_product_supplier_candidates(store_id: int, sku: str, db: Session = Depends(get_db)):
    product = db.query(Product).filter(Product.store_id == store_id, Product.sku == sku).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    sku_norm = normalize_name(sku)
    name_norm = product.normalized_name or normalize_name(product.name or "")
    matches_index: dict[tuple, ProductMatch] = {
        (m.supplier, m.supplier_normalized): m
        for m in db.query(ProductMatch).all()
    }
    CANDIDATE_THRESHOLD = 0.15
    scored = []
    for sp in db.query(SupplierPrice).all():
        if not sp.normalized_name:
            continue
        score = max(
            _score_str(sku_norm, sp.normalized_name) if sku_norm else 0.0,
            _score_str(name_norm, sp.normalized_name) if name_norm else 0.0,
        )
        if score >= CANDIDATE_THRESHOLD:
            match = matches_index.get((sp.supplier, sp.normalized_name))
            scored.append({
                "match_id": match.id if match else None,
                "supplier": sp.supplier, "supplier_name": sp.name,
                "supplier_normalized": sp.normalized_name, "supplier_price": sp.price,
                "score": round(score, 3),
                "match_status": match.status if match else None,
            })
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:8]


@router.post("/products/{store_id}/{sku}/confirm-supplier")
def confirm_supplier_for_product(
    store_id: int, sku: str,
    supplier: str, supplier_normalized: str,
    db: Session = Depends(get_db),
):
    from datetime import datetime
    product = db.query(Product).filter(Product.store_id == store_id, Product.sku == sku).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    match = db.query(ProductMatch).filter(
        ProductMatch.supplier == supplier,
        ProductMatch.supplier_normalized == supplier_normalized,
    ).first()
    if not match:
        sp = db.query(SupplierPrice).filter(
            SupplierPrice.supplier == supplier,
            SupplierPrice.normalized_name == supplier_normalized,
        ).first()
        if not sp:
            raise HTTPException(status_code=404, detail="Supplier price not found")
        match = ProductMatch(
            supplier=sp.supplier, supplier_name=sp.name,
            supplier_normalized=sp.normalized_name, supplier_price=sp.price,
            status="pending",
        )
        db.add(match)
        db.flush()
    match.sku = sku
    match.store_id = store_id
    match.product_name = product.name
    match.status = "confirmed"
    match.match_type = "manual"
    match.confirmed_at = datetime.utcnow()
    db.commit()
    return {"id": match.id, "status": match.status}
