# FrontDoor: Team Guide

Everything we built, how the parts fit together, how to run and demo it, and what to say to judges.
Written for the three of us: backend/voice, AI/simulation, frontend.

---

## 1. What FrontDoor is

**Pitch (say this word for word):**
> "Tools like Twiage warn ERs about ambulance patients. But most patients drive in, and nobody watches them until the desk, or while they wait for hours. FrontDoor lets walk-ins check in by voice on the way, checks on them in the waiting room using voice and vitals, alerts nurses when someone gets worse, and shows the charge nurse whether there will be enough beds before the rush."

**The problem**
- Most ER patients are walk-ins, not ambulance arrivals.
- Walk-ins are invisible until the front desk, and then often unwatched in the waiting room for hours.
- People deteriorate in waiting rooms, for example chest pain that turns into a heart attack.
- Charge nurses find out they're out of beds when the rush is already there.

**How we differ from Twiage**

| | Twiage | FrontDoor |
|---|---|---|
| Who | Ambulance (EMS) patients | Walk-ins (most patients), plus EMS on the same board |
| Input | Paramedic app | Patient's own voice on their phone |
| After arrival | Handoff ends | Keeps watching in the waiting room (voice check-ins + vitals) |
| Capacity | No | Bed forecast ("N beds short in 30 min"), hold bed, overflow/diversion |

Pitch line: **"Twiage covers ambulances. FrontDoor covers everyone else, on the same board."**

### 2-minute demo script
ER: **CPMC Van Ness Campus, San Francisco**. Demo walk-ins drive in from the **Palace of Fine Arts**.

1. Board (`/#/board`): click **Reset demo**. This seeds 3 waiting patients, 1 incoming walk-in and 1 ambulance (EMS) moving on the map.
2. Phone (`/#/checkin`): enter name/age, tap the mic, say *"I've had crushing chest pain for 20 minutes and I'm sweating."*, then tap **Check in**.
   The tile appears under **Incoming** with ESI 2, red flags and a **Prepare before arrival** card (ECG, monitor). The phone speaks a reply.
3. Phone: tap **Simulate drive**. The dot moves along the real route and the ETA counts down. Board: tap **Hold bed**.
   On arrival (~1 min) the tile moves to the waiting room automatically.
4. Board: tap **Worsen** on the tile so the heart rate climbs. Phone: tap **Check on me now** and answer *"It's getting worse, it's spreading to my arm."*
   The tile turns red and a critical banner appears. The nurse taps **I'm on it**, and the phone shows **"Charge RN is coming to you now"**.
5. The header shows **"N beds short in 30 min"**. Tap **Assign bed** (it uses the held bed). The phone shows **"Your bed is ready: Bed A4"**.

---

## 2. Timeline: what we did, in order

| # | Step | Details |
|---|---|---|
| 1 | Checked the laptop | Empty folder. Node 24 and git present; Python and the SpacetimeDB CLI missing. |
| 2 | Python | You installed **Python 3.13.14** (Microsoft Store build). Verified `python` and `pip`. |
| 3 | SpacetimeDB CLI | The official `iwr https://windows.spacetimedb.com -useb \| iex` failed: PowerShell 5.1's downloader couldn't fetch from GitHub, then the mirror path crashed (`[System.Byte] does not contain a method named 'Trim'`). **Workaround:** downloaded the same official installer with `curl` from GitHub releases and ran it. Installed **2.13.0**. |
| 4 | Login | Signing in on the website isn't the same as the CLI login. Ran `spacetime login` (browser flow); the CLI is now logged in to your account. |
| 5 | API keys | Created `.env` (git-ignored) with `CARTESIA_API_KEY` and `ANTHROPIC_API_KEY`. Verified both with live calls. |
| 6 | Database | Generated a TypeScript module template to learn the exact 2.13 API. Wrote 6 tables + reducers, **published to Maincloud as `frontdoor-w3zl2`**, and smoke-tested over HTTP. |
| 7 | Python server | FastAPI with Cartesia STT/TTS, Claude triage, red-flag rules, vitals simulator, forecast. Tested voice → transcript → ESI 2 → patient row. |
| 8 | Bugs fixed (backend) | **Risk downgrade:** a later *warning* alert set risk back from critical to "watch", so risk now only escalates. **Duplicate flags:** "Diaphoresis"/"diaphoresis", so rules now dedupe case-insensitively. **Forecast:** it counted ESI 4–5 walk-ins as needing beds, so now only ESI 1–3 count. |
| 9 | React app | Vite + React 19 + SpacetimeDB React SDK. Generated client bindings. Built the phone page and nurse board. Verified with headless Edge screenshots (Puppeteer). |
| 10 | "82m ago" (not a bug) | An alert showed "82m ago". The wall clock confirmed ~83 minutes really had passed between steps. |
| 11 | One alert per patient | The board showed two banners for one patient, so it now shows only the most severe and "I'm on it" acks all of them. |
| 12 | Your first real test | Real mic + Cartesia + Claude worked. Found: **a blank answer ("-") paged a nurse.** Fixed with a server guard (fewer than 3 letters → "Sorry, I didn't catch that", no alert). Added **live status on the phone** (nurse coming / bed ready). |
| 13 | uvicorn `--reload` hang | On Windows the old process never shut down after a file change, so it kept serving stale code. Tried awaiting the cancelled task + `--timeout-graceful-shutdown`; still hung. **Decision:** run without `--reload`, restart manually. |
| 14 | Hospital | Picked **CPMC Van Ness Campus ED** (1101 Van Ness Ave), the closest full ED to the Palace of Fine Arts, ~2.5 km. Geocoded with OpenStreetMap Nominatim. |
| 15 | Twiage-style incoming | Live GPS/ETA (OSRM routing), simulated drive, auto-arrive within 150 m, Leaflet map, EMS ambulance patient, Claude "prep" items, **Hold bed**. |
| 16 | Encoding glitch | A Python edit script used Windows' default cp1252 encoding and wrote `·` as an invalid byte, so the board showed `�`. Fixed the bytes; scripts now must use UTF-8. |
| 17 | Git | `git init`, 2 local commits. **`.env` is not tracked** (checked). |
| 18 | GitHub | Installing the GitHub CLI needed Windows admin (school laptop) and was cancelled. **Plan:** create the empty repo `frontdoor` on github.com and push with Git Credential Manager (normal GitHub browser login, no admin). |
| 19 | Overflow + diversion | Hallway beds H1–H3, nearby-ER network (simulated capacity), **Suggest another ER** with database-enforced safety rules, patient accept/decline on the phone (section 7). |
| 20 | "Empty board" scare | Some fresh browsers showed an empty board. Tracing the WebSocket showed Maincloud's first reply to a brand-new identity can take 5–15 s; it wasn't a crash. Removed React StrictMode (dev double-mount opened an extra connection) and added a "Connecting to live data…" notice. An auto-reload watchdog was tried and removed because reloading restarts the slow handshake. |
| 21 | Next | Auth/permissions (section 9). |

