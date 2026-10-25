"""How does Siren's triage compare with real ED nurses?

Runs our full triage pipeline (Claude + deterministic red-flag rules, exactly what /checkin uses) on
every MIMIC-IV-ED Demo triage record that has a chief complaint and a nurse-assigned acuity (ESI 1-5),
and compares Siren's ESI with the nurse's.

Input per case: the triage chief complaint (short clinical text, e.g. "SOB", "CHEST PAIN") and the
triage vitals. Not the patient's own words, so this is a harder, terser input than a voice check-in.

Run from server/:  .venv\\Scripts\\python scripts\\eval_triage_mimic.py
Usage: eval_triage_mimic.py [all|tune|test] [label]. The tune/test split is fixed by a hash of stay_id,
so prompt changes are tuned on one half and the final number is measured once on the other half.
Writes data/eval/triage_mimic_summary[_label].json and data/eval/triage_mimic_cases[_label].csv
"""
import asyncio
import csv
import gzip
import hashlib
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(HERE.parent / ".env")

import triage  # noqa: E402

RAW = HERE / "data" / "raw" / "mimic_ed_demo"
OUT = HERE / "data" / "eval"
CONCURRENCY = 6


def split_of(stay_id: str) -> str:
    return "test" if int(hashlib.sha256(stay_id.encode()).hexdigest(), 16) % 2 else "tune"


def describe(t: dict) -> str:
    parts = [f"Triage chief complaint: {t['chiefcomplaint']}."]
    vitals = []
    for key, label, unit in [("temperature", "Temp", "F"), ("heartrate", "HR", ""), ("resprate", "RR", ""),
                             ("o2sat", "SpO2", "%"), ("sbp", "SBP", ""), ("dbp", "DBP", ""), ("pain", "Pain", "/10")]:
        if t.get(key):
            vitals.append(f"{label} {t[key]}{unit}")
    if vitals:
        parts.append("Triage vitals: " + ", ".join(vitals) + ".")
    return " ".join(parts)


async def run_case(sem: asyncio.Semaphore, t: dict) -> dict:
    async with sem:
        r = await triage.triage(describe(t), None)
    return {"stay_id": t["stay_id"], "chiefcomplaint": t["chiefcomplaint"], "nurse_esi": int(t["acuity"]),
            "frontdoor_esi": r.acuity, "specialty": r.specialty, "red_flags": "; ".join(r.red_flags)}


async def main() -> None:
    part = sys.argv[1] if len(sys.argv) > 1 else "all"
    label = sys.argv[2] if len(sys.argv) > 2 else ""
    suffix = f"_{label}" if label else ""
    with gzip.open(RAW / "triage.csv.gz", "rt", encoding="utf-8") as fh:
        rows = [t for t in csv.DictReader(fh)
                if t["acuity"] and t["chiefcomplaint"] and t["chiefcomplaint"].upper() != "UNKNOWN-CC"]
    if part != "all":
        rows = [t for t in rows if split_of(t["stay_id"]) == part]
    print(f"Running {len(rows)} real triage cases ({part}) through Siren...")
    sem = asyncio.Semaphore(CONCURRENCY)
    cases = await asyncio.gather(*(run_case(sem, t) for t in rows))

    n = len(cases)
    diff = [c["frontdoor_esi"] - c["nurse_esi"] for c in cases]  # > 0 means Siren said LESS urgent
    exact = sum(d == 0 for d in diff)
    within1 = sum(abs(d) <= 1 for d in diff)
    under = sum(d > 0 for d in diff)
    over = sum(d < 0 for d in diff)
    high_risk = [c for c in cases if c["nurse_esi"] <= 2]
    missed_high = [c for c in high_risk if c["frontdoor_esi"] >= 3]
    confusion = Counter((c["nurse_esi"], c["frontdoor_esi"]) for c in cases)

    summary = {
        "source": "MIMIC-IV-ED Demo v2.2 (PhysioNet, ODbL), triage table",
        "pipeline": f"triage.triage ({triage.MODEL}, effort low) + red_flags rules, same as /checkin",
        "run_at": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "split": part,
        "label": label or "baseline",
        "cases": n,
        "exact_match_pct": round(100 * exact / n, 1),
        "within_one_level_pct": round(100 * within1 / n, 1),
        "frontdoor_more_urgent_pct": round(100 * over / n, 1),
        "frontdoor_less_urgent_pct": round(100 * under / n, 1),
        "nurse_high_risk_cases": len(high_risk),
        "high_risk_rated_esi3_or_lower": len(missed_high),
        "high_risk_sensitivity_pct": round(100 * (len(high_risk) - len(missed_high)) / max(len(high_risk), 1), 1),
        "confusion_nurse_to_frontdoor": {f"{a}->{b}": k for (a, b), k in sorted(confusion.items())},
        "missed_high_risk_examples": [
            {"complaint": c["chiefcomplaint"], "nurse": c["nurse_esi"], "frontdoor": c["frontdoor_esi"]}
            for c in missed_high[:15]
        ],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"triage_mimic_summary{suffix}.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    with open(OUT / f"triage_mimic_cases{suffix}.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(cases[0]))
        w.writeheader()
        w.writerows(cases)
    print(json.dumps({k: v for k, v in summary.items() if k != "missed_high_risk_examples"}, indent=1))
    print("missed high-risk examples:", summary["missed_high_risk_examples"])


if __name__ == "__main__":
    asyncio.run(main())
