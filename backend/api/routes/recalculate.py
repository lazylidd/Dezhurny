import json
import threading
import time

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

import api.state as state
from services.recalc_service import run_recalc_background

router = APIRouter(tags=["recalculate"])


@router.post("/stores/{store_id}/recalculate")
def recalculate(store_id: int, force: bool = False):
    with state._recalc_start_lock:
        current = state._recalc_state.get(store_id, {})
        is_running = current.get("status") == "running"
        if not is_running or force:
            if is_running and force:
                current["stop_requested"] = True
            state._recalc_state[store_id] = {
                "status": "running",
                "done": 0, "total": 0, "api_calls": 0,
                "result": None, "error": None, "stop_requested": False,
            }
            threading.Thread(target=run_recalc_background, args=(store_id,), daemon=True).start()

    def generate():
        while True:
            st = state._recalc_state.get(store_id, {"status": "idle"})
            status = st.get("status", "idle")
            yield f"data: {json.dumps({'type': 'progress', 'done': st.get('done', 0), 'total': st.get('total', 0), 'api_calls': st.get('api_calls', 0)})}\n\n"
            if status == "done":
                yield f"data: {json.dumps({'type': 'done', **(st.get('result') or {})})}\n\n"
                break
            elif status == "error":
                yield f"data: {json.dumps({'type': 'error', 'message': st.get('error', '')})}\n\n"
                break
            time.sleep(0.3)

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.get("/stores/{store_id}/recalculate/status")
def recalculate_status(store_id: int):
    st = state._recalc_state.get(store_id, {"status": "idle"})
    return {
        "status": st.get("status", "idle"),
        "done": st.get("done", 0),
        "total": st.get("total", 0),
        "api_calls": st.get("api_calls", 0),
        "result": st.get("result"),
        "error": st.get("error"),
    }


@router.post("/stores/{store_id}/recalculate/stop")
def recalculate_stop(store_id: int):
    st = state._recalc_state.get(store_id)
    if st and st.get("status") == "running":
        st["stop_requested"] = True
    return {"ok": True}