---

## 3. Architecture

```
                    HTTP (fetch)                         HTTPS
 ┌──────────────┐  /transcribe /speak    ┌─────────────┐ ───────▶ Cartesia  (STT ink-whisper, TTS sonic-3.6)
 │ Phone page   │  /checkin /followup    │  FastAPI    │ ───────▶ Claude    (triage + follow-up, structured JSON)
 │ (React)      │ ─────────────────────▶ │  server/    │ ───────▶ OSRM      (drive time + route geometry)
 │ /#/checkin   │  /location /demo/*     │             │
 └──────┬───────┘                        │ simulator   │  HTTP reducer calls + SQL
        │                                │ (3 s tick)  │ ───────────────────────────┐
        │ WebSocket subscription         └─────────────┘                            ▼
        │ (live status)                                               ┌───────────────────────────┐
        └────────────────────────────────────────────────────────────▶│ SpacetimeDB (Maincloud)   │
                                                                      │ frontdoor-w3zl2           │
 ┌──────────────┐  WebSocket subscription (useTable)                  │ tables + reducers in      │
 │ Nurse board  │ ◀──────────────────────────────────────────────────▶│ spacetimedb/src/index.ts  │
 │ (React)      │  direct reducer calls: ackAlert, assignBed,         └───────────────────────────┘
 │ /#/board     │  freeBed, holdBed
 └──────────────┘
```

### How the parts integrate

**Browser → FastAPI (HTTP).** The phone page never calls Cartesia or Claude directly, because the API keys must stay on the server. [web/src/api.ts](../web/src/api.ts) wraps every call:

```ts
async speak(text: string): Promise<void> {
  const r = await fetch(`${API_URL}/speak`, { method: 'POST', ... body: JSON.stringify({ text }) });
  const url = URL.createObjectURL(await r.blob());
  const audio = new Audio(url);
  ...
}
```

**FastAPI → SpacetimeDB (HTTP).** [server/stdb.py](../server/stdb.py) gets an anonymous identity token once (`POST /v1/identity`), then calls reducers and runs SQL over HTTP:

```python
async def call(reducer: str, *args) -> None:
    r = await _client.post(f"/v1/database/{DB}/call/{reducer}", json=list(args), headers=await _auth())
    if r.status_code >= 400:
        raise ReducerError(f"{reducer} failed: {r.text}")

async def sql(query: str) -> list[dict]:
    ...  # decodes options ([0, v] = some, [1, []] = none) and timestamps ([micros])
```

Reducer names are snake_case over HTTP (`check_in`, `raise_alert`), even though they're camelCase in TypeScript. Arguments are a JSON array in declaration order. A `ReducerError` becomes HTTP 400 through an exception handler in [server/app.py](../server/app.py).

**Board/phone ↔ SpacetimeDB (WebSocket).** The React app subscribes to tables and re-renders on every change; nothing polls. Bindings are generated from the module:

```
spacetime generate --lang typescript --out-dir web/src/module_bindings --module-path spacetimedb
```

```tsx
// web/src/main.tsx
const connectionBuilder = DbConnection.builder()
  .withUri(STDB_URI).withDatabaseName(STDB_DB).withToken(readToken())
  .onConnect((_conn, _identity, token) => { localStorage.setItem(TOKEN_KEY, token); });
...
<SpacetimeDBProvider connectionBuilder={connectionBuilder}>

// web/src/Board.tsx
const [patients] = useTable(tables.patient);
const ackAlert = useReducer(reducers.ackAlert);
```

**Why some writes go through the server and some don't:**

| Write | Who calls it | Why |
|---|---|---|
| `checkIn`, `addFollowUp`, `raiseAlert` | Server | Needs Claude/Cartesia results and the API keys |
| `addVitals`, `setForecast` | Server (simulator) | Background loop, not a user action |
| `updateLocation`, `markArrived` | Server | Needs OSRM ETA / geofence check |
| `resetDemo` | Server (`/demo/reset`) | Also seeds patients and starts drives |
| `ackAlert`, `assignBed`, `freeBed`, `holdBed` | **Board directly** | Plain nurse actions with no AI or keys involved; the result shows up instantly for everyone |

