from sqlalchemy import Boolean, Column, Date, DateTime, Float, Integer, String, func

from database.db import Base


class Order(Base):
    __tablename__ = "orders"

    id = Column(Integer, primary_key=True, index=True)
    store_id = Column(Integer, index=True, nullable=False)
    order_id = Column(String, nullable=False, index=True)   # YM order ID
    offer_name = Column(String, nullable=True)              # название товара
    sku = Column(String, nullable=True)                     # сопоставленный SKU
    market_price = Column(Float, nullable=True)             # цена продажи
    buyer_payment = Column(Float, nullable=True)            # платёж покупателя
    all_services_fee = Column(Float, nullable=True)         # все услуги маркета
    supplier_price = Column(Float, nullable=True)           # цена закупки (из матчинга или вручную)
    supplier_price_matched = Column(Float, nullable=True)  # цена закупки из матча (не перезаписывается вручную)
    supplier_price_is_manual = Column(Boolean, nullable=False, server_default='false')  # True = введено вручную
    commission_amount = Column(Float, nullable=True)        # комиссия маркета (тариф за размещение), руб
    promo_discount = Column(Float, nullable=True)           # скидка за участие в совместных акциях, руб
    tax_amount = Column(Float, nullable=True)               # налог, руб
    order_kind = Column(String, nullable=True)              # normal / nonpickup / return
    order_date = Column(Date, nullable=True)                # дата заказа (из отчёта/API)
    shipment_date = Column(Date, nullable=True)             # дата отгрузки из ЯМ API (supplierShipmentDate)
    fee_breakdown = Column(String, nullable=True)           # JSON: детализация комиссий {placement, logistics, payment, bonus, other}
    quantity = Column(Integer, nullable=True, server_default='1')  # кол-во товаров в заказе
    ym_status = Column(String, nullable=True)               # PROCESSING / READY_TO_SHIP / DELIVERY / PICKUP / DELIVERED / NONPICKUP / RETURNED
    payment_date = Column(Date, nullable=True)              # дата выплаты (paymentOrder.date из stats/orders)
    serial_number = Column(String, nullable=True)           # серийный номер (вводится вручную)
    created_at = Column(DateTime, server_default=func.now())
