# CR IA — GPU externa sob demanda (modelos pesados)

> Sua VPS (8 vCPUs · 24 GB RAM · 200 GB) roda com folga: API, Postgres, site,
> worker e modelos de **até ~14B quantizados** no Ollama local.
> Modelos realmente pesados (Qwen3-Coder 30B, GPT-OSS 20B full, Qwen-Image,
> FLUX local, fine-tunes grandes) vão para uma **GPU alugada por hora**,
> ligada só quando você precisa. A CR IA já fala com ela por HTTP.

## 1. O que roda onde (8 vCPU / 24 GB RAM)

| Carga | Onde | Por quê |
|---|---|---|
| API + Postgres + site + worker | VPS | leve (< 2 GB RAM) |
| Qwen3 4B/8B, Gemma 3 4B/12B, Qwen3-Coder 7B | VPS (Ollama CPU) | cabem nos 24 GB; ~5–20 tok/s |
| Qwen3 30B / GPT-OSS 20B / Qwen-Image | **GPU externa** | precisam de 16–48 GB VRAM |
| FLUX fotorrealista sem GPU própria | Cloudflare Workers AI | pago por uso, zero infra |

Regra prática: **texto e código do dia a dia ficam na VPS (custo zero)**;
**imagem pesada e raciocínio máximo usam GPU/CF sob demanda.**

## 2. Opção A — GPU por hora (RunPod / Vast.ai / Lambda)

Qualquer provedor que rode Docker com Ollama ou vLLM serve. Passo a passo (RunPod):

1. Crie um Pod GPU (ex.: RTX 4090 24 GB ou A100 40 GB) com a imagem
   `ollama/ollama` + porta HTTP 11434 exposta com **proxy autenticado** do provedor.
2. No terminal do pod:
   ```bash
   ollama pull qwen3:30b          # ou gpt-oss:20b, qwen2.5-coder:32b...
   ollama list
   ```
3. Copie a URL HTTPS do pod (ex.: `https://xxxx-11434.proxy.runpod.net`).
4. Na CR IA (`.env` da VPS ou vars do Workers):
   ```env
   OLLAMA_URL=https://xxxx-11434.proxy.runpod.net
   OLLAMA_TEXT_MODELS=qwen3:30b,qwen3:8b
   CHAT_PROVIDER=ollama
   ```
5. Reinicie a API (`docker compose up -d api worker`) e confira em
   **Administração → Sistema**: Ollama alcançável + modelo 🟢 no seletor.
6. Terminou o trabalho pesado? **Desligue o pod.** A CR IA volta sozinha para
   os modelos da VPS (auto-seleção detecta a queda no `ping()`).

💰 Custo típico 2026: RTX 4090 ≈ US$ 0,40–0,70/hora; A100 40 GB ≈ US$ 1–2/hora.
Uma sessão de 2h de codificação pesada sai por menos de um lanche.

## 3. Opção B — Cloudflare Workers AI (zero infra)

Já integrado. Modelos `@cf/*` (Llama, Qwen, Gemma, FLUX.1-Schnell) via binding.
O admin libera em **Administração → Modelos** (vem bloqueado por padrão para
não gerar custo surpresa). Ideal para imagens fotorrealistas esporádicas.

## 4. Opção C — GPU futura na própria VPS

OVH e Contabo oferecem VPS/servidores com GPU. Quando fizer sentido, basta:
```bash
docker compose --profile ollama up -d     # sobe Ollama local na VPS
docker compose exec ollama ollama pull qwen3:30b
```
e descomentar o bloco `deploy.resources` (NVIDIA) no `docker-compose.yml`.
Nenhuma linha de código muda — é só configuração.

## 5. Segurança da GPU externa

- **Nunca exponha Ollama sem autenticação.** Use o proxy com token do provedor
  ou um Cloudflare Tunnel + Access na frente.
- Guarde a URL como `OLLAMA_URL` no `.env` (VPS) ou `wrangler secret` (CF) —
  nunca no código, nunca no chat.
- Tokens estimados e chamadas ficam registradas em `usage_events`
  (Administração → Sistema), então dá para auditar quanto cada modelo consumiu.

## 6. Roteamento automático entre VPS / GPU / CF

O `ModelRegistry` (`apps/api/src/adapters/ai/registry.ts`) decide assim:

1. Ollama (`OLLAMA_URL`) alcançável? Usa os modelos de lá primeiro
   (inclusive `*coder*` para programação).
2. Senão, Workers AI liberado pelo admin? Usa `@cf/*`.
3. Senão, mock local (sempre funciona, respostas básicas).

Ou seja: **ligar a GPU = modelos pesados aparecem; desligar = volta ao plano
gratuito — sem reconfigurar nada.**