---

## 4. Data model ([spacetimedb/src/index.ts](../spacetimedb/src/index.ts))

Patient tables (`patient`, `vitals`, `alert`, `follow_up`, `redirect_offer`) are **private**; clients read them through the `my_*` views. `bed`, `forecast` and `hospital` are public (no patient details). See section 12.

### Tables

**patient**

| Field | Type | Meaning |
|---|---|---|
| id | u64 PK autoInc | |
| name, age | string, u32 | |
| complaint | string | 2–5 word chief complaint ("Chest pain") |
| transcript | string | What the patient said |
| summary | string | One-line note for the nurse (Claude) |
| acuity | u8 | ESI 1 (most urgent) … 5 |
| redFlags | string | Comma separated |
| status | string | `incoming` → `waiting` → `roomed` → `discharged`, or `incoming` → `redirected` (accepted another ER) |
| risk | string | `normal` / `watch` / `critical` (only escalates) |
| etaMinutes | u32 | Minutes away while incoming |
| lat, lng | f64 | Live position while incoming |
| bedId | option u32 | Assigned bed |
| createdAt, updatedAt | timestamp | |
| source | string, default `walk-in` | `walk-in` or `ems` (added later with a default so old rows migrated) |
| prep | string, default `''` | Comma-separated things to have ready on arrival |

**vitals**: id, patientId (indexed), hr, spo2, sbp, dbp, rr, tempC, recordedAt. Kept to the latest **40 per patient**.

**alert**: id, patientId (indexed), level (`warning`/`critical`), reason, createdAt, ackedBy (option), ackedAt (option).

**follow_up**: waiting-room voice check-ins. id, patientId, question, answer, flagged, createdAt.

**bed**: id (u32 PK), label, zone (`Acute`/`Fast track`/`Resus`/`Hallway`), status (`free`/`reserved`/`occupied`/`cleaning`), patientId (option).
Seeded beds: A1–A4 Acute, B1–B3 Fast track, R1 Resus, plus overflow stretchers H1–H3 (Hallway); A1, A2, A3, B1, B2 and R1 start occupied so the demo opens near capacity.

**hospital**: nearby EDs for diversion. id (u32 PK), name, lat, lng, bedsFree, waitMinutes, updatedAt. Written by the Python server; capacity is **simulated**.

**redirect_offer**: id (u64 PK autoInc), patientId (indexed), hospitalId, driveMinutes, waitMinutes, status (`pending`/`accepted`/`declined`), createdAt.

**forecast**: single row id 0. horizonMinutes, expectedArrivals, bedsFree, bedsNeeded, bedsShort (i32, >0 = short), basis (explanation text), updatedAt.

### Reducers

| Reducer | Args | Behavior |
|---|---|---|
| `init` | – | Seeds beds on first publish |
| `checkIn` | name, age, complaint, transcript, summary, acuity, redFlags, etaMinutes, lat, lng, source, prep | Inserts a patient. `etaMinutes > 0` → `incoming`, else `waiting`. ESI ≤ 2 starts at risk `watch` |
| `updateLocation` | patientId, lat, lng, etaMinutes | Updates position/ETA; ignored unless status is `incoming` |
| `markArrived` | patientId | `incoming` → `waiting`, ETA 0 |
| `addVitals` | patientId, hr, spo2, sbp, dbp, rr, tempC | Inserts a reading, deletes the oldest beyond 40 |
| `addFollowUp` | patientId, question, answer, flagged | Logs a voice check-in |
| `raiseAlert` | patientId, level, reason | **Dedupe:** skips if an open alert of the same level exists. Raises risk (**only escalates**) |
| `ackAlert` | alertId, nurse | Sets ackedBy/ackedAt ("I'm on it") |
| `holdBed` | bedId, patientId | Free bed → `reserved` for that patient; releases any other hold they had |
| `assignBed` | bedId, patientId | Bed must be free **or held for this patient**. Releases other holds, sends their previous bed to `cleaning`, bed → `occupied`, patient → `roomed` |
| `freeBed` | bedId | State machine: `reserved` → `free` (hold released); `occupied` → `cleaning` (patient discharged); `cleaning` → `free` |
| `setForecast` | horizonMinutes, expectedArrivals, bedsFree, bedsNeeded, bedsShort, basis | Upserts row 0 |
| `setHospital` | id, name, lat, lng, bedsFree, waitMinutes | Upserts a nearby ED (simulated capacity) |
| `offerRedirect` | patientId, hospitalId, driveMinutes, waitMinutes | **Refuses** unless the patient is `incoming`, a `walk-in`, ESI 3–5 and not critical. Supersedes any pending offer |
| `respondRedirect` | offerId, accept | Called from the patient's phone. Accept → patient `redirected`, any held bed released. Decline → offer `declined` |
| `resetDemo` | – | Deletes patients, vitals, alerts, follow-ups, beds, forecast, offers; re-seeds beds |

Snippet showing escalation and dedupe:

