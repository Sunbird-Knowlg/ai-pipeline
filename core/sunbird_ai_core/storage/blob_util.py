import fsspec

_SCHEME_BY_STORAGE_TYPE = {
    "azure": "az",
    "aws": "s3",
    "gcp": "gs",
}


def _build_storage_options(storage_type: str, auth_type: str, config: dict) -> dict:
    if storage_type == "azure":
        if auth_type == "ACCESS_KEY":
            return {"account_name": config["account_name"], "account_key": config["account_key"]}
        if auth_type == "OIDC":
            from azure.identity import DefaultAzureCredential

            return {"account_name": config["account_name"], "credential": DefaultAzureCredential()}
        if auth_type == "IAM":
            from azure.identity import ManagedIdentityCredential

            return {"account_name": config["account_name"], "credential": ManagedIdentityCredential()}
        if auth_type == "DEV":
            return {"connection_string": "UseDevelopmentStorage=true"}
        raise ValueError(f"Unsupported Azure auth_type: {auth_type}")

    if storage_type == "aws":
        return {"key": config.get("access_key"), "secret": config.get("secret_key")}

    if storage_type == "gcp":
        return {"token": config.get("service_account_json_path")}

    raise ValueError(f"Unsupported cloud_storage_type: {storage_type}")


class BlobStorageUtil:
    """fsspec-based multi-cloud blob abstraction. Builds the fsspec URL scheme
    and storage_options from config — job code never imports adlfs/s3fs/gcsfs
    directly. Auth type mapping matches the Java cloud-store-sdk (ACCESS_KEY,
    OIDC, IAM). Uploading to an existing key overwrites in place.
    """

    def __init__(
        self, cloud_storage_type: str, cloud_storage_auth_type: str, container: str, auth_config: dict
    ):
        self._scheme = _SCHEME_BY_STORAGE_TYPE[cloud_storage_type]
        self._container = container
        self._storage_options = _build_storage_options(
            cloud_storage_type, cloud_storage_auth_type, auth_config
        )

    def _uri(self, object_key: str) -> str:
        return f"{self._scheme}://{self._container}/{object_key}"

    def upload(self, local_path: str, object_key: str) -> None:
        with open(local_path, "rb") as src:
            with fsspec.open(self._uri(object_key), "wb", **self._storage_options) as dst:
                dst.write(src.read())

    def upload_bytes(self, data: bytes, object_key: str) -> None:
        with fsspec.open(self._uri(object_key), "wb", **self._storage_options) as dst:
            dst.write(data)

    def download(self, object_key: str, local_path: str) -> None:
        with fsspec.open(self._uri(object_key), "rb", **self._storage_options) as src:
            with open(local_path, "wb") as dst:
                dst.write(src.read())

    def download_from_uri(self, uri: str, local_path: str) -> None:
        """Downloads by full URI — our own az://<container>/<key> scheme
        (authenticated) or an arbitrary public HTTPS URL (unauthenticated,
        e.g. the artifactUrl stored on a Content node).
        """
        own_prefix = f"{self._scheme}://{self._container}/"
        if uri.startswith(own_prefix):
            self.download(uri[len(own_prefix):], local_path)
            return
        with fsspec.open(uri, "rb") as src, open(local_path, "wb") as dst:
            dst.write(src.read())

    def object_key_from_uri(self, uri: str) -> str:
        own_prefix = f"{self._scheme}://{self._container}/"
        if uri.startswith(own_prefix):
            return uri[len(own_prefix):]
        return uri

    def get_uri(self, object_key: str) -> str:
        return self._uri(object_key)
