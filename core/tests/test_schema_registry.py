import json
from unittest.mock import Mock, patch

import jsonschema
import pytest
from sunbird_ai_core.graph.schema_registry import SchemaRegistry

SAMPLE_SCHEMA = {
    "type": "object",
    "properties": {"name": {"type": "string"}},
    "required": ["name"],
}
SAMPLE_CONFIG = {"relationFields": ["status", "languageCode"]}


def _mock_response(payload):
    response = Mock()
    response.text = json.dumps(payload)
    response.raise_for_status = Mock()
    return response


@patch("sunbird_ai_core.graph.schema_registry.requests.get")
def test_fetches_schema_and_caches(mock_get):
    mock_get.return_value = _mock_response(SAMPLE_SCHEMA)
    registry = SchemaRegistry("https://blob.example.com/schemas/local")

    schema1 = registry.get_schema("Transcript", "1.0")
    schema2 = registry.get_schema("Transcript", "1.0")

    assert schema1 == SAMPLE_SCHEMA
    assert schema2 == SAMPLE_SCHEMA
    mock_get.assert_called_once_with(
        "https://blob.example.com/schemas/local/transcript/1.0/schema.json", timeout=10
    )


@patch("sunbird_ai_core.graph.schema_registry.requests.get")
def test_get_relation_fields_falls_back_when_absent(mock_get):
    mock_get.return_value = _mock_response({})
    registry = SchemaRegistry("https://blob.example.com/schemas/local")

    fields = registry.get_relation_fields("Content", "1.0")

    assert fields == ["description", "status"]


@patch("sunbird_ai_core.graph.schema_registry.requests.get")
def test_get_relation_fields_uses_config_value(mock_get):
    mock_get.return_value = _mock_response(SAMPLE_CONFIG)
    registry = SchemaRegistry("https://blob.example.com/schemas/local")

    fields = registry.get_relation_fields("Transcript", "1.0")

    assert fields == ["status", "languageCode"]


@patch("sunbird_ai_core.graph.schema_registry.requests.get")
def test_validate_raises_on_invalid_payload(mock_get):
    mock_get.return_value = _mock_response(SAMPLE_SCHEMA)
    registry = SchemaRegistry("https://blob.example.com/schemas/local")

    with pytest.raises(jsonschema.ValidationError):
        registry.validate("Transcript", {})


@patch("sunbird_ai_core.graph.schema_registry.requests.get")
def test_validate_passes_valid_payload(mock_get):
    mock_get.return_value = _mock_response(SAMPLE_SCHEMA)
    registry = SchemaRegistry("https://blob.example.com/schemas/local")

    registry.validate("Transcript", {"name": "English"})
