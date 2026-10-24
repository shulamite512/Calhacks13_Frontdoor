"""FrontDoor voice + AI server.

Run:  .venv\\Scripts\\python -m uvicorn app:app --port 8000   (from the server/ folder)
      Restart after edits; --reload hangs on Windows.
"""
import asyncio
import hmac
import logging
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from fastapi import FastAPI, File, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse, Response  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import network  # noqa: E402
import routing  # noqa: E402
import simulator  # noqa: E402
import stdb  # noqa: E402
import triage  # noqa: E402
import voice  # noqa: E402

logging.basicConfig(level=logging.INFO)

# The ER this demo runs for, and where demo patients start (Palace of Fine Arts, SF).
HOSPITAL = {"name": "CPMC Van Ness Campus ED", "lat": 37.78598, "lng": -122.42235}
DEMO_START = (37.80292, -122.44840)

# Background patients created by /demo/reset so the board isn't empty.
# "drive" = (start lat, start lng, seconds the simulated drive takes) for patients still on the way.
DEMO_PATIENTS = [
    dict(name="Maria Lopez", age=34, complaint="Ankle injury", acuity=4,
         transcript="I twisted my ankle playing soccer and it's swollen.",
         summary="Right ankle inversion injury, swelling, able to bear some weight."),
    dict(name="James Chen", age=67, complaint="Shortness of breath", acuity=3, flags="shortness of breath",
         transcript="I've been more short of breath than usual since yesterday.",
         summary="Increased dyspnea x1 day, history of COPD per patient.", prep="Nebulizer"),
    dict(name="Aisha Patel", age=8, complaint="Fever", acuity=4,
         transcript="My daughter has had a fever of 102 since this morning.",
         summary="Pediatric fever 102F since AM, drinking fluids, no rash reported."),
    dict(name="Robert King", age=52, complaint="Abdominal pain", acuity=3,
         transcript="Sharp pain in my lower right belly for six hours.",
         summary="RLQ abdominal pain x6h, sharp, worsening.", prep="IV access, CT abdomen",
         drive=(*DEMO_START, 420)),
    dict(name="EMS Medic 12: male ~70", age=70, complaint="Possible stroke", acuity=2, source="ems",
         flags="facial droop, slurred speech", transcript="EMS report: left facial droop, slurred speech, onset 25 min ago.",
         summary="Ambulance: suspected stroke, last known well 25 min ago, BP 182/96.",
         prep="Stroke team, CT scanner", drive=(37.7605, -122.4680, 300)),
]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(simulator.run())
    yield
    _stop_drives()
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="FrontDoor", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(stdb.ReducerError)
async def reducer_error(_request, exc: stdb.ReducerError):
    # e.g. "patient 1 not found" or "bed A4 is occupied": a bad request, not a server crash.
    return JSONResponse({"error": str(exc)}, status_code=400)


class SpeakIn(BaseModel):
    text: str


class CheckInIn(BaseModel):
    name: str
    age: int
    transcript: str
    etaMinutes: int = 0
    lat: float = DEMO_START[0]
    lng: float = DEMO_START[1]
    phoneId: str = ""   # the phone's SpacetimeDB identity (hex), so it can see only its own record


class StaffLoginIn(BaseModel):
    pin: str
    identity: str       # the board browser's SpacetimeDB identity (hex)
    name: str


class PinIn(BaseModel):
    pin: str


class StaffPatientIn(BaseModel):
    pin: str
    patientId: int


def _check_pin(pin: str) -> None:
    """Board-only actions that go through this server (not the database) are gated by the staff PIN."""
    expected = os.getenv("STAFF_PIN")
    if not expected:
        raise HTTPException(503, "STAFF_PIN is not set in .env")
    if not hmac.compare_digest(pin.encode(), expected.encode()):
        raise HTTPException(403, "wrong staff PIN")


class FollowUpIn(BaseModel):
    patientId: int
    question: str
    answer: str


class PatientIdIn(BaseModel):
    patientId: int


class LocationIn(BaseModel):
    patientId: int
    lat: float
    lng: float


ARRIVED_WITHIN_M = 150
_drives: dict[int, asyncio.Task] = {}


async def _drive(pid: int, lat: float, lng: float, seconds: float) -> None:
    """Move a patient along the real route to the hospital, compressed into `seconds`."""
    try:
        duration, path = await routing.route(lat, lng, HOSPITAL["lat"], HOSPITAL["lng"])
        steps = max(2, int(seconds / 2))
        for i in range(1, steps + 1):
            frac = i / steps
            plat, plng = path[min(len(path) - 1, int(frac * (len(path) - 1)))]
            eta = max(0, round(duration * (1 - frac) / 60))
            await stdb.call("update_location", pid, plat, plng, eta)
            await asyncio.sleep(2)
        await stdb.call("mark_arrived", pid)
    except asyncio.CancelledError:
        raise
    except Exception:
        logging.exception("drive for patient %s failed", pid)


def _start_drive(pid: int, lat: float, lng: float, seconds: float) -> None:
    if pid in _drives:
        _drives[pid].cancel()
    _drives[pid] = asyncio.create_task(_drive(pid, lat, lng, seconds))


def _stop_drives() -> None:
    for t in _drives.values():
        t.cancel()
    _drives.clear()


@app.get("/health")
async def health():
    return {"ok": True, "db": stdb.DB, "hospital": HOSPITAL}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    audio = await file.read()
    if not audio:
        raise HTTPException(400, "empty audio")
    text = await voice.transcribe(audio, file.filename or "audio.webm", file.content_type or "audio/webm")
    return {"text": text}


@app.post("/speak")
async def speak(body: SpeakIn):
    return Response(await voice.speak(body.text), media_type="audio/mpeg")


