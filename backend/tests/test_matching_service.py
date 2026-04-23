import pytest
from services.matching_service import _score, _score_str


class TestScore:
    def test_identical_tokens(self):
        assert _score({"apple", "16gb"}, {"apple", "16gb"}) == pytest.approx(1.0)

    def test_disjoint_tokens(self):
        assert _score({"apple"}, {"samsung"}) == 0.0

    def test_empty_query(self):
        assert _score(set(), {"apple"}) == 0.0

    def test_empty_target(self):
        assert _score({"apple"}, set()) == 0.0

    def test_partial_overlap_jaccard(self):
        # A={a,b,c}, B={b,c,d} → common=2, union=4 → jaccard=0.5
        # coverage = 2/3 (smaller=3), scaled = 0.85 * 2/3 ≈ 0.567
        # base = max(0.5, 0.567) ≈ 0.567
        score = _score({"a", "b", "c"}, {"b", "c", "d"})
        assert 0.55 < score < 0.60

    def test_subset_triggers_coverage(self):
        # query ⊂ target → coverage = 1.0, scaled = 0.85 → base = max(jaccard, 0.85)
        score = _score({"iphone"}, {"iphone", "pro", "max"})
        assert score == pytest.approx(0.85)

    def test_numeric_bonus_applied(self):
        # both sets share numeric token "16gb" → num_coverage = 1.0 → bonus = 0.15
        score_with_num = _score({"sony", "16gb"}, {"sony", "16gb"})
        score_no_num = _score({"sony", "abc"}, {"sony", "abc"})
        assert score_with_num == pytest.approx(1.0)
        assert score_no_num == pytest.approx(1.0)

    def test_numeric_mismatch_no_bonus(self):
        # numeric tokens present but differ → num_coverage = 0.0 → no bonus
        score = _score({"sony", "16gb"}, {"sony", "32gb"})
        # common={"sony"}, union={"sony","16gb","32gb"} → jaccard=1/3
        # coverage = 1/2 (smaller=2 for {"sony","16gb"}), scaled = 0.85*0.5 = 0.425
        # base = max(1/3, 0.425) ≈ 0.425, bonus = 0 (num_coverage=0)
        assert score == pytest.approx(0.425)


class TestScoreStr:
    def test_identical_strings(self):
        assert _score_str("iphone 15 pro", "iphone 15 pro") == pytest.approx(1.0)

    def test_disjoint_strings(self):
        assert _score_str("apple", "samsung") == 0.0

    def test_partial(self):
        # No numeric tokens so bonus=0; query⊃target → coverage=1.0 → scaled=0.85
        # query={"iphone","pro","max","ultra"}, target={"iphone","pro","max"}
        # common=3, jaccard=3/4=0.75, coverage=3/3=1.0 → base=max(0.75,0.85)=0.85
        s = _score_str("iphone pro max ultra", "iphone pro max")
        assert s == pytest.approx(0.85)

    def test_case_sensitive(self):
        # _score_str uses str.split(), no lowercasing — tokens differ by case
        assert _score_str("Apple", "apple") == 0.0
