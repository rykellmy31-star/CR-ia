# CR IA — Recursos opcionais (desabilitados por padrão)

Instalação padrão (`deploy-vps-pronta.sh --apply`) sobe **só**: `db`, `api`,
`worker`, `web`. O chat funciona em modo demonstração honesto até o dono
ativar IA real (§2.6 do INSTALACAO). Tudo abaixo é opt-in:

| Recurso | Estado padrão | Para ativar |
|---|---|---|
| IA real local (Ollama + Qwen3 4B) | ⛔ parado | `docker compose --profile ollama up -d && ./scripts/ollama-setup.sh` |
| Central de Atualizações (serviço `updater`) | ⛔ parado | `docker compose --profile updates up -d` (após ler `docs/UPDATES.md`) |
| Voz + busca em docs (`ai-local`) | ⛔ parado | `docker compose --profile ai up -d` |
| Busca web própria (SearXNG) | ⛔ parado | `docker compose --profile search up -d` + `SEARXNG_URL=http://searxng:8080` |
| GPU externa / ComfyUI | ⛔ não configurado | Ver `docs/GPU-EXTERNA.md` |
| Recuperação de senha (SMTP) | ⛔ não configurado | Preencher `SMTP_*` no `.env` |
| Backup externo R2 | ⛔ não configurado | Preencher `R2_*` + ver `docs/INSTALACAO.md` §2.4 |
| Buscas pagas (Brave/Tavily/Google) | ⛔ bloqueadas | Chave do dono + `BLOCK_PAID_PROVIDERS=false` (decisão explícita) |
| Modelos pagos (OpenAI/Claude/…) | ⛔ bloqueados | Chave no cofre + liberação explícita (nunca ativam sozinhos) |
| Agente dev (execução) | ⛔ desativado sem Docker/host | Precisa de socket no worker (docker) ou flag de host em dev; push/PR/merge sempre exigem aprovação |

Regra geral: nada pago, nada externo e nada com poder administrativo liga
sozinho. Cada ativação acima é uma decisão explícita do dono, registrada onde
aplicável (auditoria/histórico).
