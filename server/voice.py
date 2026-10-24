"""Cartesia speech-to-text (Ink) and text-to-speech (Sonic)."""
import os

import httpx

API = "https://api.cartesia.ai"
VERSION = "2026-08-14"
VOICE_ID = os.getenv("CARTESIA_VOICE_ID", "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4")

_client = httpx.AsyncClient(base_url=API, timeout=30)


def _headers() -> dict:
    return {"Authorization": f"Bearer {os.environ['CARTESIA_API_KEY']}", "Cartesia-Version": VERSION}


async def transcribe(audio: bytes, filename: str, content_type: str) -> str:
    r = await _client.post(
        "/stt",
        headers=_headers(),
        files={"file": (filename, audio, content_type)},
        data={"model": "ink-whisper", "language": "en"},
    )
    r.raise_for_status()
    return r.json()["text"].strip()


async def speak(text: str) -> bytes:
    r = await _client.post(
        "/tts/bytes",
        headers=_headers(),
        json={
            "model_id": "sonic-3.6",
            "transcript": text,
            "voice": {"id": VOICE_ID},
            "output_format": {"container": "mp3", "sample_rate": 44100, "bit_rate": 128000},
        },
    )
    r.raise_for_status()
    return r.content
