from typing import Any

import requests


class KnowlgClient:
    """Config-driven HTTP client for calls into the knowlg platform.
    No hardcoded paths — every endpoint comes from config, keyed by name.
    Job code calls client.post("transcript_create", payload) unaware of the
    actual URL.
    """

    def __init__(self, content_service_url: str, apis: dict[str, str], api_key: str = ""):
        """api_key is optional — internal calls to the knowlg platform (same
        cluster/namespace) require no authentication. Only set this if a
        deployment ever puts an authenticating proxy in front of it.
        """
        self._base_url = content_service_url.rstrip("/")
        self._api_key = api_key
        self._apis = apis

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    def _resolve_path(self, api_key: str, **path_params: str) -> str:
        if api_key not in self._apis:
            raise KeyError(f"Unknown knowlg API key: {api_key}")
        path = self._apis[api_key]
        return path.format(**path_params) if path_params else path

    def post(self, api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
        path = self._resolve_path(api_key)
        response = requests.post(f"{self._base_url}{path}", json=payload, headers=self._headers(), timeout=30)
        response.raise_for_status()
        return response.json()

    def get(self, api_key: str, identifier: str) -> dict[str, Any]:
        path = self._resolve_path(api_key, identifier=identifier)
        response = requests.get(f"{self._base_url}{path}", headers=self._headers(), timeout=30)
        response.raise_for_status()
        return response.json()
