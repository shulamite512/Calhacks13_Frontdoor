"""Specialty departments at our ER and their (simulated) live readiness.

Real-world notes used here:
- CPMC Van Ness is not a trauma center; major trauma in San Francisco goes to Zuckerberg SF General
  (the city's Level I trauma center).
- Serious burns in San Francisco go to the Bothin Burn Center at UCSF Health Hyde Hospital
  (formerly Saint Francis Memorial).
Everything else (beds, doctors, resource status) is simulated and editable by staff on the board.
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
    (7, "Orthopedics", "Ortho beds", 2, 6, 1, "Splint/cast room", True, "Ortho resident in house"),
    (8, "Obstetrics", "L&D rooms", 1, 6, 1, "Labor & delivery", True, "OB hospitalist in house"),
    (9, "Psychiatry", "Psych holds", 0, 3, 1, "Safe room", False, "Safe rooms full; crisis team on call"),
    (10, "Gastroenterology", "GI beds", 2, 4, 0, "Endoscopy suite", True, "No GI on call until 7 am"),
    (11, "Pulmonology", "Step-down beds", 3, 6, 1, "BiPAP machines", True, ""),
    (12, "Nephrology", "Dialysis chairs", 1, 4, 1, "Dialysis", True, "Emergency dialysis available"),
    (13, "Burns", "Burn beds", 0, 0, 0, "Burn unit", False,
     "No burn unit: serious burns go to the Bothin Burn Center (UCSF Health Hyde Hospital)"),
]


async def seed() -> None:
    for d in DEPARTMENTS:
        await stdb.call("set_department", *d)
