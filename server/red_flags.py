"""Deterministic red-flag rules. These run alongside the LLM so alerts never depend on it alone."""

# phrase -> (flag label, level)
KEYWORDS = {
    "spreading to my arm": ("pain radiating to arm", "critical"),
    "spreading to my left arm": ("pain radiating to arm", "critical"),
    "down my arm": ("pain radiating to arm", "critical"),
    "jaw": ("pain radiating to jaw", "critical"),
    "can't breathe": ("severe shortness of breath", "critical"),
    "cannot breathe": ("severe shortness of breath", "critical"),
    "short of breath": ("shortness of breath", "warning"),
    "chest pain": ("chest pain", "warning"),
    "chest hurts": ("chest pain", "warning"),
    "pressure in my chest": ("chest pain", "warning"),
    "face is drooping": ("possible stroke", "critical"),
    "slurred": ("possible stroke", "critical"),
    "can't move my": ("possible stroke", "critical"),
    "numb": ("numbness", "warning"),
    "worst headache": ("thunderclap headache", "critical"),
    "passed out": ("syncope", "warning"),
    "fainted": ("syncope", "warning"),
    "coughing up blood": ("hemoptysis", "critical"),
    "vomiting blood": ("hematemesis", "critical"),
    "sweating": ("diaphoresis", "warning"),
    "getting worse": ("symptoms worsening", "warning"),
    "it's worse": ("symptoms worsening", "warning"),
    "feel worse": ("symptoms worsening", "warning"),
    "dizzy": ("dizziness", "warning"),
}


def check_text(text: str) -> list[tuple[str, str]]:
    """Return unique (flag, level) pairs found in free text."""
    t = text.lower()
    seen: dict[str, str] = {}
    for phrase, (flag, level) in KEYWORDS.items():
        if phrase in t and (flag not in seen or level == "critical"):
            seen[flag] = level
    return list(seen.items())


def check_vitals(v: dict) -> tuple[str, str] | None:
    """Return (level, reason) for the worst abnormal vital, or None."""
    critical, warning = [], []
    if v["hr"] >= 130 or v["hr"] <= 40:
        critical.append(f"HR {v['hr']}")
    elif v["hr"] >= 110:
        warning.append(f"HR {v['hr']}")
    if v["spo2"] <= 90:
        critical.append(f"SpO2 {v['spo2']}%")
    elif v["spo2"] <= 93:
        warning.append(f"SpO2 {v['spo2']}%")
    if v["sbp"] <= 90:
        critical.append(f"BP {v['sbp']}/{v['dbp']}")
    elif v["sbp"] >= 180:
        warning.append(f"BP {v['sbp']}/{v['dbp']}")
    if v["rr"] >= 28:
        critical.append(f"RR {v['rr']}")
    elif v["rr"] >= 22:
        warning.append(f"RR {v['rr']}")
    if critical:
        return "critical", ", ".join(critical + warning)
    if warning:
        return "warning", ", ".join(warning)
    return None
