"""Nearby emergency departments we can suggest to stable walk-ins when we're full.

Capacity and waits are SIMULATED for the demo (no public real-time feed exists). The base waits
could be shaped by Apify "popular times" data per hospital.
"""
import asyncio
import json
import random
from datetime import datetime
from pathlib import Path

import routing
import stdb

BUSYNESS_FILE = Path(__file__).parent / "data" / "network_busyness.json"
DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]

# ER-entrance coordinates come from the Apify Google Maps scrape. Annual ED visits (HCAI 2025) are
# real and shown for context; beds free and waits are simulated.
HOSPITALS = [
    # id, name, lat, lng, base beds free, base wait (min)
    (1, "Kaiser Permanente SF (Geary)", 37.78220, -122.44263, 4, 15),    # 33,458 ED visits
    (2, "UCSF Parnassus ED", 37.76337, -122.45742, 2, 35),               # 39,855
    (3, "Zuckerberg SF General", 37.75559, -122.40549, 3, 45),           # 50,799 (trauma center)
    (4, "UCSF Health St. Mary's", 37.77429, -122.45440, 3, 20),          # 12,836
]

_state: dict[int, list[int]] = {}  # id -> [beds_free, wait]


async def seed() -> None:
    _state.clear()
    for hid, name, lat, lng, beds, wait in HOSPITALS:
        _state[hid] = [beds, wait]
        await stdb.call("set_hospital", hid, name, lat, lng, beds, wait)


def _busyness_now(hid: int) -> float | None:
    """Google popular-times busyness (0-100) for this hospital right now, if we scraped it."""
    if not BUSYNESS_FILE.exists():
        return None
    days = json.loads(BUSYNESS_FILE.read_text(encoding="utf-8")).get(str(hid))
    if not days:
        return None
    now = datetime.now()
    return days[DAYS[now.weekday()]][now.hour]


async def drift() -> None:
    """Nudge simulated capacity so the panel feels live. With scraped popular times, the wait
    drifts toward a target that follows that hospital's real busyness for this hour."""
    for hid, name, lat, lng, base_beds, base_wait in HOSPITALS:
        beds, wait = _state.setdefault(hid, [base_beds, base_wait])
        busy = _busyness_now(hid)
        target = base_wait if busy is None else round(base_wait * (0.5 + busy / 100))
        step = 5 if target > wait else -5 if target < wait - 4 else random.choice([-5, 0, 0, 5])
        beds = max(0, min(base_beds + 2, beds + random.choice([-1, 0, 0, 1])))
        wait = max(5, min(base_wait + 30, wait + step))
        _state[hid] = [beds, wait]
        await stdb.call("set_hospital", hid, name, lat, lng, beds, wait)


async def best_alternative(lat: float, lng: float) -> dict | None:
    """Hospital with free beds and the lowest drive + wait time from the patient's position."""
    async def option(h):
        hid, name, hlat, hlng, base_beds, base_wait = h
        beds, wait = _state.get(hid, [base_beds, base_wait])
        if beds == 0:
            return None
        seconds, _ = await routing.route(lat, lng, hlat, hlng)
        drive = max(1, round(seconds / 60))
        return {"hospitalId": hid, "name": name, "lat": hlat, "lng": hlng,
                "driveMinutes": drive, "waitMinutes": wait, "total": drive + wait}

    options = [o for o in await asyncio.gather(*(option(h) for h in HOSPITALS)) if o]
    return min(options, key=lambda o: o["total"]) if options else None
