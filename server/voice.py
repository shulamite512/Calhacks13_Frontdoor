"""Cartesia speech-to-text (Ink) and text-to-speech (Sonic)."""
import os

import httpx

API = "https://api.cartesia.ai"
VERSION = "2026-08-14"
VOICE_ID = os.getenv("CARTESIA_VOICE_ID", "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4")
# San Francisco's most common languages; tested round-trip (Sonic speaks, Ink transcribes) for each.
LANGUAGES = {"en": "English", "es": "Spanish", "zh": "Chinese", "vi": "Vietnamese", "tl": "Tagalog"}


def lang_or_en(code: str | None) -> str:
    return code if code in LANGUAGES else "en"


_client = httpx.AsyncClient(base_url=API, timeout=30)


def _headers() -> dict:
    return {"Authorization": f"Bearer {os.environ['CARTESIA_API_KEY']}", "Cartesia-Version": VERSION}


async def transcribe(audio: bytes, filename: str, content_type: str, language: str = "en") -> str:
    r = await _client.post(
        "/stt",
        headers=_headers(),
        files={"file": (filename, audio, content_type)},
        data={"model": "ink-whisper", "language": lang_or_en(language)},
    )
    r.raise_for_status()
    return r.json()["text"].strip()


async def speak(text: str, language: str = "en") -> bytes:
    r = await _client.post(
        "/tts/bytes",
        headers=_headers(),
        json={
            "model_id": "sonic-3.6",
            "transcript": text,
            "voice": {"id": VOICE_ID},
            "language": lang_or_en(language),
            "output_format": {"container": "mp3", "sample_rate": 44100, "bit_rate": 128000},
        },
    )
    r.raise_for_status()
    return r.content
