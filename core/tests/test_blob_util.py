import io
from unittest.mock import patch

import pytest
from sunbird_ai_core.storage.blob_util import BlobStorageUtil, _build_storage_options


def test_access_key_auth_options():
    options = _build_storage_options("azure", "ACCESS_KEY", {"account_name": "acc", "account_key": "key"})
    assert options == {"account_name": "acc", "account_key": "key"}


def test_dev_auth_options():
    options = _build_storage_options("azure", "DEV", {})
    assert options == {"connection_string": "UseDevelopmentStorage=true"}


def test_unsupported_auth_type_raises():
    with pytest.raises(ValueError):
        _build_storage_options("azure", "BOGUS", {})


def test_unsupported_storage_type_raises():
    with pytest.raises(ValueError):
        _build_storage_options("bogus", "ACCESS_KEY", {})


def test_uri_construction():
    util = BlobStorageUtil(
        cloud_storage_type="azure",
        cloud_storage_auth_type="DEV",
        container="test-container",
        auth_config={},
    )
    assert util.get_uri("content/do_123/captions.vtt") == "az://test-container/content/do_123/captions.vtt"


def test_object_key_from_uri_strips_own_prefix():
    util = BlobStorageUtil(
        cloud_storage_type="azure",
        cloud_storage_auth_type="DEV",
        container="test-container",
        auth_config={},
    )
    key = util.object_key_from_uri("az://test-container/content/do_123/captions.vtt")
    assert key == "content/do_123/captions.vtt"


def test_object_key_from_uri_passes_through_external_url():
    util = BlobStorageUtil(
        cloud_storage_type="azure",
        cloud_storage_auth_type="DEV",
        container="test-container",
        auth_config={},
    )
    external = "https://other-account.blob.core.windows.net/other-container/video.mp4"
    assert util.object_key_from_uri(external) == external


def test_get_uri_returns_public_https_when_endpoint_configured():
    util = BlobStorageUtil(
        cloud_storage_type="azure",
        cloud_storage_auth_type="DEV",
        container="test-container",
        auth_config={},
        public_endpoint="myaccount.blob.core.windows.net",
    )
    assert util.get_uri("content/do_123/captions.vtt") == (
        "https://myaccount.blob.core.windows.net/test-container/content/do_123/captions.vtt"
    )


def test_object_key_from_uri_strips_own_public_https_prefix():
    util = BlobStorageUtil(
        cloud_storage_type="azure",
        cloud_storage_auth_type="DEV",
        container="test-container",
        auth_config={},
        public_endpoint="myaccount.blob.core.windows.net",
    )
    own_https = "https://myaccount.blob.core.windows.net/test-container/content/do_123/captions.vtt"
    assert util.object_key_from_uri(own_https) == "content/do_123/captions.vtt"


def _util():
    return BlobStorageUtil(
        cloud_storage_type="azure",
        cloud_storage_auth_type="DEV",
        container="test-container",
        auth_config={},
    )


@pytest.mark.parametrize(
    "uri", ["file:///etc/passwd", "/etc/passwd", "ftp://example.com/x", "../../etc/passwd"]
)
def test_download_from_uri_rejects_disallowed_scheme(uri, tmp_path):
    with pytest.raises(ValueError):
        _util().download_from_uri(uri, str(tmp_path / "out"))


def test_download_from_uri_allows_https(tmp_path):
    fake_remote = io.BytesIO(b"external file contents")
    fake_remote.__enter__ = lambda self: self
    fake_remote.__exit__ = lambda self, *a: None

    with patch("sunbird_ai_core.storage.blob_util.fsspec.open", return_value=fake_remote):
        local_path = tmp_path / "out.bin"
        _util().download_from_uri("https://other.example.com/video.mp4", str(local_path))

    assert local_path.read_bytes() == b"external file contents"


def test_upload_streams_full_file_contents(tmp_path):
    source = tmp_path / "source.bin"
    payload = b"x" * (2 * 1024 * 1024 + 17)  # larger than one copy chunk
    source.write_bytes(payload)

    fake_remote = io.BytesIO()
    fake_remote.__enter__ = lambda self: self
    fake_remote.__exit__ = lambda self, *a: None
    fake_remote.close = lambda: None

    with patch("sunbird_ai_core.storage.blob_util.fsspec.open", return_value=fake_remote):
        _util().upload(str(source), "content/do_123/video.mp4")

    assert fake_remote.getvalue() == payload
