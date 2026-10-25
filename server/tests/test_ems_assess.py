"""/ems/assess must answer even when the LLM key is missing or ER matching is down.

Run from server/:  python -m pytest tests
"""
import logging
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
os.environ["BACKGROUND_TASKS"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import app  # noqa: E402
import matching  # noqa: E402
import triage  # noqa: E402

REPORT = {"transcript": "male 70, left facial droop, slurred speech", "age": 70, "lat": 37.79, "lng": -122.43}
OPTION = {"hospitalId": matching.OUR_ID, "name": "Ours", "lat": 0, "lng": 0, "driveMinutes": 5,
          "waitMinutes": 20, "canTreat": True, "reason": "emergency care", "totalMinutes": 5}


@pytest.fixture
def client(monkeypatch):
    # No key: the SDK would raise TypeError on the request instead of an APIError.
    monkeypatch.setattr(triage._client, "api_key", None)
    monkeypatch.setattr(triage._client, "auth_token", None)
    return TestClient(app.app)


def test_missing_api_key_falls_back_to_rules(client, monkeypatch):
    async def rank(*_a, **_k):
        return [dict(OPTION)]
    monkeypatch.setattr(matching, "rank", rank)

    r = client.post("/ems/assess", json=REPORT)

    assert r.status_code == 200
    body = r.json()
    assert body["acuity"] <= 2  # stroke signs caught by the rules
    assert body["options"][0]["onFrontDoor"] is True
    assert body["vitals"] == {}


def test_matching_failure_is_503_without_patient_text(client, monkeypatch, caplog):
    async def rank(*_a, **_k):
        raise RuntimeError("sql failed (503): unavailable")
    monkeypatch.setattr(matching, "rank", rank)

    with caplog.at_level(logging.INFO):
        r = client.post("/ems/assess", json=REPORT)

    assert r.status_code == 503
    assert "radio" in r.json()["detail"]
    assert "facial droop" not in caplog.text
