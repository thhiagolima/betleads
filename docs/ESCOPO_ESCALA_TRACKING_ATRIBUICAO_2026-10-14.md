# Escopo — escala de envio, tracking e atribuição

**Data:** 14/10/2026
**Prioridade:** P0 operacional
**Origem:** revisão de código sobre `AUDITORIA_TRACKING_ATRIBUICAO_ESCALA_2026-10-14.md` e `STATUS_P0_2026-10-14.md`
**Área coberta:** campanhas, jornadas, links, cliques, webhooks de cassino, ledger financeiro, atribuição, relatórios de jornada/campanha e a infraestrutura que os sustenta
**Fora de escopo:** composer, gamificação, Meta/ads, automações de e-mail fora de jornada, autenticação do CRM

## Status de execução (atualizado em 15/10/2026)

Legenda: ✅ concluído · 🟡 parcial / depende de ação externa · ⏳ pendente

| Fase | Situação | Commits | Banco |
| ---- | -------- | ------- | ----- |
| A — Observabilidade | ✅ código; 🟡 configuração | `bcf7183`, `1406a9a` | `20261014220000` aplicada |
| B — Contenção | ✅ código e banco | `37ea079`, `76f53c2`, `58f9a80` | `20261015090000`, `…091000`, `…092000` aplicadas |
| SEC-01 — Correção de permissões | ✅ aplicada (WhatsApp fora, documentado) | ver commit SEC-01 | `20261015100000` aplicada |
| C — Integridade do envio | 🟡 código pronto e revisado; aguarda migrations e deploy | ver commit da Fase C | `…110000`, `…111000`, `…112000`, `…113000` **não aplicadas** |

Pendências fora do código:

- **Deploy no VPS** do código das Fases A e B (`docker compose up -d --build`). Até lá, produção roda o código anterior sobre o banco novo (compatível).
- **OBS-01:** CPU/RAM de 24 h após o upgrade (dashboard Supabase) e Index/Performance Advisor.
- **OBS-02/03:** preencher `SENTRY_DSN` (Node) e `VITE_SENTRY_DSN` (React); ativar scrubber e "não guardar IP" nos projetos.
- **OBS-04:** criar monitores e heartbeats no Better Stack conforme `RUNBOOK_OBSERVABILIDADE.md` e preencher `BETTERSTACK_HEARTBEAT_*`.
- **Realtime:** confirmar que reconectou após o restart do upgrade.

Ações operacionais executadas:

- 15/10 00h55 BRT: `start_after = 2026-10-15T03:55:01Z` na jornada "PIX gerado e não pago" da Sorte Alta, que nunca havia inscrito ninguém e dispararia para todo o histórico de PIX pendentes.
- Eventos perdidos pelo CON-04 já haviam sido reprocessados; efeitos colaterais e correções propostas em `RECUPERACAO_EVENTOS_PERDIDOS_2026-10-15.md` (aguardando decisão: 25 inscrições de nível, 71 depósitos com detalhe sobrescrito, 6 `ultimo_login` regredidos).

## 0. Contexto e decisões tomadas

A Fase 0/1 da auditoria corrigiu a **semântica** da atribuição: clique first-party, grau A, correção dos UUIDs no trigger de nível e `recipient_player_id` obrigatório. A revisão de código desta data mostra que a **capacidade** e a **integridade operacional** continuam abertas. O sistema tem tetos globais fixos que não crescem com o número de tenants, e há caminhos de envio duplicado e de perda de evento.

Decisões já tomadas (não reabrir sem novo fato):

| Tema                           | Decisão                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Short.io                       | Contrato permite links únicos ilimitados; limite de API 50 req/s. Cota deixa de ser risco; vazão continua |
| Valor operacional em jornadas  | Não exibir. Jornadas mostram somente valor atribuído (grau A)                                            |
| Destinatário sem player        | Enviar aos resolvidos e reportar os não resolvidos; nunca bloquear a campanha inteira                    |
| TPS de provedores              | Sem contrato fixo; usar valor inicial conservador e configurável (seção 5)                               |
| Supabase                       | Compute elevado de Small (t3a.small, CPU 94%) para **Large** (2 vCPU dedicadas, 8 GB, 160 conexões)      |
| Erros/tracing                  | Sentry (plano free inicialmente)                                                                         |
| Uptime/logs/heartbeats         | Better Stack (plano free inicialmente)                                                                   |

## 1. Objetivo

Sustentar dezenas de tenants com:

