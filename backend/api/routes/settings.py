from fastapi import APIRouter

import api.state as state
from tasks.scheduler import reschedule_sync
from utils.settings import get_all as get_all_settings, get_setting, set_setting

router = APIRouter(tags=["settings"])

_SYNC_INTERVAL_KEYS = {"sync_interval_min", "sync_interval_max"}


@router.get("/settings")
def get_settings():
    return get_all_settings()


@router.post("/settings")
def update_settings(body: dict):
    for key, value in body.items():
        set_setting(key, value)
    if state._scheduler is not None and _SYNC_INTERVAL_KEYS.intersection(body.keys()):
        reschedule_sync(state._scheduler)
    return get_all_settings()
