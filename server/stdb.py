"""Tiny async client for the SpacetimeDB HTTP API (call reducers, run SQL)."""
import os

import httpx

HOST = os.getenv("STDB_HOST", "https://maincloud.spacetimedb.com")
DB = os.getenv("STDB_DB", "frontdoor-w3zl2")

_client = httpx.AsyncClient(base_url=HOST, timeout=15)
_token: str | None = None


async def _auth() -> dict:
    global _token
    if _token is None:
        r = await _client.post("/v1/identity")
        r.raise_for_status()
        _token = r.json()["token"]
    return {"Authorization": f"Bearer {_token}"}


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