- envio sem duplicidade e sem perda, com justiça entre tenants e respeito ao TPS dos provedores;
- depósito sempre registrado, independentemente de jornada ou atribuição;
- clique confirmado disponível para todos os tenants, com redirect que não depende do Postgres para responder;
- relatórios com definição única, frescor visível e custo que não cresce com o histórico;
- toda falha observável, alertada e reprocessável.

## 2. Princípios de implementação

1. **Ledger primeiro.** Nenhuma lógica de jornada, nível ou atribuição roda na transação do depósito.
2. **Nada longo dentro de HTTP.** Cron apenas acorda; o trabalho roda em worker com lease e prazo.
3. **Idempotência por chave estável** em envio, billing, chamada de voz, clique e webhook.
4. **Justiça por tenant** em todo consumo de fila (dispatcher, scanner, replay, campanhas).
5. **Grau A ou nada** em receita atribuída.
6. **Toda mudança é aditiva e reversível** (flag por tenant, migration sem lock longo, `CREATE INDEX CONCURRENTLY`).
7. **Medir antes e depois.** Cada entrega registra a métrica que pretende mover.

## 3. Linha de base e metas

| Indicador                         | Hoje (14/10)                                   | Meta deste escopo                      |
| --------------------------------- | ---------------------------------------------- | -------------------------------------- |
| Vazão de jornadas (global)        | ~250/min (lote 250, ondas de 12, 1 tick/min)   | TPS configurado (seção 5), por tenant  |
| Vazão de campanhas                | ~84/min com `rate_per_minute=1000`             | TPS configurado                        |
| Scanner                           | ~1.500 players/min global                      | ciclo completo < 15 min por tenant     |
| Replay de webhook                 | 20/min, sem DLQ                                | inbox com workers; DLQ monitorada      |
| Idade da fila pronta p95          | desconhecida                                   | < 5 min                                |
| Envio duplicado                   | possível (3 caminhos)                          | 0 em teste de falha                    |
| Depósito falho por jornada        | possível (trigger na transação)                | 0                                      |
| Tenants com clique confirmado     | 1 de 3                                         | todos os tenants ativos                |
| Redirect p95                      | depende do Postgres                            | < 150 ms, independente do Postgres     |
| CPU do banco                      | 94% no Small                                   | < 60% sustentado no Large              |

## 4. Entregas

Cada item tem ID para rastreio em PR/commit. Ordem das fases = ordem recomendada de execução; itens dentro de uma fase podem ser paralelos.

---

### Fase A — Observabilidade e capacidade (dias 1–2) — ✅ código concluído

Sem medição não há como provar ganho das demais fases.

**🟡 OBS-01 — Linha de base do banco após o upgrade para Large**

- Registrar CPU, RAM, conexões, cache hit e temp files por 24 h após o upgrade.
- Exportar top 20 queries por tempo total em Query Performance (`pg_stat_statements`).
- Rodar Index Advisor e Performance Advisor; anexar resultado neste documento.
- Candidatos já identificados: `reserve_journey_delivery` (`count(*)` diário sob advisory lock), `list_journey_metrics`, scanner (`select *` em players), `refresh_recent_dashboard_metrics`, escritas do sync Short.io, `journey_eligible_lead_count`.
- **Aceite:** tabela "query → tempo total → ação" registrada; meta de CPU revisada com dado real.

**✅ OBS-02 — Sentry no servidor (Node 22, VPS)**

- `@sentry/node` com `instrument.mjs` carregado por `node --import ./instrument.mjs .output/server/index.mjs`. O arquivo precisa ser copiado para o estágio `runner` do `Dockerfile` e o `CMD` ajustado.
- DSN somente por variável `SENTRY_DSN`; nunca commitado. `SENTRY_ENVIRONMENT` e `SENTRY_RELEASE` (SHA do git).
- `tracesSampleRate: 0.1` e profiling desligado no plano free; subir pontualmente durante investigação.
- `beforeSend`/`beforeSendLog` removendo telefone, e-mail, nome, payload de webhook e tokens (LGPD).
- Tags obrigatórias: `tenant_id`, `source_type`, `channel`, `job` (dispatcher/scanner/webhook/replay/sync/redirect).
- Substituir `console.error` silenciosos dos caminhos críticos por `Sentry.captureException` com contexto.
- **Aceite:** erro de teste visível no Sentry com tags e sem PII; release identificada.

**✅ OBS-03 — Sentry no front-end**

- `@sentry/react` com `VITE_SENTRY_DSN`; session replay desligado (PII).
- Upload de source maps no build.
- **Aceite:** erro de tela rastreável até o componente.

**🟡 OBS-04 — Better Stack: uptime e heartbeats**

