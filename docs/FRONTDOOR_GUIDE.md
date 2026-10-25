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

- The arrival curve lives in [server/data/arrival_curve.json](../server/data/arrival_curve.json), built by [server/scripts/build_arrival_curve.py](../server/scripts/build_arrival_curve.py): **real daily volume** (CPMC Van Ness, 34,742 ED visits in 2025 ≈ 95/day, California HCAI) spread over an **assumed typical-ED hourly shape** (quiet 3–6 am, busy late morning to evening). See section 13 for why the shape isn't scraped.
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

**Data honesty:** other hospitals' beds and waits are **simulated**; there's no public real-time bed feed. Their ER-entrance locations come from the Apify Google Maps scrape and their annual ED volumes from HCAI (real). In production, live capacity would come from hospital partnerships or health-information exchanges.

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
3. **Forecast data:** done with real HCAI volume (section 13). A real hourly shape would need the hospital's own arrival logs or EHR feed.
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
19. **Is the arrival curve real?** The volume is: CPMC Van Ness logged 34,742 ED visits in 2025 (California HCAI), about 95 a day. The hour-by-hour shape is a typical-ED assumption: we scraped Google popular times with Apify for 60+ ER and hospital listings in SF and five other US cities, and Google hides them for hospitals. The board shows the source on the forecast.
20. **What's real vs simulated?**
    - **Real:** voice STT/TTS, LLM triage, red-flag rules, live database sync, real-road routing/ETA, GPS sharing.
    - **Simulated:** vitals, bed occupancy, other hospitals' beds/waits, the hourly shape of arrivals, the EMS patient. **Real:** CPMC's daily ED volume (HCAI), hospital locations, drive times (OSRM), voice, AI triage.

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
- **Simulated data:** vitals, starting bed occupancy, the hourly arrival shape (daily volume is real HCAI data), the EMS feed, and other hospitals' beds and waits (diversion).
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

---

## 13. Forecast data: what we scraped and what we used

| Step | What happened |
|---|---|
| Apify, SF ER listings | Google Maps scraper (`compass/crawler-google-places`, place details on) for CPMC Van Ness ER + 4 nearby ERs. All 5 found, **no popular times** for any. |
| Apify, SF main hospital listings | 6 main hospital listings. **No popular times.** |
| Apify, US cities | "emergency room" in San Jose, Houston, Phoenix, Chicago, Atlanta, Dallas (48 places). **1 hit**: a downtown Atlanta 24/7 urgent care, busiest around midnight (nightlife area). Not ER-like, so not used. |
| California HCAI | Downloaded "Hospital Emergency Department – Encounters by Facility" (2012–2025). **CPMC Van Ness: 34,742 ED visits in 2025 (~95/day)**, 6,674 admitted. Saved in [server/data/hcai_ed_visits_sf.json](../server/data/hcai_ed_visits_sf.json). |
| Result | `arrival_curve.json` = real HCAI daily volume × typical-ED hourly shape. With the demo patients, the board shows **"3 beds short in 30 min"**. |

Side benefits of the scrape: the exact **ER entrance** for CPMC (1260 Franklin St, used on the map) and the other EDs, and the discovery that Saint Mary's is now **UCSF Health St. Mary's**.

SF ED volumes, 2025 (HCAI): Zuckerberg SF General 50,799 · UCSF Medical Center 39,855 · CPMC Van Ness 34,742 · Kaiser SF 33,458 · CPMC Mission Bernal 19,979 · UCSF Health Hyde 18,769 · UCSF Health St. Mary's 12,836 · CPMC Davies 11,303 · Chinese Hospital 6,110.

Scripts: [fetch_popular_times.py](../server/scripts/fetch_popular_times.py) (needs `APIFY_TOKEN`), [build_arrival_curve.py](../server/scripts/build_arrival_curve.py) (set `USE_APIFY_SHAPE = True` to try the scraped shape).

Judge line: "The volume is real state data; Google won't publish hospital busyness, so in production the hourly pattern would come from the hospital's own arrival logs."

---

## 14. Department readiness (does the specialty have a doctor and a bed?)

**Question it answers:** "This patient needs a cardiologist. Do we have one on call, a CCU bed, and is the cath lab free?"

