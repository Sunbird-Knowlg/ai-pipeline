import logging
import shutil

import fsspec

_ALLOWED_EXTERNAL_SCHEMES = ("http://", "https://")

# Bytes per chunk when streaming uploads/downloads — keeps memory flat
# regardless of source/artifact size (audio/video files can be large).
_COPY_BUFFER_SIZE = 1024 * 1024

logger = logging.getLogger(__name__)

_SCHEME_BY_STORAGE_TYPE = {
    "azure": "az",
    "aws": "s3",
    "gcp": "gs",
}


def _build_storage_options(storage_type: str, auth_type: str, config: dict) -> dict:
    """Generates the filesystem-specific storage options dictionary for fsspec backends.

    Args:
        storage_type: Cloud provider type ('azure', 'aws', 'gcp').
        auth_type: Authorization pattern, valid values depend on storage_type —
            azure: 'ACCESS_KEY', 'OIDC', 'IAM', 'DEV'; aws: 'ACCESS_KEY', 'IAM';
            gcp: 'SERVICE_ACCOUNT', 'OIDC'.
        config: Dictionary containing credentials/keys.

    Returns:
        A dictionary of backend configurations for fsspec filesystem establishment.

    Raises:
        ValueError: If the storage type is unsupported, or auth_type isn't one
            of the values valid for that storage_type — e.g. a typo like
            cloud_storage_auth_type: OIDC on an AWS deployment (meaning IAM
            auth) fails fast here instead of silently building credentials
            with a None key/secret.
    """
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
        if auth_type == "ACCESS_KEY":
            return {"key": config["access_key"], "secret": config["secret_key"]}
        if auth_type == "IAM":
            # No explicit credentials — s3fs falls back to boto3's default
            # credential chain (instance profile / IRSA).
            return {}
        raise ValueError(f"Unsupported AWS auth_type: {auth_type}")

    if storage_type == "gcp":
        if auth_type == "SERVICE_ACCOUNT":
            return {"token": config["service_account_json_path"]}
        if auth_type == "OIDC":
            # No explicit credentials — gcsfs falls back to Application
            # Default Credentials (workload identity).
            return {}
        raise ValueError(f"Unsupported GCP auth_type: {auth_type}")

    raise ValueError(f"Unsupported cloud_storage_type: {storage_type}")


