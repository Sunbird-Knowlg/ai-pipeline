import json
from dataclasses import asdict, dataclass, field
from typing import Any


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

        Args:
            raw: The raw JSON string containing the event payload.

        Returns:
            An instance of EnrichedMetadataEvent.
        """
        payload = json.loads(raw)
        return cls(
            id=payload["id"],
            contentType=payload["contentType"],
            action=payload.get("action", ""),
            data=payload.get("data", {}),
        )

    def to_json(self) -> str:
        """Serializes the EnrichedMetadataEvent instance to a JSON string.

        Returns:
            A JSON-serialized string representation of the event.
        """
        return json.dumps(asdict(self))


@dataclass
class MediaTranscriptionRequest:
    """Represents a request payload for transcribing audio/video media files.

    Attributes:
        contentId: Unique identifier of the content.
        enrichmentId: Identifier referencing the database enrichment entry.
        transcriptId: Unique identifier representing the specific transcript.
        artifactUrl: Public or cloud URL pointing to the raw media artifact file.
        mimeType: The media MIME type (e.g., 'video/mp4', 'audio/mpeg').
    """
    contentId: str
    enrichmentId: str
    transcriptId: str
    artifactUrl: str
    mimeType: str

    @classmethod
    def from_json(cls, raw: str) -> "MediaTranscriptionRequest":
        """Deserializes a raw JSON string into a MediaTranscriptionRequest instance.

        Args:
            raw: The raw JSON string containing the transcription request.

        Returns:
            An instance of MediaTranscriptionRequest.
        """
        return cls(**json.loads(raw))

    def to_json(self) -> str:
        """Serializes the MediaTranscriptionRequest instance to a JSON string.

        Returns:
            A JSON-serialized string representation of the request.
        """
        return json.dumps(asdict(self))


@dataclass
class MediaMultilingualRequest:
    """Represents a request payload for translating transcriptions to target languages.

    Attributes:
        contentId: Unique identifier of the content.
        enrichmentId: Identifier referencing the database enrichment entry.
        sourceLanguage: The ISO language code of the source transcript.
        sourceTranscriptUrl: URL pointing to the source language transcript.
        targetLanguages: A list of target ISO language codes to translate into.
    """
    contentId: str
    enrichmentId: str
    sourceLanguage: str
    sourceTranscriptUrl: str
    targetLanguages: list[str]

    @classmethod
    def from_json(cls, raw: str) -> "MediaMultilingualRequest":
        """Deserializes a raw JSON string into a MediaMultilingualRequest instance.

        Args:
            raw: The raw JSON string containing the translation request.

        Returns:
            An instance of MediaMultilingualRequest.
        """
        return cls(**json.loads(raw))

    def to_json(self) -> str:
        """Serializes the MediaMultilingualRequest instance to a JSON string.

        Returns:
            A JSON-serialized string representation of the request.
        """
        return json.dumps(asdict(self))


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

        Returns:
            A JSON-serialized string representation of the DLQ envelope.
        """
        return json.dumps(asdict(self))
