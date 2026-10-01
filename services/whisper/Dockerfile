FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py register.py metadata.json hypercorn-config.toml .

# The unit registers itself on boot and reports which artifact it is. The digest covers the
# source, which this image does not carry, so it is baked in here (CI passes it).
ARG ARTIFACT_DIGEST=
ENV ARTIFACT_DIGEST=${ARTIFACT_DIGEST}

EXPOSE 9080
CMD ["python", "-m", "hypercorn", "--config", "hypercorn-config.toml", "main:app"]
