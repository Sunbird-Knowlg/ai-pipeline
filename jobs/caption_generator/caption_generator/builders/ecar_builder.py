import json
import os
import shutil
import tempfile

from sunbird_ai_core.storage.blob_util import BlobStorageUtil


def build_and_upload_ecar(
    content_id: str, enrichment: dict, transcripts: list[dict], storage: BlobStorageUtil
) -> str:
    """Builds a manifest + per-language captions.vtt zip, uploads it, returns
    the blob object key for Enrichment.transcriptUrl.
    """
    tmp_dir = tempfile.mkdtemp(prefix=f"{content_id}_ecar_")
    try:
        content_root = os.path.join(tmp_dir, content_id)
        os.makedirs(content_root, exist_ok=True)

        manifest = {"enrichment": enrichment, "transcripts": transcripts}
        with open(os.path.join(content_root, "manifest.json"), "w") as f:
            json.dump(manifest, f)

        for transcript in transcripts:
            captions_url = transcript.get("captionsUrl")
            if not captions_url:
                continue
            language_code = transcript["languageCode"]
            language_dir = os.path.join(content_root, "transcripts", language_code)
            os.makedirs(language_dir, exist_ok=True)
            local_vtt_path = os.path.join(language_dir, "captions.vtt")
            storage.download_from_uri(captions_url, local_vtt_path)

        ecar_path = os.path.join(tmp_dir, f"{content_id}_transcripts")
        zip_path = shutil.make_archive(ecar_path, "zip", root_dir=tmp_dir, base_dir=content_id)

        ecar_object_key = f"content/{content_id}/{content_id}_transcripts.ecar"
        storage.upload(zip_path, ecar_object_key)
        return storage.get_uri(ecar_object_key)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
