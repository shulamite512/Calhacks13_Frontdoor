# FrontDoor

Walk-in ER patients check in by voice on the way, get checked on in the waiting room (voice + vitals),
nurses get alerts when someone gets worse, and the charge nurse sees bed shortfalls before the rush.

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
   Needs `.env` in the repo root with `CARTESIA_API_KEY` and `ANTHROPIC_API_KEY`.

2. **Web app**:
   ```
   cd web
   npm install      # first time only
   npm run dev
   ```
   - Patient phone page: http://localhost:5173/#/checkin
   - Nurse board: http://localhost:5173/#/board

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
| Bed forecast | `server/forecast.py`, `server/data/arrival_curve.json` (replace with Apify data) |
| Phone page | `web/src/CheckIn.tsx` |
| Nurse board | `web/src/Board.tsx`, `web/src/index.css` |

## Demo script (2 min)

1. Board: click **Reset demo** (seeds 4 background patients).
2. Phone: enter name/age, tap the mic, say "I've had crushing chest pain for 20 minutes and I'm sweating." Check in.
   The tile appears under **Incoming** with ESI 2 and red flags.
3. Phone: tap **I've arrived**. Board: tap **Worsen** on the tile (heart rate climbs).
4. Phone: tap **Check on me now**, answer "It's getting worse, it's spreading to my arm."
   Tile turns red, critical banner appears. Nurse taps **I'm on it**.
5. Header shows "N beds short in 30 min". Tap **Assign bed** on the tile (picks Resus/Acute automatically).

Forecast hour can be pinned for the demo: set `FORECAST_HOUR=18` before starting the server.

## Notes

- Mic access needs `localhost` or HTTPS. For a real phone, tunnel the web app and API (e.g. `ngrok http 5173`)
  and set `VITE_API_URL` to the tunneled API URL.
- Not a medical device. Demo data only.