```ts
const RISK_ORDER: Record<string, number> = { normal: 0, watch: 1, critical: 2 };
// Risk only escalates, so a later warning never hides an earlier critical.
function raiseRisk(ctx: Ctx, id: bigint, risk: string) { ... }

export const raiseAlert = spacetimedb.reducer(..., (ctx, { patientId, level, reason }) => {
  const open = [...ctx.db.alert.patientId.filter(patientId)].find(
    a => a.ackedAt === undefined && a.level === level
  );
  if (open) return;
  ...
});
```

---

## 5. Python server ([server/](../server/))

Run: `cd server` then `.venv\Scripts\python -m uvicorn app:app --port 8000`. Reads `../.env`.

### Endpoints ([server/app.py](../server/app.py))

| Method | Path | Body | Returns / does |
|---|---|---|---|
| GET | `/health` | – | `{ok, db, hospital}` |
| POST | `/transcribe` | multipart `file` (webm/mp4/mp3/wav) | `{text}` via Cartesia STT |
| POST | `/speak` | `{text}` | `audio/mpeg` via Cartesia TTS |
| POST | `/checkin` | `{name, age, transcript, etaMinutes, lat?, lng?}` | Claude triage → `check_in` reducer → `{patientId, complaint, summary, acuity, red_flags, prep, spoken_reply}` |
| GET | `/followup/question/{id}` | – | `{question}` ("Hi Chelsi, … how are you feeling right now…") |
| POST | `/followup` | `{patientId, question, answer}` | Blank/garbled answer (< 3 letters) → `heard:false`, no alert. Else Claude + rules → `add_follow_up`, `raise_alert` if needed → `{level, reason, spoken_reply, heard}` |
| POST | `/location` | `{patientId, lat, lng}` | Within 150 m of the ER → `mark_arrived`. Else OSRM ETA → `update_location` → `{arrived, etaMinutes}` |
| POST | `/redirect/suggest` | `{patientId}` | Picks the nearby ED with free beds and the lowest OSRM drive + wait, calls `offer_redirect` → `{hospitalId, name, driveMinutes, waitMinutes, total}`. 400 with the reason if the patient isn't eligible |
| POST | `/demo/drive` | `{patientId}` | Simulated drive from the Palace of Fine Arts, compressed to ~60 s |
| POST | `/demo/worsen` | `{patientId}` | Turns on "gets worse" vitals drift |
| POST | `/demo/arrive` | `{patientId}` | `mark_arrived` |
| POST | `/demo/reset` | – | Stops drives, `reset_demo`, seeds 5 demo patients (2 incoming with drives, incl. EMS) |

### Modules

**[voice.py](../server/voice.py)** (Cartesia, API version `2026-08-14`, `Authorization: Bearer`)
- STT: `POST /stt`, model `ink-whisper`, language `en`.
- TTS: `POST /tts/bytes`, model `sonic-3.6`, MP3 44.1 kHz/128 kbps, default voice `db6b0ed5-…`. Override with `CARTESIA_VOICE_ID`.

**[triage.py](../server/triage.py)** (Claude)
- Model `claude-opus-5-5`, `output_config={"effort": "low"}` for speed.
- Structured output: `client.beta.messages.parse(..., output_format=Triage)` with Pydantic models, so we get validated JSON instead of parsing free text.
- Server-side refusal fallback: `betas=["server-side-fallback-2026-07-01"], fallbacks="default"`.
- `Triage`: complaint, summary, acuity, red_flags, prep, spoken_reply. `FollowUp`: level (`none`/`warning`/`critical`), reason, spoken_reply.
- If Claude errors or refuses, a **rule-based fallback** is used, so check-in never fails because of the LLM.
- Rules can only **add** flags or **raise** urgency (critical rule → ESI ≤ 2), never lower it:

```python
rule_flags = red_flags.check_text(transcript)
for flag, level in rule_flags:
    if flag.lower() not in {f.lower() for f in result.red_flags}:
        result.red_flags.append(flag)
    if level == "critical":
        result.acuity = min(result.acuity, 2)
```

**[red_flags.py](../server/red_flags.py)**
- Keyword rules: "spreading to my arm", "jaw", "can't breathe", "slurred", "worst headache", "coughing up blood", etc. → critical. "Chest pain", "short of breath", "dizzy", "it's worse", etc. → warning.
- Vitals thresholds:

| Vital | Warning | Critical |
|---|---|---|
| HR | ≥ 110 | ≥ 130 or ≤ 40 |
| SpO₂ | ≤ 93 | ≤ 90 |
| Systolic BP | ≥ 180 | ≤ 90 |
| RR | ≥ 22 | ≥ 28 |

**[simulator.py](../server/simulator.py)** (simulated wearable)
- Every **3 s**: reads patients and beds via SQL, writes one vitals row per active patient.
- Baseline is seeded per patient id (ESI ≤ 2 gets +10 HR).
- "Worsen" mode drifts each tick: HR +4–7 (max 148), SpO₂ −0.6 (min 86), SBP −2–4 (min 86), RR +0.8 (max 30).
- Tracks the highest level already alerted per patient, so it only raises an alert on **escalation**. `note_alert()` keeps a voice-raised critical from being followed by a vitals "warning".
- Recomputes the forecast and writes it only when it changed.

**[forecast.py](../server/forecast.py)**

```
expected   = arrivals_per_hour[hour] × 30/60 × bed_rate(0.6)
needed     = waiting(ESI 1–3) + incoming(ESI 1–3, ETA ≤ 30) + expected
             (patients with a held bed are excluded, since their bed is already counted)
available  = free + cleaning
bedsShort  = needed − available
```

