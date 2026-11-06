# Pinned to the digest python:3.11-slim resolved to at the time this was pinned, not just the
# tag -- the tag is mutable and gets republished; the digest is the actual bytes CI last verified.
FROM python:3.11-slim@sha256:65bd3d9f1d7fa268dd1909973ba7eb4bdf41f6dcf2cfbe76ba9528b170f3fd79

# No system ffmpeg: faster_whisper decodes via PyAV, whose manylinux wheel bundles its own FFmpeg
# shared libraries. An unused system ffmpeg only adds attack surface to a service that parses
# untrusted media.
WORKDIR /app
# requirements.txt is the pip-compile --generate-hashes output (source: requirements.in), so
# --require-hashes fails the build on anything not pinned to an exact, verified artifact --
# including transitive dependencies, which an unhashed requirements.txt leaves entirely unpinned.
COPY requirements.in requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
COPY main.py register.py metadata.json hypercorn-config.toml .

# The unit registers itself on boot and reports which artifact it is. The digest covers the
# source, which this image does not carry, so it is baked in here (CI passes it).
ARG ARTIFACT_DIGEST=
ENV ARTIFACT_DIGEST=${ARTIFACT_DIGEST}

# --create-home, not --no-create-home: the model weights are downloaded to $HOME/.cache/huggingface
# at import time (see main.py), which needs to be writable -- without a real home, every container
# start would try to redownload into a path it can't write to.
RUN useradd --system --create-home whisper && chown -R whisper:whisper /app
USER whisper

# Baked in at the pinned default size, so a pod does not need internet egress on every start and
# boots instantly from the image's own cache. An override of WHISPER_MODEL_SIZE at deploy time
# still falls back to downloading at runtime -- this only pre-warms the common case.
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"

EXPOSE 9080
CMD ["python", "-m", "hypercorn", "--config", "hypercorn-config.toml", "main:app"]
