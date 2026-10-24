"""Bed-demand forecast: will we have enough beds in the next 30 minutes?"""
import json
import os
from datetime import datetime
from pathlib import Path

CURVE_FILE = Path(__file__).parent / "data" / "arrival_curve.json"
HORIZON_MIN = 30


def _load_curve() -> dict:
    return json.loads(CURVE_FILE.read_text())


def compute(patients: list[dict], beds: list[dict]) -> dict:
    curve = _load_curve()
    hour = int(os.getenv("FORECAST_HOUR", datetime.now().hour))
    per_hour = curve["arrivals_per_hour"][hour]
    # Not every walk-in needs a bed; bed_rate is the share that does.
    expected = round(per_hour * HORIZON_MIN / 60 * curve.get("bed_rate", 0.6))

    # ESI 4-5 patients are usually treated in chairs / fast track, so only ESI 1-3 need a bed.
    # A held bed is already counted as taken, so its patient doesn't need another one.
    held_for = {b["patient_id"] for b in beds if b["status"] == "reserved"}
    needs_bed = [p for p in patients if p["acuity"] <= 3 and p["id"] not in held_for]
    waiting = sum(1 for p in needs_bed if p["status"] == "waiting")
    incoming = sum(1 for p in needs_bed if p["status"] == "incoming" and p["eta_minutes"] <= HORIZON_MIN)
    # Hallway stretchers are overflow, not real capacity, so they don't count as available.
    rooms = [b for b in beds if b["zone"] != "Hallway"]
    free = sum(1 for b in rooms if b["status"] == "free")
    cleaning = sum(1 for b in rooms if b["status"] == "cleaning")  # back in service within the horizon
    hallway = sum(1 for b in beds if b["zone"] == "Hallway" and b["status"] == "occupied")

    needed = waiting + incoming + expected
    available = free + cleaning
    return {
        "horizonMinutes": HORIZON_MIN,
        "expectedArrivals": expected,
        "bedsFree": free,
        "bedsNeeded": needed,
        "bedsShort": needed - available,
        "basis": f"{waiting} waiting + {incoming} incoming (ESI 1-3) + ~{expected} expected walk-ins "
        f"vs {free} free + {cleaning} cleaning beds"
        + (f", {hallway} in hallway beds" if hallway else "")
        + f" ({curve['source']}, {hour}:00)",
    }
