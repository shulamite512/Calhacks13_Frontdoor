"""Specialty departments at our ER and their (simulated) live readiness.

Real-world note: CPMC Van Ness is not a trauma center; major trauma in San Francisco goes to
Zuckerberg SF General (the city's Level I trauma center). We model that as a service not offered.
"""
import stdb

# Names must match triage.Specialty (what Claude picks for each patient).
DEPARTMENTS = [
    # id, name, bed label, beds free, beds total, doctors on call, key resource, ready, note
    (1, "Cardiology", "CCU beds", 2, 4, 1, "Cath lab", True, "Interventional cardiologist on call"),
    (2, "Neurology", "Neuro ICU beds", 1, 2, 1, "CT scanner", True, "Stroke team; tele-neurology backup"),
    (3, "Surgery", "Post-op beds", 2, 6, 1, "Operating room", False, "OR busy until ~45 min"),
    (4, "ICU", "ICU beds", 1, 12, 1, "Ventilators", True, "Intensivist in house"),
    (5, "Pediatrics", "Peds beds", 3, 8, 2, "Peds ED bay", True, ""),
    (6, "Trauma", "Trauma bays", 0, 0, 0, "Trauma team", False,
     "Not a trauma center: major trauma goes to Zuckerberg SF General (Level I)"),
]


async def seed() -> None:
    for d in DEPARTMENTS:
        await stdb.call("set_department", *d)
