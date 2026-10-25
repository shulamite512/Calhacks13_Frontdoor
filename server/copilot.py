"""Charge-Nurse Copilot: an agent that notices urgent events on the board and acts on them.

Triggers (checked every simulator tick):
  - a critical patient (ESI 1-2) is on the way
  - a waiting patient got a critical alert
  - the forecast says we'll be 4+ beds short

On each trigger, Claude gets a snapshot of the board and a small set of tools. Every tool call is
validated here before it runs, and the autonomy level is fixed in code, not chosen by the model:
  AUTO (reversible, one-tap undo on the board): hold a bed, page a department/nurse, post a checklist,
      flag a patient as top priority
  APPROVAL (a nurse must confirm): assign a bed, offer a patient another ER
  NEVER (no tool exists): lower urgency, discharge, redirect a critical patient
Every action is written to agent_action with the agent's reason and shown on the board.
"""
import asyncio
import json
import logging
import os
import time

import anthropic

import matching
import stdb

log = logging.getLogger("copilot")

MODEL = "claude-opus-5-5"
MAX_TURNS = 6
BEDS_SHORT_TRIGGER = 4
BEDS_SHORT_COOLDOWN_S = 600
ENABLED = os.getenv("COPILOT_ENABLED", "1") != "0"
DEPARTMENTS = ["Cardiology", "Neurology", "Surgery", "ICU", "Pediatrics", "Trauma", "Orthopedics", "Obstetrics",
               "Psychiatry", "Gastroenterology", "Pulmonology", "Nephrology", "Burns", "Charge nurse"]

_client = anthropic.AsyncAnthropic()
_handled: set[str] = set()
_running: set[str] = set()
_last_beds_short = 0.0
HOSPITAL: dict = {}  # set by app.py: our ER's name and location

SYSTEM = """You are the Charge-Nurse Copilot for an emergency department. Something urgent just \
happened. Look at the snapshot, then take the few actions that most help the team right now, \
using only the tools. Be decisive and brief.

Rules:
- Holding a bed, paging, posting a checklist and flagging priority happen immediately (a nurse can \
undo them). Assigning a bed or offering another ER only creates a proposal a nurse must approve.
- Prefer Resus for ESI 1, Acute for ESI 2-3. Use hallway beds only if nothing else is free, and \
never hold a hallway bed.
- Page the department the patient needs; page the "Charge nurse" for a deteriorating waiting patient.
- Never try to lower anyone's urgency, discharge anyone, or send a critical patient elsewhere.
- Take at most 4 actions, then reply with one short sentence summarizing what you did."""


def _tool(name: str, description: str, props: dict) -> dict:
    return {
        "name": name, "description": description, "strict": True,
        "input_schema": {"type": "object", "properties": props, "required": list(props), "additionalProperties": False},
    }


PID = {"type": "integer", "description": "patient id"}
REASON = {"type": "string", "description": "short reason shown to nurses"}
TOOLS = [
    _tool("hold_bed", "AUTO: reserve a free (non-hallway) bed for a patient who is on the way.",
          {"patient_id": PID, "bed_label": {"type": "string"}, "reason": REASON}),
    _tool("page_department", "AUTO: send a page to a department or the charge nurse.",
          {"patient_id": PID, "department": {"type": "string", "enum": DEPARTMENTS},
           "message": {"type": "string"}}),
    _tool("post_checklist", "AUTO: post a short prep checklist on the patient's tile.",
          {"patient_id": PID, "items": {"type": "array", "items": {"type": "string"}}}),
    _tool("flag_priority", "AUTO: flag a patient as top priority for the team.", {"patient_id": PID, "reason": REASON}),
    _tool("propose_bed", "APPROVAL: propose assigning a free bed (hallway allowed) to a patient; a nurse confirms.",
          {"patient_id": PID, "bed_label": {"type": "string"}, "reason": REASON}),
    _tool("propose_other_er", "APPROVAL: propose offering a stable walk-in still on the way a better-matched ER.",
          {"patient_id": PID, "reason": REASON}),
]


