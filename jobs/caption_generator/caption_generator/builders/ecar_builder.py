import json
import logging
import os
import shutil
import tempfile

from sunbird_ai_core.storage.blob_util import BlobStorageUtil

logger = logging.getLogger(__name__)


def build_and_upload_ecar(
    content_id: str, enrichment: dict, transcripts: list[dict], storage: BlobStorageUtil
) -> str:
    """Builds a manifest + per-language captions.vtt zip, uploads it, returns
    the blob object key for Enrichment.transcriptUrl.
    """
    logger.info("Building ECAR", extra={"content_id": content_id, "transcript_count": len(transcripts)})
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
            logger.debug("Downloading captions for ECAR", extra={"content_id": content_id, "language_code": language_code})
            storage.download_from_uri(captions_url, local_vtt_path)

        ecar_path = os.path.join(tmp_dir, f"{content_id}_transcripts")
        zip_path = shutil.make_archive(ecar_path, "zip", root_dir=tmp_dir, base_dir=content_id)

        ecar_object_key = f"content/{content_id}/{content_id}_transcripts.ecar"
        storage.upload(zip_path, ecar_object_key)
        ecar_uri = storage.get_uri(ecar_object_key)
        logger.info("ECAR uploaded", extra={"content_id": content_id, "ecar_object_key": ecar_object_key})
        return ecar_uri
    except Exception:
        logger.exception("ECAR build failed", extra={"content_id": content_id})
        raise
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