- Uptime: home do CRM, rota de redirect com token sintético, rota de webhook (health sem efeito colateral).
- Heartbeats: dispatcher de jornadas, scanner, dispatcher de campanhas, replay de webhook, sync Short.io, refresh do dashboard. Cada job faz ping ao concluir; ausência = alerta.
- Logs do container do VPS enviados ao Better Stack.
- **Aceite:** derrubar um job em homologação dispara alerta em < 5 min.

**✅ OBS-05 — Heartbeat real e métricas de fila**

- `dispatcher_runs` passa a registrar início, progresso e fim (hoje só registra o fim).
- Expor por tenant/canal: fila pronta, idade p95 do item mais antigo, enviados/min, erros/min.
- **Aceite:** consulta única responde "o worker está vivo?" e "qual tenant está atrasado?".

---

### Fase B — Contenção de baixo risco (dias 2–4) — ✅ concluída

**✅ CON-08 — RLS avaliado uma vez por query, não por linha (executar primeiro)**
- Origem: `BASELINE_BANCO_2026-10-14.md` (NOVO-A). As telas do CRM via PostgREST (`authenticated`) respondem por **44% do tempo medido** do banco.
- Causa: `players`, `sms_send_logs`, `deposits`, `webhook_logs`, `activation_runs` (e demais tabelas por tenant) têm até 3 políticas permissivas, duas delas idênticas, chamando `has_tenant_access(tenant_id)`, `current_tenant_id()` e `is_super_admin()` sem `(select …)`. Cada função roda por linha; `user_roles` (11 linhas) acumulou 143 milhões de seq scans. O mesmo `count(*)` de players leva 8,6 ms sem RLS e ~4 s via PostgREST.
- Mudanças:
  - inventário completo das políticas atuais (`pg_policies`) e da semântica de cada função, em especial de onde `current_tenant_id()` lê o tenant e se valida vínculo do usuário;
  - uma política por tabela e comando, com funções embrulhadas em `(select …)` para virarem InitPlan, preservando exatamente quem pode ler/escrever o quê;
  - funções auxiliares `STABLE`, `SECURITY DEFINER` com `search_path` fixo e índice em `user_roles (user_id)`;
  - leituras `authenticated` passam `.eq("tenant_id", tenantId)` explicitamente, para usar os índices `(tenant_id, …)` (prioridade: `history.functions.ts`, `send-window.functions.ts`, `players-list.functions.ts`).
- **Revisão de segurança obrigatória:** matriz de acesso antes × depois (super admin, admin/gestor/member do tenant A, usuário do tenant B, usuário sem vínculo, `anon`) para SELECT/INSERT/UPDATE/DELETE em cada tabela alterada.
- **Aceite:** matriz de acesso idêntica; `count(*)` de players via `authenticated` < 100 ms; nenhuma tela com timeout de 8 s; CPU p95 reavaliada.

**✅ CON-01 — Índice de lookup do clique**
- `link_dispatches` só tem `unique (tenant_id, tracking_token)`; o redirect busca por `tracking_token` sozinho (`src/lib/click-tracking.server.ts:107-113`).
- Criar `CREATE UNIQUE INDEX CONCURRENTLY` em `link_dispatches (tracking_token)`.
- **Aceite:** `EXPLAIN` do lookup usa index scan.

**✅ CON-02 — Segredo de assinatura vazio derruba o tracking**
- `trackingSecret` usa `??`; `CLICK_TRACKING_SECRET=` vazio vira `""` e lança exceção em todo envio rastreado e redirect (`src/lib/click-tracking.server.ts:13-19`).
- Trocar por `||` e validar no boot (falhar o deploy, não o tráfego).
- **Aceite:** teste unitário cobre variável vazia, ausente e curta.

**✅ CON-03 — Replay de webhook sem bloqueio de cabeça de fila**
- `webhook-replay.ts` seleciona os 20 mais antigos `recebido/erro` sem contador; 20 erros permanentes travam o backlog.
- Adicionar em `webhook_logs`: `replay_attempts`, `next_replay_at`, `dead_lettered_at`; backoff exponencial; DLQ após 5 tentativas; seleção por `next_replay_at` com distribuição por tenant; idade mínima de 2 min; claim com `FOR UPDATE SKIP LOCKED` via RPC.
- Índice parcial `webhook_logs (next_replay_at) WHERE status IN ('recebido','erro') AND dead_lettered_at IS NULL`.
- **Aceite:** teste com evento envenenado não impede o processamento dos seguintes.

