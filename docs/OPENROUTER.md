# OpenRouter — provedor primário (v0.3.0)

Tudo abaixo é operado pelo celular em **Administração → Provedores de IA**.
Nada aqui exige SSH após a instalação inicial.

## 1. Chave de API

1. Crie em `openrouter.ai/keys` (começa com `sk-or-v1-`).
2. No painel: cole em **🔑 OpenRouter** → **💾 Salvar chave** (vai para o
   cofre cifrado; exige `CREDENTIALS_SECRET` no `.env` do servidor).
3. **🧪 Testar** valida sem gastar nada (`GET /auth/key`, oficial).
4. O painel mostra só a máscara (`sk-or-v…wxyz`) e a fonte:
   - `.env` no servidor tem **prioridade** e é **preservado** (o painel nunca
     apaga a chave do `.env`; para usar a do cofre, remova a do `.env`).

Sem chave, os modelos OpenRouter aparecem como **🔑 Configurar API** e nunca
são chamados.

## 2. Catálogo dinâmico (sem lista fixa)

O sistema consulta a API oficial (`GET /models` + `GET /images/models`) e
monta o catálogo: texto, imagem, edição, contexto e preços por 1M de tokens.

- **🔄 ATUALIZAR MODELOS DE IA**: sincroniza agora (leitura pública, sem
  gasto). O relatório mostra adicionados / atualizados / removidos.
- **Sync automático**: ligado por padrão (24h), configurável no painel.
- **Suas escolhas são preservadas**: padrões, desabilitados e “Pago
  autorizado” sobrevivem a todos os syncs (o sync nunca toca neles).
- Modelos que saem do ar na OpenRouter passam a **🔴 Indisponível** (o
  painel mostra que saíram do catálogo; nada quebra).

Regra honesta de custo: **só é “grátis” o que tem preço conhecido igual a
zero**. Sem preço divulgado = tratado como **pago** (bloqueado até você
ativar).

## 3. Pagos: bloqueio padrão + ativação por modelo

- Todo modelo pago (ou sem preço) nasce **bloqueado** — qualquer tentativa
  retorna erro claro, sem chamar a API (sem gasto possível).
- Para liberar: marque **“Pago autorizado”** no modelo → **💾 Salvar
  seleção**. Vale só para aquele modelo (registrado em auditoria).
- Modelos pagos sem ativação aparecem como **🟡 Ativável**; com ativação,
  **🟢 Pronto**.

## 4. Imagens (Image Studio)

- **Geração**: usa a Image API oficial (`POST /images`). Os bytes voltam e
  são **validados de verdade** (assinatura PNG/JPEG/WebP/GIF/SVG) — HTTP 200
  sozinho nunca é aceito como prova.
- **Edição**: disponível nos modelos que declaram entrada de imagem
  (ex.: os 4 verificados abaixo). A lista de “Modelo de edição” só oferece
  quem suporta.
- **Custo real**: cada imagem retorna `usage.cost` (USD), gravado no seu
  consumo (Administração → Uso e cotas → coluna **$ real**).
- **Fallback**: sem chave ou sem créditos, o sistema usa o Pollinations
  gratuito (quando ligado) — nunca finge que o SVG demo é IA.

Modelos de imagem verificados em 24/10/2026 (via `/images/models`, ao vivo):
`qwen/qwen-image-2.1-turbo`, `qwen/qwen-image-2.1-pro`,
`qwen/qwen-image-3-pro`, `black-forest-labs/flux-3-image-klein` — todos com
geração + edição (`input_references`), sem preço divulgado no catálogo
(portanto tratados como pagos; exigem créditos + ativação).

## 5. Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| 🔑 Configurar API | sem chave | Salve a chave (§1) |
| Chave inválida (401) | chave errada/revogada | Gere outra em openrouter.ai/keys e salve de novo |
| Sem créditos (402) | saldo zerado | Recarregue em openrouter.ai/settings/billing ou use modelo 🆓 |
| Limite atingido (429) | cotas do free | Aguarde (a tela mostra a contagem) |
| Sync falha | VPS sem internet/DNS | Confira a rede da VPS e tente de novo |
| 🟡 Ativável | pago sem ativação | Marque “Pago autorizado” (§3) |

## 6. Notas técnicas (resumo)

- Descoberta: `GET /models` (texto+preços) e `GET /images/models`
  (imagem+parâmetros) — sem chave, sem custo.
- Chat: `POST /chat/completions` (OpenAI-compatível) + `HTTP-Referer` e
  `X-Title: CR IA`.
- Imagens: `POST /images` (`aspect_ratio` 1:1/4:5/9:16/16:9, `n: 1`,
  `input_references` com data URL na edição).
- Chave: `GET /auth/key` (validação + uso/limite, sem gasto).
- Custo de chat por chamada não é informado pela API → o consumo mostra
  tokens (e ≈$ estimado); custo **real** existe para imagens (`$ real`).