def reset() -> None:
    global _last_beds_short
    _handled.clear()
    # Give the demo a minute to fill up before reacting to the beds-short forecast.
    _last_beds_short = time.time() - BEDS_SHORT_COOLDOWN_S + 60


async def _record(pid: int, kind: str, level: str, status: str, summary: str, detail: str, bed_id: int, trigger: str):
    await stdb.call("record_agent_action", pid, kind, level, status, summary[:200], detail[:500], bed_id, trigger)


async def _snapshot(focus_pid: int | None) -> dict:
    patients = await stdb.sql("SELECT * FROM patient")
    beds = await stdb.sql("SELECT * FROM bed")
    depts = await stdb.sql("SELECT * FROM department")
    fc = await stdb.sql("SELECT * FROM forecast")
    active = [p for p in patients if p["status"] in ("incoming", "waiting", "roomed")]
    return {
        "focus_patient_id": focus_pid,
        "patients": [{k: p[k] for k in ("id", "name", "age", "complaint", "acuity", "risk", "status", "source",
                                         "specialty", "eta_minutes", "red_flags")} for p in active],
        "beds": [{"label": b["label"], "zone": b["zone"], "status": b["status"],
                  "held_or_used_by": b["patient_id"]} for b in beds],
        "departments": [{"name": d["name"], "doctors_on_call": d["doctors_on_call"], "beds_free": d["beds_free"],
                         "beds_total": d["beds_total"], "resource": d["resource"], "ready": d["resource_ready"]}
                        for d in depts],
        "forecast": fc[0]["basis"] if fc else "",
    }


async def _execute(name: str, args: dict, trigger: str) -> str:
    """Validate and run one tool call. Returns a result string for Claude (raise ValueError to reject)."""
    pid = int(args["patient_id"])
    rows = await stdb.sql(f"SELECT * FROM patient WHERE id = {pid}")
    if not rows:
        raise ValueError(f"patient {pid} not found")
    p = rows[0]
    beds = await stdb.sql("SELECT * FROM bed")
    label_to_bed = {b["label"].upper(): b for b in beds}

    if name in ("hold_bed", "propose_bed"):
        b = label_to_bed.get(str(args["bed_label"]).upper())
        if not b or b["status"] != "free":
            raise ValueError(f"bed {args['bed_label']} is not free")
        if name == "hold_bed":
            if p["status"] != "incoming":
                raise ValueError("only patients still on the way get a held bed")
            if b["zone"] == "Hallway":
                raise ValueError("never hold a hallway bed")
            if any(x["status"] == "reserved" and x["patient_id"] == pid for x in beds):
                raise ValueError("patient already has a held bed")
            await stdb.call("hold_bed", b["id"], pid)
            await _record(pid, "hold_bed", "auto", "done", f"Held {b['label']} ({b['zone']}) for {p['name']}",
                          args["reason"], b["id"], trigger)
            return f"held {b['label']}"
        if p["status"] not in ("incoming", "waiting"):
            raise ValueError("patient doesn't need a bed")
        await _record(pid, "suggest_bed", "approval", "pending", f"Assign {b['label']} ({b['zone']}) to {p['name']}?",
                      args["reason"], b["id"], trigger)
        return f"proposed {b['label']} for nurse approval"

    if name == "page_department":
        dept = args["department"]
        if dept not in DEPARTMENTS:
            raise ValueError("unknown department")
        await _record(pid, "page", "auto", "done", f"Paged {dept}: {args['message']}", args["message"], 0, trigger)
        return f"paged {dept}"

    if name == "post_checklist":
        items = [str(i) for i in args["items"]][:5]
        await _record(pid, "checklist", "auto", "done", f"Prep for {p['name']}: " + " · ".join(items), "", 0, trigger)
        return "checklist posted"

    if name == "flag_priority":
        await _record(pid, "prioritize", "auto", "done", f"Top priority: {p['name']}", args["reason"], 0, trigger)
        return "flagged"

    if name == "propose_other_er":
        if p["status"] != "incoming" or p["source"] != "walk-in" or p["acuity"] <= 2:
            raise ValueError("only stable walk-ins still on the way can be offered another ER")
        offers = await stdb.sql(f"SELECT * FROM redirect_offer WHERE patient_id = {pid}")
        if any(o["status"] == "pending" for o in offers):
            raise ValueError("an offer is already pending for this patient")
        options = await matching.rank(p["specialty"], p["lat"], p["lng"], HOSPITAL)
        best = next((o for o in options if o["hospitalId"] != matching.OUR_ID and o["canTreat"]), None)
        if not best:
            raise ValueError("no nearby ER can treat this patient right now")
        await _record(pid, "suggest_other_er", "approval", "pending",
                      f"Offer {p['name']} {best['name']}? {best['reason']}", args["reason"], 0, trigger)
        return f"proposed {best['name']} for nurse approval"

    raise ValueError(f"unknown tool {name}")


