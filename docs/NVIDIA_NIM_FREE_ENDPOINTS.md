# CR IA — NVIDIA NIM (Free Endpoints de desenvolvimento)

Esta prévia integra **chat NVIDIA NIM**, **Cosmos3 Nano para geração de imagens**
e dois serviços de recuperação de informação (**embeddings e reranking**), cada um
com seu contrato de API. APIs adicionais, como voz, vídeo, OCR e segurança,
precisam de integração e homologação específicas e não são anunciadas como ativas.

## Sem uso comercial por padrão

De acordo com a FAQ oficial da NVIDIA, os endpoints gratuitos do programa de
desenvolvedores são para desenvolvimento, pesquisa, prototipagem e testes. O uso
de produção requer condições/licenciamento apropriados.

- Não há modelos NVIDIA autorizados por padrão.
- Não entram no `autoSelectText`.
- Apenas o administrador pode chamar o modelo pelo chat.
- `GET /v1/models` pode retornar modelos incompatíveis, indisponíveis e/ou sem
  Free Endpoint; **não comprova gratuidade**.
- `POST /api/admin/nvidia/sync` não executa inferência nem faz cobranças.
- O administrador marca manualmente somente IDs que conferiu no catálogo
  https://build.nvidia.com/models, com selo **Free Endpoint** e API de chat.
- Os modelos aparecem na interface como `nvidia-nim:<id>` para não colidir com
  IDs da OpenRouter. Para a NVIDIA enviamos apenas `<id>`.

## Passos após publicação controlada

1. Administração → Provedores de IA → NVIDIA NIM.
2. Colar chave obtida em https://build.nvidia.com (campo com máscara; cofre).
   Se `NVIDIA_API_KEY` estiver no `.env`, ela tem prioridade.
3. Clicar **Consultar modelos NVIDIA** (somente leitura).
4. Conferir cada modelo de chat no catálogo oficial e selecionar somente os
   que possuem Free Endpoint. Marcar ciência de uso exclusivo em testes e salvar.
5. No chat do administrador, escolher o modelo `nvidia-nim:...` e testar.

Cuidado: a consulta de modelos não confirma a permissão real da chave para
inferência; só uma inferência autorizada comprova isso. Um HTTP 403 pode
significar que a organização não possui permissão para o endpoint.

## Componentes alterados

- Configuração `.env` e `docker-compose.yml` (chave opcional)
- Cofre administrativo (`cred.nvidia`)
- Registros de modelos da API, adaptador de texto NVIDIA NIM e namespace próprio
- `GET /api/admin/nvidia/status`
- `POST /api/admin/nvidia/key` — salvar no cofre
- `POST /api/admin/nvidia/sync` — consultar `/v1/models`
- `POST /api/admin/nvidia/approve` — salvar seleção manual de modelos de chat
- `POST /api/admin/nvidia/image/enable` — habilitar Cosmos3 Nano apenas em testes
- `POST /api/admin/nvidia/retrieval/embed` — teste de embeddings
- `POST /api/admin/nvidia/retrieval/rerank` — teste de reranking
- UI na tela existente **Provedores de IA**

## Limitações e homologação

O ZIP contém alterações no código, **não está assinado** e não foi implantado
na VPS. Não instalar sobre a aplicação vigente sem backup, assinatura válida
sob chave do proprietário, compilação, testes e revisão de diferenças.

Fontes NVIDIA:
- https://build.nvidia.com/models
- https://docs.api.nvidia.com/nim/docs/product
- https://docs.api.nvidia.com/nim/reference/llm-apis


## Imagens NVIDIA — Cosmos3 Nano (prévia de testes, 29/10/2026)

O catálogo consultado identifica `nvidia/cosmos3-nano` como **Free Endpoint**.
Esse é um modelo de **Physical AI** (robótica, simulação, mundo físico), e não um
substituto genérico para artes publicitárias. Para imagens comuns, mantenha a
OpenRouter (pode ser paga) ou outro gerador verificado.

- Superadmin → Provedores de IA → configurar chave NVIDIA no cofre.
- Ativar **Cosmos3 Nano** explicitamente; começa desativado.
- No **Estúdio de Imagens** selecionar `nvidia-nim:nvidia/cosmos3-nano`.
- Formatos aceitos neste adaptador: 1:1, 16:9, 9:16. 4:5 devolve erro honesto.
- API usada: `POST https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano` com
  `{model_mode:'text2image', prompt, resolution}`. Saída: `b64_image` em JPEG.
- Somente administrador pode utilizar; proibido definir como padrão global;
  geração não é automática. Limites (429) e falta de autorização/créditos (402)
  são tratados sem compra automática de créditos.
- Outros modelos de imagem NVIDIA (FLUX, Qwen Image, Stable Diffusion) não são
  anunciados como gratuitos: em 29/10/2026 o catálogo filtrado indica
  principalmente **Downloadable**, não **Free Endpoint**. Exigem comprovação
  de acesso, condições e implementação por modelo antes da habilitação.

## Ferramentas Free Endpoint de recuperação de informação

Foram adicionados endpoints de teste, somente para Superadmin, com execução
sob demanda e sem integração automática à busca dos clientes:

- `POST /api/admin/nvidia/retrieval/embed` — Nemotron 3.5 Embed 1B/8B via
  `/v1/embeddings` (`input_type`: `query` ou `passage`).
- `POST /api/admin/nvidia/retrieval/rerank` — Nemotron 3.5 Rerank 8B via endpoint
  próprio de reranking. A tela fornece testes mínimos e relata erro quando a
  conta não tem permissão. Uma integração RAG completa requer homologação adicional.

## Limites / o que ainda não foi homologado

- Não houve chamadas reais à NVIDIA neste pacote; validações usam testes locais
  simulados. A conta NVIDIA pode não ter acesso aos endpoints mesmo com chave.
- Serviços de voz, vídeo, PDF/OCR especializado e outros protocolos requerem
  adaptadores diferentes; o catálogo genérico não garante compatibilidade.
- A gratuidade é para prototipagem; **não** autorizar uso comercial por clientes
  do SaaS sem licença e termos adequados.
- O pacote não foi implantado na VPS e não deve substituir a produção antes de
  testar compilação, migrações, backups, regressões e aprovação.

Fontes oficiais:
- https://build.nvidia.com/nvidia/cosmos3-nano/modelcard
- https://build.nvidia.com/models?label=image+generation
- https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-embed-8b-infer
- https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3_5-rerank-8b-infer
