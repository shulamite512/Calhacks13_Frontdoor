"""Scrape Google Maps "popular times" for our ER and the nearby ERs with Apify, and build the
hourly arrival curve the forecast uses.

Run from the server/ folder:  .venv\\Scripts\\python scripts\\fetch_popular_times.py
Needs APIFY_TOKEN in the repo-root .env. Writes:
  data/popular_times_raw.json  (Apify output, for reference)
  data/arrival_curve.json      (what forecast.py reads)
  data/network_busyness.json   (hourly busyness for the nearby ERs, used by network.py)

Google gives the SHAPE of the day (relative busyness 0-100 per hour). Total daily ED visits are
not public in real time, so DAILY_VISITS is an assumption we state openly.
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent.parent
load_dotenv(HERE.parent / ".env")

ACTOR = "compass~crawler-google-places"
DAILY_VISITS = 110  # assumed ED visits/day for our ER; Google only gives the shape
DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]  # Python weekday() order

# key -> search string. "ours" drives the arrival curve; the rest shape network busyness.
PLACES = {
    "ours": "CPMC Van Ness Campus Emergency Department, 1101 Van Ness Ave, San Francisco",
    "1": "Kaiser Permanente San Francisco Medical Center Emergency, 2425 Geary Blvd, San Francisco",
    "2": "UCSF Medical Center Parnassus Emergency Department, 505 Parnassus Ave, San Francisco",
    "3": "Zuckerberg San Francisco General Hospital Emergency, 1001 Potrero Ave, San Francisco",
    "4": "Saint Mary's Medical Center Emergency, 450 Stanyan St, San Francisco",
}


def scrape() -> list[dict]:
    token = os.getenv("APIFY_TOKEN")
    if not token:
        sys.exit("APIFY_TOKEN is not set in .env")
    body = {
        "searchStringsArray": list(PLACES.values()),
        "maxCrawledPlacesPerSearch": 1,
        "scrapePlaceDetailPage": True,  # required for popularTimesHistogram
        "language": "en",
        "maxReviews": 0,
        "maxImages": 0,
    }
    r = httpx.post(
        f"https://api.apify.com/v2/acts/{ACTOR}/run-sync-get-dataset-items",
        headers={"Authorization": f"Bearer {token}"},
        json=body,
        timeout=600,
    )
    r.raise_for_status()
    return r.json()


def day_curve(hist: dict, day: str) -> list[float]:
    hours = [0.0] * 24
    for e in hist.get(day) or []:
        if 0 <= e.get("hour", -1) < 24:
            hours[e["hour"]] = float(e.get("occupancyPercent") or 0)
    return hours


def match(items: list[dict], query: str) -> dict | None:
    for it in items:
        if it.get("searchString") == query:
            return it
    return None


def main() -> None:
    items = scrape()
    (HERE / "data" / "popular_times_raw.json").write_text(json.dumps(items, indent=1), encoding="utf-8")

    found = {}
    for key, query in PLACES.items():
        it = match(items, query)
        hist = (it or {}).get("popularTimesHistogram") or {}
        has = any(day_curve(hist, d) != [0.0] * 24 for d in DAYS)
        print(f"{key:>4}: {(it or {}).get('title', 'NOT FOUND')!s:<55} popular times: {'yes' if has else 'NO'}")
        if has:
            found[key] = {d: day_curve(hist, d) for d in DAYS}

    if "ours" not in found:
        sys.exit("No popular times for our ER; arrival_curve.json left unchanged.")

    by_weekday = {}
    for d in DAYS:
        occ = found["ours"][d]
        # Google shows 0 for hours it has no data (often overnight); ERs never really hit zero,
        # so keep a small floor before scaling the day to DAILY_VISITS.
        floored = [max(o, 5.0) for o in occ]
        total = sum(floored)
        by_weekday[d] = [round(DAILY_VISITS * o / total, 1) for o in floored]
    average = [round(sum(by_weekday[d][h] for d in DAYS) / 7, 1) for h in range(24)]

    curve_file = HERE / "data" / "arrival_curve.json"
    old = json.loads(curve_file.read_text(encoding="utf-8"))
    curve = {
        "source": "Google popular times via Apify",
        "scraped_at": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "daily_visits_assumed": DAILY_VISITS,
        "bed_rate": old.get("bed_rate", 0.6),
        "arrivals_per_hour": average,
        "by_weekday": by_weekday,
    }
    curve_file.write_text(json.dumps(curve, indent=1), encoding="utf-8")

    network = {k: v for k, v in found.items() if k != "ours"}
    (HERE / "data" / "network_busyness.json").write_text(json.dumps(network, indent=1), encoding="utf-8")
    print(f"Wrote arrival_curve.json (our ER) and network_busyness.json ({len(network)} nearby ERs).")


if __name__ == "__main__":
    main()
