# CR IA v0.3.0 — Lista de pendências (o que falta provar/fazer)

> Atualizado em **24/10/2026**. Contrato do que NÃO foi executado ou
> validado até o fechamento do ZIP v0.3.0. Nada aqui está simulado: cada
> item diz exatamente o que falta e como concluir.

## P0 — Exige a VPS / chaves do dono (não executável pelo agente)

- [ ] **P0.1 — Instalação v0.3.0 na VPS.** Rodar `docs/INSTALACAO.md` §2.2
  com `cr-ia-v0.3.0-pronta.zip` e confirmar `/api/health` =
  `"version": "0.3.0"`. Inclui a migração aditiva `0004` (coluna
  `usage_events.cost_usd`) — sintaxe revisada, **não executada em Postgres
  real nesta rodada** (sem PG no ambiente do agente; o e2e de banco foi
  provado na v0.2.0 e o `migrate-seed.sh` aplica 0001→0004 sozinho).
- [ ] **P0.2 — Chave OpenRouter real + sync no painel.** Salvar a chave em
  Administração → Provedores de IA, testar e rodar “ATUALIZAR MODELOS DE
  IA”. O sync foi provado ao vivo pelo agente (520 modelos, 63 de imagem),
  mas **com o catálogo público (sem chave)** — o sync com a sua chave só
  acontece na sua VPS.
- [ ] **P0.3 — Geração/edição de imagem paga real.** Exige créditos
  OpenRouter + ativação do modelo (“Pago autorizado”). O caminho inteiro foi
  testado contra stubs fiéis (formato oficial, validação de bytes, custo
  0.04 registrado), mas **nenhuma imagem paga foi gerada de verdade**
  (proibido sem autorização — e continua proibido).
- [ ] **P0.4 — Chat pago real (qualquer modelo).** Mesmo motivo do P0.3:
  provado contra stub (bloqueio 403 → ack → 200), nunca contra a API real.

## P1 — Melhorias futuras (não bloqueiam o aceite)

- [ ] **P1.1 — Preço de imagem por endpoint.** O `/images/models` não traz
  preço; o preço exato por imagem está no endpoint por modelo
  (`/images/models/<id>/endpoints`). Hoje: imagem sem preço = pago +
  custo real registrado após gerar. Evolução: buscar endpoints no sync.
- [ ] **P1.2 — Histórico de custo por usuário no painel.** O `$ real` já
  existe por linha (Uso e cotas); falta um totalizador por usuário/período.
- [ ] **P1.3 — Assinatura minisign das releases.** O upload pelo painel
  exige ZIP + assinatura válida (recusa sem ela — testado). Falta o dono
  gerar o par de chaves e configurar `UPDATE_SIGNING_PUBLIC_KEY` (roteiro
  em `docs/UPDATES.md`); até lá, atualizações são pelo ZIP via SSH.

## P2 — Herdado das rodadas anteriores (sem mudança)

- Docker Compose na VPS, navegador/celular real, Ollama/Qwen3 na VPS,
  SearXNG real, SMTP real, R2 real, Brave/Tavily/Google-PSE reais,
  chamadas pagas dos 6 provedores Fase 2 — ver `PENDENCIAS-v0.2.0.md`.
