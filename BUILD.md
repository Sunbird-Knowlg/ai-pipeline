# Build & Run Guide — for beginners

This walks through everything needed to get `ai-pipeline` running locally: environment setup, installing the two jobs, running tests, spinning up the local dev stack, building Docker images, and packaging for real Flink deployment. Written assuming you've never touched this repo before.

If you're new to Python itself (not just this repo), read `core/docs/00_python_foundations.md` first — this guide assumes you know what a venv/pip/pytest are, just not this specific project's setup.

---

## 1. Prerequisites

- **Python 3.11** — managed via `pyenv` (not the macOS system Python, not a one-off Homebrew install). If you don't have pyenv yet:
  ```bash
  brew install pyenv
  ```
  Then wire it into your shell — add to `~/.zshrc`:
  ```bash
  export PYENV_ROOT="$HOME/.pyenv"
  [[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"
  eval "$(pyenv init -)"
  ```
  ```bash
  source ~/.zshrc
  pyenv install 3.11.15
  pyenv global 3.11.15   # or `pyenv local 3.11.15` from inside this repo, to scope it to just this project
  ```
  Verify: `pyenv which python3` should point into `~/.pyenv/versions/3.11.15/...`, not `/usr/bin/python3` or a Homebrew path.
- **Docker** (with `docker-compose`) — for the local dev stack and for building job images.
- **ffmpeg** — only needed if you'll run `jobs/caption_generator/scripts/transcribe_local.py` outside a container. Check with `which ffmpeg`; install via `brew install ffmpeg` if missing.
- **Java 11** — PyFlink itself is a thin Python wrapper around the real Java Flink engine (via a bridge called Py4J/pemja), so a JVM must be present. `java -version` should show 11+; if not, `brew install openjdk@11`.

---

## 2. Clone and create a virtual environment

```bash
git clone <repo-url> ai-pipeline
cd ai-pipeline
python3 -m venv .venv       # uses the pyenv-managed 3.11 from step 1
source .venv/bin/activate
pip install --upgrade pip
```

**Why a venv:** every Python project should get its own isolated copy of installed packages — otherwise this project's exact dependency versions (PyFlink 1.20, specific `faster-whisper`/`litellm` versions) could conflict with some other Python project on your machine. `source .venv/bin/activate` makes your shell's `python`/`pip` point at this isolated copy until you close the terminal or run `deactivate`.

---

## 3. Install the packages

```bash
make install
```

This runs `pip install -e core/` then `pip install -e jobs/enrichment_router/ -e jobs/caption_generator/` (see the `Makefile` if you want the raw commands). The `-e` (editable) flag means Python imports the actual source files in place — editing a `.py` file takes effect immediately, no reinstall needed.

Uses `apache-flink==1.20.5`, which ships a real prebuilt `cp311` wheel — installs cleanly on Python 3.11, no manual overrides needed (unlike the old `1.18.1` pin this repo used to carry, whose PyPI package was source-only and hard-pinned an incompatible `pemja`/`numpy` combo).

**A pip warning you may see and can ignore:** `apache-beam` (a PyFlink dependency) pins `protobuf<4.24`, which downgrades protobuf below what a few `google-cloud-*` packages (pulled in transitively by `gcsfs`) declare wanting. pip prints a dependency-conflict warning about this but still installs successfully — confirmed (real import + usage test, not just `pip install` succeeding) that `gcsfs`/`google.cloud.storage` work fine on the downgraded version. Forcing protobuf back up via a constraints file was tried and made things worse — `apache-beam` itself hard-requires `<4.24`, so pinning higher makes pip's resolver walk back through older, source-only `apache-beam` releases and fail to build. Leave it as-is unless something concrete actually breaks.

---

## 4. Run the tests

```bash
make test              # unit tests only (fast, no external services needed)
make test-integration  # needs the local dev stack running (step 6) — real JanusGraph/Kafka/Azurite
```

Under the hood this runs `pytest` across all three modules (`core/tests`, `jobs/enrichment_router/tests`, `jobs/caption_generator/tests`). If everything's installed correctly, `make test` should show something like `61 passed`.

Also worth running before you consider any change "done":
```bash
make lint   # ruff (style/correctness) + mypy (type checking)
```

---

## 5. Try the standalone transcription script (no Flink needed)

The fastest way to see the actual transcription pipeline work, without any Kafka/JanusGraph/Docker setup at all:

```bash
python jobs/caption_generator/scripts/transcribe_local.py path/to/video.mp4 --output-dir out/
```

Produces `out/transcript.json` and `out/captions.vtt`. Add `--model tiny` for a much faster (lower-quality) test run instead of the production `large-v3-turbo` model — useful while iterating. Add `--word-level-vtt` to also get word-level and karaoke-style caption previews.

---

## 6. Local dev stack (JanusGraph, Kafka, Azurite, Flink)