class BlobStorageUtil:
    """fsspec-based multi-cloud blob abstraction wrapper.

    This utility constructs fsspec filesystem URLs and builds credential configurations 
    dynamically, hiding cloud-specific package dependencies (like adlfs, s3fs, or gcsfs) 
    behind standard file read/write methods.
    """

    def __init__(
        self,
        cloud_storage_type: str,
        cloud_storage_auth_type: str,
        container: str,
        auth_config: dict,
        public_endpoint: str = "",
    ):
        """Initializes the multi-cloud blob storage utility.

        Args:
            cloud_storage_type: Cloud provider type ('azure', 'aws', 'gcp').
            cloud_storage_auth_type: Authorization pattern — see
                _build_storage_options for the valid values per
                cloud_storage_type.
            container: The storage container or bucket name.
            auth_config: Dictionary containing authentication credentials.
            public_endpoint: Optional public domain proxy URL endpoint.
        """
        self._scheme = _SCHEME_BY_STORAGE_TYPE[cloud_storage_type]
        self._container = container
        self._public_endpoint = public_endpoint
        self._storage_options = _build_storage_options(
            cloud_storage_type, cloud_storage_auth_type, auth_config
        )

    def _uri(self, object_key: str) -> str:
        """Constructs the internal private URI for an object key.

        Args:
            object_key: The relative file path in the container.

        Returns:
            An internal protocol URI string (e.g., 'az://container/key').
        """
        return f"{self._scheme}://{self._container}/{object_key}"

    def _public_uri(self, object_key: str) -> str:
        """Constructs the public HTTPS URL for an object key.

        Args:
            object_key: The relative file path in the container.

        Returns:
            A public proxy HTTPS URL string.
        """
        return f"https://{self._public_endpoint}/{self._container}/{object_key}"

    def _own_prefixes(self) -> list[str]:
        """Generates URI prefixes that belong to the container managed by this instance.

        Returns:
            A list of matching private and public URI prefix strings.
        """
        prefixes = [f"{self._scheme}://{self._container}/"]
        if self._public_endpoint:
            prefixes.append(f"https://{self._public_endpoint}/{self._container}/")
        return prefixes

    def upload(self, local_path: str, object_key: str) -> None:
        """Uploads a local file to cloud storage, overwriting in place if it exists.

        Args:
            local_path: The filesystem path of the source file.
            object_key: The destination key path in the container.
        """
        logger.info("upload", extra={"object_key": object_key, "local_path": local_path})
        with open(local_path, "rb") as src:
            with fsspec.open(self._uri(object_key), "wb", **self._storage_options) as dst:
                shutil.copyfileobj(src, dst, length=_COPY_BUFFER_SIZE)

    def upload_bytes(self, data: bytes, object_key: str) -> None:
        """Uploads raw bytes to cloud storage, overwriting in place if it exists.

        Args:
            data: The raw binary data to write.
            object_key: The destination key path in the container.
        """
        logger.info("upload_bytes", extra={"object_key": object_key, "size_bytes": len(data)})
        with fsspec.open(self._uri(object_key), "wb", **self._storage_options) as dst:
            dst.write(data)

    def download(self, object_key: str, local_path: str) -> None:
        """Downloads a cloud object to a local file path.

        Args:
            object_key: The relative path of the cloud object.
            local_path: The target destination path on the local filesystem.
        """
        logger.info("download", extra={"object_key": object_key, "local_path": local_path})
        with fsspec.open(self._uri(object_key), "rb", **self._storage_options) as src:
            with open(local_path, "wb") as dst:
                shutil.copyfileobj(src, dst, length=_COPY_BUFFER_SIZE)

    def download_from_uri(self, uri: str, local_path: str) -> None:
        """Downloads a file to a local path by parsing its full URI.

        This method automatically detects if the URI belongs to its own container
        (in which case it uses authenticated credentials) or if it is an arbitrary
        public HTTPS URL (in which case it downloads it anonymously). Any other
        scheme (e.g. a bare local path, or file://) is rejected — uri commonly
        comes from event/content metadata, so treating it as trusted enough to
        resolve to an arbitrary local file or internal-network URL isn't safe.

        Args:
            uri: The full URL or internal URI to download from.
            local_path: The target destination path on the local filesystem.

        Raises:
            ValueError: If uri isn't this container's own URI and doesn't use
                an allowed external scheme (http/https).
        """
        for prefix in self._own_prefixes():
            if uri.startswith(prefix):
                self.download(uri[len(prefix):], local_path)
                return
        if not uri.startswith(_ALLOWED_EXTERNAL_SCHEMES):
            raise ValueError(f"Refusing to download from disallowed scheme: {uri!r}")
        logger.info("download_from_uri: external URL", extra={"uri": uri, "local_path": local_path})
        with fsspec.open(uri, "rb") as src, open(local_path, "wb") as dst:
            shutil.copyfileobj(src, dst, length=_COPY_BUFFER_SIZE)

    def object_key_from_uri(self, uri: str) -> str:
        """Extracts the relative object key from a full URI if it belongs to this container.

        Args:
            uri: The full URL or internal URI.

        Returns:
            The relative key path if matching this container, otherwise the original URI.
        """
        for prefix in self._own_prefixes():
            if uri.startswith(prefix):
                return uri[len(prefix):]
        return uri

    def get_uri(self, object_key: str) -> str:
        """Retrieves the preferred external reference URI for an object key.

        Prefers returning a public HTTPS proxy URL if a public endpoint is 
        configured; otherwise, returns the internal protocol URI (e.g., 'az://...').

        Args:
            object_key: The relative file path in the container.

        Returns:
            A public HTTPS URL or an internal protocol URI string.
        """
        if self._public_endpoint:
            return self._public_uri(object_key)
        return self._uri(object_key)