- The arrival curve lives in [server/data/arrival_curve.json](../server/data/arrival_curve.json). **It's a placeholder** until we have the Apify popular-times data.
- `FORECAST_HOUR=18` pins the hour for demos.

**[routing.py](../server/routing.py)**
- OSRM public server: `router.project-osrm.org/route/v1/driving/...`, no API key. Returns drive seconds + route geometry.
- Falls back to straight-line distance at ~30 km/h if OSRM fails.

**Drive simulation** (`_drive` in app.py)
- Fetches the real route, then steps along it every 2 s, calling `update_location` with the remaining ETA (`duration × (1 − fraction)`).
- Calls `mark_arrived` at the end.
- Seeded drives: Robert King (walk-in, 420 s) and EMS Medic 12 (suspected stroke, 300 s, starting in the Inner Sunset).

**Measured latency:** TTS ≈ 1.9 s, STT ≈ 1.4 s, triage ≈ 3–5 s, full voice check-in ≈ 5–7 s.

---

## 6. Frontend ([web/](../web/))

Vite + React 19 + TypeScript. Routing is by hash: `#/board` shows the nurse board; anything else shows the phone page.

**[config.ts](../web/src/config.ts)**: `VITE_API_URL` (default `http://localhost:8000`), `VITE_STDB_URI` (`wss://maincloud.spacetimedb.com`), `VITE_STDB_DB` (`frontdoor-w3zl2`), and `HOSPITAL` (CPMC Van Ness lat/lng).

**[CheckIn.tsx](../web/src/CheckIn.tsx)** (patient phone)
1. Form: name, age, minutes away. The mic button uses [useRecorder.ts](../web/src/useRecorder.ts) (MediaRecorder, tap to start/stop), then `/transcribe` fills the editable "What we heard" box. Typing works too.
2. **Check in** → `/checkin` → the session is saved in localStorage (survives a refresh) → the reply is spoken via `/speak`.
3. **LiveStatus** subscribes to the patient, alert and bed tables and shows:
   - "The ER is expecting you in about N min"
   - "The team knows you're here"
   - "**Charge RN is coming to you now**" (after an ack)
   - "**Your bed is ready: Bed A4**"
4. **I've arrived**, **Share my location** (`watchPosition` → `/location` every 10 s, auto-stops on arrival), **Simulate drive** (demo).
5. **Check on me now**: speaks the question → records → transcribes → `/followup` → speaks the reply. Unheard answers aren't logged.
6. **Start a new check-in** clears the session.

**[Board.tsx](../web/src/Board.tsx)** (charge nurse)
- **Header:**
  - The forecast pill ("5 beds short in 30 min", with the basis text).
  - A live connection dot.
  - A "You are" nurse-name field, used for acks.
- **Alerts:**
  - Each patient gets one banner, showing their most severe, newest open alert.
  - **I'm on it** acknowledges all of that patient's open alerts.
  - The last 3 acknowledged alerts stay visible, greyed out.
- **Columns:**
  - **Incoming** shows the map plus tiles, sorted by ETA.
  - **Waiting room** shows tiles sorted by risk, then ESI.
  - **Beds** is the bed grid.
- **Tile:**
  - ESI badge, EMS or Walk-in badge, complaint, summary, red-flag chips.
  - For incoming patients, a **Prepare before arrival** card.
  - Latest vitals, with abnormal values in red, plus an HR sparkline.
  - Buttons: **Hold bed** / **Release A4** (incoming) or **Assign bed** (waiting), and **Worsen** (demo).
- **Bed picking** (`pickBed`):
  - critical or ESI 1 → Resus, then Acute, then Fast track
  - ESI 4–5 → Fast track first
  - everyone else → Acute first
  - **Assign bed** uses the patient's held bed if they have one.
- **Bed grid:**
  - Tap an occupied bed → it goes to cleaning (patient discharged).
  - Tap a cleaning bed → free.
  - Tap a reserved bed → the hold is released.

**[IncomingMap.tsx](../web/src/IncomingMap.tsx)**
- Uses Leaflet imperatively (no react-leaflet) with OpenStreetMap tiles.
- Red **ER** marker; walk-ins are circles and EMS are squares, colored by risk/ESI.
- Each marker has a permanent label: name · ETA.
- Markers update in place as positions change. The map re-frames only when patients join or leave.

---

## 7. Overflow and diversion

**Problem:** when 0 beds are free, where do patients go? Two answers, both built and tested.

### 7.1 Hallway beds (patients already inside)
- Three overflow stretchers **H1–H3** (zone `Hallway`) are seeded with the other beds.
- **Assign bed** uses them **only when no regular bed is free** (`pickBed(p, beds, allowHallway=true)` in [web/src/Board.tsx](../web/src/Board.tsx)). **Hold bed** never uses a hallway spot.
- The forecast does **not** count hallway spots as capacity, and says when they're in use:
  `... vs 0 free + 0 cleaning beds, 1 in hallway beds` ([server/forecast.py](../server/forecast.py)).