```bash
make dev-up     # docker-compose up -d — starts everything in docker/docker-compose.yml
make dev-down   # tear it down
```

This starts: Cassandra + JanusGraph (graph database), Redpanda (a lightweight Kafka-compatible broker), Azurite (a local Azure Blob Storage emulator — so you don't need a real cloud account), and a Flink JobManager + TaskManager (`flink:1.20.5-scala_2.12-java11`). This is what `make test-integration` and any real end-to-end local testing of the two jobs actually needs.

---

## 7. Build the Docker images

Each job has its own Dockerfile (`docker/Dockerfile.enrichment-router`, `docker/Dockerfile.caption-generator`) — different images because `caption-generator` needs `ffmpeg` and heavier ML dependencies (`faster-whisper`, `litellm`) that `enrichment-router` doesn't.

**Important:** build from the **repo root**, not from inside `docker/` — the Dockerfiles `COPY core/ ...` and `COPY jobs/<name>/ ...`, and those paths are resolved relative to wherever you point Docker's build context (the final `.` in the command below), not relative to the Dockerfile's own location.

```bash
docker build -f docker/Dockerfile.enrichment-router -t enrichment-router:local .
docker build -f docker/Dockerfile.caption-generator -t caption-generator:local .
```

Both images are based on `flink:1.20.5-scala_2.12-java11`, install Python 3.11 + this repo's packages inside the image, and set an `ENTRYPOINT` that runs `flink run -py <job>/main.py --config config.yaml` automatically when the container starts — so running the container **is** submitting the job, no extra step needed once it's deployed somewhere with access to real Kafka/JanusGraph/blob storage.

Verify a build actually succeeded (don't trust a truncated log tail):
```bash
docker images | grep -E "enrichment-router|caption-generator"
```

Real Helm charts for actually deploying these images to a Kubernetes cluster live in the separate `sunbird-spark-installer` repo (`helmcharts/knowledgebb/charts/py-flink`), not in this repo — `deploy/` here only has Helm chart *values* skeletons.

---

## 8. Package a job for real Flink deployment (zip artifact)

If you're submitting to an actual Flink cluster (not via the Docker image above) — PyFlink jobs don't package as a single fat JAR the way Java/Scala Flink jobs do. Instead:

```bash
make package-enrichment-router    # -> artifacts/enrichment-router.zip
make package-caption-generator    # -> artifacts/caption-generator.zip
```

This installs `core/` and the job's own package into a flat directory (`dist/<job-name>/`) and zips it. That zip gets distributed to every Flink TaskManager and added to Python's import path — see `Makefile` for the exact `pip install -t ...` + `zip` commands.

```bash
make submit-router    # flink run -py ... -pyfs artifacts/enrichment-router.zip --config ...
make submit-capgen
```

These assume a Flink cluster is already reachable (e.g. the one `make dev-up` started) and `flink` is on your `PATH` (comes with a real Flink installation, not just the Docker image).

---

## 9. Configuration — how jobs actually get their settings

Each job reads its own `config.yaml` (`jobs/enrichment_router/config.yaml`, `jobs/caption_generator/config.yaml`). Any value in there can be overridden by an environment variable named `SUNBIRD_AI_<DOTTED_KEY_UPPERCASED>` — e.g. `kafka.brokers` is overridden by setting `SUNBIRD_AI_KAFKA_BROKERS`. Env vars always win over the YAML file. See `core/docs/01_config.md` for the exact mechanism and a documented gotcha (the `${VAR}` syntax visible in the YAML files is *not* auto-substituted the way it looks — it's just a naming hint, the real override is the `SUNBIRD_AI_` env var).

Secrets (API keys) are never put in `config.yaml` — they're only ever supplied via environment variables at deploy time.

---

## Quick reference — everything, start to finish

```bash
# one-time machine setup
brew install pyenv
# add pyenv init block to ~/.zshrc, then:
source ~/.zshrc
pyenv install 3.11.15
pyenv global 3.11.15        # or `pyenv local 3.11.15` inside this repo only
brew install docker ffmpeg openjdk@11   # if not already present

# per-clone setup
git clone <repo-url> ai-pipeline
cd ai-pipeline
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
make install                # install core + both jobs (editable)

# day-to-day
make test                   # unit tests
make test-integration        # integration tests (needs dev stack)
make lint                    # ruff + mypy
make dev-up / dev-down       # local JanusGraph/Kafka/Azurite/Flink stack
python jobs/caption_generator/scripts/transcribe_local.py <video> --output-dir out/

# docker images (from repo root)
docker build -f docker/Dockerfile.enrichment-router -t enrichment-router:local .
docker build -f docker/Dockerfile.caption-generator -t caption-generator:local .
docker images | grep -E "enrichment-router|caption-generator"   # verify it actually built

# real Flink cluster deployment
make package-<job-name>       # build zip artifact
make submit-router            # submit enrichment-router
make submit-capgen            # submit caption-generator
```
