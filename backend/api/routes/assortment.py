import json
import os
import tempfile
import time
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, Form
from sqlalchemy import func
from sqlalchemy.orm import Session

from api.deps import get_db
from database.db import SessionLocal
from models.price_update import PriceUpdate
from models.product import Product
from models.product_match import ProductMatch
from models.store import Store
from models.supplier_price import SupplierPrice
from parsers.excel_parser import parse_excel
from parsers.pdf_parser import parse_pdf
from price_engine.calculator import calculate_shelf_price
from schemas.product_schema import ProductOut
from services import embedding_service
from services.assortment_service import sync_assortment
from services.matching_service import run_auto_matching, _score_str
from services.yam_client import get_client_for_store
from utils.normalizer import normalize_name

router = APIRouter(tags=["assortment"])


def _embed_supplier_prices_bg(suppliers: List[str]) -> None:
    if not embedding_service.is_available():
        return
    db = SessionLocal()
    try:
        for supplier in suppliers:
            sps = db.query(SupplierPrice).filter(
                SupplierPrice.supplier == supplier,
                SupplierPrice.name_embedding.is_(None),
            ).all()
            for sp in sps:
                emb = embedding_service.embed(sp.normalized_name)
                if emb:
                    sp.name_embedding = json.dumps(emb)
            db.commit()
    finally:
        db.close()


def _embed_products_bg(store_id: int) -> None:
    if not embedding_service.is_available():
        return
    db = SessionLocal()
    try:
        products = db.query(Product).filter(
            Product.store_id == store_id,
            Product.name_embedding.is_(None),
        ).all()
        for p in products:
            text = p.normalized_name or p.name or ""
            if text:
                emb = embedding_service.embed(text)
                if emb:
                    p.name_embedding = json.dumps(emb)
        db.commit()
    finally:
        db.close()


@router.get("/stores/{store_id}/assortment", response_model=List[ProductOut])
def get_assortment(store_id: int, limit: int = 500, offset: int = 0, db: Session = Depends(get_db)):
    products = (
        db.query(Product)
        .filter(Product.store_id == store_id)
        .offset(offset).limit(limit).all()
    )
    skus = [p.sku for p in products]
    if not skus:
        return []
    matches = (
        db.query(ProductMatch.sku, func.min(ProductMatch.supplier_price))
        .filter(ProductMatch.store_id == store_id, ProductMatch.status == "confirmed", ProductMatch.sku.in_(skus))
        .group_by(ProductMatch.sku).all()
    )
    sku_supplier: dict = {m[0]: m[1] for m in matches}
    latest_pus = (
        db.query(PriceUpdate)
        .filter(PriceUpdate.store_id == store_id, PriceUpdate.sku.in_(skus))
        .order_by(PriceUpdate.created_at.desc()).all()
    )
    sku_pu: dict = {}
    for pu in latest_pus:
        if pu.sku not in sku_pu:
            sku_pu[pu.sku] = pu
    result = []
    for p in products:
        out = ProductOut.model_validate(p)
        out.supplier_price = sku_supplier.get(p.sku)
        pu = sku_pu.get(p.sku)
        if pu:
            out.profit = pu.profit
            out.actual_roi = pu.actual_roi
        result.append(out)
    return result


