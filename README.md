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

**Apify + HCAI data:** ER-entrance locations from an Apify Google Maps scrape; real ED volumes from
California HCAI drive the forecast ([server/scripts/](server/scripts/)).

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

ER: CPMC Van Ness Campus, San Francisco. Demo walk-ins drive in from the Palace of Fine Arts.

1. Board: sign in with the staff PIN, then click **Reset demo**. Seeds 3 waiting patients, 1 walk-in and 1 ambulance (EMS) moving on the map.
2. Phone: enter name/age, tap the mic, say "I've had crushing chest pain for 20 minutes and I'm sweating." Check in.
   The tile appears under **Incoming** with ESI 2, red flags and a "Prepare before arrival" card (ECG, monitor).
3. Phone: tap **Simulate drive**. The dot moves along the real route; ETA counts down. Board: tap **Hold bed**.
   On arrival (~1 min) the tile moves to the waiting room automatically.
4. Board: tap **Worsen** on the tile (heart rate climbs). Phone: tap **Check on me now**, answer
   "It's getting worse, it's spreading to my arm." Tile turns red, critical banner. Nurse taps **I'm on it**;
   the phone shows "Charge RN is coming to you now".
5. Header shows "N beds short in 30 min". Tap **Assign bed** (uses the held bed). Phone shows "Your bed is ready".

Optional extras: pick **Español** on the phone and check in in Spanish (the nurse still sees English);
tap **Share my status with family** and open the link in another tab.

Pitch line: Twiage covers ambulances; FrontDoor covers everyone else, on the same board.

Forecast hour can be pinned for the demo: set `FORECAST_HOUR=18` before starting the server.

## Notes

- Mic access needs `localhost` or HTTPS. For a real phone, tunnel the web app and API (e.g. `ngrok http 5173`)
  and set `VITE_API_URL` to the tunneled API URL.
- Not a medical device. Demo data only.
