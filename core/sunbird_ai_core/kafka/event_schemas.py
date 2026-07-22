import json
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class EnrichedMetadataEvent:
    """Covers both Content-published and Transcript-approved events on the
    enriched.metadata topic, discriminated by contentType.
    """

    id: str
    contentType: str
    action: str
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_json(cls, raw: str) -> "EnrichedMetadataEvent":
        payload = json.loads(raw)
        return cls(
            id=payload["id"],
            contentType=payload["contentType"],
            action=payload.get("action", ""),
            data=payload.get("data", {}),
        )

    def to_json(self) -> str:
        return json.dumps(asdict(self))


@dataclass
class MediaTranscriptionRequest:
    contentId: str
    enrichmentId: str
    transcriptId: str
    artifactUrl: str
    mimeType: str

    @classmethod
    def from_json(cls, raw: str) -> "MediaTranscriptionRequest":
        return cls(**json.loads(raw))

    def to_json(self) -> str:
        return json.dumps(asdict(self))


@dataclass
class MediaMultilingualRequest:
    contentId: str
    enrichmentId: str
    sourceLanguage: str
    sourceTranscriptUrl: str
    targetLanguages: list[str]

    @classmethod
    def from_json(cls, raw: str) -> "MediaMultilingualRequest":
        return cls(**json.loads(raw))

    def to_json(self) -> str:
        return json.dumps(asdict(self))


@dataclass
class DlqEnvelope:
    originalEvent: dict[str, Any]
    errorMessage: str
    jobName: str

    def to_json(self) -> str:
        return json.dumps(asdict(self))
