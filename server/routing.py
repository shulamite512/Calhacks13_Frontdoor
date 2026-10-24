"""Drive-time ETA and route geometry from the public OSRM server (no API key)."""
import math

import httpx

OSRM = "https://router.project-osrm.org/route/v1/driving"
_client = httpx.AsyncClient(timeout=10, headers={"User-Agent": "FrontDoor-hackathon"})


def distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


async def route(lat: float, lng: float, to_lat: float, to_lng: float) -> tuple[float, list[tuple[float, float]]]:
    """Return (drive seconds, [(lat, lng), ...]). Falls back to a straight line at 30 km/h."""
    try:
        r = await _client.get(
            f"{OSRM}/{lng},{lat};{to_lng},{to_lat}", params={"overview": "full", "geometries": "geojson"}
        )
        r.raise_for_status()
        best = r.json()["routes"][0]
        return best["duration"], [(c[1], c[0]) for c in best["geometry"]["coordinates"]]
    except (httpx.HTTPError, KeyError, IndexError):
        return distance_m(lat, lng, to_lat, to_lng) / 8.3, [(lat, lng), (to_lat, to_lng)]
