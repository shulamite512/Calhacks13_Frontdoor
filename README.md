# FrontDoor

Walk-in ER patients check in by voice, in their own language, on the way. They get checked on in the waiting
room (voice + vitals), nurses get alerts when someone gets worse, each patient's department shows whether it
has a doctor and a bed, and the charge nurse sees bed shortfalls before the rush. Family can follow along
with a status-only link.

Docs: [team guide](docs/FRONTDOOR_GUIDE.md) · [Devpost draft](docs/DEVPOST.md)

## Sponsor technology

**SpacetimeDB:** the real-time backend for everything. 12 tables and reducers in
[spacetimedb/src/index.ts](spacetimedb/src/index.ts); private patient tables with per-user views
(`my_patients`, `my_alerts`, …); server-only and staff-only reducers; live board via the React SDK.

**Cartesia:** voice in and out, in English, Spanish, Chinese, Vietnamese and Tagalog
([server/voice.py](server/voice.py)).
- *Setup:* `CARTESIA_API_KEY` in `.env`. API version `2026-08-14`.
- *Features used:* **Ink** `ink-whisper` (batch STT with `language`) for check-ins and waiting-room answers;
  **Sonic** `sonic-3.6` (`/tts/bytes`, MP3, `language`) for spoken replies with one voice across languages.
- *Known limitations:* batch rather than streaming (~3 s per voice turn); deterministic red-flag keywords
  are English-only (Claude handles other languages); live status cards on the phone are English.

**Claude (Anthropic):** pre-triage note, ESI, red flags, department, prep items and waiting-room
follow-ups ([server/triage.py](server/triage.py)), with deterministic safety rules alongside
([server/red_flags.py](server/red_flags.py)).

**Public data:** ER-entrance locations from an Apify Google Maps scrape; real ED volumes (California
HCAI) and the real hourly arrival pattern (MIMIC-IV-ED Demo) drive the forecast; vitals replay real
de-identified ED stays (MIMIC-IV-ED Demo, ODbL); licensed bed totals from CDPH. Claude's triage was
evaluated against real nurse ESI ([server/data/eval/](server/data/eval/)). Scripts: [server/scripts/](server/scripts/).

```
phone page (React) ──voice──> FastAPI (server/) ──> Cartesia STT/TTS, Claude triage
                                   │  simulator: vitals + forecast every 3s
                                   ▼
                     SpacetimeDB (spacetimedb/)  ── live subscription ──> nurse board (React)
```

## Run it (3 terminals)

1. **Python server** (voice, AI, simulator):
   ```
   cd server
   python -m venv .venv            # first time only
   .venv\Scripts\pip install -r requirements.txt   # first time only
   .venv\Scripts\python -m uvicorn app:app --port 8000
   ```
   After editing Python files, stop it (Ctrl+C) and start it again (`--reload` hangs on Windows).
   Needs `.env` in the repo root (see `.env.example`): `CARTESIA_API_KEY`, `ANTHROPIC_API_KEY`, `STAFF_PIN`,
   and `STDB_TOKEN` (the database owner's token, shared privately) unless you're on the owner's laptop.

2. **Web app**:
   ```
   cd web
   npm install      # first time only
   npm run dev
   ```
   - Patient phone page: http://localhost:5173/#/checkin
   - Nurse board: http://localhost:5173/#/board (sign in with your name and the staff PIN)
   - Family page: opened from the patient's **Share my status with family** link (`#/family/<token>`)

3. **SpacetimeDB module** (only when you change `spacetimedb/src/index.ts`):
   ```
   spacetime publish frontdoor-w3zl2 --module-path spacetimedb --yes
   spacetime generate --lang typescript --out-dir web/src/module_bindings --module-path spacetimedb
   ```
   Database: `frontdoor-w3zl2` on Maincloud (dashboard: https://spacetimedb.com/frontdoor-w3zl2).

## Who owns what

| Area | Files |
|---|---|
| Tables + reducers | `spacetimedb/src/index.ts` |
| Voice (Cartesia) | `server/voice.py`, `/transcribe`, `/speak` in `server/app.py` |
| LLM triage + follow-up | `server/triage.py` |
| Red-flag rules | `server/red_flags.py` |
| Vitals simulator | `server/simulator.py` |
| Bed forecast | `server/forecast.py`, `server/data/arrival_curve.json` (built by `server/scripts/build_arrival_curve.py` from HCAI volume) |
| Phone page | `web/src/CheckIn.tsx` |
| Nurse board | `web/src/Board.tsx`, `web/src/index.css` |

## Demo script (2 min)

Story: you're driving to the ER. FrontDoor sends you to the ER that can actually treat you right now,
tells it you're coming, and watches over you until you're in a bed. Our ER: CPMC Van Ness; demo
patients drive in from the Palace of Fine Arts.

1. Board: sign in with the staff PIN, click **Reset demo**. Robert (abdominal pain, needs surgery) is
   already offered **Kaiser** because our OR is busy: the tile shows why.
2. Phone: the page asks for location and lists **ERs near you** (outside SF it uses the demo location).
   Say "Pain in my lower right belly for eight hours, getting sharper." The phone shows
   **A better match for you right now: Kaiser. Surgery ready, operating room ready. At CPMC: operating
   room busy. 7 min away.** Tap **Keep my spot** (or Go to Kaiser to show directions).
3. Phone (new check-in): say "Crushing chest pain going to my left arm, I'm sweating." Red **Call 911 now**
   card + best-equipped ER (cardiology ready, cath lab ready). Board tile: ESI 2, "Prepare: 12-lead ECG".
4. Back to the stable patient: **Simulate drive** → arrives → wearable vitals start → **Worsen** (real
   deteriorating ER patient) → red alert → nurse taps **I'm on it** → phone: "Charge RN is coming to you now".
5. Header "N beds short in 30 min" → **Assign bed** → phone: "Your bed is ready: A4".

Optional: pick **Español** and check in in Spanish; **Share my status with family**.

Forecast hour can be pinned for the demo: set `FORECAST_HOUR=18` before starting the server.

## Notes

- Mic access needs `localhost` or HTTPS. For a real phone, tunnel the web app and API (e.g. `ngrok http 5173`)
  and set `VITE_API_URL` to the tunneled API URL.
- Not a medical device. Demo data only.
