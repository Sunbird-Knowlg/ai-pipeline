import json
import zipfile

from caption_generator.builders.ecar_builder import build_and_upload_ecar


def test_builds_manifest_and_uploads_ecar(mock_storage):
    captured = {}

    def _capture_upload(local_path, object_key):
        with open(local_path, "rb") as f:
            captured["zip_bytes"] = f.read()
        captured["object_key"] = object_key

    def _fake_download(uri, local_path):
        with open(local_path, "w") as f:
            f.write("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n")

    mock_storage.upload.side_effect = _capture_upload
    mock_storage.download_from_uri.side_effect = _fake_download

    enrichment = {"contentId": "do_123", "aiFeatures": ["transcript"]}
    transcripts = [
        {"languageCode": "en", "sourceLanguage": True, "captionsUrl": "az://c/en/captions.vtt"},
        {"languageCode": "hi", "sourceLanguage": False, "captionsUrl": "az://c/hi/captions.vtt"},
    ]

    result_uri = build_and_upload_ecar("do_123", enrichment, transcripts, mock_storage)

    assert captured["object_key"] == "content/do_123/do_123_transcripts.ecar"
    assert result_uri == "az://test-container/content/do_123/do_123_transcripts.ecar"

    import io

    with zipfile.ZipFile(io.BytesIO(captured["zip_bytes"])) as zf:
        names = zf.namelist()
        assert "do_123/manifest.json" in names
        assert "do_123/transcripts/en/captions.vtt" in names
        assert "do_123/transcripts/hi/captions.vtt" in names

        manifest = json.loads(zf.read("do_123/manifest.json"))
        assert manifest["enrichment"]["contentId"] == "do_123"
        assert len(manifest["transcripts"]) == 2


def test_skips_transcripts_without_captions_url(mock_storage):
    def _fake_download(uri, local_path):
        with open(local_path, "w") as f:
            f.write("WEBVTT\n")

    mock_storage.download_from_uri.side_effect = _fake_download

    transcripts = [
        {"languageCode": "en", "sourceLanguage": True, "captionsUrl": None},
    ]

    build_and_upload_ecar("do_123", {}, transcripts, mock_storage)

    mock_storage.download_from_uri.assert_not_called()