**✅ CON-04 — Evento perdido como "duplicado"**
- Quando `claim_webhook_event` não devolve recibo porque outro processamento está em andamento (< 10 min), o log é marcado `duplicado` e responde 200 (`src/lib/webhook-process.server.ts:195-197`). O replay ignora `duplicado`; se o processamento original morreu, o evento some.
- Diferenciar "já processado" (200, `duplicado`) de "em processamento" (409/503, log continua elegível ao replay).
- **Aceite:** teste de crash após claim seguido de retry processa o evento uma vez.

**✅ CON-05 — Rótulos e valores de jornada (decisão de produto)**
- Remover "Depósitos operacionais" e qualquer valor operacional das telas de jornada.
- Renomear "Recuperado operacional" (`src/components/journeys/journeys-hub.tsx:560`) para **"Recuperado atribuído"** — o valor já vem de `conversion_attributions` direct.
- Esconder o seletor Hoje/7/30 dias da lista até ele filtrar no servidor.
- Corrigir o modal "Como a conta é feita": janela de 7 dias, não 24 h.
- **Aceite:** nenhuma tela de jornada exibe valor sem grau A; textos coerentes com o atribuidor.

**✅ CON-06 — Teste de regressão do trigger de nível**
- O bug de UUIDs foi corrigido em `20261014200000`, sem teste.
- Teste SQL (ou integração contra banco local) que cria jornada de nível, deposita e valida `journey_events`/`journey_enrollments`.

**✅ CON-07 — Documentação obsoleta**
- Atualizar `CONTRATO_RASTREAMENTO_CLIQUE_WEBHOOK.md`: `bl_click_id` não é mais a chave; identidade = clique first-party → dispatch → player + `player_external_id` no webhook.
- Marcar na auditoria os itens `[x]` que valem só para Sorte Alta.

---

**✅ SEC-01 — Correção de permissões (achados F1–F4 do CON-08)**
- Migration `20261015100000_fix_rls_privilege_escalation.sql`, rollback e matriz em `supabase/tests/rls/`; detalhes em `SEC-01_CORRECAO_PERMISSOES.md`.
- Membros perdem escrita em créditos/preços de SMS, depósitos, saques e auditoria; `user_roles` só escrito pelo super admin; tabelas com credenciais restritas; `anon` sem escrita.
- Matriz: 2.560 diferenças, todas intencionais e restritas às 16 tabelas alvo.
- Exige deploy de `whatsapp-proxies.functions.ts` junto ou antes da migration.

### Fase C — Integridade do envio (semana 1–2) — 🟡 código pronto (🟡 = aguardando migration + deploy)

**🟡 ENV-01 — Lease explícito, prazo e exclusão mútua no dispatcher**
- Hoje: lease implícito de 10 min (`claimed_at < now()-10min`), `recover_orphaned_journey_claims` no início de cada tick, execuções de 16–29 min observadas e pg_net desistindo em 55 s enquanto o Node continua.
- Mudanças:
  - `lease_expires_at` e `claimed_by` por item; renovação durante o processamento;
  - orçamento de tempo por execução (~45 s); itens não iniciados são devolvidos;
  - `pg_try_advisory_lock` por shard de worker para impedir sobreposição;
  - pool contínuo de concorrência no lugar das ondas `Promise.all` (`src/lib/journeys.server.ts:834-836`);
  - alinhar `.env.example`/`docs/docker-deployment.md` (40) com o teto real (12) ou parametrizar de verdade.
- **Aceite:** dois workers concorrentes + kill no meio do lote = zero duplicidade, zero item perdido.

**🟡 ENV-02 — `already_sent` na reserva**
- `reserve_journey_delivery` não verifica execução `sent` para (enrollment, step_position, loop_iteration). Falha após aceite do provedor reenvia o passo.
- A reserva retorna `already_sent` e avança a posição.
- Chave de idempotência estável repassada a: SMS (`external_id`), billing (`billingReferenceId` hoje novo a cada chamada em `src/lib/sms.functions.ts`), voz (`src/lib/infobip-voice.server.ts` gera UUID novo) e e-mail.
- **Aceite:** teste "provedor aceitou → commit falhou → retry" não gera segundo envio nem segunda cobrança.

**🟡 ENV-03 — Reserva com custo constante**
- Substituir `count(*)` diário por contador materializado por (tenant, journey, channel, dia).
- Índices: `journey_step_executions (tenant_id, channel, player_id, created_at)` ou `player_id` desnormalizado; `sms_send_logs (tenant_id, player_id, created_at)`; `email_send_logs (tenant_id, player_id, created_at)`.
- **Aceite:** tempo da RPC estável com 10x o histórico atual.