@router.post("/stores/{store_id}/sync")
def sync_store(store_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    import random
    store = db.query(Store).filter(Store.id == store_id).first()
    if not store:
        raise HTTPException(status_code=404, detail="Store not found")
    jitter = random.randint(5, 20)
    time.sleep(jitter)
    count = sync_assortment(store.name, store_id, db)
    store.last_sync_at = datetime.now(timezone.utc)
    db.commit()
    background_tasks.add_task(_embed_products_bg, store_id)
    return {"synced": count}


@router.post("/upload-prices")
def upload_prices(
    files: List[UploadFile],
    suppliers: List[str] = Form(...),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    db: Session = Depends(get_db),
):
    if len(files) != len(suppliers):
        raise HTTPException(
            status_code=400,
            detail=f"Количество файлов ({len(files)}) не совпадает с количеством поставщиков ({len(suppliers)})",
        )
    total = 0
    affected_suppliers: set[str] = set()
    for upload, supplier in zip(files, suppliers):
        supplier = supplier.strip()
        if not supplier:
            raise HTTPException(status_code=400, detail="Название поставщика не может быть пустым")
        filename = upload.filename or ""
        ext = os.path.splitext(filename)[1].lower()
        suffix = ext if ext in (".xlsx", ".xls", ".pdf") else ".tmp"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(upload.file.read())
            tmp_path = tmp.name
        try:
            if ext in (".xlsx", ".xls"):
                items = parse_excel(tmp_path)
            elif ext == ".pdf":
                items = parse_pdf(tmp_path)
            else:
                raise HTTPException(status_code=400, detail=f"Неподдерживаемый формат: {filename}")
        finally:
            os.unlink(tmp_path)
        db.query(SupplierPrice).filter(SupplierPrice.supplier == supplier).delete()
        for item in items:
            norm = normalize_name(item["name"])
            if not norm:
                continue
            db.add(SupplierPrice(supplier=supplier, name=item["name"], normalized_name=norm, price=item["price"]))
        total += len(items)
        affected_suppliers.add(supplier)
    db.commit()

    all_match_stats: dict = {}
    no_price_count = 0
    for supplier in affected_suppliers:
        all_match_stats[supplier] = run_auto_matching(supplier, db)
        new_supplier_norms = {
            sp.normalized_name
            for sp in db.query(SupplierPrice.normalized_name)
            .filter(SupplierPrice.supplier == supplier).all()
        }
        disappeared = (
            db.query(ProductMatch)
            .filter(
                ProductMatch.supplier == supplier,
                ProductMatch.status == "confirmed",
                ProductMatch.supplier_normalized.notin_(new_supplier_norms),
            ).all()
        )
        if disappeared:
            disappeared_ids = {m.id for m in disappeared}
            disappeared_sku_store = {(m.sku, m.store_id) for m in disappeared if m.sku and m.store_id}
            other_confirmed_pairs: set[tuple] = set()
            if disappeared_sku_store:
                skus = [s for s, _ in disappeared_sku_store]
                for o in db.query(ProductMatch).filter(
                    ProductMatch.status == "confirmed",
                    ProductMatch.id.notin_(disappeared_ids),
                    ProductMatch.sku.in_(skus),
                ).all():
                    if (o.sku, o.store_id) in disappeared_sku_store:
                        other_confirmed_pairs.add((o.sku, o.store_id))
            for m in disappeared:
                if (m.sku, m.store_id) in other_confirmed_pairs:
                    continue
                m.status = "no_price"
                no_price_count += 1
    db.commit()

    combined = {
        "auto_confirmed": sum(s["auto_confirmed"] for s in all_match_stats.values()),
        "pending": sum(s["pending"] for s in all_match_stats.values()),
        "no_price": no_price_count,
    }
    background_tasks.add_task(_embed_supplier_prices_bg, list(affected_suppliers))
    return {"suppliers": list(affected_suppliers), "rows": total, "match_stats": combined}


@router.get("/suppliers")
def get_suppliers(db: Session = Depends(get_db)):
    rows = (
        db.query(SupplierPrice.supplier, func.count(SupplierPrice.id).label("count"))
        .group_by(SupplierPrice.supplier).all()
    )
    return [{"supplier": r[0], "count": r[1]} for r in rows]


@router.delete("/suppliers/{supplier}")
def delete_supplier(supplier: str, db: Session = Depends(get_db)):
    prices_deleted = db.query(SupplierPrice).filter(SupplierPrice.supplier == supplier).delete()
    matches_deleted = db.query(ProductMatch).filter(ProductMatch.supplier == supplier).delete()
    db.commit()
    return {"supplier": supplier, "prices_deleted": prices_deleted, "matches_deleted": matches_deleted}


@router.post("/matching/rerun")
def rerun_matching(supplier: str = None, db: Session = Depends(get_db)):
    q = db.query(ProductMatch).filter(ProductMatch.status == "pending")
    if supplier:
        q = q.filter(ProductMatch.supplier == supplier)
    q.delete()
    db.commit()
    suppliers_q = db.query(SupplierPrice.supplier).distinct()
    if supplier:
        suppliers_q = suppliers_q.filter(SupplierPrice.supplier == supplier)
    all_suppliers = [r[0] for r in suppliers_q.all()]
    all_stats: dict = {}
    for s in all_suppliers:
        all_stats[s] = run_auto_matching(s, db)
    return {"suppliers": all_suppliers, "stats": all_stats}


@router.get("/stores/{store_id}/debug-price")
def debug_price(store_id: int, sku: str, supplier_price: float, db: Session = Depends(get_db)):
    store = db.query(Store).filter(Store.id == store_id).first()
    if not store:
        raise HTTPException(status_code=404, detail="Store not found")
    product = db.query(Product).filter(Product.store_id == store_id, Product.sku == sku).first()
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    client, _, _ = get_client_for_store(store.name, db=db)
    tariffs_at_current = []
    if product.price and product.category_id:
        try:
            tariffs_at_current = client.calculate_tariffs(
                selling_program=store.selling_program or "FBS",
                category_id=int(product.category_id),
                price=product.price,
                length_cm=product.length or 10,
                width_cm=product.width or 10,
                height_cm=product.height or 10,
                weight_kg=product.weight or 1,
                frequency=store.payout_frequency or "MONTHLY",
            )
        except Exception as e:
            tariffs_at_current = [{"error": str(e)}]
    shelf_price, error = calculate_shelf_price(client, product, supplier_price, store)
    return {
        "product": {
            "sku": product.sku, "name": product.name, "category_id": product.category_id,
            "category": product.category, "current_price": product.price,
            "weight_kg": product.weight, "length_cm": product.length,
            "width_cm": product.width, "height_cm": product.height,
        },
        "store_settings": {
            "selling_program": store.selling_program, "payout_frequency": store.payout_frequency,
            "default_roi": store.default_roi, "tax_rate": store.tax_rate,
            "early_ship_discount_pp": store.early_ship_discount,
        },
        "input": {
            "supplier_price": supplier_price,
            "target_roi": product.roi if product.roi is not None else store.default_roi,
        },
        "tariffs_at_current_price": tariffs_at_current,
        "result": {"shelf_price": shelf_price, "error": error},
    }
