"""Match a patient's condition to the ER that can treat it right now.

For each ER (ours + the nearby network) we ask:
  1. Can it treat this? The department the patient needs is offered, has a doctor on call, a free
     bed and its key resource ready (e.g. Cardiology: cath lab ready).
  2. How fast? Real drive time from the patient's position (OSRM) + current ER wait. Critical
     patients (ESI 1-2) skip the waiting room, so for them only the drive counts.
ERs that can treat come first, then the fastest.
"""
import network
import stdb

OUR_ID = 0


def _readiness(d: dict | None, specialty: str) -> tuple[bool, str]:
    """(can treat, human reason) for one department row (snake_case SQL columns)."""
    if not specialty:
        return True, "emergency care"
    if d is None or d["beds_total"] == 0:
        return False, f"no {specialty.lower()} here" + (f" ({d['note']})" if d and d["note"] else "")
    gaps = []
    if d["doctors_on_call"] == 0:
        gaps.append("no doctor on call")
    if d["beds_free"] == 0:
        gaps.append(f"no {d['bed_label']} free")
    if not d["resource_ready"]:
        gaps.append(f"{d['resource'].lower()} busy")
    if gaps:
        return False, f"{specialty}: " + ", ".join(gaps)
    return True, (f"{specialty} ready: {d['doctors_on_call']} on call, {d['beds_free']} {d['bed_label']} free, "
                  f"{d['resource'].lower()} ready")


async def _our_wait_minutes() -> int:
    rows = await stdb.sql("SELECT * FROM forecast")
    short = rows[0]["beds_short"] if rows else 0
    return 20 + 12 * max(0, short)


async def rank(specialty: str, lat: float, lng: float, our: dict, critical: bool = False) -> list[dict]:
    """All ERs, best first. `our` = {"name", "lat", "lng"} for our own ER."""
    ours_depts = {d["name"]: d for d in await stdb.sql("SELECT * FROM department")}
    net_depts = await stdb.sql("SELECT * FROM hospital_department")
    hospitals = await stdb.sql("SELECT * FROM hospital")

    targets = [(our["lat"], our["lng"])] + [(h["lat"], h["lng"]) for h in hospitals]
    drives = await network.drive_minutes_many(lat, lng, targets)

    options = []
    ok, reason = _readiness(ours_depts.get(specialty), specialty)
    options.append({"hospitalId": OUR_ID, "name": our["name"], "lat": our["lat"], "lng": our["lng"],
                    "driveMinutes": drives[0], "waitMinutes": await _our_wait_minutes(),
                    "canTreat": ok, "reason": reason})
    for h, drive in zip(hospitals, drives[1:]):
        d = next((x for x in net_depts if x["hospital_id"] == h["id"] and x["name"] == specialty), None)
        ok, reason = _readiness(d, specialty)
        if h["beds_free"] == 0:
            ok, reason = False, "ER full right now"
        options.append({"hospitalId": h["id"], "name": h["name"], "lat": h["lat"], "lng": h["lng"],
                        "driveMinutes": drive, "waitMinutes": h["wait_minutes"], "canTreat": ok, "reason": reason})
    for o in options:
        o["totalMinutes"] = o["driveMinutes"] + (0 if critical else o["waitMinutes"])
    options.sort(key=lambda o: (not o["canTreat"], o["totalMinutes"]))
    return options
