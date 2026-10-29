"""
CR IA v0.2.0 — ai-local: transcrição (faster-whisper) + embeddings (BGE-M3).

Serviço interno (perfil "ai" do compose), só em 127.0.0.1:8001.
Modelos carregados sob demanda (lazy) e mantidos em memória.

Variáveis:
  WHISPER_MODEL=tiny|base|small|medium|large-v3 (padrão small)
  WHISPER_MODEL_DIR=/models/whisper
  EMBEDDING_MODEL=BAAI/bge-m3
  EMBEDDING_MODEL_DIR=/models/embeddings
"""
import os
import tempfile
import threading
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

app = FastAPI(title="cr-ia ai-local", version="0.2.0")

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small").strip() or "small"
WHISPER_DIR = os.environ.get("WHISPER_MODEL_DIR", "/models/whisper")
EMBED_MODEL = os.environ.get("EMBEDDING_MODEL", "BAAI/bge-m3").strip() or "BAAI/bge-m3"
EMBED_DIR = os.environ.get("EMBEDDING_MODEL_DIR", "/models/embeddings")

_lock = threading.Lock()
_whisper = None
_embedder = None


def whisper_size() -> str:
    # faster-whisper aceita tiny/base/small/medium/large-v3 (+ .en); outros
    # valores são tratados como caminho/id HuggingFace explícito.
    return WHISPER_MODEL


def get_whisper():
    global _whisper
    if _whisper is None:
        with _lock:
            if _whisper is None:
                from faster_whisper import WhisperModel

                os.makedirs(WHISPER_DIR, exist_ok=True)
                _whisper = WhisperModel(
                    whisper_size(), device="cpu", compute_type="int8",
                    download_root=WHISPER_DIR, local_files_only=False,
                )
    return _whisper


def get_embedder():
    global _embedder
    if _embedder is None:
        with _lock:
            if _embedder is None:
                from sentence_transformers import SentenceTransformer

                os.makedirs(EMBED_DIR, exist_ok=True)
                _embedder = SentenceTransformer(EMBED_MODEL, cache_folder=EMBED_DIR, device="cpu")
    return _embedder


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "ai-local",
        "version": "0.2.0",
        "whisper": WHISPER_MODEL,
        "embeddings": EMBED_MODEL,
        "loaded": {"whisper": _whisper is not None, "embeddings": _embedder is not None},
    }


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), language: Optional[str] = Form(None)):
    data = await audio.read()
    if not data:
        raise HTTPException(400, "Áudio vazio.")
    if len(data) > 100 * 1024 * 1024:
        raise HTTPException(400, "Áudio maior que 100 MB.")
    suffix = os.path.splitext(audio.filename or "audio")[1] or ".bin"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(data)
        tmp.close()
        try:
            model = get_whisper()
        except Exception as e:  # rede/modelo indisponível: erro claro, sem traceback
            raise HTTPException(503, f"Modelo Whisper indisponível: {e}")
        try:
            segments, info = model.transcribe(tmp.name, language=language or None, beam_size=5)
            text = "".join(s.text for s in segments).strip()
            return {
                "text": text,
                "language": info.language if info else (language or "desconhecido"),
                "duration_sec": round(info.duration, 2) if info and info.duration else None,
            }
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(500, f"Falha na transcrição: {e}")
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


class EmbedIn(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=64)


@app.post("/embed")
def embed(body: EmbedIn):
    texts = [(t or "")[:4000] for t in body.texts]
    if not any(texts):
        raise HTTPException(400, "Nenhum texto para embedding.")
    try:
        model = get_embedder()
    except Exception as e:
        raise HTTPException(503, f"Modelo de embeddings indisponível: {e}")
    try:
        vectors = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
        return {"embeddings": [list(map(float, v)) for v in vectors], "model": "bge-m3"}
    except Exception as e:
        raise HTTPException(500, f"Falha nos embeddings: {e}")
