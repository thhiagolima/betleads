# API de leitura (uso interno)

Data: 2026-11-20
Status: aprovado (decisões do usuário abaixo), implementar na branch feat/api-leitura
Base: MCP financeiro (`2026-10-30-mcp-financeiro-design.md`) e MCP do grupo (`2026-11-17-mcp-grupo-design.md`).

## 1. Intenção

Tudo o que o MCP faz em **leitura** também precisa estar disponível por uma API HTTP comum, para
sistemas internos (planilhas, BI, scripts). Os números são os mesmos do MCP e do painel.

## 2. Decisões do usuário

1. **Uso interno.** Sem versão pública para casas ou terceiros nesta fase.
2. **A chave herda o acesso do MCP.** Uma chave pertence a uma pessoa. Ela vale enquanto a
   pessoa tem `mcp_access` (nível diferente de nenhum), e as áreas (financeiro, operação) e as
   casas são as mesmas que essa pessoa vê no MCP, lidas a cada chamada. Sem regra de permissão
   nova.
3. **Volume:** além das ferramentas do MCP, um endpoint diário leve (`serie_diaria`) para períodos
   longos (até 366 dias), lendo direto das tabelas diárias.

## 3. Não-objetivos

Escritas (a API é só leitura, mesmo para quem tem nível de escrita no MCP), dados de jogador,
webhooks, versão pública.

## 4. Chaves

- Tabela `api_keys` (id, user_id, nome, prefixo, hash SHA-256 da chave, criada em, último uso,
  revogada em). Só `service_role` acessa.
- Formato `blk_<43 caracteres base64url>` (32 bytes aleatórios). A chave aparece **uma vez**, ao criar; o banco guarda só o hash.
- Até 5 chaves ativas por pessoa. A pessoa cria e revoga as próprias na tela "Conectar ao Claude".
  Tirar o acesso ao MCP de alguém derruba as chaves dessa pessoa na hora (a checagem é por chamada).
- Feature flag `API_ENABLED` (só a string "true" liga). Desligada: todas as rotas da API
  respondem 404 e a seção da tela some.

## 5. Rotas

- `GET /api/v1`: lista as ferramentas que a chave pode usar (nome, título, descrição, área).
- `GET /api/v1/openapi.json`: OpenAPI 3.1 gerado dos próprios esquemas de entrada (zod).
- `POST /api/v1/{ferramenta}`: corpo JSON = os mesmos argumentos da ferramenta do MCP. Resposta =
  o mesmo resultado do MCP, com `calculado_em`.
- Autenticação: `Authorization: Bearer blk_...`.
- Erros: `{ "erro": "<mensagem pt-BR>" }` com 401 (chave inválida), 403 (sem permissão ou área),
  400 (argumentos inválidos), 404 (ferramenta desconhecida), 429 (limite), 500 (erro interno).

Ferramentas: `listar_escopos`, `resumo_financeiro`, `resumo_por_dia`, `mes_da_casa`,
`metas_da_casa`, `serie_diaria` (área financeiro) e todas as de operação (`visao_geral`,
`visao_geral_por_dia`, `comparar_casas`, `ranking_experts`, `detalhe_expert`, `afiliados`,
`campanhas`, `jornadas`, `alertas`).

## 6. `serie_diaria(escopo, periodo)`

Uma linha por casa e por dia, até 366 dias e as mesmas casas do `resumo_financeiro` (permissão do
painel financeiro). Por linha: cadastros, FTDs, valor dos FTDs, depósitos, saques, anúncios, GGR
(com o GGR mensal repartido como no painel), taxas, net, dia pendente, custo de envios em BRL e o
CRM do dia (enviados, cliques, conversões e receita direta). Lê `finance_days`,
`tenant_finance_monthly_ggr`, `finance_send_usage` e `finance_activity_days` uma vez para o período
todo. Sem lucro líquido por dia (custos mensais não se repartem por dia): para isso,
`resumo_financeiro`.

## 7. Infra

- Mesmo pipeline do MCP: limite de 60 chamadas por minuto **por chave**, checagem de área,
  `assertSemDadosPessoais` nas de operação, registro em `mcp_call_log` (nova coluna `api_key_id`,
  `connection_id` nulo) e `calculado_em`.
- Migração `20261231101600_api_leitura.sql`, idempotente.
