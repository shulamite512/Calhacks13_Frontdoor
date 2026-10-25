# FrontDoor: Devpost submission draft

> Copy each section into Devpost. Track-specific sections are at the end. Numbers below were measured in our own testing.

## Tagline
FrontDoor turns your car into an ambulance (minus the siren): speak your symptoms, see the ERs around you with doctors and beds available right now, go to the one that can treat you, and the ER is ready before you arrive. Your family can see where you are.

## Inspiration
One of our teammates had a panic attack and was sure the chest pain was a heart attack. They drove to the nearest ER, got checked in, and then waited about 40 minutes to see a doctor, told only to wait until the doctor came. Nobody was watching them, and they had no idea whether that ER even had a cardiologist available. If it *had* been a heart attack, those minutes mattered.

Ambulance patients already get this: paramedics pick the right hospital and tools like Twiage send their details ahead. But most people drive themselves, pick an ER by distance or habit, and are invisible until the front desk.

## What it does
1. **The right ER, before you arrive.** The moment you open FrontDoor it finds your location and shows the ERs around you with real drive times and waits. You describe your symptoms by voice (English, Spanish, Chinese, Vietnamese or Tagalog). Claude works out what you need: urgency (ESI) and which department (Cardiology, Trauma, Burns, Surgery, ... 13 in all). FrontDoor checks every nearby ER: does it have **that department, a doctor on call, a free bed and the key equipment ready** (cath lab, OR, burn unit)? Then it ranks them by real drive time plus wait.
   - Stable patients: "A better match for you right now: Kaiser. Surgery ready, operating room ready. At CPMC: operating room busy. 7 min away." You choose, and get directions.
   - Urgent but drivable (e.g. a broken wrist): "Go now. Best ER for you: Kaiser, orthopedics ready, 10 min."
   - Critical patients: "**Call 911 now.** Best-equipped ER: Zuckerberg (Level I trauma center, trauma team ready)." For a mental-health crisis: 911 if in danger, or call/text 988. We never tell a critical patient to keep driving.
   - After speaking you see **your options**: the top ERs for your condition, each with doctors on call, beds free, equipment, drive time and wait, plus directions.
2. **The ER knows you're coming.** Your tile appears on the charge nurse's board with your summary, red flags and "Prepare before arrival: 12-lead ECG, cardiac monitor", on a live map with your ETA. The nurse can hold a bed.
3. **Nobody forgotten in the waiting room.** A wearable from triage streams vitals, and every 2 minutes FrontDoor asks by voice how you're doing, in your language. If you get worse, or stop answering, a nurse is alerted and taps **I'm on it**; your phone says "Nurse Kim is coming to you now."
4. **An AI agent that acts on what's urgent.** The Charge-Nurse Assistant watches the board. When a critical patient is on the way, or someone in the waiting room gets worse, it acts within seconds: holds the right bed, pages the department ("Stroke alert, ETA 11 min, have CT ready"), posts a checklist, flags priority. Bigger moves (assigning a bed, offering another ER) wait for a nurse's Approve. It can't lower urgency, discharge anyone or redirect a critical patient: those tools don't exist.
**Ambulances too:** the crew's tablet (`#/ems`) lets paramedics speak their report, see which ERs can take the patient (e.g. a STEMI skips the closest ER because its cath lab is busy), and pre-notify one. The patient appears on that ER's board with live monitor vitals, and the hospital's replies come back to the tablet and are read aloud: "Bed held for your patient." If the ER can't treat the patient (e.g. major trauma), once a nurse approves it, the tablet shows the hospital's suggested destination ("Zuckerberg: trauma team ready, 3 min"); the crew makes the final call.

**Family:** a shared link shows where the patient is and their ETA while they drive, then their status (nurse with them, bed A4). Never symptoms or vitals.

5. **Ready before the rush.** The board forecasts "3 beds short in 30 min" from real ED volume and shows each department's readiness. A family member can follow a status-only link.