**🟡 ENV-04 — Rate limit por provedor e por tenant (seção 5)**
- Tabela `channel_rate_limits (provider, channel, tenant_id null = global, per_second, max_concurrency)`.
- Token bucket aplicado em jornadas e campanhas (hoje jornadas não chamam `consumeBudget`).
- 429/402/5xx do provedor: adiar o item e pausar o canal do tenant, sem consumir tentativa. Hoje 3 falhas tornam a inscrição `failed` definitiva.
- **Aceite:** provedor simulado fora por 10 min não gera nenhuma inscrição `failed`.

**🟡 ENV-05 — Justiça entre tenants**
- Claim do dispatcher, do scanner, das campanhas e do replay com cota por tenant (`LATERAL ... LIMIT k` por tenant ou round-robin ponderado).
- **Aceite:** tenant com 10k itens não aumenta a idade p95 da fila de um tenant com 100 itens.

**🟡 ENV-06 — Campanha: enviar aos resolvidos, reportar os demais (decisão de produto)**
- Resolução hoje carrega players com `.range(0, 49_999)` sem ORDER (`src/lib/sms-dispatcher.server.ts:814`, `src/lib/sms.functions.ts:1023` e `:1846`): risco de falso "não cadastrado" acima do limite e de `max_rows` do PostgREST.
- Resolver por `telefone_normalizado = ANY($1)` com índice `players (tenant_id, telefone_normalizado)`.
- Persistir destinatários não resolvidos com motivo (`sem_cadastro`, `telefone_invalido`, `sem_consentimento`).
- Composer: aviso antes do envio "N destinatários sem cadastro não receberão".
- Relatório: card "Não enviados (N)" com motivo e exportação CSV.
- Campanha só falha inteira se **nenhum** destinatário resolver.
- **Aceite:** campanha com 5% não resolvidos envia 95% e lista os 5%.

**🟡 ENV-07 — Campanhas: vazão e dedupe**
- `ROUNDS_PER_MINUTE = 12` supõe ticks de 5 s, mas o cron roda 1×/min (`src/lib/sms-dispatcher.server.ts:770`). Unificar campanhas no mesmo modelo de worker/rate limit das jornadas.
- Dedupe compara template cru com `preparedContent` renderizado: nunca deduplica com links rastreados. Deduplicar por (campanha, player).
- Cursor avança antes do envio: mover para depois do registro do envio.
- Passar `deliveryKey` estável nos envios de campanha.

**🟡 ENV-09 — Entrada imediata na jornada (decisão de produto de 15/10: sem "elegível aguardando")**
- ✅ Parte 1 (commit `3d2835f`): webhook inscreve na hora em jornadas de evento — cadastro → cadastrados sem depósito; depósito pendente → PIX não pago; depósito aprovado → primeiro depósito, quase VIP, reativação, alto potencial; saques → saque pago. Mesmas regras do scanner (matcher, `start_after`, público, cooldown, `entry_key`), mesmo escopo canário; desligável com `JOURNEYS_EVENT_ENTRY_ENABLED=false`.
- ✅ Correção junto: scans de PIX/saque falhavam sempre com `fetch failed` (500 ids na URL); agora em lotes de 100. Antes disso, `start_after` foi aplicado nas 6 jornadas de PIX/saque para impedir disparo ao histórico.
- ✅ Lista de jornadas: "Elegíveis agora"/"Na fila" substituídos por "Em andamento"/"Concluíram"; etapas em resumo de uma linha.
- 🟡 Parte 2 (código pronto, aguarda migration 112000 + deploy): gatilhos de tempo (inatividade, sem login N dias, VIP esfriando…) entram no minuto em que cruzam o limiar, por janela incremental indexada; scanner completo vira rede de segurança que conta "entradas tardias".
- ⏳ Ativação de jornada com escolha explícita: "somente novos" (grava `start_after`) ou "incluir quem já cumpre hoje (N)".
- Pendência de produto: jornadas "Cashback — Reativação Automática" nunca inscrevem (não há regra de entrada para `cashback_pago`).

**ENV-08 — Scanner** _(substituído em grande parte pelo ENV-09)_
- Um scan por tenant avaliando todas as jornadas no mesmo lote, colunas explícitas no lugar de `select *`, índice `players (tenant_id, id)` para o cursor.
- `sync_journey_scan_jobs` só altera jobs que mudaram (hoje faz upsert de todas as jornadas a cada minuto).
- Workers de scanner em processo próprio (Fase D).

---

### Fase D — Desacoplar ledger e webhooks (semana 2–3)

Ferramenta: **Supabase Queues (pgmq)** como fila durável inicial, sem novo fornecedor. Migração para SQS somente se o banco voltar a ser gargalo.