| Part | What it does |
|---|---|
| Claude triage ([server/triage.py](../server/triage.py)) | Adds `specialty`: Cardiology (suspected ACS), Neurology (stroke signs), Surgery (acute abdomen), ICU, Pediatrics (under 18), Trauma (major injury) or Emergency (ED only). Stored on the patient. |
| `department` table (public, no patient data) | Per department: doctors on call, specialty beds free/total, key resource and whether it's ready, note. Seeded on **Reset demo** by [server/departments.py](../server/departments.py). |
| Board tile | One line per patient: green **"✓ Needs Cardiology: 1 on call · 2 CCU beds · Cath lab ready"** or red **"⚠ Needs Surgery: Operating room not ready"**. |
| Departments panel (right column) | Staff tap **− / +** for doctors and beds and toggle the resource (ready/busy). `update_department` is **staff-only** (tested: outsider rejected). |

Seeded departments (13; status simulated, staff-editable). The panel lists departments that current patients need first, with a count, and folds the rest behind **Show all 13 departments**.

| Department | Beds | Doctors | Resource | Note |
|---|---|---|---|---|
| Cardiology | 2/4 CCU | 1 | Cath lab: ready | Interventional cardiologist on call |
| Neurology | 1/2 Neuro ICU | 1 | CT scanner: ready | Stroke team; tele-neurology backup |
| Surgery | 2/6 post-op | 1 | Operating room: **busy** | Red warning in the demo |
| ICU | 1/12 | 1 | Ventilators: ready | |
| Pediatrics | 3/8 | 2 | Peds ED bay: ready | |
| Orthopedics | 2/6 | 1 | Splint/cast room: ready | |
| Obstetrics | 1/6 L&D rooms | 1 | Labor & delivery: ready | |
| Psychiatry | **0/3** psych holds | 1 | Safe room: **busy** | Red warning: no safe room |
| Gastroenterology | 2/4 | **0** | Endoscopy suite: ready | Red warning: no GI on call until 7 am |
| Pulmonology | 3/6 step-down | 1 | BiPAP machines: ready | |
| Nephrology | 1/4 dialysis chairs | 1 | Dialysis: ready | |
| Trauma | not offered | – | – | **Real:** SF's Level I trauma center is Zuckerberg SF General |
| Burns | not offered | – | – | **Real:** serious burns go to the Bothin Burn Center (UCSF Health Hyde Hospital, formerly Saint Francis) |

