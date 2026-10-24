"""Tiny async client for the SpacetimeDB HTTP API (call reducers, run SQL).

The server signs in as the database OWNER, because the module only accepts patient-data writes
from the owner. Token comes from STDB_TOKEN in .env, or the local `spacetime login` config.
"""
import logging
import os
import re
from pathlib import Path

import httpx

HOST = os.getenv("STDB_HOST", "https://maincloud.spacetimedb.com")
DB = os.getenv("STDB_DB", "frontdoor-w3zl2")
CLI_CONFIG = Path(os.getenv("LOCALAPPDATA", Path.home())) / "SpacetimeDB" / "config" / "cli.toml"

log = logging.getLogger("stdb")
_client = httpx.AsyncClient(base_url=HOST, timeout=15)
_token: str | None = None


def _owner_token() -> str | None:
    if os.getenv("STDB_TOKEN"):
        return os.environ["STDB_TOKEN"]
    if CLI_CONFIG.exists():
        m = re.search(r'^spacetimedb_token\s*=\s*"([^"]+)"', CLI_CONFIG.read_text(), re.M)
        if m:
            return m.group(1)
    return None


async def _auth() -> dict:
    global _token
    if _token is None:
        _token = _owner_token()
        if _token is None:
            log.warning("No STDB_TOKEN or spacetime login found: writes will be rejected by the module")
            r = await _client.post("/v1/identity")
            r.raise_for_status()
            _token = r.json()["token"]
    return {"Authorization": f"Bearer {_token}"}


def identity_arg(hex_identity: str) -> dict:
    """Encode an identity (hex string from the browser) as a reducer argument."""
    h = hex_identity.lower().removeprefix("0x")
    if not re.fullmatch(r"[0-9a-f]{64}", h):
        raise ValueError("invalid identity")
    return {"__identity__": f"0x{h}"}


class ReducerError(RuntimeError):
    pass


async def call(reducer: str, *args) -> None:
    """Call a reducer by its snake_case name with positional args."""
    r = await _client.post(f"/v1/database/{DB}/call/{reducer}", json=list(args), headers=await _auth())
    if r.status_code >= 400:
        raise ReducerError(f"{reducer} failed: {r.text}")


def _decode(value, typ):
    # Options come back as [0, value] (some) / [1, []] (none); timestamps as [micros].
    if "Sum" in typ:
        variants = typ["Sum"]["variants"]
        tag, inner = value
        if variants[tag]["name"].get("some") == "none":
            return None
        return _decode(inner, variants[tag]["algebraic_type"])
    if "Product" in typ:
        elems = typ["Product"]["elements"]
        if len(elems) == 1 and "timestamp" in (elems[0]["name"].get("some") or ""):
            return value[0]  # micros since epoch
    return value


async def sql(query: str) -> list[dict]:
    r = await _client.post(f"/v1/database/{DB}/sql", content=query, headers=await _auth())
    if r.status_code >= 400:
        raise RuntimeError(f"sql failed ({r.status_code}): {r.text}")
    result = r.json()[0]
    cols = [(e["name"]["some"], e["algebraic_type"]) for e in result["schema"]["elements"]]
    return [{name: _decode(v, typ) for (name, typ), v in zip(cols, row)} for row in result["rows"]]