**WHK-01 — Jornada fora da transação do depósito**
- `record_financial_webhook_event` atualiza `players.total_depositado`, que dispara `trg_players_journey_level_transition` (`20261008231000:151`) com UPDATE/INSERT em `journey_enrollments`/`journey_events` na mesma transação. Lock, FK ou timeout ali desfaz o depósito.
- O trigger passa a apenas publicar mensagem `level_changed` em fila (`pgmq.send`); worker aplica a transição.
- **Aceite:** falha forçada na lógica de nível não impede o registro do depósito; transição é reprocessada.

**WHK-02 — Webhook com ACK rápido**
- Rota valida autenticação, grava em `webhook_inbox` (unique por tenant + provider_event_id) e responde 202.
- Worker consome com visibility timeout e chama **um RPC transacional** `ingest_webhook_event` (player + ledger + recibo). Hoje são ~17–22 chamadas PostgREST sequenciais por depósito.
- Efeitos colaterais (atribuição, fluxos, mirror CRM_EXPERT, invalidação de cache) viram mensagens separadas.
- Falhas de processamento deixam de responder 200 `ok:false`; o retry passa a ser do worker.
- **Aceite:** ACK p95 < 2 s com 10x o pico atual; zero evento perdido em kill do worker.

**WHK-03 — Contrato de identidade por tenant**
- `resolveExternalId` escolhe o primeiro campo não vazio (`data.id` antes de `user.id`) — risco de player fantasma em casas com payload diferente (`src/lib/webhook-process.server.ts:1055-1077`).
- `tenants.webhook_contract` com caminho explícito do identificador e do timestamp do evento.
- Fixtures reais anonimizadas de ForrandoBet e PixReals; certificação como na Sorte Alta.

**WHK-04 — Eventos fora de ordem**
- Cadastro após login/depósito preenche campos placeholder (`COALESCE`/"Novo player"); `ultimo_login` e afins com `greatest()`.

**WHK-05 — HMAC utilizável em produção**
- Modo `monitor`: valida e registra `signature_valid` sem rejeitar — permite certificar a casa antes de exigir.
- Timestamp assinado com tolerância de ±5 min (anti-replay).
- `webhook_secret_previous` para rotação sem janela de falha.
- Falhar fechado quando `enforced=true` e segredo ausente.
- Segredos no Supabase Vault.
- Corrigir mojibake "assinatura invÃ¡lida".

**WHK-06 — Atribuição assíncrona**
- Consumidor da fila; atribuir apenas cadastro e depósitos; não gravar `conversion_attribution_issues` para login/jogo (hoje uma linha por login).
- Reavaliar conversões recentes quando um clique chegar depois do webhook (janela curta).
- `landing_captured_at` com `least()`; `isFtd` derivado do ledger.

---

### Fase E — Cobertura e eficiência do tracking (semana 2–4)

**TRK-01 — Rastrear separado de encurtar**
- O redirect first-party só existe quando `shortio_settings.enabled` (`src/lib/shortio.server.ts:451-457`); apenas Sorte Alta tem registro.
- Configuração `click_tracking_enabled` por tenant, ligada por padrão; encurtamento é opcional.
- Ativar ForrandoBet e PixReals com domínio de cada casa.
- **Aceite:** todo tenant ativo gera `click_events`.

**TRK-02 — Short.io em lote e fora do caminho síncrono**
- Hoje: 1 chamada por destinatário/URL, até 3×10 s, DNS e 3 escritas, antes da reserva de crédito.
- Usar criação em lote (até 1.000 links por chamada) para o lote do dispatcher antes do envio; links criados somente após reserva.
- Orçamento global de req/s compartilhado entre tenants (50 req/s do contrato; operar a 40).
- E-mail usa o redirect direto, sem Short.io.

**TRK-03 — Sync Short.io por stream, não por link**
- Substituir polling O(n links) por `POST /statistics/domain/{id}/last_clicks` paginado por domínio (traz `dt` exato, UA e `human`).
- Corrigir descoberta de tenants (`limit 10000` sem DISTINCT/ORDER em `src/lib/shortio.server.ts:680-689`).
- Parar de gravar início de bucket em `shortio_*_clicked_at`; renomear/remover colunas e índice.
- Uso: reconciliação e classificação de bot. Fonte de verdade continua `click_events`.
- Arquivar em lote links com mais de 30 dias.

**TRK-04 — Redirect independente do Postgres**
- Worker Cloudflare dedicado ao redirect, separado do CRM.
- Destino resolvido a partir do token assinado (ou KV); 302 imediato.
- Clique publicado em Cloudflare Queues com `occurred_at` capturado na borda; consumidor insere em lote em `click_events`.
- **Aceite:** com o banco indisponível, o redirect continua respondendo e os cliques são gravados depois.

