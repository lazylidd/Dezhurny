import pytest
from price_engine.calculator import _tariffs_total, calculate_shelf_price


class TestTariffsTotal:
    def test_single_fee(self):
        tariffs = [{"type": "FEE", "amount": 100.0}]
        assert _tariffs_total(tariffs, 0.0, 1000.0) == pytest.approx(100.0)

    def test_multiple_types(self):
        tariffs = [
            {"type": "FEE", "amount": 80.0},
            {"type": "DELIVERY", "amount": 50.0},
        ]
        assert _tariffs_total(tariffs, 0.0, 1000.0) == pytest.approx(130.0)

    def test_early_ship_discount_applied_to_fee(self):
        # fee_discount_pp=10, price=1000 → discount = 100 → total = 200 - 100 = 100
        tariffs = [{"type": "FEE", "amount": 200.0}]
        assert _tariffs_total(tariffs, 10.0, 1000.0) == pytest.approx(100.0)

    def test_early_ship_discount_no_fee_type(self):
        # discount only applies when FEE type present; DELIVERY alone — no discount
        tariffs = [{"type": "DELIVERY", "amount": 50.0}]
        assert _tariffs_total(tariffs, 10.0, 1000.0) == pytest.approx(50.0)

    def test_empty_tariffs(self):
        assert _tariffs_total([], 0.0, 500.0) == pytest.approx(0.0)

    def test_missing_amount_treated_as_zero(self):
        tariffs = [{"type": "FEE"}]
        assert _tariffs_total(tariffs, 0.0, 500.0) == pytest.approx(0.0)


class _FakeProduct:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _FakeStore:
    default_roi = 0.20
    tax_rate = 0.06
    early_ship_discount = 0.0
    selling_program = "FBS"
    payout_frequency = "MONTHLY"


class TestCalculateShelfPriceFallback:
    """Tests for the no-API fallback path (no dims or no category_id)."""

    def test_no_dims_uses_commission(self):
        product = _FakeProduct(
            weight=None, length=None, width=None, height=None,
            category_id=123, commission=20.0, roi=None,
        )
        store = _FakeStore()
        # commission=20% (stored as 20.0 > 1 → /100 = 0.20), tax=0.06, roi=0.20
        # denom = 1 - 0.20 - 0.06 = 0.74
        # shelf = 100 * 1.20 / 0.74 ≈ 162.16
        price, err, tariffs, eff_rate = calculate_shelf_price(None, product, 100.0, store)
        assert err is None
        assert tariffs is None
        assert price == pytest.approx(162.16, abs=0.01)
        assert eff_rate == pytest.approx(0.20)

    def test_no_category_uses_commission(self):
        product = _FakeProduct(
            weight=1.0, length=30.0, width=20.0, height=10.0,
            category_id=None, commission=30.0, roi=None,
        )
        store = _FakeStore()
        # commission=30% → 0.30, denom = 1 - 0.30 - 0.06 = 0.64
        # shelf = 100 * 1.20 / 0.64 = 187.5
        price, err, tariffs, eff_rate = calculate_shelf_price(None, product, 100.0, store)
        assert err is None
        assert price == pytest.approx(187.5)

    def test_no_dims_no_commission_returns_error(self):
        product = _FakeProduct(
            weight=None, length=None, width=None, height=None,
            category_id=123, commission=None, roi=None,
        )
        price, err, tariffs, eff_rate = calculate_shelf_price(None, product, 100.0, _FakeStore())
        assert price is None
        assert err is not None
        assert "синхронизацию" in err.lower() or "комиссии" in err.lower()

    def test_commission_too_high_returns_error(self):
        # commission=95% + tax=6% = 101% → denom ≤ 0
        product = _FakeProduct(
            weight=None, length=None, width=None, height=None,
            category_id=None, commission=95.0, roi=None,
        )
        price, err, tariffs, eff_rate = calculate_shelf_price(None, product, 100.0, _FakeStore())
        assert price is None
        assert err is not None

    def test_product_roi_overrides_store_default(self):
        product = _FakeProduct(
            weight=None, length=None, width=None, height=None,
            category_id=None, commission=20.0, roi=0.50,
        )
        store = _FakeStore()
        # roi=0.50, commission=0.20, tax=0.06, denom=0.74
        # shelf = 100 * 1.50 / 0.74 ≈ 202.70
        price, err, _, _ = calculate_shelf_price(None, product, 100.0, store)
        assert err is None
        assert price == pytest.approx(202.70, abs=0.01)

    def test_commission_stored_as_fraction(self):
        # commission=0.20 (already a fraction, ≤ 1 → not divided by 100)
        product = _FakeProduct(
            weight=None, length=None, width=None, height=None,
            category_id=None, commission=0.20, roi=None,
        )
        price_frac, _, _, _ = calculate_shelf_price(None, product, 100.0, _FakeStore())

        product2 = _FakeProduct(
            weight=None, length=None, width=None, height=None,
            category_id=None, commission=20.0, roi=None,
        )
        price_pct, _, _, _ = calculate_shelf_price(None, product2, 100.0, _FakeStore())

        assert price_frac == pytest.approx(price_pct)
