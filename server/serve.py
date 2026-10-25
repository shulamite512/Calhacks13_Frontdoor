"""Production entry point (Docker / Render): the built website at / and the API under /api, on one port.

Run:  uvicorn serve:root --host 0.0.0.0 --port $PORT   (from the server/ folder, after `npm run build` in web/)
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

import app as api

# Mounted apps don't run their own lifespan, so the root runs the API's (simulator + Assistant).
root = FastAPI(lifespan=api.lifespan)
root.mount("/api", api.app)


# The app routes with #/board and #/ems; send people who type /board or /ems to the right screen.
@root.get("/board")
async def board_alias():
    return RedirectResponse("/#/board")


@root.get("/ems")
async def ems_alias():
    return RedirectResponse("/#/ems")
root.mount("/", StaticFiles(directory=Path(__file__).parent.parent / "web" / "dist", html=True), name="web")
