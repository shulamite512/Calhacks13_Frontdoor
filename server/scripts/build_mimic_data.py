"""Turn the open MIMIC-IV-ED Demo (v2.2, PhysioNet, ODbL) into two small derived files:

  data/mimic_arrival_shape.json  real hour-of-day ED arrival pattern (all 222 demo stays)
  data/mimic_vitals.json         real vital-sign trajectories per ED stay, for the simulator to replay

Source: Johnson A, et al. MIMIC-IV-ED Demo (version 2.2). PhysioNet. https://physionet.org/content/mimic-iv-ed-demo/
Data are de-identified; dates are shifted but time of day is kept.

Download the raw files first (into data/raw/mimic_ed_demo/, not committed):
  https://physionet.org/files/mimic-iv-ed-demo/2.2/ed/{edstays,triage,vitalsign}.csv.gz
Run from server/:  .venv\\Scripts\\python scripts\\build_mimic_data.py
"""
import csv
import gzip
import json
from collections import Counter, defaultdict
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
RAW = DATA / "raw" / "mimic_ed_demo"
SOURCE = "MIMIC-IV-ED Demo v2.2 (PhysioNet, ODbL), de-identified"
MIN_READINGS = 3


def read(name: str) -> list[dict]:
    with gzip.open(RAW / f"{name}.csv.gz", "rt", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def num(x: str) -> float | None:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def arrival_shape(stays: list[dict]) -> dict:
    counts = Counter(int(s["intime"][11:13]) for s in stays)
    raw = [counts.get(h, 0) for h in range(24)]
    # 222 arrivals is a small sample, so smooth over neighbouring hours (wrapping midnight).
    smooth = [round((raw[h - 1] + 2 * raw[h] + raw[(h + 1) % 24]) / 4, 2) for h in range(24)]
    return {"source": SOURCE, "stays": len(stays), "raw_counts_by_hour": raw, "smoothed": smooth}


def trajectories(vitals: list[dict], acuity: dict[str, int]) -> list[dict]:
    by_stay = defaultdict(list)
    for v in vitals:
        by_stay[v["stay_id"]].append(v)
    out = []
    for stay_id, rows in by_stay.items():
        if len(rows) < MIN_READINGS:
            continue
        rows.sort(key=lambda r: r["charttime"])
        last = {"hr": 80.0, "spo2": 98.0, "sbp": 125.0, "dbp": 78.0, "rr": 16.0, "tempC": 37.0}
        seq = []
        for r in rows:
            temp_f = num(r["temperature"])
            reading = {
                "hr": num(r["heartrate"]), "spo2": num(r["o2sat"]), "sbp": num(r["sbp"]),
                "dbp": num(r["dbp"]), "rr": num(r["resprate"]),
                "tempC": round((temp_f - 32) * 5 / 9, 1) if temp_f and 90 < temp_f < 110 else None,
            }
            # Charted vitals are often partial; carry the last known value forward.
            for k, v in reading.items():
                if v is not None:
                    last[k] = v
            seq.append(dict(last))
        hr = [s["hr"] for s in seq]
        spo2 = [s["spo2"] for s in seq]
        sbp = [s["sbp"] for s in seq]
        # How much the stay deteriorates from its calmest point: used to pick "Worsen" trajectories.
        worst = max(max(hr) - min(hr), 0) + 3 * max(max(spo2) - min(spo2), 0) + max(max(sbp) - min(sbp), 0) / 2
        critical = max(hr) >= 130 or min(spo2) <= 90 or min(sbp) <= 90
        out.append({"stay": stay_id, "acuity": acuity.get(stay_id), "critical": critical,
                    "deterioration": round(worst, 1), "readings": seq})
    return out


def main() -> None:
    stays, triage, vitals = read("edstays"), read("triage"), read("vitalsign")
    acuity = {t["stay_id"]: int(t["acuity"]) for t in triage if t["acuity"]}
    shape = arrival_shape(stays)
    traj = trajectories(vitals, acuity)
    (DATA / "mimic_arrival_shape.json").write_text(json.dumps(shape, indent=1), encoding="utf-8")
    (DATA / "mimic_vitals.json").write_text(
        json.dumps({"source": SOURCE, "trajectories": traj}), encoding="utf-8")
    crit = [t for t in traj if t["critical"]]
    print(f"arrival shape from {shape['stays']} stays: {shape['raw_counts_by_hour']}")
    print(f"{len(traj)} vital trajectories (>= {MIN_READINGS} readings); {len(crit)} reach critical thresholds")
    print("by acuity:", sorted(Counter(t["acuity"] for t in traj).items(), key=lambda x: (x[0] is None, x[0])))


if __name__ == "__main__":
    main()
