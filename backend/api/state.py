import threading

# Справочник id→slug магазинов (fallback когда Store не найден в БД)
STORES: dict[int, str] = {1: "yam16", 2: "yam21"}

# Состояние фонового пересчёта цен — ключ: store_id
_recalc_state: dict[int, dict] = {}
_recalc_start_lock = threading.Lock()

# Состояние фонового применения цен (одна операция за раз)
_apply_state: dict = {"status": "idle"}
_apply_start_lock = threading.Lock()

# APScheduler — устанавливается в lifespan main.py
_scheduler = None
