# CR IA — entrega de integração NVIDIA (prévia, 2026-10-29)

## Alterações no código

- Mantidos: OpenRouter, Ollama, Docker Compose, menu `menu` e atualizador pelo GitHub.
- Chat NVIDIA NIM Free Endpoints por seleção manual administrativa (`/v1/chat/completions`).
- Geração **Cosmos3 Nano** Free Endpoint via `/v1/cosmos/nvidia/cosmos3-nano`, no Estúdio de Imagens.
- Interface Superadmin para habilitar/desabilitar o Cosmos; fica desabilitado por padrão.
- Endpoints administrativos de teste para Nemotron 3.5 Embed 1B/8B e Nemotron 3.5 Rerank 8B.
- As chaves são registradas no cofre do backend, não no código/repositório.
- Modelos NVIDIA são ocultos na lista para usuários não administradores e as rotas de geração e chat impedem uso por não administradores.
- Nenhum modelo NVIDIA entra na seleção automática nem vira padrão global.
- Tratamento de limites (429), crédito/entitlement (402), permissão (401/403) e respostas de imagem inválidas.

## Limitações reais

- Não foi feita inferência NVIDIA real, pois não temos a chave da conta. As permissões precisam ser confirmadas no painel NVIDIA.
- Este é um **pacote de desenvolvimento**, não instalador de produção homologado.
- No catálogo NVIDIA filtrado por Image Generation, **Cosmos3 Nano** está sinalizado Free Endpoint para Physical AI; FLUX/Stable Diffusion/Qwen aparecem principalmente como Downloadable e **não** foram habilitados como endpoints gratuitos.
- Cosmos não é o modelo recomendado para publicidade comercial; sua especialidade é mundo físico/robótica.
- Edição de imagem NVIDIA, vídeo, voz, OCR, moderação, modelos científicos e outros formatos não estão integrados: exigem APIs diferentes e permissões próprias. OpenRouter continua disponível para imagem e edição conforme créditos/permissão.
- A NVIDIA limita Free Endpoints à prototipagem/desenvolvimento. A CR IA não disponibiliza os endpoints a clientes finais em produção.
- Atualização da CR IA na VPS e testes reais de Docker/TS dependem de ambiente de homologação e autorização.

## Verificações locais feitas

- Código TypeScript/TSX: análise de sintaxe de 131 arquivos sem erros de parsing.
- `node scripts/nvidia-free-check.mjs`: 11 verificações de fluxos simulados aprovadas (rede real não utilizada).
- `node --test scripts/cria-menu.test.mjs`: 6 testes aprovados.
- Varredura por padrões de chaves privadas e tokens: sem correspondências (não substitui auditoria completa).
- `tsc --noEmit`: bloqueado neste ambiente pela ausência de `@types/node` e `vite/client`; compilação completa **não foi concluída**.

## Primeiros testes na VPS de homologação

1. Armazene o código no repositório GitHub após revisar o conteúdo publicado; repositório público não pode conter segredos nem bancos reais.
2. Faça backup e use staging; não atualize produção com ZIP de prévia.
3. Configure chave `NVIDIA_API_KEY` pelo Superadmin → Provedores de IA, sem colocar no GitHub.
4. Habilite Cosmos3 Nano na mesma área e faça teste manual de geração com formato 1:1, com prompt de robótica/cena física.
5. Teste as ferramentas de embeddings/reranking separadamente; anote respostas HTTP/limites.
6. Valide Docker, persistência, segurança de roles, compilação completa e rollback antes da promoção.

Fontes: https://build.nvidia.com/nvidia/cosmos3-nano/modelcard ; https://build.nvidia.com/models?label=image+generation ; https://docs.api.nvidia.com/nim/docs/product
