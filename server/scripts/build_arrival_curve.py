"""Build data/arrival_curve.json.

  VOLUME (how many per day): REAL. CPMC Van Ness Campus ED visits from California HCAI
         (2025: 34,742, about 95/day).
  SHAPE  (which hours are busy): ASSUMED typical ED pattern (quiet 3-6 am, busy late morning to
         evening). We tried to get a real shape from Google popular times via Apify, but Google
         hides popular times for hospitals: 0 of 60+ SF and US ER/hospital listings had them.
         The only walk-in site with data (a downtown Atlanta 24/7 urgent care) peaks at midnight,
         which is not ER-like, so USE_APIFY_SHAPE is off. Flip it to compare.

Run from server/:  .venv\\Scripts\\python scripts\\build_arrival_curve.py
Inputs: data/popular_times_raw_us.json (from the Apify run), data/hcai_ed_visits_sf.json
"""
import json
from datetime import datetime, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]
OUR_FACILITY = "CALIFORNIA PACIFIC MEDICAL CENTER - VAN NESS CAMPUS"
HCAI_YEAR = "2025"
SHAPE_TITLE = "Urgent Care 24/7 Atlanta"
FLOOR = 5.0  # Google reports 0 for hours without data; real ERs never empty out
USE_APIFY_SHAPE = False
# Relative arrivals by hour (0-23) for a typical US ED: low 3-6 am, peak late morning to evening.
TYPICAL_ED_SHAPE = [4, 3, 3, 2, 2, 2, 3, 5, 7, 9, 10, 11, 11, 11, 10, 10, 10, 11, 11, 10, 9, 8, 6, 5]


def main() -> None:
    if USE_APIFY_SHAPE:
        places = json.loads((DATA / "popular_times_raw_us.json").read_text(encoding="utf-8"))
        place = next(p for p in places if p.get("title") == SHAPE_TITLE and p.get("popularTimesHistogram"))
        hist = place["popularTimesHistogram"]
        shape_note = (f"Google popular times of '{place['title']}' ({place.get('city')}, {place.get('state')}) via Apify")
    else:
        hist = {d: [{"hour": h, "occupancyPercent": v * 9} for h, v in enumerate(TYPICAL_ED_SHAPE)] for d in DAYS}
        shape_note = ("assumed typical ED pattern; Google popular times are hidden for hospitals "
                      "(0 of 60+ ER/hospital listings scraped via Apify had them)")

    hcai = json.loads((DATA / "hcai_ed_visits_sf.json").read_text(encoding="utf-8"))
    visits = hcai["facilities"][OUR_FACILITY][HCAI_YEAR]
    daily = visits["ED_Visit"] / 365

    by_weekday = {}
    for d in DAYS:
        occ = [FLOOR] * 24
        for e in hist.get(d) or []:
            occ[e["hour"]] = max(FLOOR, float(e.get("occupancyPercent") or 0))
        total = sum(occ)
        by_weekday[d] = [round(daily * o / total, 1) for o in occ]
    average = [round(sum(by_weekday[d][h] for d in DAYS) / 7, 1) for h in range(24)]

    old = json.loads((DATA / "arrival_curve.json").read_text(encoding="utf-8"))
    curve = {
        "source": f"HCAI {HCAI_YEAR} volume, typical-ED shape" if not USE_APIFY_SHAPE
                  else f"HCAI {HCAI_YEAR} volume + Apify popular-times shape",
        "volume": f"{OUR_FACILITY}: {visits['ED_Visit']} ED visits in {HCAI_YEAR} (~{daily:.0f}/day), HCAI",
        "shape": shape_note,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "bed_rate": old.get("bed_rate", 0.6),
        "arrivals_per_hour": average,
        "by_weekday": by_weekday,
    }
    (DATA / "arrival_curve.json").write_text(json.dumps(curve, indent=1), encoding="utf-8")
    peak = max(range(24), key=lambda h: average[h])
    print(f"~{daily:.0f} visits/day; average peak {average[peak]}/h at {peak}:00, low {min(average)}/h")
    for d in DAYS:
        print(d, " ".join(f"{x:4.1f}" for x in by_weekday[d]))


if __name__ == "__main__":
    main()
