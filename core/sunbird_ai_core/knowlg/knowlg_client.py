import logging
from typing import Any
from urllib.parse import quote

import requests

logger = logging.getLogger(__name__)


class KnowlgClient:
    """Config-driven HTTP client for communicating with the Knowlg platform.

    This client decouples application code from hardcoded endpoint paths by 
    resolving URLs dynamically from a routing configuration dictionary.

    Attributes:
        _base_url (str): The normalized target base URL of the Knowlg Content Service.
        _api_key (str): Optional bearer authorization token for secure gateways.
        _apis (dict[str, str]): Routing table mapping API keys to path templates.
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
        self._apis = apis

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

    def post(self, api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Executes a JSON POST request to a resolved Knowlg endpoint.

        Args:
            api_key: The routing key mapping to the target path template.
            payload: Dictionary containing the JSON request payload.

        Returns:
            The parsed JSON response dictionary.

        Raises:
            requests.exceptions.RequestException: If the request fails
                (HTTP error status, connection error, or timeout).
            ValueError: If the response body is not valid JSON.
        """
        path = self._resolve_path(api_key)
        url = f"{self._base_url}{path}"
        logger.info("POST %s", url, extra={"api_key": api_key})
        try:
            response = requests.post(url, json=payload, headers=self._headers(), timeout=30)
            response.raise_for_status()
        except requests.exceptions.RequestException:
            logger.exception("knowlg POST failed", extra={"api_key": api_key, "url": url})
            raise
        try:
            return response.json()
        except ValueError:
            logger.exception("knowlg POST returned non-JSON body", extra={"api_key": api_key, "url": url})
            raise

    def get(self, api_key: str, identifier: str) -> dict[str, Any]:
        """Executes a GET request to a resolved endpoint, formatting the identifier path parameter.

        Args:
            api_key: The routing key mapping to the target path template.
            identifier: The unique entity identifier to embed in the path.

        Returns:
            The parsed JSON response dictionary.

        Raises:
            requests.exceptions.RequestException: If the request fails
                (HTTP error status, connection error, or timeout).
            ValueError: If the response body is not valid JSON.
        """
        path = self._resolve_path(api_key, identifier=identifier)
        url = f"{self._base_url}{path}"
        logger.info("GET %s", url, extra={"api_key": api_key, "identifier": identifier})
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