## How we built it
- **SpacetimeDB (Maincloud)** is the real-time backend: 13 tables, reducers for every state change, per-user views, and access rules enforced in the database.
- **Cartesia** handles voice. **Ink** (`ink-whisper`) does speech-to-text and **Sonic** (`sonic-3.6`) speaks replies, in 5 languages, using one voice.
- **Claude** (`claude-opus-5-5`, low effort, structured outputs) handles triage, department routing, prep items and waiting-room follow-ups. Deterministic red-flag rules run alongside it.
- **Claude as an agent** (tool use, validated in code, three autonomy levels) runs the Charge-Nurse Assistant.
- **Python FastAPI** runs the voice and AI server, a vitals simulator, the bed forecast and OSRM routing.
- **React + Leaflet/OpenStreetMap** for the patient phone page, the nurse board and the family page.
- **Real data:** California HCAI ED volumes (CPMC Van Ness: 34,742 visits in 2025) feed the forecast. ER-entrance locations came from an Apify Google Maps scrape.

## Challenges
- Google hides "popular times" for hospitals: 0 of 60+ ER listings we scraped had them. We used real state ED volumes instead and say plainly that the hourly shape is assumed.
- Getting access rules right in the database, not just in the UI: patient tables are private, nurses get a staff role by PIN, phones see only themselves.
- Making AI safe to rely on: rules can only raise urgency, never lower it; critical patients are never redirected; a blank answer never pages a nurse.

## Accomplishments
- A full, working flow from voice to nurse to bed, live across devices.
- Claude routed 12 of 12 test patients to the right department.
- Voice works round-trip in 5 languages.

## What's real vs simulated
| Real | Simulated |
|---|---|
| Voice (Cartesia), AI triage (Claude), live database (SpacetimeDB), drive times (OSRM), hospital locations, access rules; CPMC's daily ED volume (HCAI); **hourly arrival pattern and vital-sign trajectories replayed from 222 real de-identified ED stays (MIMIC-IV-ED Demo)**; **licensed bed totals** for ICU (36), perinatal (53) and pediatrics (25) from CDPH | How many beds are free *right now*, doctors on call, resource status, other hospitals' waits, the ambulance feed. These exist only inside hospital systems (HIPAA); in production they'd come from HL7/FHIR feeds |

## How well does the AI triage?
We ran our triage pipeline on 206 real ED triage records (MIMIC-IV-ED Demo) and compared it with the nurses' ESI. The first version leaned less urgent on borderline cases. We then rewrote the prompt to walk the published ESI v4 algorithm, tuning on one half of the cases and measuring **once** on the held-out half: it caught **96% of the nurses' ESI 1-2 patients (48 of 50), up from 84%**, stayed 98% within one level, and became more cautious (35% rated more urgent than the nurse, the safer error for a heads-up a nurse confirms). FrontDoor still only escalates, keeps watching vitals and voice, and leaves every decision to nurses.

## What we learned
- "Nearest ER" is often the wrong answer: what matters is whether that ER has the right department, doctor, bed and equipment right now.
- Safety rules belong in the database, not the UI: if a reducer refuses to redirect a critical patient, no screen can get it wrong.
- Measure the AI before trusting it: our first triage prompt looked fine in demos but under-triaged real borderline cases until we tested it against nurses.
- Real hospital data is hard to get (Google hides hospital popular times; live bed counts sit behind HIPAA), so we used public state data and are honest about what's simulated.

## What's next
Pilot with one ED's charge nurses; real vitals from wearables; hospital SSO instead of a PIN; bed and on-call data from the hospital's systems; hand-off of the check-in when a patient goes to another ER.

## Built with
spacetimedb, cartesia, claude, anthropic, python, fastapi, react, typescript, vite, leaflet, openstreetmap, osrm, apify

---

## Track: SpacetimeDB
SpacetimeDB is FrontDoor's whole live backend, not an add-on. It's the shared ops dashboard and persistent world state that three kinds of actors coordinate through:
- **Python server** (signs in as the database owner): checks patients in, streams vitals every 3 s, raises alerts, writes the forecast, moves ambulances along routes.
- **Nurses** (staff role): acknowledge alerts, hold/assign/free beds, update department readiness. Every change appears on every board instantly.
- **Patients' phones:** see their own status update live ("Nurse Kim is coming", "Your bed is ready") and accept or decline a redirect offer.

What we used: 13 tables, ~25 reducers with guards (`requireServer`, `requireStaff`, phone ownership), **private tables + per-user views** (`my_patients`, `my_vitals`, `my_alerts`, `my_offers`, `my_staff`), schema migrations with defaults, the TypeScript module + React SDK (`useTable`, `useReducer`), and the HTTP API from Python. Safety rules (never redirect ESI 1–2 or ambulance patients) are enforced in reducers, so no client can bypass them.