**TRK-05 — Keyring de assinatura**
- Formato `kid.assinatura`, verificação com N chaves ativas, chave separada para hash de IP/UA, desacoplada de `CRON_SECRET`.

**TRK-06 — Bots, previews e abuso**
- Sem User-Agent, HEAD, sem `Accept-Language` ou clique < 3 s após `sent_at` = suspeito (não humano).
- Rate limit no Cloudflare para a rota de clique.
- Dedupe por (dispatch, ip_hash, ua_hash, janela de 10 s).
- Agregado em `link_dispatches` atualizado só no primeiro clique.

---

### Fase F — Relatórios e UX (semana 3–4, CON-05 antecipado)

**REP-01 — Agregação no banco**
- `getConversionReport`, `getJourneyReportDetails` e `getConversionDataHealth` leem linhas sem limite e contam no Node; `.in()` com milhares de UUIDs (risco de truncamento por `max_rows` e de URL longa).
- RPCs agregadas agora; em seguida read model `source_metrics_daily (tenant, source_type, source_id, step, channel, day)` atualizado incrementalmente.
- Relatórios e dashboard lidos da Read Replica quando ativada.

**REP-02 — Definição única entre lista e relatório**

| Métrica                 | Fonte                                       | Exibição                                 |
| ----------------------- | ------------------------------------------- | ---------------------------------------- |
| Elegíveis (estimativa)  | snapshot do scanner + `calculated_at`       | igual nas duas telas                     |
| Fila                    | `journey_enrollments`                       | pronta · futura · pausada · retry        |
| Enviados (canal)        | execução/log do canal                       | sempre                                   |
| Enviados rastreados     | `link_dispatches`                           | separado de enviados                     |
| Cliques confirmados (A) | `click_events` humanos                      | métrica principal de clique              |
| Cliques observados (B)  | Short.io                                    | somente diagnóstico/admin                |
| Recuperado atribuído (A)| `conversion_attributions` direct            | único valor financeiro em jornadas       |

- Campanha: remover `max(rastreado, operacional)` e a substituição do total pela amostra de 500 (`conversion-report.tsx:288-289`); totais sempre do servidor.

**REP-03 — Frescor e evidência**
- Rodapé por bloco: "Atualizado há X · fonte".
- Estado "atualizando" após 5 min, sem tom de alerta.
- Selo A/B/C/D nos cards de resultado.
- Relatório em dois blocos: **Operação da jornada** e **Resultado atribuível**.
- Códigos técnicos (`missing_token`, `dispatch_stuck`) somente em admin.

**REP-04 — Drill-down**
- Lead mascarado (`Jo*** · …4f2a`), origem, degrau, canal, enviado → clique → login → depósito com deltas, janela aplicada, grau, motivo de não atribuição.
- Paginação por cursor no servidor (hoje corte fixo de 200).
- Remover `tracking_token` do CSV.

**REP-05 — Custo de leitura**
- `staleTime` ≥ 60 s nas listas; contadores por jornada/degrau mantidos pelo worker.
- `refresh_recent_dashboard_metrics`: um job por tenant, com `EXCEPTION` por tenant, lock e orçamento de tempo (hoje série única com `statement_timeout=0`).
- Fora de jornadas, mas mesmo princípio: dashboard inicial deixa de apresentar depósito operacional como "CRM recuperou" com ROI.
- **Realtime (NOVO-B do baseline, ~22% do tempo medido):** retirar `sms_send_logs`, `webhook_logs`, `events`, `players`, `deposits` e `sessions` da publicação `supabase_realtime`; telas passam a polling com `staleTime`/`refetchInterval` ≥ 60 s ou Broadcast. Acaba com o refetch em cascata das estatísticas de histórico durante campanhas.
- Lista de players com `count: "planned"` e busca com trigram no lugar de `count: "exact"` + `ILIKE`.

**REP-06 — Acessibilidade mínima**
- Overlay do relatório com `role="dialog"` e foco gerenciado; `aria-label` em ícones; status não só por cor; contraste dos textos `text-[11px]`.

---

### Fase G — Retenção e escala (semana 4+)

**ESC-01 — Workers como processos dedicados no VPS**: dispatcher, consumidor de webhook, consumidor de atribuição/nível, scanner, conectando via Supavisor (modo transação), fora do pool do PostgREST.
**ESC-02 — Retenção e particionamento**: `webhook_logs`, `financial_webhook_attempts`, `click_events`, `link_click_snapshots`, `conversion_attribution_issues` por mês; payload bruto arquivado em Cloudflare R2; um único armazenamento de payload (hoje 4 cópias).
**ESC-03 — Read Replica** para relatórios e dashboard.
**ESC-04 — Teste de carga** (k6) com 10, 50 e 100 tenants simulados; E2E (Playwright) envio → clique → login → depósito.
**ESC-05 — Avaliar Inngest/Trigger.dev** (spike de 2 dias) como alternativa a manter fila, fairness e retry próprios.

