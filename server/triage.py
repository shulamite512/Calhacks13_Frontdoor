"""LLM symptom summary + waiting-room follow-up classification, with rule-based fallback."""
import logging
from typing import Literal

import anthropic
from pydantic import BaseModel, Field

import red_flags

log = logging.getLogger("triage")

MODEL = "claude-opus-5-5"
_client = anthropic.AsyncAnthropic()


Specialty = Literal[
    "Cardiology", "Neurology", "Surgery", "ICU", "Pediatrics", "Trauma", "Orthopedics", "Obstetrics",
    "Psychiatry", "Gastroenterology", "Pulmonology", "Nephrology", "Burns", "Emergency",
]


class Triage(BaseModel):
    complaint: str = Field(description="Chief complaint in 2-5 words, e.g. 'Chest pain'")
    summary: str = Field(description="One sentence for the triage nurse: symptoms, onset, key negatives")
    acuity: int = Field(description="Emergency Severity Index 1 (most urgent) to 5")
    red_flags: list[str] = Field(description="Short labels of red-flag findings; empty if none")
    prep: list[str] = Field(
        description="0-3 short things the ED should have ready on arrival, e.g. 'ECG', 'cardiac monitor'; "
        "empty for minor complaints"
    )
    specialty: Specialty = Field(
        description="Department most likely needed beyond the ED: Cardiology (suspected ACS/arrhythmia), "
        "Neurology (stroke signs, seizure), Surgery (acute abdomen, appendicitis), ICU (likely critical care), "
        "Pediatrics (patient under 18), Trauma (major multi-system injury), Orthopedics (isolated fracture or "
        "dislocation), Obstetrics (pregnancy-related), Psychiatry (mental-health crisis, suicidal thoughts), "
        "Gastroenterology (GI bleeding), Pulmonology (asthma/COPD flare), Nephrology (kidney failure, "
        "missed dialysis), Burns (significant burns), Emergency (ED care only)"
    )
    spoken_reply: str = Field(description="1-2 calm sentences spoken back to the patient")


class FollowUp(BaseModel):
    level: Literal["none", "warning", "critical"]
    reason: str = Field(description="Short reason for the nurse, empty if level is none")
    spoken_reply: str = Field(description="1-2 calm sentences spoken back to the patient")


TRIAGE_SYSTEM = """You support emergency department intake for FrontDoor. A patient is \
describing symptoms by voice before or after arriving at the ER. Produce a structured \
pre-triage note for the nurse.

Assign the ESI level by walking the ESI v4 algorithm in order, and when torn between two \
levels choose the more urgent one (under-triage is the dangerous error):
A. Needs an immediate life-saving intervention (unresponsive, arrest, airway compromise, \
severe respiratory distress, SpO2 < 90%, signs of shock)? -> ESI 1.
B. Should not wait? -> ESI 2 if any of: a high-risk situation (possible cardiac chest pain, \
stroke signs, shortness of breath / dyspnea, GI bleeding, syncope, suicidal or homicidal \
thoughts, possible sepsis, significant trauma mechanism, pregnancy complications, overdose, \
a fall or bleeding in an older or anticoagulated patient); new confusion, lethargy or \
disorientation; or severe pain or distress (pain 7/10 or more).
C. Otherwise count expected resources (labs, imaging, IV fluids or meds, specialty consult, \
procedure): two or more -> ESI 3, one -> ESI 4, none -> ESI 5.
D. If you chose ESI 3 but the adult has danger-zone vitals (HR > 100, RR > 20, SpO2 < 92%), \
make it ESI 2.
Input may be the patient's own informal words or a nurse's terse note with abbreviations \
(SOB, BRBPR, s/p, N/V); interpret both.

The spoken reply goes to the patient. Never diagnose. Confirm they are checked in and that \
the team has their information. If any red flag is present, tell them to call 911 or pull \
over if they are driving and symptoms get worse."""

FOLLOWUP_SYSTEM = """You are checking on a patient waiting in the emergency department. \
Compare their answer with their original complaint and decide whether a nurse must be \
alerted: 'critical' for new or worsening red-flag symptoms (spreading chest pain, trouble \
breathing, stroke signs, fainting, confusion, severe bleeding); 'warning' for clear worsening \
without red flags; 'none' if stable or better. The spoken reply goes to the patient. Never \
diagnose; if level is critical, say a nurse is coming to them now."""


def _parsed(msg):
    if msg.stop_reason == "refusal" or msg.parsed_output is None:
        raise RuntimeError(f"no parsed output (stop_reason={msg.stop_reason})")
    return msg.parsed_output


async def _parse(system: str, user: str, model_cls):
    msg = await _client.beta.messages.parse(
        model=MODEL,
        max_tokens=2000,
        output_config={"effort": "low"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        system=system,
        messages=[{"role": "user", "content": user}],
        output_format=model_cls,
    )
    return _parsed(msg)


def _fallback_triage(transcript: str) -> Triage:
    flags = red_flags.check_text(transcript)
    critical = any(level == "critical" for _, level in flags)
    return Triage(
        complaint=(flags[0][0].capitalize() if flags else "Needs evaluation"),
        summary=transcript[:200],
        acuity=2 if critical or flags else 3,
        red_flags=[f for f, _ in flags],
        prep=[],
        specialty="Cardiology" if any("chest" in f or "arm" in f for f, _ in flags) else "Emergency",
        spoken_reply="You're checked in and the team has your information. "
        + ("If your symptoms get worse, pull over and call 911." if flags else "See you soon."),
    )


async def triage(transcript: str, age: int | None, language: str = "English") -> Triage:
    try:
        result = await _parse(
            TRIAGE_SYSTEM,
            f"Patient age: {age if age is not None else 'unknown'}\nPatient's language: {language}\n"
            f"Patient said: \"{transcript}\"\n\n"
            f"Write complaint, summary, red_flags and prep in English for the nurse. "
            f"Write spoken_reply in {language}.",
            Triage,
        )
    except (anthropic.APIError, RuntimeError) as e:
        log.warning("LLM triage failed, using rules: %s", e)
        return _fallback_triage(transcript)
    # Rules can only add flags / raise urgency, never lower it.
    rule_flags = red_flags.check_text(transcript)
    for flag, level in rule_flags:
        if flag.lower() not in {f.lower() for f in result.red_flags}:
            result.red_flags.append(flag)
        if level == "critical":
            result.acuity = min(result.acuity, 2)
    result.acuity = max(1, min(5, result.acuity))
    return result


async def follow_up(complaint: str, question: str, answer: str, language: str = "English") -> FollowUp:
    rule_flags = red_flags.check_text(answer)
    rule_level = "critical" if any(l == "critical" for _, l in rule_flags) else ("warning" if rule_flags else "none")
    try:
        result = await _parse(
            FOLLOWUP_SYSTEM,
            f"Original complaint: {complaint}\nWe asked: \"{question}\"\nPatient answered: \"{answer}\"\n"
            f"Write reason in English for the nurse and spoken_reply in {language}.",
            FollowUp,
        )
    except (anthropic.APIError, RuntimeError) as e:
        log.warning("LLM follow-up failed, using rules: %s", e)
        result = FollowUp(level="none", reason="", spoken_reply="Thanks. We'll check on you again soon.")
    order = {"none": 0, "warning": 1, "critical": 2}
    if order[rule_level] > order[result.level]:
        result.level = rule_level
        result.reason = ", ".join(f for f, _ in rule_flags)
        if rule_level == "critical":
            result.spoken_reply = "Thank you for telling me. A nurse is coming to you right now."
    return result