### 7.2 Suggest another ER (patients still on the way)
How it flows:
1. The Python server seeds 4 nearby SF EDs into the `hospital` table on **Reset demo** ([server/network.py](../server/network.py)) and nudges their simulated beds/waits every ~30 s (simulator tick).
2. On an eligible incoming tile, the nurse taps **Suggest another ER** (amber when the forecast is short).
3. `POST /redirect/suggest` computes, for each hospital with free beds, OSRM drive minutes from the patient's live position + that hospital's wait, and picks the lowest total.
4. It calls the `offer_redirect` reducer, which **re-checks eligibility in the database**.
5. The patient's phone (subscribed to `redirect_offer`) shows: *"Our ER is very busy right now. Kaiser Permanente SF (Geary) can likely see you sooner. About 7 min away with a ~15 min wait. It's your choice."* with **Go to Kaiser** / **Keep my spot**.
6. The phone calls `respond_redirect` directly. Accept → status `redirected`, held bed released, tile leaves Incoming and appears under **Redirected** in the right column; the phone shows **Head to Kaiser…** with a Google Maps directions link. Decline → tile shows "Patient kept their spot here."

```ts
// spacetimedb/src/index.ts: the safety rules live in the database, not just the UI
if (p.status !== 'incoming') throw new SenderError('only patients still on the way can be redirected');
if (p.source !== 'walk-in') throw new SenderError('ambulance patients are never redirected by FrontDoor');
if (p.acuity <= 2 || p.risk === 'critical') throw new SenderError('ESI 1-2 / critical patients are never redirected');
```

Tested: the EMS patient and a waiting-room patient were both refused with those messages; Robert King (ESI 3 walk-in, on the way) got Kaiser Geary (7 min drive + 15 min wait); accepting set him to `redirected`.

| Nearby ED (simulated) | Base beds | Base wait |
|---|---|---|
| Kaiser Permanente SF (Geary) | 4 | 15 min |
| UCSF Parnassus ED | 2 | 35 min |
| Zuckerberg SF General | 3 | 45 min |
| Saint Mary's Medical Center | 3 | 20 min |

The board shows them in a **Nearby ERs (simulated capacity)** panel and as grey "ER" markers on the map.

**Safety rules**
- **Never** offered to ESI 1–2, critical-risk, or EMS patients. Ambulance diversion is a hospital-level decision, not something our app does.
- **EMTALA:** a US federal law that requires any ER to screen and stabilize anyone who comes to it. So we only *suggest* an alternative **before arrival**, the patient decides, and nobody at the door is turned away.

**Data honesty:** other hospitals' capacity is **simulated**; there's no public real-time bed feed. Apify Google Maps "popular times" for those hospitals could make the simulated busyness follow real patterns. In production, the data would come from hospital partnerships or health-information exchanges.

---

## 8. Running, changing and troubleshooting

### Run (3 terminals)
```
# 1. Python server
cd server
python -m venv .venv                         # first time
.venv\Scripts\pip install -r requirements.txt   # first time
.venv\Scripts\python -m uvicorn app:app --port 8000

# 2. Web app
cd web
npm install      # first time
npm run dev      # http://localhost:5173/#/checkin and /#/board

# 3. Only when the schema changes (see below)
```

### Change the database schema
1. Edit [spacetimedb/src/index.ts](../spacetimedb/src/index.ts). New columns must be **appended at the end with `.default(...)`**, or the publish breaks existing rows.
2. `spacetime publish frontdoor-w3zl2 --module-path spacetimedb --yes`
3. `spacetime generate --lang typescript --out-dir web/src/module_bindings --module-path spacetimedb`
4. If a reducer signature changed, update the Python `stdb.call(...)` argument order, then restart the server.

Dashboard: https://spacetimedb.com/frontdoor-w3zl2. Read-only check: `spacetime sql frontdoor-w3zl2 "SELECT * FROM bed"`.

### Reset the demo
Board → **Reset demo**, or `curl -X POST localhost:8000/demo/reset`. Clearing localStorage, or "Start a new check-in", resets the phone.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Mic doesn't work on a real phone | Browsers allow the mic only on `localhost` or HTTPS. Use the laptop in a narrow window, or tunnel (`ngrok http 5173` + set `VITE_API_URL`). |
| Python change has no effect | `--reload` hangs on Windows. Ctrl+C and start again. |
| Port 8000 busy | `Get-NetTCPConnection -LocalPort 8000 -State Listen \| % { Stop-Process -Id $_.OwningProcess -Force }` |
| Board dot grey / "Connecting to live data…" | A brand-new browser can wait **5–15 s** for Maincloud's first reply. Wait; don't reload (that restarts the handshake). Browsers that already have a saved token connect faster. Headless screenshots need ~20 s. React StrictMode was removed because its dev double-mount made this worse. |
| `�` characters | A file was saved as cp1252. Always read/write UTF-8 in scripts. |
| Check-in returns ESI 3 "No symptoms reported" | The transcript was empty (curl/path issue or silent mic). |
| `{"error": "... not found"}` | Reducer rejected the call (bad id). Returned as 400, not a crash. |

---

## 9. Ownership and what's next

| Person | Owns | Files |
|---|---|---|
| You (backend/voice) | Tables, reducers, Cartesia, server glue, routing | [spacetimedb/src/index.ts](../spacetimedb/src/index.ts), [server/app.py](../server/app.py), [server/voice.py](../server/voice.py), [server/stdb.py](../server/stdb.py), [server/routing.py](../server/routing.py) |
| Person 2 (AI/sim) | LLM prompts, red-flag rules, simulator, forecast, demo feeds | [server/triage.py](../server/triage.py), [server/red_flags.py](../server/red_flags.py), [server/simulator.py](../server/simulator.py), [server/forecast.py](../server/forecast.py), [server/data/](../server/data/) |
| Person 3 (frontend) | Phone page, board, map, styling, slides | [web/src/CheckIn.tsx](../web/src/CheckIn.tsx), [web/src/Board.tsx](../web/src/Board.tsx), [web/src/IncomingMap.tsx](../web/src/IncomingMap.tsx), [web/src/index.css](../web/src/index.css) |

