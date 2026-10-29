# ai-local — voz + busca em documentos (CPU)

Serviço interno da CR IA v0.2.0 (perfil `ai` do compose):

| Recurso | Modelo | Licença | RAM aprox. |
|---|---|---|---|
| Transcrição PT/EN | faster-whisper `small` | MIT | ~1 GB |
| Embeddings multilíngues | BGE-M3 | MIT | ~2 GB |

## Subir

```bash
docker compose --profile ai up -d --build
curl http://127.0.0.1:8001/health
# {"status":"ok","whisper":"small","embeddings":"BAAI/bge-m3",...}
```

Os pesos baixam do HuggingFace no **primeiro uso** (transcreva 1 áudio curto
para "aquecer"). Para trocar o Whisper: `WHISPER_MODEL=tiny|base|small|medium`
no `.env` (tiny/base economizam RAM; medium/large-v3 exigem mais).

## API (rede interna Docker: `http://ai-local:8001`)

- `GET /health` — estado + modelos configurados.
- `POST /transcribe` — multipart `audio` (+ `language` opcional: `pt`, `en`…).
  ```bash
  curl -F audio=@voz.mp3 -F language=pt http://127.0.0.1:8001/transcribe
  ```
- `POST /embed` — JSON `{ "texts": ["..."] }` (máx. 64 por chamada).
  ```bash
  curl -H 'content-type: application/json' -d '{"texts":["contrato de aluguel"]}' \
    http://127.0.0.1:8001/embed
  ```

## Teste sem Docker (dev)

```bash
cd apps/ai-local
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
WHISPER_MODEL=tiny uvicorn src.main:app --port 8001
```

## Limites honestos

- CPU da VPS: transcrever 1 min de áudio leva ~20–60s (small). Use `tiny`
  para rascunhos rápidos.
- Sem GPU: não serve para ditado em tempo real — é transcrição de arquivos.
- Embeddings: 64 textos/chamada; documentos grandes são fatiados pela API.
