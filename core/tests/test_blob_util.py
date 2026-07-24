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
