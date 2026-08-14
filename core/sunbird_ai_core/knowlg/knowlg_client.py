import logging
from typing import Any
from urllib.parse import quote

import requests

logger = logging.getLogger(__name__)

# Every job that patches an Enrichment child object (Transcript today) hits
# this same path - not deployment-specific, so it's fixed here instead of
# duplicated across every job's config.yaml/values.yaml.
_HARDCODED_APIS = {
    "object_update": "/content/v4/enrichment/object/update/{identifier}/{objectIdentifier}",
}


class KnowlgClient:
    """Config-driven HTTP client for communicating with the Knowlg platform.

    This client decouples application code from hardcoded endpoint paths by
    resolving URLs dynamically from a routing configuration dictionary.

    Attributes:
        _base_url (str): The normalized target base URL of the Knowlg Content Service.
        _api_key (str): Optional bearer authorization token for secure gateways.
        _apis (dict[str, str]): Routing table mapping API keys to path templates,
            merged with `_HARDCODED_APIS` (which always wins on key collision).
    """

    def __init__(self, content_service_url: str, apis: dict[str, str], api_key: str = ""):
        """Initializes the Knowlg client settings.

        Args:
            content_service_url: Base service endpoint URL.
            apis: A routing table dictionary mapping API keys to path templates.
            api_key: Optional authorization token for API gateway authentication.
        """
        self._base_url = content_service_url.rstrip("/")
        self._api_key = api_key
        self._apis = {**apis, **_HARDCODED_APIS}

    def _headers(self) -> dict[str, str]:
        """Constructs standard request headers, appending authorization if available.

        Returns:
            A dictionary containing Content-Type and optional Authorization headers.
        """
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    def _resolve_path(self, api_key: str, **path_params: str) -> str:
        """Resolves and formats the path template associated with an API key.

        Path parameter values are URL-encoded before substitution, so an
        identifier containing e.g. '/' or '..' can't alter the resolved path.

        Args:
            api_key: The routing key (e.g., 'content_read').
            **path_params: Keyword arguments to substitute in path templates.

        Returns:
            The resolved and formatted path string.

        Raises:
            KeyError: If the provided api_key is not in the routing table.
        """
        if api_key not in self._apis:
            raise KeyError(f"Unknown knowlg API key: {api_key}")
        path = self._apis[api_key]
        if not path_params:
            return path
        return path.format(**{k: quote(str(v), safe="") for k, v in path_params.items()})

    def post(self, api_key: str, payload: dict[str, Any], **path_params: str) -> dict[str, Any]:
        """Executes a JSON POST request to a resolved Knowlg endpoint.

        Args:
            api_key: The routing key mapping to the target path template.
            payload: Dictionary of object fields (e.g. objectType, status) —
                wrapped as {"request": {"object": payload}} before sending,
                matching every knowlg v4 controller's requestBody()/"object"
                envelope convention. Callers pass the bare object fields.
            **path_params: Keyword arguments to substitute in the path
                template (e.g. identifier=content_id), same as get().

        Returns:
            The parsed JSON response dictionary.

        Raises:
            requests.exceptions.RequestException: If the request fails
                (HTTP error status, connection error, or timeout).
            ValueError: If the response body is not valid JSON.
        """
        path = self._resolve_path(api_key, **path_params)
        url = f"{self._base_url}{path}"
        logger.info("POST %s", url, extra={"api_key": api_key})
        try:
            response = requests.post(
                url, json={"request": {"object": payload}}, headers=self._headers(), timeout=30
            )
            response.raise_for_status()
        except requests.exceptions.RequestException:
            logger.exception("knowlg POST failed", extra={"api_key": api_key, "url": url})
            raise
        try:
            return response.json()
        except ValueError:
            logger.exception("knowlg POST returned non-JSON body", extra={"api_key": api_key, "url": url})
            raise

    def get(self, api_key: str, **path_params: str) -> dict[str, Any]:
        """Executes a GET request to a resolved Knowlg endpoint.

        Args:
            api_key: The routing key mapping to the target path template.
            **path_params: Keyword arguments to substitute in the path
                template (e.g. identifier=content_id), same as post().

        Returns:
            The parsed JSON response dictionary.

        Raises:
            requests.exceptions.RequestException: If the request fails
                (HTTP error status, connection error, or timeout).
            ValueError: If the response body is not valid JSON.
        """
        path = self._resolve_path(api_key, **path_params)
        url = f"{self._base_url}{path}"
        logger.info("GET %s", url, extra={"api_key": api_key})
        try:
            response = requests.get(url, headers=self._headers(), timeout=30)
            response.raise_for_status()
        except requests.exceptions.RequestException:
            logger.exception("knowlg GET failed", extra={"api_key": api_key, "url": url})
            raise
        try:
            return response.json()
        except ValueError:
            logger.exception("knowlg GET returned non-JSON body", extra={"api_key": api_key, "url": url})
            raise

    def patch(self, api_key: str, payload: dict[str, Any], **path_params: str) -> dict[str, Any]:
        """Executes a JSON PATCH request to a resolved Knowlg endpoint.

        Args:
            api_key: The routing key mapping to the target path template.
            payload: Dictionary of object fields (e.g. objectType, status) —
                wrapped as {"request": {"object": payload}} before sending,
                same convention as post().
            **path_params: Keyword arguments to substitute in the path
                template (e.g. identifier=content_id, objectIdentifier=transcript_id),
                same as post().

        Returns:
            The parsed JSON response dictionary.

        Raises:
            requests.exceptions.RequestException: If the request fails
                (HTTP error status, connection error, or timeout).
            ValueError: If the response body is not valid JSON.
        """
        path = self._resolve_path(api_key, **path_params)
        url = f"{self._base_url}{path}"
        logger.info("PATCH %s", url, extra={"api_key": api_key})
        try:
            response = requests.patch(
                url, json={"request": {"object": payload}}, headers=self._headers(), timeout=30
            )
            response.raise_for_status()
        except requests.exceptions.RequestException:
            logger.exception("knowlg PATCH failed", extra={"api_key": api_key, "url": url})
            raise
        try:
            return response.json()
        except ValueError:
            logger.exception("knowlg PATCH returned non-JSON body", extra={"api_key": api_key, "url": url})
            raise
