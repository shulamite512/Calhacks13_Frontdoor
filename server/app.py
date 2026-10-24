"""FrontDoor voice + AI server.

Run:  .venv\\Scripts\\python -m uvicorn app:app --port 8000   (from the server/ folder)
      Restart after edits; --reload hangs on Windows.
"""
import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from fastapi import FastAPI, File, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import Response  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import simulator  # noqa: E402
import stdb  # noqa: E402
import triage  # noqa: E402
import voice  # noqa: E402

logging.basicConfig(level=logging.INFO)

# The ER this demo runs for, and where demo patients start (Palace of Fine Arts, SF).
HOSPITAL = {"name": "CPMC Van Ness Campus ED", "lat": 37.78598, "lng": -122.42235}
DEMO_START = (37.80292, -122.44840)

# Background patients created by /demo/reset so the board isn't empty.
DEMO_PATIENTS = [
    ("Maria Lopez", 34, "Ankle injury", "I twisted my ankle playing soccer and it's swollen.",
     "Right ankle inversion injury, swelling, able to bear some weight.", 4, "", 0),
    ("James Chen", 67, "Shortness of breath", "I've been more short of breath than usual since yesterday.",
     "Increased dyspnea x1 day, history of COPD per patient.", 3, "shortness of breath", 0),
    ("Aisha Patel", 8, "Fever", "My daughter has had a fever of 102 since this morning.",
     "Pediatric fever 102F since AM, drinking fluids, no rash reported.", 4, "", 0),
    ("Robert King", 52, "Abdominal pain", "Sharp pain in my lower right belly for six hours.",
     "RLQ abdominal pain x6h, sharp, worsening.", 3, "", 15),
]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(simulator.run())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="FrontDoor", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class SpeakIn(BaseModel):
    text: str


class CheckInIn(BaseModel):
    name: str
    age: int
    transcript: str
    etaMinutes: int = 0
    lat: float = DEMO_START[0]
    lng: float = DEMO_START[1]


class FollowUpIn(BaseModel):
    patientId: int
    question: str
    answer: str


class PatientIdIn(BaseModel):
    patientId: int


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
        ", ".join(t.red_flags), body.etaMinutes, body.lat, body.lng,
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


# ---------- Demo controls ----------

@app.post("/demo/worsen")
async def demo_worsen(body: PatientIdIn):
    simulator.set_worsening(body.patientId, True)
    return {"ok": True}


@app.post("/demo/arrive")
async def demo_arrive(body: PatientIdIn):
    await stdb.call("mark_arrived", body.patientId)
    return {"ok": True}


@app.post("/demo/reset")
async def demo_reset():
    await stdb.call("reset_demo")
    simulator.reset()
    for name, age, complaint, transcript, summary, acuity, flags, eta in DEMO_PATIENTS:
        lat, lng = (DEMO_START if eta else (HOSPITAL["lat"], HOSPITAL["lng"]))
        await stdb.call("check_in", name, age, complaint, transcript, summary, acuity, flags, eta, lat, lng)
    return {"ok": True}
