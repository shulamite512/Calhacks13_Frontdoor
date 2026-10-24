"""Nearby emergency departments we can suggest to stable walk-ins when we're full.

Capacity and waits are SIMULATED for the demo (no public real-time feed exists). The base waits
could be shaped by Apify "popular times" data per hospital.
"""
import asyncio
import random

import routing
import stdb

HOSPITALS = [
    # id, name, lat, lng, base beds free, base wait (min)
    (1, "Kaiser Permanente SF (Geary)", 37.78286, -122.44066, 4, 15),
    (2, "UCSF Parnassus ED", 37.76307, -122.45740, 2, 35),
    (3, "Zuckerberg SF General", 37.75681, -122.40525, 3, 45),
    (4, "Saint Mary's Medical Center", 37.77377, -122.45361, 3, 20),
]

_state: dict[int, list[int]] = {}  # id -> [beds_free, wait]


async def seed() -> None:
    _state.clear()
    for hid, name, lat, lng, beds, wait in HOSPITALS:
        _state[hid] = [beds, wait]
        await stdb.call("set_hospital", hid, name, lat, lng, beds, wait)


async def drift() -> None:
    """Nudge simulated capacity so the panel feels live."""
    for hid, name, lat, lng, base_beds, base_wait in HOSPITALS:
        beds, wait = _state.setdefault(hid, [base_beds, base_wait])
        beds = max(0, min(base_beds + 2, beds + random.choice([-1, 0, 0, 1])))
        wait = max(5, min(base_wait + 20, wait + random.choice([-5, 0, 0, 5])))
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
