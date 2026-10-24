"""Simulated wearable vitals for every active patient, plus the periodic bed forecast."""
import asyncio
import logging
import random

import forecast
import network
import red_flags
import stdb

log = logging.getLogger("simulator")

TICK_SECONDS = 3
NETWORK_EVERY_TICKS = 10  # nudge other hospitals' simulated capacity every ~30s
LEVELS = {"none": 0, "warning": 1, "critical": 2}

# patient_id -> {"v": current vitals, "worsening": bool, "raised": highest level alerted}
_state: dict[int, dict] = {}
_last_forecast: dict | None = None


def _baseline(pid: int, acuity: int) -> dict:
    rnd = random.Random(pid)
    bump = 10 if acuity <= 2 else 0
    return {
        "hr": rnd.randint(76, 90) + bump,
        "spo2": float(rnd.randint(97, 99)),
        "sbp": rnd.randint(118, 134),
        "dbp": rnd.randint(72, 84),
        "rr": float(rnd.randint(14, 17)),
        "tempC": round(rnd.uniform(36.7, 37.2), 1),
    }


def set_worsening(pid: int, on: bool = True) -> None:
    _state.setdefault(pid, {"v": None, "worsening": False, "raised": "none"})["worsening"] = on


def note_alert(pid: int, level: str) -> None:
    """Record an alert raised elsewhere (e.g. voice follow-up) so vitals don't re-alert at a lower level."""
    s = _state.setdefault(pid, {"v": None, "worsening": False, "raised": "none"})
    if LEVELS[level] > LEVELS[s["raised"]]:
        s["raised"] = level


def reset() -> None:
    global _last_forecast
    _state.clear()
    _last_forecast = None


def _step(s: dict) -> dict:
    v = s["v"]
    if s["worsening"]:
        v["hr"] = min(148, v["hr"] + random.randint(4, 7))
        v["spo2"] = max(86.0, v["spo2"] - 0.6)
        v["sbp"] = max(86, v["sbp"] - random.randint(2, 4))
        v["dbp"] = max(54, v["dbp"] - 2)
        v["rr"] = min(30.0, v["rr"] + 0.8)
    out = {
        "hr": max(35, v["hr"] + random.randint(-2, 2)),
        "spo2": int(min(100, round(v["spo2"] + random.choice([0, 0, -1, 1])))),
        "sbp": v["sbp"] + random.randint(-3, 3),
        "dbp": v["dbp"] + random.randint(-2, 2),
        "rr": int(round(v["rr"])),
        "tempC": v["tempC"],
    }
    return out


async def _tick() -> None:
    global _last_forecast
    patients = await stdb.sql("SELECT * FROM patient")
    beds = await stdb.sql("SELECT * FROM bed")
    active = [p for p in patients if p["status"] not in ("discharged", "redirected")]

    for p in active:
        pid = p["id"]
        s = _state.setdefault(pid, {"v": None, "worsening": False, "raised": "none"})
        if s["v"] is None:
            s["v"] = _baseline(pid, p["acuity"])
        v = _step(s)
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
