"""FrontDoor voice + AI server.

Run:  .venv\\Scripts\\python -m uvicorn app:app --port 8000   (from the server/ folder)
      Restart after edits; --reload hangs on Windows.
"""
import asyncio
import hmac
import secrets
import logging
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from fastapi import FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse, Response  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import departments  # noqa: E402
import matching  # noqa: E402
import network  # noqa: E402
import routing  # noqa: E402
import simulator  # noqa: E402
import stdb  # noqa: E402
import triage  # noqa: E402
import voice  # noqa: E402

logging.basicConfig(level=logging.INFO)

# The ER this demo runs for, and where demo patients start (Palace of Fine Arts, SF).
HOSPITAL = {"name": "CPMC Van Ness Campus ED", "lat": 37.78616, "lng": -122.42285}  # ER entrance, 1260 Franklin St
DEMO_START = (37.80292, -122.44840)

# Background patients created by /demo/reset so the board isn't empty.
# "drive" = (start lat, start lng, seconds the simulated drive takes) for patients still on the way.
DEMO_PATIENTS = [
    dict(name="Maria Lopez", age=34, complaint="Ankle injury", acuity=4,
         transcript="I twisted my ankle playing soccer and it's swollen.",
         summary="Right ankle inversion injury, swelling, able to bear some weight.", specialty="Orthopedics"),
    dict(name="James Chen", age=67, complaint="Shortness of breath", acuity=3, flags="shortness of breath",
         transcript="I've been more short of breath than usual since yesterday.",
         summary="Increased dyspnea x1 day, history of COPD per patient.", prep="Nebulizer",
         specialty="Pulmonology"),
    dict(name="Aisha Patel", age=8, complaint="Fever", acuity=4,
         transcript="My daughter has had a fever of 102 since this morning.",
         summary="Pediatric fever 102F since AM, drinking fluids, no rash reported.", specialty="Pediatrics"),
    dict(name="Robert King", age=52, complaint="Abdominal pain", acuity=3,
         transcript="Sharp pain in my lower right belly for six hours.",
         summary="RLQ abdominal pain x6h, sharp, worsening.", prep="IV access, CT abdomen", specialty="Surgery",
         drive=(*DEMO_START, 420)),
    dict(name="EMS Medic 12: male ~70", age=70, complaint="Possible stroke", acuity=2, source="ems",
         flags="facial droop, slurred speech", transcript="EMS report: left facial droop, slurred speech, onset 25 min ago.",
         summary="Ambulance: suspected stroke, last known well 25 min ago, BP 182/96.",
         prep="Stroke team, CT scanner", specialty="Neurology", drive=(37.7605, -122.4680, 300)),
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
    language: str = "en"


class ShareIn(BaseModel):
    patientId: int
    phoneId: str


# Waiting-room check-in question in each supported language ({name} = first name).
FOLLOWUP_QUESTION = {
    "en": "Hi {name}, this is FrontDoor checking in. How are you feeling right now compared to when you arrived?",
    "es": "Hola {name}, le habla FrontDoor. ¿Cómo se siente ahora comparado con cuando llegó?",
    "zh": "{name}您好，我是FrontDoor。和刚到的时候相比，您现在感觉怎么样？",
    "vi": "Chào {name}, đây là FrontDoor. Bây giờ bạn cảm thấy thế nào so với lúc mới đến?",
    "tl": "Kumusta {name}, ito ang FrontDoor. Ano ang pakiramdam mo ngayon kumpara noong dumating ka?",
}
SORRY = {
    "en": "Sorry, I didn't catch that. Tap Check on me and try again.",
    "es": "Perdón, no le escuché bien. Toque Revisarme e inténtelo de nuevo.",
    "zh": "抱歉，我没听清楚。请点击“查看我的情况”再试一次。",
    "vi": "Xin lỗi, tôi nghe không rõ. Hãy nhấn Kiểm tra tôi và thử lại.",
    "tl": "Paumanhin, hindi ko narinig nang malinaw. Pindutin ang Tingnan ako at subukan muli.",
}


class CheckInIn(BaseModel):
    name: str
    age: int
    transcript: str
    etaMinutes: int = 0
    lat: float = DEMO_START[0]
    lng: float = DEMO_START[1]
    language: str = "en"
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


class MissedIn(BaseModel):
    patientId: int
    count: int = 2


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
async def transcribe(file: UploadFile = File(...), language: str = Form("en")):
    audio = await file.read()
    if not audio:
        raise HTTPException(400, "empty audio")
    text = await voice.transcribe(audio, file.filename or "audio.webm", file.content_type or "audio/webm", language)
    return {"text": text}


@app.post("/speak")
async def speak(body: SpeakIn):
    return Response(await voice.speak(body.text, body.language), media_type="audio/mpeg")


async def _patient_by_name(name: str) -> dict | None:
    safe = name.replace("'", "''")
    rows = await stdb.sql(f"SELECT * FROM patient WHERE name = '{safe}'")
    return max(rows, key=lambda r: r["id"]) if rows else None


@app.post("/checkin")
async def checkin(body: CheckInIn):
    lang = voice.lang_or_en(body.language)
    t = await triage.triage(body.transcript, body.age, voice.LANGUAGES[lang])
    await stdb.call(
        "check_in", body.name, body.age, t.complaint, body.transcript, t.summary, t.acuity,
        ", ".join(t.red_flags), body.etaMinutes, body.lat, body.lng, "walk-in", ", ".join(t.prep),
        body.phoneId.lower().removeprefix("0x"), "" if t.specialty == "Emergency" else t.specialty, lang,
    )
    p = await _patient_by_name(body.name)
    match = {}
    if p:
        try:
            match = await _match_and_advise(p)
        except Exception:
            logging.exception("matching failed for patient %s", p["id"])
    return {"patientId": p["id"] if p else None, **t.model_dump(), "match": match}


async def _match_and_advise(p: dict) -> dict:
    """Find the ER that can treat this patient right now and tell them (phone) / the board.

    - Critical (ESI 1-2) and still on the way: "Call 911 now" plus the best-equipped ER. We never tell
      a critical patient to keep driving somewhere.
    - Stable walk-in on the way: if another ER can treat them and ours can't (or it's 10+ min faster),
      offer it on the phone with the reason; the patient decides. Otherwise: "we're ready for you".
    - Already here: nothing (EMTALA: anyone at our door is seen here).
    """
    if p["status"] != "incoming" or p["source"] != "walk-in":
        return {}  # already here, or already in an ambulance (paramedics choose the destination)
    options = await matching.rank(p["specialty"], p["lat"], p["lng"], HOSPITAL, critical=p["acuity"] <= 2)
    ours = next(o for o in options if o["hospitalId"] == matching.OUR_ID)
    best = options[0]
    result = {"best": best, "ours": ours, "options": options[:4]}
    if p["acuity"] <= 2:
        where = (f" Best-equipped ER right now: {best['name']} ({best['reason']})." if best["canTreat"]
                 else " Paramedics will take you to the right ER.")
        first = ("Call 911 now if you're in immediate danger, or call or text 988 (Suicide & Crisis Lifeline)."
                 if p["specialty"] == "Psychiatry" else "Call 911 now: an ambulance is the safest way in.")
        await stdb.call("set_advice", p["id"], first + where)
        return result
    if best["hospitalId"] != matching.OUR_ID and (not ours["canTreat"] or best["totalMinutes"] + 10 < ours["totalMinutes"]):
        here = ours["reason"] if not ours["canTreat"] else f"about {ours['totalMinutes']} min until care here"
        reason = f"{best['reason']}. At {HOSPITAL['name']}: {here}."
        await stdb.call("offer_redirect", p["id"], best["hospitalId"], best["driveMinutes"], best["waitMinutes"], reason)
    elif ours["canTreat"]:
        await stdb.call("set_advice", p["id"], f"{HOSPITAL['name']} is ready for you: {ours['reason']}.")
    return result


@app.get("/followup/question/{patient_id}")
async def followup_question(patient_id: int):
    rows = await stdb.sql(f"SELECT * FROM patient WHERE id = {patient_id}")
    if not rows:
        raise HTTPException(404, "patient not found")
    first = rows[0]["name"].split()[0]
    lang = voice.lang_or_en(rows[0].get("language"))
    return {"question": FOLLOWUP_QUESTION[lang].format(name=first), "language": lang}


@app.post("/followup")
async def followup(body: FollowUpIn):
    rows = await stdb.sql(f"SELECT * FROM patient WHERE id = {body.patientId}")
    if not rows:
        raise HTTPException(404, "patient not found")
    # Silence or a mis-hear shouldn't page a nurse; ask again instead.
    lang = voice.lang_or_en(rows[0].get("language"))
    if len([c for c in body.answer if c.isalpha()]) < 2 or _is_silence_hallucination(body.answer):
        return {"level": "none", "reason": "", "heard": False, "spoken_reply": SORRY[lang]}
    r = await triage.follow_up(rows[0]["complaint"], body.question, body.answer, voice.LANGUAGES[lang])
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
    """Nurse asks: which other ER can treat this patient soonest? Offer it to the patient's phone."""
    rows = await stdb.sql(f"SELECT * FROM patient WHERE id = {body.patientId}")
    if not rows:
        raise HTTPException(404, "patient not found")
    p = rows[0]
    options = await matching.rank(p["specialty"], p["lat"], p["lng"], HOSPITAL)
    best = next((o for o in options if o["hospitalId"] != matching.OUR_ID and o["canTreat"]), None)
    if not best:
        raise HTTPException(409, "no nearby ER can treat this patient right now")
    # The module re-checks eligibility (incoming, walk-in, ESI 3-5) and rejects anything else.
    await stdb.call("offer_redirect", body.patientId, best["hospitalId"], best["driveMinutes"], best["waitMinutes"],
                    best["reason"])
    return best


# Whisper-style speech-to-text "hears" these on silence or background noise. As a whole answer to
# "how are you feeling?", they mean we didn't really hear the patient.
SILENCE_PHRASES = {
    "thank you", "thanks", "thank you very much", "thanks for watching", "thank you for watching",
    "bye", "bye bye", "you", "gracias", "muchas gracias", "谢谢", "谢谢观看", "cảm ơn", "salamat",
}


def _is_silence_hallucination(answer: str) -> bool:
    norm = "".join(c for c in answer.lower() if c.isalnum() or c.isspace() or ord(c) > 0x2e80).strip()
    return " ".join(norm.split()) in SILENCE_PHRASES


@app.post("/followup/missed")
async def followup_missed(body: MissedIn):
    """The phone asked twice automatically and heard nothing back. One silence is often a mic problem;
    repeated silence from a waiting patient is worth a nurse's look."""
    rows = await stdb.sql(f"SELECT * FROM patient WHERE id = {body.patientId}")
    if not rows:
        raise HTTPException(404, "patient not found")
    if rows[0]["status"] != "waiting":
        return {"ok": False, "reason": "not in waiting room"}
    count = max(2, min(body.count, 10))
    await stdb.call("add_follow_up", body.patientId, "Automatic check-in", "(no answer)", True)
    await stdb.call("raise_alert", body.patientId, "warning", f"No answer to {count} automatic check-ins")
    simulator.note_alert(body.patientId, "warning")
    return {"ok": True}


# ---------- Family status link ----------

@app.post("/family/share")
async def family_share(body: ShareIn):
    """The patient's phone asks for a link to send to family. Only that phone may create it."""
    rows = await stdb.sql(f"SELECT * FROM patient WHERE id = {body.patientId}")
    if not rows:
        raise HTTPException(404, "patient not found")
    p = rows[0]
    if not p["phone_id"] or p["phone_id"] != body.phoneId.lower().removeprefix("0x"):
        raise HTTPException(403, "only the patient's phone can share their status")
    token = p["family_token"] or secrets.token_urlsafe(16)
    if not p["family_token"]:
        await stdb.call("set_family_token", body.patientId, token)
    return {"token": token}


@app.get("/family/{token}")
async def family_status(token: str):
    """What a family member sees: status only, no symptoms or vitals."""
    if not token or "'" in token:
        raise HTTPException(404, "not found")
    rows = await stdb.sql(f"SELECT * FROM patient WHERE family_token = '{token}'")
    if not rows:
        raise HTTPException(404, "link not found or expired")
    p = rows[0]
    bed = None
    if p["bed_id"] is not None:
        b = await stdb.sql(f"SELECT * FROM bed WHERE id = {p['bed_id']}")
        bed = {"label": b[0]["label"], "zone": b[0]["zone"]} if b else None
    acks = [a for a in await stdb.sql(f"SELECT * FROM alert WHERE patient_id = {p['id']}") if a["acked_by"]]
    responder = max(acks, key=lambda a: a["id"])["acked_by"] if acks else None
    redirected_to = None
    if p["status"] == "redirected":
        offers = [o for o in await stdb.sql(f"SELECT * FROM redirect_offer WHERE patient_id = {p['id']}")
                  if o["status"] == "accepted"]
        if offers:
            h = await stdb.sql(f"SELECT * FROM hospital WHERE id = {offers[-1]['hospital_id']}")
            redirected_to = h[0]["name"] if h else None
    return {
        "firstName": p["name"].split()[0],
        "hospital": HOSPITAL["name"],
        "status": p["status"],
        "etaMinutes": p["eta_minutes"],
        "bed": bed,
        "responder": responder,
        "redirectedTo": redirected_to,
        "checkedInAt": p["created_at"] // 1000,
        "updatedAt": p["updated_at"] // 1000,
    }


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
    await departments.seed()
    for d in DEMO_PATIENTS:
        lat, lng, secs = d.get("drive", (HOSPITAL["lat"], HOSPITAL["lng"], 0))
        eta = 0
        if secs:
            duration, _ = await routing.route(lat, lng, HOSPITAL["lat"], HOSPITAL["lng"])
            eta = max(1, round(duration / 60))
        await stdb.call(
            "check_in", d["name"], d["age"], d["complaint"], d["transcript"], d["summary"], d["acuity"],
            d.get("flags", ""), eta, lat, lng, d.get("source", "walk-in"), d.get("prep", ""), "",
            d.get("specialty", ""), "en",
        )
        if secs:
            p = await _patient_by_name(d["name"])
            _start_drive(p["id"], lat, lng, secs)
            await _match_and_advise(p)
    return {"ok": True}