## Track: Cartesia
Voice is the product: the patient's first contact is speaking their symptoms, and the waiting-room check-ins are spoken.
- **Ink (`ink-whisper`)**: transcribes check-ins and follow-up answers in en/es/zh/vi/tl (measured ~1.4 s).
- **Sonic (`sonic-3.6`)**: speaks the reply, the follow-up question and "a nurse is coming" in the patient's language, with one consistent voice (measured ~1.6–2.1 s).
- **Accessibility:** patients who don't speak English, or can't type while scared or driving, can still check in. The nurse always sees English.
- **Automatic check-ins:** every 2 min in the waiting room, spoken and transcribed in the patient's language; Whisper-style phrases invented on silence ("Thank you.") are filtered out, and two missed check-ins in a row alert a nurse.
- **Responsibility:** silence or a mis-hear is never treated as worsening ("Sorry, I didn't catch that"); the app always tells people to call 911 for emergencies.
- **Limitations:** batch (not streaming) STT/TTS adds ~3 s per turn; deterministic red-flag keywords are English-only (Claude covers other languages); the live status cards on the phone are still English.

## Track: Anthropic
1. **Named community:** walk-in patients at San Francisco emergency departments, starting with CPMC Van Ness (34,742 ED visits in 2025), especially people who sit in the waiting room for a long time with nobody watching, and patients who don't speak English.
2. **A real problem:** our teammate's 40-minute wait with chest pain, described above.
3. **It works:** voice check-in → board → alert → "I'm on it" → bed, live, in 5 languages.
4. **Thoughtful use of Claude:** Claude writes the nurse's pre-triage note, picks the department, lists what to prepare, and judges whether a waiting patient is getting worse, in the patient's language with English output for staff. **Where it could go wrong, and what we did:**
   - *Under-triage:* deterministic red-flag rules run alongside Claude and can only raise urgency, never lower it; vitals trigger alerts on their own.
   - *Measured:* on 206 real ED triage records, the first version under-triaged borderline cases. Walking the ESI v4 algorithm in the prompt (tuned on half the cases, tested once on the other half) raised high-risk sensitivity from 84% to 96% (48 of 50) at the cost of more over-triage, which we report openly.
   - *Silence or noise read as an answer:* answers under 2 letters never reach Claude or page a nurse.
   - *Refusal or outage:* a rule-based fallback still checks the patient in; server-side fallback is enabled.
   - *Unsafe automation:* the Assistant agent can only do reversible things on its own (hold a bed, page, checklist); assigning a bed or offering another ER needs a nurse's Approve, and there is no tool to lower urgency, discharge or redirect a critical patient. Every tool call is validated in code and logged with the agent's reason.
   - *Diagnosis:* the patient is never told a diagnosis, only that they're checked in and when to call 911.

## Track: Microsoft "Built for the Real World"
- **Customer understanding:** the charge nurse (who owns the board) and the walk-in patient (who's scared and unmonitored). Built around a real 40-minute chest-pain wait.
- **Measurable usefulness:** time from worsening to a nurse responding (alert → "I'm on it" is logged with the nurse's name and time); beds-short warning 30 minutes ahead; department gaps visible before arrival.
- **Path to production:** swap the PIN for hospital SSO; vitals from wearables; beds and on-call status from the hospital's bed management and scheduling systems; a hand-off when a patient is redirected.
- **Responsible design:** private patient data with per-user views; status-only family link; AI can only raise urgency; humans make every bed and redirect decision; EMTALA respected (we only *suggest* another ER to stable walk-ins before arrival).
- **End-to-end:** working live demo from voice to bed, across phone, board and family pages.

## Track: Meta, Bringing People Closer Together with AI
FrontDoor connects people at the moment they feel most alone:
- **Patient ↔ nurse before arrival:** the nurse knows who's coming and what they need before they walk in.
- **Nobody forgotten in the waiting room:** spoken check-ins, and "Nurse Kim is coming to you now" on the patient's phone.
- **Across language barriers:** patients speak Spanish, Chinese, Vietnamese or Tagalog and are answered in their language; nurses read English.
- **Patient ↔ family:** a live status link so loved ones aren't left guessing.

AI is essential here: Claude turns frightened, unstructured speech into a nurse-ready note and translates both ways, and Cartesia makes it a conversation rather than a form.
