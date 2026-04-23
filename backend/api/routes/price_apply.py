import json
import threading
import time

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

import api.state as state
from services.price_service import run_apply_background

router = APIRouter(tags=["price-apply"])


@router.post("/apply-price-updates")
def apply_price_updates(store_id: int = None, force: bool = False):
    with state._apply_start_lock:
        current = state._apply_state.get("status", "idle")
        if current != "running" or force:
            state._apply_state.clear()
            state._apply_state.update({
                "status": "running",
                "phase": None,
                "current_store": None,
                "next_store": None,
                "applied": 0,
                "wait_total": 0,
                "wait_remaining": 0,
                "result": None,
                "error": None,
                "stop_requested": False,
            })
            threading.Thread(target=run_apply_background, args=(store_id,), daemon=True).start()

    def generate():
        while True:
            s = state._apply_state
            status = s.get("status", "idle")

            if s.get("phase") == "waiting":
                data = json.dumps({
                    "type": "progress", "phase": "waiting",
                    "current_store": s.get("current_store"),
                    "next_store": s.get("next_store"),
                    "wait_remaining": s.get("wait_remaining", 0),
                    "wait_total": s.get("wait_total", 0),
                    "applied": s.get("applied", 0),
                })
            else:
                data = json.dumps({
                    "type": "progress",
                    "phase": s.get("phase") or "starting",
                    "current_store": s.get("current_store"),
                    "applied": s.get("applied", 0),
                })

            yield f"data: {data}\n\n"

            if status == "done":
                yield f"data: {json.dumps({'type': 'done', **(s.get('result') or {})})}\n\n"
                break
            elif status == "error":
                yield f"data: {json.dumps({'type': 'error', 'message': s.get('error', '')})}\n\n"
                break

            time.sleep(0.5)

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.get("/apply-price-updates/status")
def apply_status():
    s = state._apply_state
    return {
        "status": s.get("status", "idle"),
        "phase": s.get("phase"),
        "current_store": s.get("current_store"),
        "next_store": s.get("next_store"),
        "applied": s.get("applied", 0),
        "wait_remaining": s.get("wait_remaining", 0),
        "wait_total": s.get("wait_total", 0),
        "result": s.get("result"),
        "error": s.get("error"),
    }


@router.post("/apply-price-updates/stop")
def apply_stop():
    if state._apply_state.get("status") == "running":
        state._apply_state["stop_requested"] = True
    return {"ok": True}
