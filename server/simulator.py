"""Vitals for every active patient, replayed from REAL de-identified ED stays (MIMIC-IV-ED Demo),
plus the periodic bed forecast.

Each patient is assigned a real stay's vital-sign trajectory and steps through it (time-compressed,
interpolated between charted readings). Background patients get calm trajectories so the demo isn't
flooded with alerts; "Worsen" switches a patient to a real stay that deteriorated to critical values.
Without data/mimic_vitals.json it falls back to synthetic vitals.
"""
import asyncio
import json
import logging
import random
from pathlib import Path

import copilot
import forecast
import network
import red_flags
import stdb

log = logging.getLogger("simulator")

TICK_SECONDS = 3
STEPS_PER_READING = 3     # ticks between real charted readings (~9 s per reading)
NETWORK_EVERY_TICKS = 10  # nudge other hospitals' simulated capacity every ~30s
WORSEN_WITHIN_READINGS = 6
LEVELS = {"none": 0, "warning": 1, "critical": 2}
VITALS_FILE = Path(__file__).parent / "data" / "mimic_vitals.json"


def _load_trajectories() -> tuple[list[dict], list[dict]]:
    if not VITALS_FILE.exists():
        return [], []
    trajs = json.loads(VITALS_FILE.read_text(encoding="utf-8"))["trajectories"]
    # Charting errors exist in real data (e.g. SpO2 10%); skip stays with impossible values.
    trajs = [t for t in trajs if all(_plausible(r) for r in t["readings"])]
    calm = [t for t in trajs if all(_level(r) == "none" for r in t["readings"])]
    # A real deterioration: the stay starts below critical and turns critical within the first few
    # charted readings (so "Worsen" shows in under a minute of demo time).
    worse = [t for t in trajs if _level(t["readings"][0]) != "critical"
             and any(_level(r) == "critical" for r in t["readings"][1:WORSEN_WITHIN_READINGS])]
    worse.sort(key=lambda t: -t["deterioration"])
    return calm, worse


def _plausible(r: dict) -> bool:
    return 25 <= r["hr"] <= 220 and 50 <= r["spo2"] <= 100 and 50 <= r["sbp"] <= 250 and 5 <= r["rr"] <= 60


def _level(r: dict) -> str:
    hit = red_flags.check_vitals(_ints(r))
    return hit[0] if hit else "none"


def _ints(r: dict) -> dict:
    return {"hr": round(r["hr"]), "spo2": round(r["spo2"]), "sbp": round(r["sbp"]),
            "dbp": round(r["dbp"]), "rr": round(r["rr"]), "tempC": round(r["tempC"], 1)}


CALM, WORSE = _load_trajectories()
log.info("vitals replay: %d calm and %d deteriorating real ED stays", len(CALM), len(WORSE))

# patient_id -> {"traj": readings, "pos": float index, "loop": bool, "worsening": bool, "raised": level, "stay": id}
_state: dict[int, dict] = {}
_last_forecast: dict | None = None


def _new_state() -> dict:
    return {"traj": None, "pos": 0.0, "loop": True, "worsening": False, "raised": "none", "stay": None}


def _assign_calm(s: dict, pid: int, acuity: int) -> None:
    if not CALM:
        return
    pool = [t for t in CALM if t["acuity"] == min(max(acuity, 1), 3)] or CALM
    t = random.Random(pid).choice(pool)
    s.update(traj=t["readings"], pos=0.0, loop=True, stay=t["stay"])


def set_worsening(pid: int, on: bool = True) -> None:
    s = _state.setdefault(pid, _new_state())
    s["worsening"] = on
    if on and WORSE:
        t = WORSE[pid % len(WORSE)]
        s.update(traj=t["readings"], pos=0.0, loop=False, stay=t["stay"])


def note_alert(pid: int, level: str) -> None:
    """Record an alert raised elsewhere (e.g. voice follow-up) so vitals don't re-alert at a lower level."""
    s = _state.setdefault(pid, _new_state())
    if LEVELS[level] > LEVELS[s["raised"]]:
        s["raised"] = level


def reset() -> None:
    global _last_forecast
    _state.clear()
    _last_forecast = None


def _replay(s: dict) -> dict:
    traj = s["traj"]
    i = int(s["pos"])
    frac = s["pos"] - i
    a = traj[i]
    b = traj[(i + 1) % len(traj)] if (s["loop"] or i + 1 < len(traj)) else a
    v = {k: a[k] + (b[k] - a[k]) * frac for k in a}
    s["pos"] += 1 / STEPS_PER_READING
    if s["pos"] >= len(traj) - (0 if s["loop"] else 1):
        s["pos"] = 0.0 if s["loop"] else float(len(traj) - 1)
    return _ints(v)


def _synthetic(s: dict, pid: int, acuity: int) -> dict:
    """Fallback when the MIMIC file is missing."""
    v = s.setdefault("v", {
        "hr": random.Random(pid).randint(76, 90) + (10 if acuity <= 2 else 0),
        "spo2": 98.0, "sbp": 125, "dbp": 78, "rr": 16.0, "tempC": 37.0,
    })
    if s["worsening"]:
        v["hr"] = min(148, v["hr"] + random.randint(4, 7))
        v["spo2"] = max(86.0, v["spo2"] - 0.6)
        v["sbp"] = max(86, v["sbp"] - random.randint(2, 4))
        v["rr"] = min(30.0, v["rr"] + 0.8)
    return _ints({k: (x + random.uniform(-1.5, 1.5) if k in ("hr", "sbp") else x) for k, x in v.items()})


async def _tick() -> None:
    global _last_forecast
    patients = await stdb.sql("SELECT * FROM patient")
    beds = await stdb.sql("SELECT * FROM bed")
    # Walk-ins: vitals start at triage (a wearable clip/patch handed out on arrival); nobody is
    # measured while driving in, they're triaged by what they tell us. Ambulance patients are on the
    # paramedics' monitor, so their vitals stream while they're still on the way.
    active = [p for p in patients
              if p["status"] in ("waiting", "roomed") or (p["status"] == "incoming" and p["source"] == "ems")]

    for p in active:
        pid = p["id"]
        s = _state.setdefault(pid, _new_state())
        if s["traj"] is None and not s["worsening"]:
            _assign_calm(s, pid, p["acuity"])
        v = _replay(s) if s["traj"] else _synthetic(s, pid, p["acuity"])
        await stdb.call("add_vitals", pid, v["hr"], v["spo2"], v["sbp"], v["dbp"], v["rr"], v["tempC"])
        hit = red_flags.check_vitals(v)
        if hit and LEVELS[hit[0]] > LEVELS[s["raised"]]:
            s["raised"] = hit[0]
            await stdb.call("raise_alert", pid, hit[0], hit[1])

    f = forecast.compute(patients, beds)
    if f != _last_forecast:
        _last_forecast = f
        await stdb.call(
            "set_forecast", f["horizonMinutes"], f["expectedArrivals"], f["bedsFree"],
            f["bedsNeeded"], f["bedsShort"], f["basis"],
        )

    # Let the Copilot agent react to anything urgent (runs in the background).
    await copilot.check(patients, {"beds_short": f["bedsShort"], "basis": f["basis"]})


async def run() -> None:
    ticks = 0
    while True:
        try:
            await _tick()
            ticks += 1
            if ticks % NETWORK_EVERY_TICKS == 0:
                await network.drift()
        except Exception:
            log.exception("simulator tick failed")
        await asyncio.sleep(TICK_SECONDS)
