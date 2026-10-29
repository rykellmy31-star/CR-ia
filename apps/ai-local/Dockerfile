# CR IA v0.2.0 — ai-local: Whisper + embeddings na CPU.
# Pesos (~1 GB Whisper small + ~2 GB BGE-M3) baixados no primeiro uso.
FROM python:3.11-slim AS run
WORKDIR /srv
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_OFFLINE=0
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
COPY apps/ai-local/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/ai-local/src ./src
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=120s \
  CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8001/health')"
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
