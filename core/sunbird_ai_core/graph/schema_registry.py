import json
import logging
from typing import Any

import jsonschema
import requests

logger = logging.getLogger(__name__)


class SchemaRegistry:
    """Fetches object type schema.json/config.json from blob storage at runtime
    and caches them for process lifetime — same pattern as DefinitionFactory /
    SchemaValidatorFactory in knowlg-service. No local/hardcoded schema copies.

    Attributes:
        _base_path (str): Base URL/path schema and config files are fetched from.
    """

    def __init__(self, base_path: str):
        """Initializes the registry with the blob storage base path.

        Args:
            base_path: The base URL/path under which `<object_type>/<version>/`
                schema and config files are stored.
        """
        self._base_path = base_path.rstrip("/")
        self._schema_cache: dict[str, dict[str, Any]] = {}
        self._config_cache: dict[str, dict[str, Any]] = {}

    def _cache_key(self, object_type: str, version: str) -> str:
        """Builds the in-memory cache key for an object type/version pair."""
        return f"{object_type}:{version}"

    def _fetch_json(self, object_type: str, version: str, filename: str) -> dict[str, Any]:
        """Fetches and parses one JSON file for an object type/version.

        Args:
            object_type: The functional object type identifier (e.g. 'Transcript').
            version: The schema version string.
            filename: The file to fetch ('schema.json' or 'config.json').

        Returns:
            The parsed JSON document.

        Raises:
            requests.exceptions.HTTPError: If the HTTP request returns an error status.
        """
        url = f"{self._base_path}/{object_type.lower()}/{version}/{filename}"
        logger.info("Fetching schema registry file", extra={"url": url})
        try:
            response = requests.get(url, timeout=10)
            response.raise_for_status()
        except requests.exceptions.HTTPError:
            logger.exception("Schema registry fetch failed", extra={"url": url})
            raise
        return json.loads(response.text)

    def get_schema(self, object_type: str, version: str = "1.0") -> dict[str, Any]:
        """Retrieves an object type's JSON Schema, caching it for process lifetime.

        Args:
            object_type: The functional object type identifier (e.g. 'Transcript').
            version: The schema version string.

        Returns:
            The parsed JSON Schema document.
        """
        key = self._cache_key(object_type, version)
        if key not in self._schema_cache:
            logger.debug("Schema cache miss", extra={"object_type": object_type, "version": version})
            self._schema_cache[key] = self._fetch_json(object_type, version, "schema.json")
        return self._schema_cache[key]

    def get_config(self, object_type: str, version: str = "1.0") -> dict[str, Any]:
        """Retrieves an object type's config.json, caching it for process lifetime.

        Args:
            object_type: The functional object type identifier (e.g. 'Transcript').
            version: The schema version string.

        Returns:
            The parsed config.json document.
        """
        key = self._cache_key(object_type, version)
        if key not in self._config_cache:
            logger.debug("Config cache miss", extra={"object_type": object_type, "version": version})
            self._config_cache[key] = self._fetch_json(object_type, version, "config.json")
        return self._config_cache[key]

    def get_relation_fields(self, object_type: str, version: str = "1.0") -> list[str]:
        """Retrieves the relationFields declared in an object type's config.json.

        Args:
            object_type: The functional object type identifier (e.g. 'Transcript').
            version: The schema version string.

        Returns:
            The declared relation field names, or a default fallback if unset.
        """
        config = self.get_config(object_type, version)
        return config.get("relationFields", ["description", "status"])

    def validate(self, object_type: str, payload: dict[str, Any], version: str = "1.0") -> None:
        """Validates a payload dictionary against an object type's JSON Schema.

        Args:
            object_type: The functional object type identifier (e.g. 'Transcript').
            payload: The dictionary to validate.
            version: The schema version string.

        Raises:
            jsonschema.ValidationError: If the payload does not conform to the schema.
        """
        schema = self.get_schema(object_type, version)
        try:
            jsonschema.validate(instance=payload, schema=schema)
        except jsonschema.ValidationError:
            logger.exception("Schema validation failed", extra={"object_type": object_type, "version": version})
            raise