async def _run(trigger: str, event: str, focus_pid: int | None) -> None:
    snapshot = await _snapshot(focus_pid)
    messages = [{"role": "user", "content": f"Event: {event}\n\nBoard snapshot:\n{json.dumps(snapshot, default=str)}"}]
    for _ in range(MAX_TURNS):
        resp = await _client.beta.messages.create(
            model=MODEL, max_tokens=4000, output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            system=SYSTEM, tools=TOOLS, messages=messages,
        )
        if resp.stop_reason == "refusal":
            log.warning("copilot refused on %s", trigger)
            return
        calls = [b for b in resp.content if b.type == "tool_use"]
        if not calls:
            text = " ".join(b.text for b in resp.content if b.type == "text").strip()
            log.info("copilot %s: %s", trigger, text)
            return
        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for c in calls:
            try:
                out, err = await _execute(c.name, c.input, trigger), False
            except (ValueError, stdb.ReducerError) as e:
                out, err = f"Rejected: {e}", True
            results.append({"type": "tool_result", "tool_use_id": c.id, "content": out, "is_error": err})
        messages.append({"role": "user", "content": results})


async def _guarded(trigger: str, event: str, focus_pid: int | None) -> None:
    _running.add(trigger)
    try:
        await _run(trigger, event, focus_pid)
    except Exception:
        log.exception("copilot run failed for %s", trigger)
    finally:
        _running.discard(trigger)


async def check(patients: list[dict], forecast_row: dict | None) -> None:
    """Called every tick: start the agent for any new urgent event."""
    global _last_beds_short
    if not ENABLED:
        return
    events = []
    for p in patients:
        if p["status"] == "incoming" and p["acuity"] <= 2:
            events.append((f"critical_incoming:{p['id']}", p["id"],
                           f"Critical patient on the way: {p['name']}, ESI {p['acuity']}, {p['complaint']}, "
                           f"needs {p['specialty'] or 'emergency care'}, {p['source']}, ETA {p['eta_minutes']} min."))
    alerts = await stdb.sql("SELECT * FROM alert")
    waiting = {p["id"]: p for p in patients if p["status"] == "waiting"}
    for a in alerts:
        if a["level"] == "critical" and a["acked_at"] is None and a["patient_id"] in waiting:
            p = waiting[a["patient_id"]]
            events.append((f"deteriorating:{a['id']}", p["id"],
                           f"Waiting patient deteriorating: {p['name']}, {p['complaint']}, alert: {a['reason']}."))
    if (forecast_row and forecast_row["beds_short"] >= BEDS_SHORT_TRIGGER and patients
            and time.time() - _last_beds_short > BEDS_SHORT_COOLDOWN_S):
        _last_beds_short = time.time()
        events.append((f"beds_short:{int(time.time())}", None,
                       f"Forecast: {forecast_row['beds_short']} beds short in 30 min. {forecast_row['basis']}"))
    for trigger, pid, event in events:
        if trigger in _handled or trigger in _running:
            continue
        _handled.add(trigger)
        asyncio.create_task(_guarded(trigger, event, pid))
