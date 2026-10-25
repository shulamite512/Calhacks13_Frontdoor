# FrontDoor: Devpost submission draft

> Copy each section into Devpost. Track-specific sections are at the end. Numbers below were measured in our own testing.

## Tagline
Walk-in ER patients check in by voice, in their own language, on the way. Nurses watch them in the waiting room and know before anyone gets worse or a department runs out of room.

## Inspiration
One of our teammates had a panic attack and was sure the chest pain was a heart attack. They went to the ER, got checked in, and then waited about 40 minutes to see a doctor, told only to wait until the doctor came. Nobody was watching them in that time. If it *had* been a heart attack, those minutes mattered.

Ambulance patients already get this attention. Tools like Twiage send their details to the ER before they arrive. But most patients drive themselves in, and nobody sees them until the front desk, or while they sit in the waiting room. FrontDoor is for those walk-ins.

## What it does
- **Voice check-in on the way.** The patient taps the mic and describes their symptoms in English, Spanish, Chinese, Vietnamese or Tagalog. Claude writes an English pre-triage note for the nurse (complaint, summary, ESI acuity, red flags, which department they likely need, what to prepare), and replies to the patient by voice in their own language.
- **Live incoming map.** Walk-ins and ambulances appear on a map with real drive-time ETAs. The board shows "Prepare before arrival: 12-lead ECG, cardiac monitor" and lets the nurse hold a bed.
- **Nobody forgotten in the waiting room.** Every 2 minutes, automatically, FrontDoor checks in by voice ("How are you feeling compared to when you arrived?") and watches vitals. If someone gets worse, or stops answering twice in a row, the tile turns red and a nurse taps **I'm on it**. The patient's phone shows "Nurse Kim is coming to you now".
- **Department readiness.** For each patient: does the department they need have a doctor on call, a bed and its key resource? For example, "✓ Cardiology: 1 on call · 2 CCU beds · cath lab ready", or a red warning when the OR is busy or no psychiatric safe room is free. 13 departments, editable by staff.
- **Beds before the rush.** The header forecasts "3 beds short in 30 min" from current patients and real ED volume. Hallway overflow beds are used only when needed, and stable walk-ins still on the way can be offered a nearby ER with a shorter wait.
- **Family link.** The patient can share a status page with family: arrived, nurse with them, in bed A4. No symptoms or vitals.

## How we built it
- **SpacetimeDB (Maincloud)** is the real-time backend: 12 tables, reducers for every state change, per-user views, and access rules enforced in the database.
- **Cartesia** handles voice. **Ink** (`ink-whisper`) does speech-to-text and **Sonic** (`sonic-3.6`) speaks replies, in 5 languages, using one voice.
- **Claude** (`claude-opus-5-5`, low effort, structured outputs) handles triage, department routing, prep items and waiting-room follow-ups. Deterministic red-flag rules run alongside it.
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
We ran our triage pipeline on 206 real ED triage records (MIMIC-IV-ED Demo) and compared it with the nurses' ESI: **98.5% within one level**, 58.3% exact. It leans less urgent on borderline ESI 2 vs 3 cases (71.1% of nurse ESI 1-2 cases also rated 1-2), working only from the nurse's 2-3 word complaint and vitals. That's why FrontDoor keeps watching vitals and voice, only ever escalates, and leaves every decision to nurses.

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

What we used: 12 tables, ~25 reducers with guards (`requireServer`, `requireStaff`, phone ownership), **private tables + per-user views** (`my_patients`, `my_vitals`, `my_alerts`, `my_offers`, `my_staff`), schema migrations with defaults, the TypeScript module + React SDK (`useTable`, `useReducer`), and the HTTP API from Python. Safety rules (never redirect ESI 1–2 or ambulance patients) are enforced in reducers, so no client can bypass them.

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
   - *Measured:* on 206 real ED triage records, 98.5% were within one ESI level of the nurse, but 33 of the nurses' 114 ESI 1-2 cases were rated 3. We report that openly and design around it.
   - *Silence or noise read as an answer:* answers under 2 letters never reach Claude or page a nurse.
   - *Refusal or outage:* a rule-based fallback still checks the patient in; server-side fallback is enabled.
   - *Unsafe automation:* Claude never assigns beds or redirects anyone. Humans do, and the database refuses to redirect ESI 1–2 or ambulance patients.
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
