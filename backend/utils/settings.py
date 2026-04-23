"""Простое хранилище глобальных настроек приложения (JSON-файл)."""
from __future__ import annotations

import json
from pathlib import Path

_SETTINGS_FILE = Path(__file__).parent.parent / "data" / "settings.json"

_DEFAULTS: dict = {
    "auto_match_enabled": True,
    # Сборка: время начала приёма заказов (МСК, формат HH:MM)
    # До этого времени раздел сборки пуст; после — показываем заказы дня
    "order_cutoff_time": "10:00",
    # Анти-аффилированность: интервал авто-синхронизации (сек)
    "sync_interval_min": 1200,
    "sync_interval_max": 1800,
    # Анти-аффилированность: пауза между магазинами при синхронизации (сек)
    "sync_inter_store_delay_min": 180,
    "sync_inter_store_delay_max": 480,
    # Анти-аффилированность: jitter перед стартом синхронизации (сек)
    "sync_start_jitter_max": 120,
    # Анти-аффилированность: jitter между обновлением цены и остатка (сек)
    "price_stock_jitter_min": 30,
    "price_stock_jitter_max": 90,
    # Анти-аффилированность: пауза между магазинами при применении цен (сек)
    "apply_inter_store_delay_min": 900,
    "apply_inter_store_delay_max": 2700,
}


def _load() -> dict:
    if _SETTINGS_FILE.exists():
        try:
            return {**_DEFAULTS, **json.loads(_SETTINGS_FILE.read_text())}
        except Exception:
            pass
    return dict(_DEFAULTS)


def _save(data: dict) -> None:
    _SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def get_setting(key: str):
    return _load().get(key, _DEFAULTS.get(key))


def set_setting(key: str, value) -> None:
    s = _load()
    s[key] = value
    _save(s)


def get_all() -> dict:
    return _load()