### Next
1. **Overflow + diversion** (section 7): done.
2. **Auth and permissions**: done (section 12).
3. **Apify data:** Google Maps popular times for San Francisco EDs → `arrival_curve.json` and the busyness of the diversion network.
4. **Figma:** Person 3 restyles to match the designs (Figma MCP if connected, or screenshots).
5. **Stretch:** a FrontDoor MCP server ("which patients are deteriorating?").
6. **Scale story only:** Kafka + Flink for multi-hospital, high-volume vitals streams. Not built.
7. Push to GitHub (`frontdoor` repo), Devpost with the Spacetime and Cartesia tags, backup video.

---

## 10. Judge Q&A

### Product and clinical safety
1. **Isn't the AI making triage decisions?** No. It drafts a pre-triage note and a suggested ESI. Nurses still triage. Our rules can only make a patient *more* urgent, never less.
2. **What if the AI under-triages chest pain?** Deterministic red-flag rules run on every transcript. Phrases like "spreading to my arm" force ESI ≤ 2 and a critical alert even if the LLM says otherwise.
3. **What does the patient hear?** Calm confirmation only, never a diagnosis. With red flags we tell them to call 911, or to pull over if they're driving.
4. **What if a patient doesn't answer the check-in?** Silence or a garbled answer doesn't page a nurse; we ask again. We fixed this after testing: originally a blank answer raised a critical alert.
5. **How do you avoid alert fatigue?** One banner per patient, dedupe of the same level, alerts only on escalation, and "I'm on it" clears all of a patient's alerts.
6. **What happens when beds run out?** Hallway beds for patients inside. For low-acuity walk-ins still on the way, an optional suggestion of a nearby ER with a shorter wait.

### AI reliability
7. **Which model and why?** Claude Opus 5.5 at low effort: strong clinical reasoning, ~3–5 s per triage. We use structured outputs, so responses are validated JSON matching a schema, not free text.
8. **What if the LLM is down or refuses?** Server-side fallback first; then our rule-based triage takes over, so check-in always works.
9. **Hallucinations?** The output is constrained to fields (complaint, summary, ESI, flags, prep). The summary comes from the patient's own words, the transcript is stored next to it, and the nurse sees both.

### Privacy, HIPAA, auth
10. **Is patient data secure?** Patient tables are private in the database. Nurses only see them after a staff PIN login, which grants their browser's SpacetimeDB identity a staff role. A patient's phone sees only its own record through per-user views. Only our server, signed in as the database owner, can write patient data. We tested each rule with an outsider identity, a nurse and a phone.
11. **HIPAA?** The demo uses fake data. In production: a BAA with each vendor, hospital SSO, encryption, audit logs, and data retention policies.
12. **Who acknowledged an alert?** Stored on the alert (`ackedBy`, `ackedAt`). The name comes from the nurse's staff record in the database, not from the browser, so it can't be faked.

### Tech choices
13. **Why SpacetimeDB?** The database *is* the backend: tables + reducers + live subscriptions. The board updates within milliseconds when anything changes, with no polling, no separate websocket server and no cache layer.
14. **Why Cartesia?** Fast, natural voice both ways: ink-whisper STT (~1.4 s) and Sonic TTS (~1.9 s). That matters for a scared patient.
15. **Why not Kafka/Flink?** Overkill for one ER. SpacetimeDB handles live state at our scale. Kafka/Flink is the scale story for many hospitals and continuous device streams.
16. **How does the map work without a map server?** Leaflet + OpenStreetMap tiles. ETAs and routes come from the free OSRM routing API.
17. **How do the vitals work?** In the demo they're simulated (a wearable stand-in) with a "gets worse" mode. In production: Apple Watch/Fitbit/BLE pulse oximeters through the phone.

### Data and forecast honesty
18. **Where does "5 beds short" come from?** Waiting + incoming patients who need beds (ESI 1–3) + expected walk-ins from an hourly arrival curve, minus free and cleaning beds. The formula is shown under the number.
19. **Is the arrival curve real?** Currently a placeholder typical-ED curve, and the board says so. We're replacing it with Apify-scraped Google Maps popular times for SF EDs.
20. **What's real vs simulated?**
    - **Real:** voice STT/TTS, LLM triage, red-flag rules, live database sync, real-road routing/ETA, GPS sharing.
    - **Simulated:** vitals, bed occupancy, other hospitals' capacity, the arrival curve (for now), the EMS patient.

### Business and adoption
21. **Who pays?** Hospitals: it reduces left-without-being-seen rates, waiting-room adverse events and boarding chaos. Priced per ED per month.
22. **How does a hospital adopt it?** A QR code and link at the entrance and on the website; the board runs in a browser. Later: EHR integration (HL7/FHIR) and hospital SSO.
23. **Do patients need an app?** No. It's a web page; voice works in the browser.

### Twiage, EMTALA, diversion
24. **How is this different from Twiage?** Twiage is for paramedics and ambulance patients. We're for the majority who walk in, we keep watching them after arrival, and we show both on one board.
25. **Doesn't suggesting another ER violate EMTALA?** No. EMTALA applies once someone comes to the ED. We only offer a choice *before* arrival, never to ESI 1–2 or EMS, and anyone who arrives is seen.
26. **Couldn't diversion send a sick person away?** Only ESI 3–5 walk-ins see it, the patient chooses, and red-flag rules keep sick patients at ESI ≤ 2.

