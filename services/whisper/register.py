"""
Self-registration with core-api, replicated from @ai-pipeline/runtime's register.ts (TypeScript).

core-api's own /v1/deployments endpoint never recomputes contractHash or validates it came from
the real TS contract machinery — it only checks that `schemas.{input,output,config}` are each a
valid Ajv-strict draft-07 JSON Schema, and that contractHash matches /^sha256:[0-9a-f]{64}$/,
comparing it only against a previously *stored* hash on later registrations. So this only needs to
reproduce the same canonicalization + hashing algorithm consistently across redeploys of the same
version — it does not need to match what a hypothetical TS implementation would compute.
"""

import json
import logging
import os
import pathlib
from hashlib import sha256

import httpx

logger = logging.getLogger(__name__)

_METADATA_PATH = pathlib.Path(__file__).parent / "metadata.json"

_SEGMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "id": {"type": "integer", "minimum": 0},
        "start": {"type": "number", "minimum": 0},
        "end": {"type": "number", "minimum": 0},
        "text": {"type": "string"},
    },
    "required": ["id", "start", "end", "text"],
    "additionalProperties": False,
}

_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "artifactUrl": {"type": "string", "format": "uri"},
        "language": {"type": "string", "minLength": 2, "maxLength": 10},
    },
    "required": ["artifactUrl"],
    "additionalProperties": False,
}

_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "language": {"type": "string"},
        "languageProbability": {"type": "number"},
        "duration": {"type": "number"},
        "segments": {"type": "array", "items": _SEGMENT_SCHEMA},
    },
    "required": ["language", "languageProbability", "duration", "segments"],
    "additionalProperties": False,
}

_CONFIG_SCHEMA = {"type": "object", "properties": {}, "additionalProperties": False}


def _canonical_json(value) -> str:
    """Matches packages/contracts/src/schemas.ts's canonicalJson exactly: sort object keys
    lexicographically, drop undefined (nothing here ever sets None, so this never triggers),
    recurse into arrays/objects, JSON-encode primitives with no extra whitespace."""
    if isinstance(value, list):
        return "[" + ",".join(_canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        entries = sorted((k, v) for k, v in value.items() if v is not None)
        return "{" + ",".join(f"{json.dumps(k)}:{_canonical_json(v)}" for k, v in entries) + "}"
    return json.dumps(value, ensure_ascii=False)


def _contract_hash(schemas: dict) -> str:
    return "sha256:" + sha256(_canonical_json(schemas).encode("utf-8")).hexdigest()


_RETRYABLE_STATUS = {502, 503}


async def register_on_boot() -> None:
    metadata = json.loads(_METADATA_PATH.read_text())

    core_api_url = os.environ["CORE_API_URL"]
    advertised_endpoint = os.environ["ADVERTISED_ENDPOINT"]
    deployment_mode = os.environ.get("DEPLOYMENT_MODE", "immutable")
    artifact_digest = os.environ["ARTIFACT_DIGEST"]

    schemas = {"input": _INPUT_SCHEMA, "output": _OUTPUT_SCHEMA, "config": _CONFIG_SCHEMA}
    body = {
        "metadata": metadata,
        "schemas": schemas,
        "contractHash": _contract_hash(schemas),
        "artifactDigest": artifact_digest,
        "endpoint": advertised_endpoint,
        "mode": deployment_mode,
    }

    url = f"{core_api_url.rstrip('/')}/v1/deployments"
    max_attempts = 20
    logger.debug("registering with core-api: url=%s body=%s", url, body)
    async with httpx.AsyncClient(timeout=30) as client:
        for attempt in range(1, max_attempts + 1):
            try:
                response = await client.post(url, json=body)
                if response.status_code < 300:
                    logger.info("whisper registered: %s", response.json())
                    return
                if response.status_code not in _RETRYABLE_STATUS:
                    logger.error(
                        "registration refused (%s): %s", response.status_code, response.text
                    )
                    raise RuntimeError(
                        f"registration refused ({response.status_code}): {response.text}"
                    )
                last_error = f"{response.status_code}: {response.text}"
            except httpx.HTTPError as error:
                last_error = str(error)

            if attempt >= max_attempts:
                logger.error("gave up registering after %d attempts: %s", attempt, last_error)
                raise RuntimeError(f"gave up registering after {attempt} attempts: {last_error}")
            logger.warning(
                "registration attempt %d/%d failed: %s", attempt, max_attempts, last_error
            )
            await _sleep(min(1.0 * (2 ** (attempt - 1)), 5.0))


async def _sleep(seconds: float) -> None:
    import asyncio

    await asyncio.sleep(seconds)