Tested (Claude's pick): chest pain → Cardiology, abdominal pain → Surgery, EMS stroke → Neurology, 8-year-old → Pediatrics, motorcycle crash → Trauma, 34 weeks pregnant with contractions → Obstetrics, thoughts of self-harm → Psychiatry, vomiting blood → Gastroenterology, missed dialysis → Nephrology, boiling-oil burns → Burns, bent wrist → Orthopedics, severe asthma → Pulmonology. All 12 correct.

**Demo idea:** after the chest-pain check-in, tap **Cath lab: ready** to make it busy. The tile turns red ("Cath lab not ready"), showing the charge nurse would know before the patient arrives.

**Judge Q&A**
- *Where would real department status come from?* The hospital's on-call schedule (e.g. Amion/QGenda), bed management system and OR/cath-lab scheduling. In the demo it's simulated and staff-editable.
- *What if the specialty isn't available?* The tile says so before arrival. For a stable walk-in, **Suggest another ER** is there; for ESI 1–2 (like the trauma patient) a nurse would call the transfer center. We never auto-redirect critical patients.

---

## 15. Multilingual voice and family link

**Languages:** English, Spanish, Chinese, Vietnamese, Tagalog (San Francisco's most common). Each was tested round-trip: Sonic speaks a sentence, Ink transcribes it back correctly.

| Step | Language |
|---|---|
| Patient picks a language on the phone; the UI switches | Patient's |
| Voice check-in transcribed by Cartesia Ink with `language` | Patient's |
| Claude writes complaint, summary, red flags, prep | **English** (for the nurse) |
| Claude's spoken reply, read by Cartesia Sonic | Patient's |
| Waiting-room question ([server/app.py](../server/app.py) `FOLLOWUP_QUESTION`) and follow-up reply | Patient's |
| Board tile | English + a purple language badge (e.g. SPANISH) |

Tested: Rosa, 61, speaking Spanish about chest pain radiating to her left arm → nurse sees "Chest pain radiating to arm", ESI 2, Cardiology; Rosa hears "Rosa, ya está registrada…"; her Spanish follow-up "me siento peor, ahora me cuesta respirar" raised a **critical** alert with the reason in English.

Limitations: red-flag keywords are English-only (Claude covers other languages); phone status cards are English.

**Family link:** the patient taps **Share my status with family** → `POST /family/share` (only the patient's own phone, matched by `phoneId`; others get 403) → a random token is stored on the patient → the link `#/family/<token>` shows a status timeline (checked in → arrived → nurse with them → bed → done, or "heading to another ER"), refreshed every 5 s through `GET /family/{token}`. It never shows symptoms or vitals. Bad tokens return 404.

Devpost text for every Tier 1 track is in [docs/DEVPOST.md](DEVPOST.md).

---

## 16. Automatic waiting-room check-ins

Once a patient is **in the waiting room**, their phone checks in by itself, so nobody has to remember to tap.

| Setting | Value ([web/src/CheckIn.tsx](../web/src/CheckIn.tsx)) |
|---|---|
| First check-in | 30 s after arriving (`AUTO_FIRST_MS`, short so it shows in a demo) |
| Then | every 2 min (`AUTO_EVERY_MS`) |
| Listening window | 8 s, then recording stops automatically (`AUTO_LISTEN_MS`) |
| Missed answers before a nurse is told | 2 in a row (`MISSES_BEFORE_ALERT`) |

Flow: speak the question in the patient's language (Sonic) → listen 8 s → transcribe (Ink) → same `/followup` path as a manual check-in (Claude + rules, alerts if worse). The phone shows **Automatic check-ins · next in 1:32** with a checkbox to turn it off. It stops when the patient gets a bed, leaves or is redirected.

**Silence safety:**
- One silent answer never pages a nurse (it's often a mic problem).
- Whisper-style speech-to-text invents short phrases on silence or noise ("Thank you.", "Bye.", "Gracias"). We found this in testing: a silent test mic was transcribed as "Thank you." and "Bye.". `SILENCE_PHRASES` in [server/app.py](../server/app.py) treats those as *not heard*. Real answers ("I feel a little better now, thanks") still go through.
- **Two missed automatic check-ins in a row** → `POST /followup/missed` → warning alert **"No answer to 2 automatic check-ins"** and a flagged follow-up row. A patient who stops responding is exactly who a nurse should see.

Tested in a real browser with a simulated microphone: check-ins fired at 30 s and ~2.5 min with no taps; the second miss raised the warning on the board.

Judge line: "FrontDoor keeps asking, in your language, every two minutes. And if you stop answering, that's a signal too."

---

## 17. Making the simulated parts real (MIMIC-IV-ED + CDPH)

**Why some data is simulated at all:** live vitals, bed occupancy and department status exist only inside a hospital's private systems (bedside monitors, the EHR's bed board, on-call schedules), protected by HIPAA. No hackathon team can access them. In production FrontDoor would read them through standard hospital feeds (HL7 v2 ADT / FHIR). So we replaced as much as public data allows:

| Part | Before | Now | Source |
|---|---|---|---|
| Daily ED volume | real | real | HCAI: CPMC Van Ness 34,742 visits (2025) |
| Hourly arrival pattern | assumed | **real** hour-of-day pattern of 222 ED arrivals | MIMIC-IV-ED Demo v2.2 (open, ODbL) |
| Vitals | random numbers | **replayed real ED vital-sign trajectories** (159 stays) | MIMIC-IV-ED Demo vitalsign table |
| "Worsen" button | synthetic drift | switches to a **real stay that deteriorated** to critical values (17 stays, all critical within 45 s of demo time) | MIMIC-IV-ED Demo |
| Department bed totals | made up | **real licensed totals**: ICU 36, perinatal 53, pediatric 25 (+8 PICU); none for coronary care, psych or burns | CDPH bed types, 2026-10-16 |
| Free beds right now, doctors on call, resource status | simulated | still simulated, staff-editable | (only in hospital systems) |

**How the vitals replay works** ([server/simulator.py](../server/simulator.py)): each patient gets a real stay's trajectory and steps through it every 3 s (one charted reading is about 9 s, interpolated). Background patients get calm stays (no reading crosses an alert threshold) so the demo isn't flooded. Real data is messy, so stays with impossible values (e.g. a charted SpO2 of 10%) are dropped. "Worsen" picks a stay that starts below critical and turns critical within its first 6 readings. Tested live: James went from HR 86 to 130, raising a warning and then a critical alert ("HR 131, RR 22").

### Claude vs real ED nurses (206 real triage cases)
[server/scripts/eval_triage_mimic.py](../server/scripts/eval_triage_mimic.py) runs our full triage pipeline (Claude + rules, same as /checkin) on every MIMIC-IV-ED Demo triage record with a chief complaint and a nurse-assigned ESI.

| Measure | Result |
|---|---|
| Exact match with the nurse's ESI | **58.3%** |
| Within one ESI level | **98.5%** |
| FrontDoor more urgent than the nurse | 13.1% |
| FrontDoor less urgent than the nurse | **28.6%** |
| Nurse ESI 1-2 cases that FrontDoor also rated 1-2 | **71.1%** (81 of 114) |

Confusion (nurse -> FrontDoor): 1->1: 3, 1->2: 14, 1->3: 1, 2->1: 1, 2->2: 63, 2->3: 31, 2->4: 1, 3->2: 24, 3->3: 54, 3->4: 11, 3->5: 1, 4->3: 2.

**How to read it honestly:**
- It's almost never far off (98.5% within one level), but it **leans less urgent on ESI 2 vs 3** calls: dyspnea, falls, abnormal labs, GI bleeding ("BRBPR"), transfers.
- The input is harder than real use: the nurse's 2-3 word shorthand ("SOB", "Psych eval") plus triage vitals, with no age, history or the patient's own words. Nurses saw the patient.
- The demo cohort is unusually sick (patients later admitted; most triaged ESI 1-2).
- **This is why FrontDoor never relies on triage alone:** vitals and voice check-ins keep watching, alerts only escalate, and nurses make every decision. Judge line: "We measured it against real nurses and found where it under-triages, so it's designed to be a second set of eyes, not the decision-maker."
- We then improved it fairly (next subsection).

### Improving it fairly: tune on one half, test once on the other

The 206 cases are split by a hash of `stay_id` into a **tune** half (110) and a **test** half (96). We changed the prompt while looking only at the tune half, then ran the test half **once**.

**The change** ([server/triage.py](../server/triage.py) `TRIAGE_SYSTEM`): instead of a one-line ESI description, Claude walks the published **ESI v4 algorithm** step by step: (A) life-saving intervention → 1; (B) high-risk situation (standard handbook categories), new confusion, or severe pain → 2; (C) count expected resources → 3/4/5; (D) danger-zone vitals (HR > 100, RR > 20, SpO2 < 92%) upgrade a 3 to a 2; and "when torn between two levels, choose the more urgent". We did *not* copy specific missed cases into the prompt (we had seen some misses from both halves in the first run, so we used only general handbook guidance).

| | Tune half (110) before -> after | **Test half (96) before -> after** |
|---|---|---|
| Nurse ESI 1-2 cases also rated 1-2 | 60.9% -> 82.8% | **84.0% -> 96.0% (48 of 50)** |
| Rated less urgent than the nurse | ~25% -> 18.2% | ~20% -> **15.6%** |
| Rated more urgent than the nurse | 12.7% -> 31.8% | 13.5% -> 35.4% |
| Within one ESI level | 99.1% -> 98.2% | 97.9% -> 97.9% |
| Exact match | 53.6% -> 50.0% | 63.5% -> 49.0% |

**Trade-off, stated plainly:** FrontDoor now misses only 2 of 50 high-risk patients in the held-out half, but it rates about a third of patients more urgent than the nurse did (mostly nurse ESI 3 -> FrontDoor 2). For a pre-arrival heads-up that a nurse then confirms, over-triage is the safer error. Minor complaints still come out low (spot check after the change: ankle sprain, sore throat, finger cut -> ESI 4; crushing chest pain, fall on blood thinners -> ESI 2).

**Noise:** re-running the unchanged prompt on all 206 cases gave 72.8% vs 71.1% the first time, so differences of a couple of points are noise. The +12 to +22 point gains above are not.

Files: [triage_mimic_summary.json](../server/data/eval/triage_mimic_summary.json) (baseline, all cases), [triage_mimic_summary_esi_v1_tune.json](../server/data/eval/triage_mimic_summary_esi_v1_tune.json) (tune half, after) and [triage_mimic_summary_esi_v1_test.json](../server/data/eval/triage_mimic_summary_esi_v1_test.json) (held-out test half, after, with `triage_mimic_cases_esi_v1_test.csv`).

Files: [mimic_arrival_shape.json](../server/data/mimic_arrival_shape.json), [mimic_vitals.json](../server/data/mimic_vitals.json), [eval/](../server/data/eval/), [cdph_beds_cpmc_van_ness.json](../server/data/cdph_beds_cpmc_van_ness.json). Raw downloads live in server/data/raw/ (not committed); [build_mimic_data.py](../server/scripts/build_mimic_data.py) lists the URLs.

Citation: Johnson A, Bulgarelli L, Pollard T, Celi LA, Mark R, Horng S. MIMIC-IV-ED Demo (version 2.2). PhysioNet (2023). Open Data Commons Open Database License v1.0. Derived files in this repo are shared under the same license.

