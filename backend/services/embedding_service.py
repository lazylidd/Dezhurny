"""
Embedding service — Ollama (nomic-embed-text).

Используется для семантического матчинга поставщик → SKU.
Если Ollama недоступна, функции возвращают None / False —
система автоматически использует токен-based fallback.
"""
from __future__ import annotations

from typing import Optional, List

import requests

OLLAMA_URL = "http://localhost:11434/api/embeddings"
MODEL = "nomic-embed-text"


def embed(text: str) -> Optional[List[float]]:
    """Получить эмбеддинг текста. None если Ollama недоступна или ошибка."""
    try:
        r = requests.post(
            OLLAMA_URL,
            json={"model": MODEL, "prompt": text},
            timeout=30,
        )
        r.raise_for_status()
        return r.json()["embedding"]
    except Exception:
        return None


def is_available() -> bool:
    """Проверить доступность Ollama."""
    try:
        r = requests.get("http://localhost:11434/api/tags", timeout=3)
        return r.ok
    except Exception:
        return False
