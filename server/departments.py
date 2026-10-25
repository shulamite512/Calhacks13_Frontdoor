"""Specialty departments at our ER and their live readiness.

REAL (CDPH licensed bed counts for CPMC Van Ness, data/cdph_beds_cpmc_van_ness.json):
  - ICU 36 beds, Perinatal (Obstetrics) 53, Pediatric 25 (+8 pediatric ICU), general acute 135.
  - No separately licensed coronary care, psychiatric or burn beds.
  - Not a trauma center: major trauma in SF goes to Zuckerberg SF General (Level I).
  - Serious burns go to the Bothin Burn Center at UCSF Health Hyde Hospital (formerly Saint Francis).
SIMULATED (and editable by staff on the board): how many beds are free right now, doctors on call,
and whether each key resource is ready. That live status only exists inside hospital systems.
"""
import stdb

# Names must match triage.Specialty (what Claude picks for each patient).
DEPARTMENTS = [
    # id, name, bed label, beds free, beds total, doctors on call, key resource, ready, note
    (1, "Cardiology", "cardiac ICU beds", 2, 4, 1, "Cath lab", True,
     "No separately licensed CCU; cardiac patients use part of the 36 licensed ICU beds"),
    (2, "Neurology", "Neuro ICU beds", 1, 2, 1, "CT scanner", True,
     "Stroke team; tele-neurology backup. Beds come from the ICU pool"),
    (3, "Surgery", "Post-op beds", 2, 6, 1, "Operating room", False,
     "OR busy until ~45 min. Beds come from the 135 licensed general acute beds"),
    (4, "ICU", "ICU beds", 3, 36, 1, "Ventilators", True, "36 licensed ICU beds (CDPH)"),
    (5, "Pediatrics", "Peds beds", 7, 25, 2, "Peds ED bay", True,
     "25 licensed pediatric beds + 8 pediatric ICU (CDPH)"),
    (6, "Trauma", "Trauma bays", 0, 0, 0, "Trauma team", False,
     "Not a trauma center: major trauma goes to Zuckerberg SF General (Level I)"),
    (7, "Orthopedics", "Ortho beds", 2, 6, 1, "Splint/cast room", True,
     "Ortho resident in house. Beds come from general acute"),
    (8, "Obstetrics", "L&D/perinatal beds", 6, 53, 1, "Labor & delivery", True,
     "53 licensed perinatal beds (CDPH); OB hospitalist in house"),
    (9, "Psychiatry", "ED psych holds", 0, 3, 1, "Safe room", False,
     "No licensed inpatient psych beds here (CDPH); safe rooms in the ED are full; crisis team on call"),
    (10, "Gastroenterology", "GI beds", 2, 4, 0, "Endoscopy suite", True,
     "No GI on call until 7 am. Beds come from general acute"),
    (11, "Pulmonology", "Step-down beds", 3, 6, 1, "BiPAP machines", True, "Beds come from general acute"),
    (12, "Nephrology", "Dialysis chairs", 1, 4, 1, "Dialysis", True, "Emergency dialysis available"),
    (13, "Burns", "Burn beds", 0, 0, 0, "Burn unit", False,
     "No licensed burn beds (CDPH): serious burns go to the Bothin Burn Center (UCSF Health Hyde Hospital)"),
]


async def seed() -> None:
    for d in DEPARTMENTS:
        await stdb.call("set_department", *d)
