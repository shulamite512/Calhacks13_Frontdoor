"""Nearby emergency departments: where they are, how busy they are, and which departments they can
offer, so a patient can be matched to an ER that can actually treat their condition.

REAL: locations (Apify Google Maps scrape), annual ED volumes (HCAI 2025), licensed bed types per
hospital (CDPH, data/cdph_beds_sf.json), Zuckerberg SF General = SF's Level I trauma center,
UCSF Health Hyde Hospital = 16 licensed burn beds (Bothin Burn Center).
SIMULATED: ER wait times, beds free right now, doctors on call, resource readiness.
"""
import asyncio
import json
import random
from datetime import datetime
from pathlib import Path

import routing
import stdb

DATA = Path(__file__).parent / "data"
BUSYNESS_FILE = DATA / "network_busyness.json"
CDPH_FILE = DATA / "cdph_beds_sf.json"
DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]

HOSPITALS = [
    # id, name, lat, lng, base ER beds free, base wait (min), CDPH facility name, 2025 ED visits (HCAI)
    (1, "Kaiser Permanente SF (Geary)", 37.78220, -122.44263, 4, 15, "KAISER FOUNDATION HOSPITAL - SAN FRANCISCO", 33458),
    (2, "UCSF Parnassus ED", 37.76337, -122.45742, 2, 35, "UCSF MEDICAL CENTER", 39855),
    (3, "Zuckerberg SF General", 37.75559, -122.40549, 3, 45,
     "PRISCILLA CHAN AND MARK ZUCKERBERG SAN FRANCISCO GENERAL HOSPITAL AND TRAUMA CENTER", 50799),
    (4, "UCSF Health Stanyan", 37.77429, -122.45440, 3, 20, "UCSF HEALTH STANYAN HOSPITAL", 12836),
    (5, "UCSF Health Hyde", 37.79005, -122.41675, 3, 25, "UCSF HEALTH HYDE HOSPITAL", 18769),
]

# Department order matches departments.py at our ER; id = hospital_id * 100 + index.
DEPT_NAMES = ["Cardiology", "Neurology", "Surgery", "ICU", "Pediatrics", "Trauma", "Orthopedics",
              "Obstetrics", "Psychiatry", "Gastroenterology", "Pulmonology", "Nephrology", "Burns"]
RESOURCES = {
    "Cardiology": "Cath lab", "Neurology": "CT scanner", "Surgery": "Operating room", "ICU": "Ventilators",
    "Pediatrics": "Peds ED bay", "Trauma": "Trauma team", "Orthopedics": "Splint/cast room",
    "Obstetrics": "Labor & delivery", "Psychiatry": "Safe room", "Gastroenterology": "Endoscopy suite",
    "Pulmonology": "BiPAP machines", "Nephrology": "Dialysis", "Burns": "Burn unit",
}
# Keep the demo predictable: these departments start ready.
DEMO_READY = {(1, "Surgery"), (3, "Surgery"), (3, "Trauma"), (5, "Burns"), (1, "Cardiology"), (2, "Cardiology")}

_state: dict[int, list[int]] = {}  # id -> [beds_free, wait]


def _cdph() -> dict[str, dict[str, int]]:
    if not CDPH_FILE.exists():
        return {}
    return json.loads(CDPH_FILE.read_text(encoding="utf-8"))["facilities"]


def departments_for(hid: int, cdph_name: str) -> list[tuple]:
    """(id, hospital_id, name, bed label, free, total, doctors, resource, ready, note) per department."""
    beds = _cdph().get(cdph_name, {})
    icu, ccu = beds.get("INTENSIVE CARE", 0), beds.get("CORONARY CARE", 0)
    rnd = random.Random(hid)
    rows = []
    for i, name in enumerate(DEPT_NAMES, start=1):
        total, label, note = 6, f"{name.lower()} beds", "Beds come from general acute (simulated split)"
        if name == "Cardiology":
            total, label = (ccu, "coronary care beds") if ccu else (min(icu, 4), "cardiac ICU beds")
            note = f"{ccu} licensed coronary care beds (CDPH)" if ccu else "Cardiac patients use the ICU pool"
        elif name == "Neurology":
            total, label, note = (2 if icu else 0), "neuro ICU beds", "Beds come from the ICU pool"
        elif name == "ICU":
            total, label, note = icu, "ICU beds", f"{icu} licensed ICU beds (CDPH)"
        elif name == "Pediatrics":
            total = beds.get("PEDIATRIC", 0)
            label, note = "peds beds", (f"{total} licensed pediatric beds (CDPH)" if total else "No licensed pediatric beds (CDPH)")
        elif name == "Obstetrics":
            total = beds.get("PERINATAL", 0)
            label, note = "perinatal beds", (f"{total} licensed perinatal beds (CDPH)" if total else "No licensed perinatal beds (CDPH)")
        elif name == "Burns":
            total = beds.get("BURN", 0)
            label, note = "burn beds", (f"{total} licensed burn beds (CDPH), Bothin Burn Center" if total else "No licensed burn beds (CDPH)")
        elif name == "Trauma":
            total = 6 if hid == 3 else 0
            label, note = "trauma bays", ("San Francisco's Level I trauma center" if total else "Not a trauma center")
        elif name == "Psychiatry":
            total, label = (6, "psych emergency beds") if hid == 3 else (2, "ED psych holds")
            note = "Psychiatric Emergency Services" if hid == 3 else "ED safe rooms"
        free = 0 if total == 0 else max(0, min(total, round(total * rnd.uniform(0.05, 0.3)) or rnd.choice([0, 1, 1])))
        doctors = 0 if total == 0 else (0 if rnd.random() < 0.08 else 1)
        ready = total > 0 and ((hid, name) in DEMO_READY or rnd.random() < 0.8)
        if (hid, name) in DEMO_READY:
            free, doctors = max(free, 2), max(doctors, 1)
        rows.append((hid * 100 + i, hid, name, label, free, total, doctors, RESOURCES[name], ready, note))
    return rows


async def seed() -> None:
    _state.clear()
    for hid, name, lat, lng, beds, wait, cdph_name, _visits in HOSPITALS:
        _state[hid] = [beds, wait]
        await stdb.call("set_hospital", hid, name, lat, lng, beds, wait)
        for d in departments_for(hid, cdph_name):
            await stdb.call("set_hospital_department", *d)


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
    """Nudge simulated ER capacity so the panel feels live."""
    for hid, name, lat, lng, base_beds, base_wait, _cdph_name, _visits in HOSPITALS:
        beds, wait = _state.setdefault(hid, [base_beds, base_wait])
        busy = _busyness_now(hid)
        target = base_wait if busy is None else round(base_wait * (0.5 + busy / 100))
        step = 5 if target > wait else -5 if target < wait - 4 else random.choice([-5, 0, 0, 5])
        beds = max(0, min(base_beds + 2, beds + random.choice([-1, 0, 0, 1])))
        wait = max(5, min(base_wait + 30, wait + step))
        _state[hid] = [beds, wait]
        await stdb.call("set_hospital", hid, name, lat, lng, beds, wait)


async def drive_minutes(lat: float, lng: float, to_lat: float, to_lng: float) -> int:
    seconds, _ = await routing.route(lat, lng, to_lat, to_lng)
    return max(1, round(seconds / 60))


async def drive_minutes_many(lat: float, lng: float, targets: list[tuple[float, float]]) -> list[int]:
    return await asyncio.gather(*(drive_minutes(lat, lng, a, b) for a, b in targets))