## 5. TPS inicial (configurável)

| Canal  | Global                  | Por tenant           | Em erro do provedor                     |
| ------ | ----------------------- | -------------------- | --------------------------------------- |
| SMS    | 15 msg/s (900/min)      | 5 msg/s              | 429/5xx: adiar 60 s; 402: pausar canal  |
| E-mail | 10 msg/s                | 4 msg/s              | idem                                    |
| Voz    | 5 chamadas simultâneas  | 2 simultâneas        | idem                                    |
| Short.io API | 40 req/s          | compartilhado        | 429: respeitar `retry-after`            |

Valores ficam em tabela, alteráveis sem deploy. Revisar após 7 dias de operação com dados de OBS-05.

## 6. QA

### Matriz obrigatória (além da seção 6.3 da auditoria)

- `CLICK_TRACKING_SECRET` vazio, ausente e curto;
- dois workers + kill após claim, após aceite do provedor e antes do commit;
- provedor 429/402/timeout por 10 min;
- tenant ruidoso (10k) + tenant pequeno (100): idade da fila do pequeno;
- campanha com destinatários não resolvidos, tenant com > 1k e > 50k players;
- webhook: duplicado, em processamento, fora de ordem (login → cadastro), envenenado no replay;
- falha forçada na lógica de nível durante depósito;
- HMAC: monitor, exigido, ausente, inválido, rotacionado, replay fora da janela;
- redirect com banco indisponível; token de outro tenant; preview de SMS sem UA;
- relatório com > 1.000 dispatches (sem truncamento).

### Gates de release por fase

- **A:** alertas disparando em homologação; linha de base anexada.
- **B:** testes de CON-02/03/04/06 verdes; nenhuma tela de jornada com valor operacional.
- **C:** zero duplicidade e zero perda no teste de falha; fairness comprovada.
- **D:** depósito independente de jornada comprovado por teste; ACK p95 < 2 s.
- **E:** todos os tenants ativos com `click_events`; redirect funciona sem banco.
- **F:** números iguais entre lista, relatório e consulta SQL de referência.
- **G:** soak de 60 min dentro dos SLOs com 50 tenants simulados.

## 7. Dependências externas e responsáveis

| Dependência                                   | Responsável sugerido | Bloqueia     |
| --------------------------------------------- | -------------------- | ------------ |
| Segredo HMAC e formato de assinatura por casa | Integrações/cassino  | WHK-05       |
| Fixtures reais ForrandoBet/PixReals           | Integrações          | WHK-03       |
| Domínio de redirect/Short.io por casa         | Operação             | TRK-01       |
| Cloudflare Workers Paid + Queues + KV         | Infra                | TRK-04       |
| Publicação no VPS (pendência do STATUS P0)    | Infra                | todas        |
| Confirmação de `max_rows` do PostgREST        | Infra                | REP-01/ENV-06|
| TPS contratual dos provedores                 | Comercial            | ajuste de §5 |

## 8. Riscos

- **Sentry free:** cota de eventos/spans pode estourar com sampling alto; manter 10% e filtrar ruído.
- **Better Stack free:** número de monitores limitado; priorizar redirect, webhook e heartbeats do dispatcher e do replay.
- **pgmq no mesmo Postgres:** alivia o HTTP, não a CPU; monitorar após WHK-02 e decidir sobre SQS.
- **Mudança de semântica visível:** números vão cair quando valores operacionais saírem das jornadas; comunicar aos usuários antes do deploy.
- **Migrations em tabelas grandes:** sempre `CONCURRENTLY`, `NOT VALID` + `VALIDATE` e fora de pico.

## 9. Definition of Done

- Depósito nunca falha por jornada, nível ou atribuição.
- Zero envio duplicado e zero perda nos testes de falha.
- Fila pronta p95 < 5 min sob carga de 50 tenants, sem tenant ruidoso afetando os demais.
- Todos os tenants ativos com clique confirmado; redirect independente do banco.
- Jornadas exibem somente valor atribuído (grau A), com frescor e definição visíveis.
- Campanhas enviam aos resolvidos e reportam os não resolvidos.
- Todo job crítico com heartbeat, alerta e reprocessamento seguro.
- CPU do banco < 60% sustentado, com top queries documentadas.