### Performance
27. **How fast is it end to end?** Voice check-in ≈ 5–7 s (STT 1.4 s + triage 3–5 s + reply). Board updates are effectively instant over the subscription.
28. **What if 100 people check in at once?** Each check-in is independent HTTP work. SpacetimeDB reducers are transactional, and the LLM calls scale horizontally. The bottleneck is LLM latency, not the database.

---

## 11. Known limitations (be honest)

- **Auth is hackathon-grade:** one shared staff PIN (not per-nurse accounts or hospital SSO). The phone-facing server endpoints (`/followup`, `/location`, `/demo/drive`, `/demo/arrive`) take a patient id without proving the caller is that patient's phone.
- **Simulated data:** vitals, starting bed occupancy, the arrival curve, the EMS feed, and other hospitals' capacity (diversion).
- **Mic on real phones needs HTTPS** (tunnel). The demo runs best on the laptop.
- **Real GPS from San Jose** gives an hour-long ETA to San Francisco, so use **Simulate drive** in the demo.
- **The Python server's in-memory state** (simulator alert levels, drives) is lost on restart. Reset the demo after restarting.
- **`--reload` hangs on Windows.** Restart manually.
- **Public OSRM server**: fine for a demo, rate-limited. Production would self-host.
- **Patient lookup after check-in uses name** (newest row with that name). Two identical names at the same moment could collide.
- **First connect can be slow** (5–15 s) for a brand-new browser; open the board a minute before demoing.
- **Diversion is a suggestion only**: the other ER isn't notified and doesn't receive the check-in. In production, the check-in would be forwarded through a hospital partnership or health-information exchange.
- **Not a medical device**; demo data only.

---

## 12. Login and permissions (built and tested)

### Who can do what

| Who | How they prove it | Can read | Can do |
|---|---|---|---|
| **FrontDoor server** | Signs in as the **database owner** (token from `STDB_TOKEN` in `.env`, or the local `spacetime login`). The owner identity is recorded in the private `config` table when the module is first published. | Everything (SQL) | Check in patients, update location/arrival, add vitals and follow-ups, raise alerts, write forecast and hospital network, offer redirects, reset demo, **grant staff** |
| **Nurse (staff)** | Enters the **staff PIN** on the board. The server checks it against `STAFF_PIN` and calls `grant_staff` with the browser's SpacetimeDB identity. | All patients, vitals, alerts, offers (via `my_*` views) | Acknowledge alerts (name taken from the staff record), assign / hold / free beds; board actions that go through the server (reset, worsen, suggest another ER) send the PIN |
| **Patient's phone** | Its SpacetimeDB identity is saved as `phoneId` on the patient row at check-in. | Only its own patient row, alerts and offers | Answer its own redirect offer |
| **Anyone else** | – | Beds, forecast, nearby hospitals (no patient details) | Nothing |

### How it's built
- **Private tables + views** ([spacetimedb/src/index.ts](../spacetimedb/src/index.ts)): `my_patients`, `my_vitals`, `my_alerts`, `my_offers` return everything for staff and only the caller's own rows otherwise; `my_staff` tells the board whether this browser is signed in.
- **Guards:** `requireServer(ctx)` on 11 reducers, `requireStaff(ctx)` on 4, and `respondRedirect` checks `phoneId === ctx.sender`.
- **Board** ([web/src/Board.tsx](../web/src/Board.tsx)): shows a sign-in form until `my_staff` has a row; "Sign out" calls `staff_logout`.
- **Phone** ([web/src/CheckIn.tsx](../web/src/CheckIn.tsx)): sends its identity (`phoneId`) with the check-in; its token is kept in localStorage so the identity survives a refresh.
- **Server** ([server/stdb.py](../server/stdb.py), [server/app.py](../server/app.py)): owner token, `POST /staff/login`, PIN check (`hmac.compare_digest`) on reset / worsen / suggest.

### Tests we ran (all passed)
| Test | Result |
|---|---|
| Outsider calls `check_in`, `assign_bed`, `reset_demo` | Rejected ("only the FrontDoor server can do this" / "staff login required") |
| Outsider reads `patient` | "no such table … may be marked private" |
| Outsider reads `my_patients` | 0 rows |
| Wrong PIN on `/staff/login` and `/demo/reset` | 403 |
| Nurse after PIN login reads `my_patients` | All 5 patients |
| Phone after check-in reads `my_patients` | Only its own row; no other patients' alerts |
| Nurse tries to answer the patient's redirect offer | Rejected ("only the patient can answer this offer"); the phone's answer works |
| Nurse acknowledges an alert | `ackedBy` = "Nurse Kim" from the staff record |

### Setup notes
- `.env` needs `STAFF_PIN` (a random 6-digit PIN was generated on the owner's laptop). See `.env.example`.
- Teammates running their own server need `STDB_TOKEN` (the owner's token, shared privately), or the module will reject their writes.
- Publishing these access rules required `--delete-data` once so `init` could record the owner; demo data is recreated by **Reset demo**. Staff logins survive resets.

### Pitch line
"Every action is tied to a SpacetimeDB identity: the server is the database owner, nurses get a staff role, and patients can only see themselves. In production we'd swap the PIN for hospital SSO and add HIPAA-grade audit logging."
