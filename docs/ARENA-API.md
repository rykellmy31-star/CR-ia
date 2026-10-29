# Investigação: API da Arena para aplicações externas (22/10/2026)

> Exigência do Prompt Mestre §3: investigar quais modelos da Arena podem ser
> usados legitimamente por aplicações externas; integrar somente via API
> oficial compatível, com credenciais autorizadas; nunca automatizar
> interfaces privadas nem contornar assinaturas/termos.

## Conclusão

**NÃO integrar.** Não foi encontrada API pública oficial de desenvolvedor da
Arena (arena.ai) documentada em fontes públicas até esta data. Nenhum código
da CR IA chama a Arena, e nenhum adaptador foi criado.

## Evidências

- Levantamento independente de 18/07/2026 cobrindo site, termos de uso, blog,
  GitHub, Hugging Face e imprensa: nenhum developer API documentado; os
  termos proíbem acesso automatizado. Status: "não confirmado", não
  "não existe" — ou seja, reavaliar se a Arena anunciar algo oficial.
  ([11](https://vc.ru/provod/3037039-arena-ai-api-ofitsialnyy-interfeys-razrabotchika))
- A Arena (ex-LMArena/Chatbot Arena) opera como plataforma pública de
  avaliação de LLMs por voto humano, não como provedora de inferência por API.
  ([4](https://en.wikipedia.org/wiki/Arena.ai))
- Buscas por "Arena.ai official API / developers / external applications"
  retornam apenas empresas homônimas sem relação (Arena PLM, Arena Chat,
  Arena Physica) — nenhuma expõe os modelos do ranking da arena.ai.

## Decisão de engenharia

1. Sem adaptador `arena` no registro de modelos.
2. Sem credencial, endpoint ou menção de disponibilidade na interface.
3. Este documento é a prova da investigação (exigência §15: documentar o que
   foi verificado e o que continua pendente).
4. Gatilho de reavaliação: anúncio oficial em arena.ai/blog ou docs com
   endpoints + autenticação + termos para terceiros. Só então desenhar o
   adaptador (chave do admin, status pago/externo, teste real de inferência).

## IDs reais adotados para os demais provedores (mesma pesquisa, 22/10/2026)

- OpenAI: `gpt-5-mini` ($0,25/$2,00), `gpt-5` ($1,25/$10,00) por 1M in/out.
  ([1](https://developers.openai.com/api/docs/models/gpt-5-mini),
  [2](https://benchlm.ai/openai/api-pricing))
- Anthropic: `claude-opus-4-6` (flagship atual, API desde 14/10/2026),
  `claude-sonnet-4-6`. ([8](https://www.anthropic.com/news/claude-opus-4-6))
- Google: `gemini-3.8-flash` (GA estável), `gemini-4-argon` (flagship);
  família 2.5 em aposentadoria no Vertex em 20/10/2026.
  ([6](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions))
- xAI: `grok-4.7` ($2,00/$6,00), `grok-4.3`. ([2](https://docs.x.ai/overview))
- DeepSeek: aliases oficiais `deepseek-chat`, `deepseek-reasoner`.
- Mistral: aliases oficiais `mistral-large-latest`, `mistral-medium-latest`.
