import json
import time
import uuid
from dataclasses import asdict, dataclass, field, fields
from typing import Any

# Standard BE_JOB_REQUEST envelope used platform-wide for job-to-job Kafka
# events (see e.g. VideoEnrichmentHelper.getStreamingEvent in
# knowledge-platform-jobs, TranscriptManager.pushEnrichedMetadataApprovedEvent
# in knowledge-platform) — eid/ets/mid/actor/context/object wrap an
# action-specific edata payload, rather than each job inventing its own flat
# shape.
_PDATA_ID = "org.ekstep.platform"
_PDATA_VER = "1.0"


def _known_fields_only(cls, payload: dict[str, Any]) -> dict[str, Any]:
    """Drops any payload key that isn't a declared field of cls.

    Keeps from_json forward-compatible: a producer adding a new field to
    the event doesn't break every consumer still on the old dataclass shape.
    """
    known = {f.name for f in fields(cls)}
    return {k: v for k, v in payload.items() if k in known}


def _wrap_be_job_request(
    actor_id: str, action: str, object_id: str, edata: dict[str, Any], channel: str = "", env: str = ""
) -> str:
    """Wraps an action-specific payload in the standard BE_JOB_REQUEST envelope."""
    ets = int(time.time() * 1000)
    envelope = {
        "eid": "BE_JOB_REQUEST",
        "ets": ets,
        "mid": f"LP.{ets}.{uuid.uuid4()}",
        "actor": {"id": actor_id, "type": "System"},
        "context": {"pdata": {"ver": _PDATA_VER, "id": _PDATA_ID}, "channel": channel, "env": env},
        "object": {"ver": "1.0", "id": object_id},
        "edata": {"action": action, **edata},
    }
    return json.dumps(envelope, default=str)


def _unwrap_be_job_request(raw: str) -> dict[str, Any]:
    """Extracts the edata payload (plus context.channel) from a BE_JOB_REQUEST envelope."""
    payload = json.loads(raw)
    edata = dict(payload.get("edata", {}))
    edata["channel"] = payload.get("context", {}).get("channel", "")
    return edata


@dataclass
class EnrichedMetadataEvent:
    """Represents a content metadata event on the enriched.metadata topic.

    This event format covers both content-published and transcript-approved
    events, which are differentiated by their contentType.

    Attributes:
        id: The unique identifier for the content.
        contentType: The type of content (e.g., 'Video', 'Audio').
        action: The action that triggered this event (e.g., 'publish').
        data: Additional dictionary payload containing updated metadata fields.
    """

    id: str
    contentType: str
    action: str
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_json(cls, raw: str) -> "EnrichedMetadataEvent":
        """Deserializes a raw JSON string into an EnrichedMetadataEvent instance.

        Accepts both the standard BE_JOB_REQUEST envelope (object.id/edata.action/
        edata.contentType, the rest of edata as data) and the older flat shape
        (id/contentType/action/data directly) — producers migrate independently,
        so both must keep working during a rolling deploy.

        Args:
            raw: The raw JSON string containing the event payload.

        Returns:
            An instance of EnrichedMetadataEvent.
        """
        payload = json.loads(raw)
        edata = payload.get("edata")
        if edata is None:
            return cls(
                id=payload["id"],
                contentType=payload["contentType"],
                action=payload.get("action", ""),
                data=payload.get("data", {}),
            )
        data = {k: v for k, v in edata.items() if k not in ("action", "contentType")}
        data["channel"] = payload.get("context", {}).get("channel", "")
        return cls(
            id=payload.get("object", {}).get("id", ""),
            contentType=edata.get("contentType", ""),
            action=edata.get("action", ""),
            data=data,
        )

    def to_json(self) -> str:
        """Serializes the EnrichedMetadataEvent instance to the standard envelope.

        Returns:
            A JSON-serialized BE_JOB_REQUEST envelope string.
        """
        data = {k: v for k, v in self.data.items() if k != "channel"}
        return _wrap_be_job_request(
            actor_id="knowlg-service",
            action=self.action,
            object_id=self.id,
            edata={"contentType": self.contentType, **data},
            channel=self.data.get("channel", ""),
        )


