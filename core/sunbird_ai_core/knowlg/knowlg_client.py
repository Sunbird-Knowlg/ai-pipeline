from typing import Any

import requests


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
        return path.format(**path_params) if path_params else path

    def post(self, api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Executes a JSON POST request to a resolved Knowlg endpoint.

        Args:
            api_key: The routing key mapping to the target path template.
            payload: Dictionary containing the JSON request payload.

        Returns:
            The parsed JSON response dictionary.

        Raises:
            requests.exceptions.HTTPError: If the HTTP request returns an error status.
        """
        path = self._resolve_path(api_key)
        response = requests.post(f"{self._base_url}{path}", json=payload, headers=self._headers(), timeout=30)
        response.raise_for_status()
        return response.json()

    def get(self, api_key: str, identifier: str) -> dict[str, Any]:
        """Executes a GET request to a resolved endpoint, formatting the identifier path parameter.

        Args:
            api_key: The routing key mapping to the target path template.
            identifier: The unique entity identifier to embed in the path.

        Returns:
            The parsed JSON response dictionary.

        Raises:
            requests.exceptions.HTTPError: If the HTTP request returns an error status.
        """
        path = self._resolve_path(api_key, identifier=identifier)
        response = requests.get(f"{self._base_url}{path}", headers=self._headers(), timeout=30)
        response.raise_for_status()
        return response.json()