async def _patient_by_name(name: str) -> dict | None:
    safe = name.replace("'", "''")
    rows = await stdb.sql(f"SELECT * FROM patient WHERE name = '{safe}'")
    return max(rows, key=lambda r: r["id"]) if rows else None


@app.post("/checkin")
async def checkin(body: CheckInIn):
    t = await triage.triage(body.transcript, body.age)
    await stdb.call(
        "check_in", body.name, body.age, t.complaint, body.transcript, t.summary, t.acuity,
        ", ".join(t.red_flags), body.etaMinutes, body.lat, body.lng, "walk-in", ", ".join(t.prep),
        body.phoneId.lower().removeprefix("0x"),
    )
    p = await _patient_by_name(body.name)
    return {"patientId": p["id"] if p else None, **t.model_dump()}


@app.get("/followup/question/{patient_id}")
async def followup_question(patient_id: int):
    rows = await stdb.sql(f"SELECT * FROM patient WHERE id = {patient_id}")
    if not rows:
        raise HTTPException(404, "patient not found")
    first = rows[0]["name"].split()[0]
    return {"question": f"Hi {first}, this is FrontDoor checking in. How are you feeling right now compared to when you arrived?"}


@app.post("/followup")
async def followup(body: FollowUpIn):
    rows = await stdb.sql(f"SELECT * FROM patient WHERE id = {body.patientId}")
    if not rows:
        raise HTTPException(404, "patient not found")
    # Silence or a mis-hear shouldn't page a nurse; ask again instead.
    if len([c for c in body.answer if c.isalpha()]) < 3:
        return {"level": "none", "reason": "", "heard": False,
                "spoken_reply": "Sorry, I didn't catch that. Tap Check on me and try again."}
    r = await triage.follow_up(rows[0]["complaint"], body.question, body.answer)
    await stdb.call("add_follow_up", body.patientId, body.question, body.answer, r.level != "none")
    if r.level != "none":
        await stdb.call("raise_alert", body.patientId, r.level, f"Patient reports: {r.reason}")
        simulator.note_alert(body.patientId, r.level)
    return {**r.model_dump(), "heard": True}


@app.post("/location")
async def location(body: LocationIn):
    """Live GPS from the patient's phone: update ETA, auto-arrive near the ER."""
    left = routing.distance_m(body.lat, body.lng, HOSPITAL["lat"], HOSPITAL["lng"])
    if left <= ARRIVED_WITHIN_M:
        await stdb.call("mark_arrived", body.patientId)
        return {"arrived": True, "etaMinutes": 0}
    duration, _ = await routing.route(body.lat, body.lng, HOSPITAL["lat"], HOSPITAL["lng"])
    eta = max(1, round(duration / 60))
    await stdb.call("update_location", body.patientId, body.lat, body.lng, eta)
    return {"arrived": False, "etaMinutes": eta}


@app.post("/staff/login")
async def staff_login(body: StaffLoginIn):
    """Check the PIN, then grant this browser's identity the staff role in the database."""
    _check_pin(body.pin)
    try:
        ident = stdb.identity_arg(body.identity)
    except ValueError:
        raise HTTPException(400, "invalid identity")
    await stdb.call("grant_staff", ident, body.name.strip()[:40] or "Staff")
    return {"ok": True}


@app.post("/redirect/suggest")
async def redirect_suggest(body: StaffPatientIn):
    _check_pin(body.pin)
    """Find the nearby ER with the best drive + wait and offer it to the patient's phone."""
    rows = await stdb.sql(f"SELECT * FROM patient WHERE id = {body.patientId}")
    if not rows:
        raise HTTPException(404, "patient not found")
    p = rows[0]
    best = await network.best_alternative(p["lat"], p["lng"])
    if not best:
        raise HTTPException(409, "no nearby ER has free beds")
    # The module re-checks eligibility (incoming, walk-in, ESI 3-5) and rejects anything else.
    await stdb.call("offer_redirect", body.patientId, best["hospitalId"], best["driveMinutes"], best["waitMinutes"])
    return best


# ---------- Demo controls ----------

@app.post("/demo/drive")
async def demo_drive(body: PatientIdIn):
    """Simulate the patient driving from the Palace of Fine Arts to the ER in about a minute."""
    _start_drive(body.patientId, *DEMO_START, 60)
    return {"ok": True}


@app.post("/demo/worsen")
async def demo_worsen(body: StaffPatientIn):
    _check_pin(body.pin)
    simulator.set_worsening(body.patientId, True)
    return {"ok": True}


@app.post("/demo/arrive")
async def demo_arrive(body: PatientIdIn):
    await stdb.call("mark_arrived", body.patientId)
    return {"ok": True}


@app.post("/demo/reset")
async def demo_reset(body: PinIn):
    _check_pin(body.pin)
    _stop_drives()
    await stdb.call("reset_demo")
    simulator.reset()
    await network.seed()
    for d in DEMO_PATIENTS:
        lat, lng, secs = d.get("drive", (HOSPITAL["lat"], HOSPITAL["lng"], 0))
        eta = 0
        if secs:
            duration, _ = await routing.route(lat, lng, HOSPITAL["lat"], HOSPITAL["lng"])
            eta = max(1, round(duration / 60))
        await stdb.call(
            "check_in", d["name"], d["age"], d["complaint"], d["transcript"], d["summary"], d["acuity"],
            d.get("flags", ""), eta, lat, lng, d.get("source", "walk-in"), d.get("prep", ""), "",
        )
        if secs:
            p = await _patient_by_name(d["name"])
            _start_drive(p["id"], lat, lng, secs)
    return {"ok": True}