@dataclass
class MediaTranscriptionRequest:
    """Represents a request payload for transcribing audio/video media files.

    Attributes:
        contentId: Unique identifier of the content.
        enrichmentId: Identifier referencing the database enrichment entry.
        transcriptId: Unique identifier representing the specific transcript.
        artifactUrl: Public or cloud URL pointing to the raw media artifact file.
        mimeType: The media MIME type (e.g., 'video/mp4', 'audio/mpeg').
        channel: The owning channel of the content, carried in the envelope's
            context.channel rather than edata (set at construction time,
            round-trips through to_json/from_json like any other field).
    """
    contentId: str
    enrichmentId: str
    transcriptId: str
    artifactUrl: str
    mimeType: str
    channel: str = ""

    @classmethod
    def from_json(cls, raw: str) -> "MediaTranscriptionRequest":
        """Deserializes a BE_JOB_REQUEST envelope into a MediaTranscriptionRequest.

        Args:
            raw: The raw JSON string containing the transcription request envelope.

        Returns:
            An instance of MediaTranscriptionRequest.
        """
        return cls(**_known_fields_only(cls, _unwrap_be_job_request(raw)))

    def to_json(self, env: str = "") -> str:
        """Serializes the MediaTranscriptionRequest instance to a BE_JOB_REQUEST envelope.

        Args:
            env: The producing job's deployment environment, for context.env.

        Returns:
            A JSON-serialized BE_JOB_REQUEST envelope string.
        """
        edata = {k: v for k, v in asdict(self).items() if k != "channel"}
        return _wrap_be_job_request(
            actor_id="enrichment-router",
            action="media-transcription-request",
            object_id=self.contentId,
            edata=edata,
            channel=self.channel,
            env=env,
        )


@dataclass
class MediaMultilingualRequest:
    """Represents a request payload for translating transcriptions to target languages.

    Attributes:
        contentId: Unique identifier of the content.
        enrichmentId: Identifier referencing the database enrichment entry.
        sourceLanguage: The ISO language code of the source transcript.
        sourceTranscriptUrl: URL pointing to the source language transcript.
        targetLanguages: A list of target ISO language codes to translate into.
        channel: The owning channel of the content, carried in the envelope's
            context.channel rather than edata (set at construction time,
            round-trips through to_json/from_json like any other field).
    """
    contentId: str
    enrichmentId: str
    sourceLanguage: str
    sourceTranscriptUrl: str
    targetLanguages: list[str]
    channel: str = ""

    @classmethod
    def from_json(cls, raw: str) -> "MediaMultilingualRequest":
        """Deserializes a BE_JOB_REQUEST envelope into a MediaMultilingualRequest.

        Args:
            raw: The raw JSON string containing the translation request envelope.

        Returns:
            An instance of MediaMultilingualRequest.
        """
        return cls(**_known_fields_only(cls, _unwrap_be_job_request(raw)))

    def to_json(self, env: str = "") -> str:
        """Serializes the MediaMultilingualRequest instance to a BE_JOB_REQUEST envelope.

        Args:
            env: The producing job's deployment environment, for context.env.

        Returns:
            A JSON-serialized BE_JOB_REQUEST envelope string.
        """
        edata = {k: v for k, v in asdict(self).items() if k != "channel"}
        return _wrap_be_job_request(
            actor_id="enrichment-router",
            action="media-multilingual-request",
            object_id=self.contentId,
            edata=edata,
            channel=self.channel,
            env=env,
        )


@dataclass
class DlqEnvelope:
    """Represents the packaging envelope for events routed to the Dead Letter Queue (DLQ).

    When a Flink job fails to process an event, it wraps the input event and
    the failure reason inside this envelope before writing it to the DLQ topic.

    Attributes:
        originalEvent: The raw event dictionary that failed processing.
        errorMessage: The exception message details that caused the job to fail.
        jobName: The name of the Flink job where the failure occurred.
    """
    originalEvent: dict[str, Any]
    errorMessage: str
    jobName: str

    def to_json(self) -> str:
        """Serializes the DlqEnvelope instance to a JSON string.

        Uses default=str so a non-JSON-native value anywhere in the original
        event (this is the failure-capture path — it must not itself fail).

        Returns:
            A JSON-serialized string representation of the DLQ envelope.
        """
        return json.dumps(asdict(self), default=str)
