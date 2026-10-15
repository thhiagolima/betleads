# Baseline do banco: pós-upgrade Small → Large (OBS-01)

**Data:** 14/10/2026 (coleta 22:36–22:50 BRT)
**Item do escopo:** OBS-01 (`ESCOPO_ESCALA_TRACKING_ATRIBUICAO_2026-10-14.md`, Fase A)
**Projeto:** `fnonshammxhurrwwqkcp` (PostgreSQL 17.6, região ca-central-1)
**Status:** baseline parcial. Os dados de SQL estão completos. CPU e RAM por 24 h, Index Advisor e Performance Advisor ficaram pendentes (seção 9).

---

## 1. Método e janela de tempo

| Item | Valor |
| --- | --- |
| Acesso | Somente leitura (`default_transaction_read_only=on`, `statement_timeout=15s`), via pooler Supavisor em modo sessão. O host direto `db.<ref>.supabase.co` falhou com `ENOTFOUND` (IPv6). |
| Ferramentas | Script Node `pg` no scratchpad e `npx supabase inspect db bloat/db-stats` (CLI 2.119). Nenhuma escrita, DDL, VACUUM/ANALYZE ou reset. |
| Restart do Postgres (upgrade) | `pg_postmaster_start_time` = **14/10 22:10 BRT** (01:10 UTC de 15/10) |
| `pg_stat_statements` | `stats_reset` = **02/10 13:47 BRT**; `dealloc=0`; `track=top`; `track_planning=off`; `save=on`. As estatísticas **sobreviveram ao restart**. |
| Janela efetiva dos dados cumulativos | **02/10 13:47 → 14/10 22:37 BRT (~12,4 dias)**. Cerca de 99,8% da janela é do compute **Small**, então os números descrevem a carga que levou a CPU a 94%. |
| Janela pós-upgrade | Amostra delta de 300 s (14/10 22:42–22:47 BRT), em horário de vale, cerca de 30 min após o restart |
| `pg_stat_database` / `pg_stat_user_tables` | Cumulativos desde o reset de 02/10 (`stats_reset` nulo no nível do banco; bgwriter/WAL/checkpointer resetados em 02/10 13:47) |

**Limitações conhecidas (afetam a leitura):**
- `pg_stat_statements` **não registra statements cancelados** (timeout ou erro). As queries do papel `authenticated` batem no `statement_timeout=8s` (os `max_ms` aparecem agrupados entre 7,8 e 7,99 s). O custo real dessas queries é **maior** que o medido (inferido).
- `track=top`: o custo interno das funções aparece agregado na chamada PostgREST (`LATERAL "public"."fn"(...)`). Por isso as queries internas foram analisadas com `EXPLAIN (ANALYZE, BUFFERS)` de leitura.
- CPU do walsender/decodificação lógica do Realtime, PostgREST, Supavisor e pg_net não aparece em `pg_stat_statements`.

---

## 2. Snapshot de capacidade (Large)

| Parâmetro | Valor |
| --- | --- |
| `max_connections` | 160 |
| `shared_buffers` / `effective_cache_size` | 2 GB / 6 GB |
| `work_mem` / `maintenance_work_mem` | 12 MB / 512 MB |
| `max_worker_processes` / `max_parallel_workers` | 6 / 2 |
| `wal_buffers` / `max_wal_size` / `checkpoint_timeout` | 16 MB / 4 GB / 300 s |
| Timeouts por papel | `authenticated` 8 s, `anon` 3 s, `authenticator` 8 s (+ `lock_timeout` 8 s) |
| `temp_file_limit` | ilimitado (-1) |
| Tamanho do banco | 1.991 MB (tabelas 1.033 MB, índices 512 MB) |
| Extensões | pg_cron 1.6.4, pg_net 0.20.4, pg_stat_statements 1.11, pgcrypto, supabase_vault, uuid-ossp. **`index_advisor` não instalado.** |

### 2.1 Indicadores no momento da coleta

| Indicador | Valor | Observação |
| --- | --- | --- |
| Conexões cliente | 12–14 (8 PostgREST idle, Supavisor, exporter) | 160 disponíveis; uso < 10% |
| Backends ativos (amostra de 5 s por 300 s) | média 0,00, máx. 0 | Vale noturno |
| Carga de execução pós-upgrade (delta 300 s) | 2,5 s de execução em 301 s = **0,008 backend ocupado** | Vale; não serve como pico |
| Long-running (> 5 s) | 0 | |
| Locks aguardando / bloqueios | 0 / 0 | |
| Replication slots | 0 | **Realtime sem slot após o restart** (`list_changes` também não apareceu no delta). Verificar se o Realtime reconectou. Hipótese, não confirmada. |
| Cache hit (banco, desde 02/10) | **99,90%** | |
| Cache hit tabelas / índices | 99,26% / 99,74% | Saudável; o problema não é I/O |
| Temp files (desde 02/10) | **9.604 arquivos, 23 GB** | ~775 arquivos e 1,9 GB/dia; principais geradores na seção 3.3 |
| Deadlocks / conflitos | 0 / 0 | |
| Rollbacks | 836 mil de 7,35 milhões de xacts (**11,4%**) | Alto; inclui timeouts e erros de RPC (inferido) |
| WAL gerado (desde 02/10) | 12,96 GB (~1 GB/dia); `wal_buffers_full`=12,3 milhões | |
| Checkpoints | 3.554 programados, 19 requisitados | Saudável |

### 2.2 Carga total medida em `pg_stat_statements` (12,4 dias, Small)

| Papel | Chamadas | Tempo de execução | % |
| --- | --- | --- | --- |
| `authenticated` (telas do CRM via PostgREST + RLS) | 160.806 | 7,25 h | **44,1%** |
| `service_role` (workers, webhooks, dispatcher) | 7.948.227 | 4,90 h | 29,8% |
| `supabase_admin` (Realtime `list_changes`) | 1.301.426 | 3,61 h | **22,0%** |
| `postgres` (pg_cron, pg_net) | 266.879 | 0,59 h | 3,6% |
| Demais | | 0,09 h | 0,5% |
| **Total** | 9,88 milhões | **16,44 h** | |

**Leitura:** 16,44 h de execução em 297 h de relógio equivalem, em média, a **0,055 backend ocupado** (cerca de 3% de 2 vCPU). Os 94% de CPU no Small **não vêm de carga média sustentada de SQL**. As causas prováveis, todas inferidas, são:
1. **picos concentrados** de telas do CRM: queries de 1–8 s com RLS por linha, disparadas em rajada pelo Realtime (seção 4, achado 1);
2. CPU fora do `pg_stat_statements`: decodificação lógica do Realtime sobre tabelas de alta escrita, PostgREST/JSON e pg_net;
3. Small = t3a.small **burstable**: com os créditos esgotados, a CPU satura com pouca carga real.

A confirmação depende do gráfico de CPU por hora (pendência P1, seção 9).

---

## 3. Queries mais pesadas

Texto normalizado e truncado, sem literais. `rows` = linhas devolvidas por chamada (PostgREST agrega em 1 linha JSON).

### 3.1 Top 20 por tempo total

| # | Query (normalizada) | Chamadas | Tempo total | Média | Máx. | Origem no código | Ação proposta | Item |
|---|---|---|---|---|---|---|---|---|
| 1 | `SELECT … FROM realtime.list_changes($1,$2,$3,$4)` (supabase_admin) | 927.565 | 12.600 s (21,3%) | 13,6 ms | 11,6 s | Realtime `postgres_changes`: `use-realtime-invalidate.ts`, `sms.tsx:1415`, `history-shell.tsx:254`, `alertas.tsx:495-504`, `eventos.tsx:74`, WhatsApp | Tirar da publicação `supabase_realtime` as tabelas de alta escrita (`sms_send_logs`, `webhook_logs`, `events`, `players`, `deposits`, `sessions`) e trocar por polling com `staleTime`/`refetchInterval` (já existe em `sms.tsx`) ou Broadcast | **NOVO-B** (sugerido para REP-05) |
| 2 | `SELECT status, delivery_status, created_at FROM sms_send_logs WHERE created_at >= $1 AND created_at <= $2 ORDER BY created_at DESC LIMIT 50000` (authenticated, **sem `tenant_id`**) | 9.703 | 10.279 s (17,4%) | 1.059 ms | 7,98 s (timeout) | `src/lib/history.functions.ts:478` `fetchStatusRows`, chamada 2× por `getChannelHistoryStats` (janela atual e anterior) e invalidada pelo Realtime em `history-shell.tsx:254` | Filtrar `.eq("tenant_id")` explicitamente e agregar no banco (RPC `count … group by bucket`) em vez de trazer até 50 mil linhas; derrubar RLS por linha (NOVO-A) | REP-01, REP-05, NOVO-A |
| 3 | `SELECT <24 cols> FROM players WHERE tenant_id=$1 ORDER BY ultimo_login DESC NULLS LAST LIMIT/OFFSET` + `count(*)` exato (authenticated) | 1.227 | 4.901 s (8,3%) | **3.994 ms** | 7,86 s | `src/lib/players-list.functions.ts:369` (`count: "exact"`) | `count: "planned"`/`"estimated"` ou contador cacheado; RLS NOVO-A. **Sem RLS, o mesmo `count(*)` leva 8,6 ms** (EXPLAIN, seção 5) | NOVO-A, REP-05 |
| 4 | `SELECT created_at FROM sms_send_logs WHERE created_at BETWEEN $1 AND $2 ORDER BY created_at ASC LIMIT 50000` (authenticated, sem `tenant_id`) | 4.847 | 4.590 s (7,8%) | 947 ms | 7,99 s | `src/lib/history.functions.ts:828-834` (timeline) | Igual ao #2: RPC agregada por hora/dia com `tenant_id` | REP-01, NOVO-A |
| 5 | `UPDATE activation_runs SET error,finished_at,status WHERE status=$2 AND tenant_id=$3 AND started_at<$4` | 13.874 | 2.757 s (4,7%) | 199 ms | 7,3 s | `src/lib/orchestrator.server.ts:495-499` (limpeza de zumbis a cada tick do orquestrador) | Índice parcial `WHERE status='running'` (seção 6); rodar só quando houver `running` antigo. A média alta para tabela de 13 mil linhas sugere espera de lock (inferido) | ENV-01 |
| 6 | `record_financial_webhook_event(...)` | 76.572 | 1.907 s (3,2%) | 24,9 ms | 5,8 s | `src/lib/webhook-process.server.ts:353` | Inclui o trigger de nível de jornada na mesma transação (520 mil blocos sujos); tirar jornada da transação | WHK-01, WHK-02 |
| 7 | `select net.http_post(url, headers || vault secret, body)` (pg_cron) | 63.957 | 1.300 s (2,2%) | 20,3 ms | 3,3 s | `cron.job` 7, 8, 9, 14, 17, 20, 21, 22 | Leitura do `vault.decrypted_secrets` a cada tick; cron só acorda o worker (ESC-01) | ENV-01, ESC-01 |
| 8 | `reserve_sms_credits(...)` | 50.226 | 1.124 s (1,9%) | 22,4 ms | 6,5 s | `src/lib/sms.functions.ts:533` | Lock de linha do saldo por tenant (59 mil blocos sujos); reservar em lote por lote do dispatcher | ENV-02, ENV-04 |
| 9 | `players … WHERE tenant_id ORDER BY ultimo_deposito DESC NULLS LAST` + `count(*)` exato | 367 | 1.085 s | 2.958 ms | 6,7 s | `players-list.functions.ts` (ordenação alternativa) | Igual ao #3 | NOVO-A |
| 10 | `INSERT INTO sms_send_logs (...)` | 729.098 | 1.028 s | 1,4 ms | 6,0 s | dispatcher/campanhas (`sms-dispatcher.server.ts`, `sms.functions.ts`) | 10 índices na tabela (4 sem uso, seção 7); o custo por linha é baixo, mas o volume é alto. A publicação Realtime também incide | ENV-07, NOVO-B |
| 11 | `INSERT INTO webhook_logs (evento,payload,status,tenant_id)` | 123.903 | 864 s | 7,0 ms | 6,0 s | `src/lib/webhook-process.server.ts:26` | Payload jsonb grande (314 MB de heap); inbox e retenção | WHK-02, ESC-02 |
| 12 | `reserve_journey_delivery_with_contact_limits(...)` | 55.965 | 836 s | 14,9 ms | 6,6 s | `src/lib/journeys.server.ts:289` | **1.401 blocos por chamada (~11 MB lidos do cache)**: o cooldown faz join em `journey_enrollments` por `player_id` sem índice líder (EXPLAIN, seção 5), e há 6 `count(*)` de 24 h/7 d | **ENV-03** |
| 13 | `players … WHERE (nome/telefone/email/external_id ILIKE $) AND tenant_id` + `count(*)` | 135 | 821 s | **6.081 ms** | 7,5 s | busca em `players-list.functions.ts` | `pg_trgm`/GIN ou busca por prefixo normalizado; sem `count` exato | NOVO-A, REP-05 |
| 14 | `players_by_behavior_filters(...)` | 140 | 819 s | 5.849 ms | 7,9 s | `players-list.functions.ts:363/513/704/898` | Reescrever com `tenant_id` explícito e paginação no servidor | NOVO-A |
| 15 | `journey_eligible_lead_count(tenant, journey)` | 904 | 806 s | **892 ms** | 7,7 s | `src/lib/conversion-report.functions.ts:77` | `count(*)` sobre `players` a cada abertura de relatório; usar snapshot do scanner + `calculated_at` | REP-02, ENV-08 |
| 16 | `claim_webhook_event(...)` | 116.831 | 654 s | 5,6 ms | 6,7 s | `webhook-process.server.ts` | OK por chamada; volume | WHK-02 |
| 17 | `SELECT player_id FROM deposits WHERE player_id = ANY($1) AND status=$2` (authenticated, sem `tenant_id`) | 2.564 | 580 s | 226 ms | 4,9 s | `src/lib/history.functions.ts:565` `countConversions` | Adicionar `tenant_id` (todos os índices de `deposits` começam por `tenant_id`; hoje faz seq scan); mover para RPC | REP-01 |
| 18 | `SELECT player_id, created_at FROM sms_send_logs WHERE created_at BETWEEN … AND player_id IS NOT NULL LIMIT 5000` (sem `tenant_id`) | 2.714 | 530 s | 195 ms | 1,7 s | `src/lib/history.functions.ts:555` `countConversions` | Igual ao #17 | REP-01 |
| 19 | `INSERT INTO events (...)` | 87.280 | 523 s | 6,0 ms | 1,7 s | `webhook-process.server.ts` | Volume; partição e retenção | ESC-02 |
| 20 | `SELECT to_phone FROM sms_send_logs WHERE tenant_id AND content=$ AND status AND created_at>= AND to_phone = ANY($)` (service_role) | 952 | 517 s | 543 ms | 5,1 s | `src/lib/sms-dispatcher.server.ts:976` (dedupe de campanha) | Dedupe por (campanha, player), como previsto em ENV-07; elimina a comparação por `content` | **ENV-07** |

Fora do top 20, mas relevantes para os suspeitos do escopo:

| Query | Chamadas | Total | Média | Origem | Item |
|---|---|---|---|---|---|
| `refresh_dashboard_daily_metrics_range` (authenticated) | 146 | 449 s | 3.074 ms | Chamada removida do front em `c4dddd6` (dados históricos da janela) | REP-05 |
| `dashboard_summary_v2` | 162 | 353 s | 2.182 ms | `src/lib/dashboard.functions.ts:136` | REP-05 |
| `SELECT id,status,… FROM sms_send_logs WHERE tenant_id AND created_at… ORDER BY created_at DESC LIMIT/OFFSET` | 1.123 | 325 s | 290 ms (**58 mil blocos temp**) | `src/lib/sms.functions.ts:1366` (paginação por OFFSET) | REP-01 |
| `select public.refresh_recent_dashboard_metrics()` (cron 18) | 107 | 252 s | 2.357 ms (máx. 13 s) | `cron.job` 18; série única por tenant/dia com `statement_timeout=0` | **REP-05** |
| `resolve_sms_audience_v2` | 93 | 189 s | 2.033 ms (42 mil blocos temp) | `src/lib/sms-audiences.functions.ts:51/83` | ENV-06 |
| `INSERT link_click_snapshots` + `UPDATE tracked_links` + `SELECT tracked_links` (sync Short.io) | 63.720 + 63.091 + 21.414 | 177 + 170 + 188 s | 2,8 / 2,7 / 8,8 ms | `src/lib/shortio.server.ts` (sync por link) | **TRK-03** |
| `claim_due_journey_enrollments` | 1.185 | 101 s | 84,9 ms | dispatcher de jornadas | ENV-01, ENV-05 |
| `journey_metrics` / `list_journey_metrics` | 1.042 / 28 | 101 / 7 s | 96,5 / 259 ms | `conversion-report.functions.ts:73`, `journeys.functions.ts:91/467` | REP-01, REP-05 |
| `recover_orphaned_journey_claims` | 560 | 74 s | 131,5 ms | início de cada tick do dispatcher | ENV-01 |
| `claim_journey_scan_jobs` | 482 | 33 s | 68,6 ms | scanner | ENV-08 |
| Scanner `SELECT * FROM players WHERE tenant_id AND id > $ ORDER BY id` (service_role) | 1.179 + 379 | 41 + 147 s | 35–388 ms | `src/lib/journey-scanner.server.ts:163`, `journeys.server.ts:149` | **ENV-08** (colunas explícitas) |
| `SELECT name FROM pg_timezone_names` (authenticator) | 316 | 151 s | 479 ms | Introspecção de schema do PostgREST a cada reload | Reduzir reloads do schema cache (inferido) |

### 3.2 Top por tempo médio (mínimo de 20 chamadas)

| Query | Chamadas | Média | Máx. | Blocos/chamada | Origem |
|---|---|---|---|---|---|
| players busca ILIKE + count | 135 | 6.081 ms | 7,5 s | 80 mil | players-list |
| `players_by_behavior_filters` | 140 | 5.849 ms | 7,9 s | 64 mil | players-list |
| players `total_depositado >= $` + count | 24 | 5.304 ms | 7,9 s | 71 mil | players-list (filtro de faixa) |
| players faixa de depósito + count | 57 | 4.773 ms | 7,9 s | 142 mil | players-list |
| players lista padrão + count | 1.227 | 3.994 ms | 7,9 s | 63 mil | players-list:369 |
| `refresh_dashboard_daily_metrics_range` | 146 | 3.074 ms | 7,8 s | 290 mil | (removido em c4dddd6) |
| players por `ultimo_deposito` + count | 367 | 2.958 ms | 6,7 s | 20 mil | players-list |
| `refresh_recent_dashboard_metrics()` | 107 | 2.357 ms | 13,0 s | 122 mil | cron 18 |
| `dashboard_summary_v2` | 162 | 2.182 ms | 7,9 s | 135 mil | dashboard.functions.ts:136 |
| `resolve_sms_audience_v2` | 93 | 2.033 ms | 7,5 s | 6,8 mil + temp | sms-audiences |
| `withdrawals` lista (authenticated) | 24 | 1.984 ms | 3,7 s | 5 mil | tela de saques |
| `deposits` lista (authenticated) | 22 | 1.818 ms | 2,5 s | 4,7 mil | tela de depósitos |
| `admin_list_users_with_usage` | 21 | 1.588 ms | 6,6 s | 6,5 mil | admin |
| `sessions` lista (authenticated) | 24 | 1.547 ms | 2,7 s | 3,8 mil | tela de sessões |
| `webhook_logs` lista por tenant (service_role) | 94 / 95 | 1.184 / 1.156 ms | 8,0 / 6,6 s | 6 mil / 2,6 mil | `webhooks.functions.ts:141/175` |
| `sms_send_logs` stats (#2) | 9.703 | 1.059 ms | 8,0 s | 4,2 mil | history.functions.ts:478 |
| `journey_eligible_lead_count` | 904 | 892 ms | 7,7 s | 15 mil | conversion-report:77 |

Padrão dominante: **todas as listas `authenticated` sobre tabelas com RLS ficam entre 1,5 e 6 s**, mesmo com os índices certos. As mesmas consultas como `postgres` (sem RLS) rodam em milissegundos (seção 5).

### 3.3 Maiores geradores de arquivos temporários

| Query | Chamadas | Blocos temp escritos (8 kB) |
|---|---|---|
| `sms_send_logs` paginação por tenant (sms.functions.ts:1366) | 1.123 | 58.253 (~455 MB) |
| Consulta ad hoc `with sorte as materialized (… webhook_logs …)` | 1 | 46.420 |
| `resolve_sms_audience_v2` | 93 | 42.680 |
| `gamification_snapshot_v2` | 116 | 38.302 |
| `player_filter_contextual_facets_v1` | 74 | 22.454 |
| `realtime.list_changes` | 927.565 | 13.929 |

Os 23 GB acumulados em `temp_bytes` também incluem ordenações de manutenção (CREATE INDEX das migrations) que não aparecem com `track=top` (inferido).

---

## 4. Principais achados

1. **RLS avaliado por linha (NOVO-A, maior alavanca).** `players`, `sms_send_logs`, `deposits`, `webhook_logs` e `activation_runs` têm **3 políticas permissivas** cada. `tenant_isolation_guard` e `<tabela>_tenant_isolation` são idênticas. Elas chamam `has_tenant_access(tenant_id)`, `current_tenant_id()` (plpgsql que faz parse de `request.headers`) e `is_super_admin()` **sem `(select …)`**, então cada uma roda por linha. Evidências:
   - `user_roles` (11 linhas) com **143,5 milhões de seq scans e 1,13 bilhão de tuplas lidas**; `tenants` com 1,96 milhão de seq scans.
   - Mesmo `count(*)` de players do maior tenant (20.698 linhas): **8,6 ms sem RLS** contra média de **~4.000 ms** via PostgREST `authenticated`.
   - As queries de tela sem filtro `tenant_id` (#2, #4, #17, #18) não conseguem usar os índices `(tenant_id, created_at)`. O planner não deriva o tenant da função de RLS.
2. **Realtime sobre tabelas de alta escrita (NOVO-B).** A publicação inclui `sms_send_logs` (789 mil inserts), `webhook_logs`, `events`, `players` e `deposits`. Resultado: 22% do tempo medido, mais CPU de decodificação lógica fora do pgss (inferido). Além disso, `history-shell.tsx`/`sms.tsx` invalidam queries de estatística a cada mudança, o que realimenta o #2/#4 durante campanhas.
3. **Timeouts silenciosos.** Muitos `max_ms` entre 7,8 e 7,99 s indicam que parte das chamadas `authenticated` passa do limite de 8 s e é cancelada. Essas chamadas não entram no pgss, e a taxa de rollback é 11,4%.
4. **pg_net com timeout em massa antes do upgrade.** Em `net._http_response` (TTL de 6 h): **~210–340 timeouts por hora** entre 19h e 00h UTC contra 14 na primeira hora pós-upgrade (01h UTC, vale). Há também 108 respostas 502. O cron marca `succeeded` porque `net.http_post` é assíncrono: o `cron.job_run_details` **não mede a saúde real dos workers**.
5. **Reserva de jornada (ENV-03).** O custo vem do cooldown e dos limites de contato, mais que do `count(*)` diário. O `count(*)` diário usa index-only scan e roda em 5 ms; o cooldown varre o índice único `(journey_id, player_id, entry_key)` por `player_id` sem coluna líder (767 buffers).
6. **`refresh_tenant_daily_metric_day` não é sargável**: usa `(created_at at time zone 'America/Sao_Paulo')::date = _date` em `deposits`/`withdrawals`/`players`. Isso explica parte dos 1.175 seq scans de `deposits` (28,6 mil linhas por scan). O cron 18 teve **5 timeouts em 24 h** (17h UTC, máx. 121,8 s).
7. **Dispatcher de jornadas muito longo** (`dispatcher_runs`, 24 h): `journey` com média de **354 s** e máximo de **3.573 s**; `journey_scan` com média de 36,7 s e máximo de 633 s. Confirma o ENV-01.
8. **CON-01 confirmado:** `link_dispatches` com 1.306 seq scans de ~10,7 mil linhas (lookup por `tracking_token` sem `tenant_id`).

---

## 5. Evidência de EXPLAIN (somente leitura, `EXPLAIN (ANALYZE, BUFFERS)` como `postgres`)

| Consulta interna | Plano | Buffers | Tempo |
|---|---|---|---|
| Cooldown em `reserve_journey_delivery` (join `journey_step_executions` × `journey_enrollments` por `player_id`) | Index Scan em `journey_enrollments_journey_id_player_id_entry_key_key` usando só `player_id` (não líder) | 767 hits só nesse nó | 14 ms (amostra) |
| `count(*)` diário da reserva | Index Only Scan `journey_step_executions_daily_reservation_idx` | 124 | 5 ms |
| `count(*)` `sms_send_logs` por player em 7 d | Index Scan `idx_sms_send_logs_player` + filtro tenant/status/data | 4 | < 1 ms (cresce com o histórico do player) |
| `count(*)` voz em 7 d | Index Scan `daily_reservation_idx` (tenant, channel, created_at) | 139 | 15 ms (cresce com o volume de voz) |
| `count(*)` players do maior tenant | Index Only Scan `players_tenant_id_idx` | 1.346 | **8,6 ms** (contra ~4 s via RLS) |
| Zumbis de `activation_runs` | Index Scan `activation_runs_tenant_id_idx` + filtro status/started_at | ~850 de custo estimado | |

---

## 6. DDL proposto (**NÃO APLICADO**)

> Nada abaixo foi executado. Rodar fora de transação (o `CONCURRENTLY` exige isso), um índice por vez e fora de horário de pico. Validar com `EXPLAIN` antes e depois.

```sql
-- NÃO APLICADO — CON-01: lookup do redirect por token (1.306 seq scans em link_dispatches)
-- Pré-checagem: select tracking_token from public.link_dispatches group by 1 having count(*) > 1;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS link_dispatches_tracking_token_uidx
  ON public.link_dispatches (tracking_token);

-- NÃO APLICADO — ENV-03: cooldown/limites por player em reserve_journey_delivery
CREATE INDEX CONCURRENTLY IF NOT EXISTS journey_enrollments_tenant_player_idx
  ON public.journey_enrollments (tenant_id, player_id);

-- NÃO APLICADO — ENV-03: limites de contato 24h/7d por player
CREATE INDEX CONCURRENTLY IF NOT EXISTS sms_send_logs_tenant_player_created_idx
  ON public.sms_send_logs (tenant_id, player_id, created_at DESC)
  WHERE player_id IS NOT NULL;

-- NÃO APLICADO — ENV-03 (email_send_logs tem 3 linhas hoje; criar já para não crescer sem índice)
CREATE INDEX CONCURRENTLY IF NOT EXISTS email_send_logs_tenant_player_created_idx
  ON public.email_send_logs (tenant_id, player_id, created_at DESC)
  WHERE player_id IS NOT NULL;

-- NÃO APLICADO — ENV-01: limpeza de zumbis do orquestrador (#5)
CREATE INDEX CONCURRENTLY IF NOT EXISTS activation_runs_tenant_running_idx
  ON public.activation_runs (tenant_id, started_at)
  WHERE status = 'running';

-- NÃO APLICADO — FKs sem índice em journey_events (2.060 seq scans de ~43 mil linhas;
-- causa inferida: ON DELETE CASCADE/SET NULL vindo de journeys e journey_step_executions)
CREATE INDEX CONCURRENTLY IF NOT EXISTS journey_events_execution_idx
  ON public.journey_events (execution_id) WHERE execution_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS journey_events_journey_created_idx
  ON public.journey_events (journey_id, created_at DESC);
```

### 6.1 Reescrita de RLS proposta (NOVO-A, NÃO APLICADO, exige revisão de segurança)

Princípio da recomendação oficial do Supabase: envolver funções em `(select …)` para virar InitPlan (uma avaliação por query) e consolidar políticas duplicadas. **Atenção à semântica:** hoje o efeito é `has_tenant_access(tenant_id) OR tenant_id = current_tenant_id() OR is_super_admin()`. A forma abaixo preserva isso com um array de tenants calculado uma vez por query.

```sql
-- NÃO APLICADO — exemplo para public.players; repetir por tabela após teste em staging
CREATE OR REPLACE FUNCTION public.accessible_tenant_ids()
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(array_agg(tenant_id), '{}')
  FROM public.user_roles
  WHERE user_id = auth.uid() AND tenant_id IS NOT NULL
    AND role IN ('admin','gestor','member')
$$;

-- substituir players_tenant_isolation, tenant_isolation_guard e tenant_access_base por:
CREATE POLICY players_tenant_rls ON public.players FOR ALL TO authenticated
  USING (
    (select public.is_super_admin())
    OR tenant_id = ANY ((select public.accessible_tenant_ids()))
  )
  WITH CHECK (
    (select public.is_super_admin())
    OR tenant_id = ANY ((select public.accessible_tenant_ids()))
  );
```

Complemento obrigatório no código, sem depender de DDL: toda leitura `authenticated` deve passar `.eq("tenant_id", tenantId)` explicitamente. Os pontos principais são `history.functions.ts:478, 555, 565, 641, 828` e `send-window.functions.ts:86`.

---

## 7. Saúde das tabelas e índices

### 7.1 Tabelas grandes (desde 02/10)

| Tabela | Linhas (est.) | Total / heap / índices | Seq scans (média de linhas) | Idx scans | Dead % | Último autovacuum (UTC) | Observação |
|---|---|---|---|---|---|---|---|
| webhook_logs | 192.567 | 507 / 314 / 92 MB | 205 (65,6 mil) | 176.552 | 9,9% | 14/10 20:59 | bloat 1,2 (47 MB); payload jsonb. ESC-02 |
| sms_send_logs | 739.124 | 437 / 246 / **190 MB** | 68 (111 mil) | 52.370 | 0,0% | 14/10 16:57 | 10 índices, 4 sem uso (~77 MB) |
| events | 103.429 | 251 / 130 / 28 MB | 1 | 162.264 | 0,1% | 13/10 20:57 | `n_mod_since_analyze` 10.315 |
| deposits | 77.270 | 171 / 55 / 50 MB | **1.175 (28,6 mil)** | 228.380 | 0,4% | 15/10 00:26 | **bloat 2,6 (34 MB)**; índice duplicado |
| financial_webhook_attempts | 49.514 | 148 / 34 / 13 MB | 4 | 50.766 | 9,4% | 14/10 13:50 | TOAST grande (`raw_payload`) |
| link_click_snapshots | 55.772 | 121 / 111 / 10 MB | 5 | 75.067 | 2,2% | 15/10 00:36 | ~130 inserts/min no vale (TRK-03) |
| journey_enrollments | 48.262 | 38 / 19 / 19 MB | **1.802 (23 mil)** | 14,7 milhões | **15,8%** | 15/10 00:15 | 41 autovacuums; alto churn |
| players | 32.195 | 35 / 13 / 21 MB | 811 (11 mil) | 2,4 milhões | 2,8% | 14/10 23:59 | 17 índices |
| journey_events | 67.899 | 21 / 15 / 6 MB | **2.060 (43 mil)** | 23.683 | 0,0% | 14/10 23:49 | FKs sem índice (seção 6) |
| link_dispatches | 16.724 | 16 / 7 / 9 MB | **1.306 (10,7 mil)** | 169.033 | **12,6%** | 14/10 19:13 | CON-01 |
| journey_step_executions | 20.731 | 14 / 6 / 8 MB | 2.352 (304) | 153.858 | 1,4% | 15/10 00:40 | |
| dispatcher_runs | 46.339 | 12 / 9 / 4 MB | 168 (26 mil) | **6** | 0,0% | 14/10 08:42 | sem retenção (~4 mil/dia) |
| conversion_attribution_issues | 18.142 | 9 / 3 / 5 MB | 6 | 19.971 | 0,0% | 13/10 02:34 | ~1,5 mil/dia (WHK-06) |
| click_events | 274 | 0,5 MB | 13 | 3.441 | 0,0% | nunca | volume ainda irrelevante |
| webhook_event_receipts | 79.433 | 30 MB | 37 | 198.170 | **11,9%** | 13/10 21:00 | |
| cron.job_run_details | 68.831 | 47 MB | 11 | 275.332 | 7,8% | 14/10 17:50 | sem limpeza (~10 mil/dia) |
| user_roles | 11 | | **143,5 milhões (8)** | 13,8 milhões | | | Sintoma do RLS (NOVO-A) |

`autovacuum_vacuum_scale_factor=0,2` (padrão). Nenhuma tabela tem `reloptions` próprio. Para `journey_enrollments`, `link_dispatches` e `webhook_event_receipts` (dead entre 12% e 16%), considerar `autovacuum_vacuum_scale_factor=0.05` por tabela (proposta, NÃO APLICADO).

### 7.2 Índices sem uso desde 02/10 (candidatos, NÃO APLICADO)

| Tabela | Índice | Tamanho | Recomendação |
|---|---|---|---|
| deposits | `deposits_tenant_status_created_idx` | 12 MB | **Duplicado exato** de `deposits_tenant_status_idx` `(tenant_id, status, created_at DESC)`; remover um |
| sms_send_logs | `idx_sms_send_logs_flow_created` | 43 MB | Coberto por `sms_send_logs_tenant_flow_player_created_idx`; candidato a remoção |
| sms_send_logs | `idx_sms_send_logs_idempotency_key` | 11 MB | 0 scans; validar uso no dispatcher antes |
| sms_send_logs | `idx_sms_send_logs_flow_lead` | 8 MB | candidato |
| sms_send_logs | `idx_sms_send_logs_provider_message_id` | 15 MB | **Manter**: usado em `sms-webhook.ts:201` (0 scans = sem callbacks com esse campo no período; inferido) |
| journey_enrollments | `journey_enrollments_tenant_player_due_idx` | 7,8 MB | Parcial (só active/waiting) e não atende o cooldown; substituir pelo índice da seção 6 |
| webhook_event_receipts | `webhook_event_receipts_status_idx` | 6,6 MB | candidato |
| players | `idx_players_ultimo_login`, `idx_players_status`, `idx_players_affiliate_id` | 2,5 MB | redundantes (sem `tenant_id`) |

```sql
-- NÃO APLICADO — remoções de baixo risco (manter rollback com o CREATE correspondente)
DROP INDEX CONCURRENTLY IF EXISTS public.deposits_tenant_status_created_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_sms_send_logs_flow_created;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_players_ultimo_login;
```

---

## 8. Saúde do pg_cron (últimas 24 h, até 14/10 22:38 BRT)

| jobid | Job | Agenda | Execuções | Falhas | Média (s) | Máx. (s) | Último status | Observação |
|---|---|---|---|---|---|---|---|---|
| 7 | dispatch-sms | `* * * * *` | 1.437 | 1 | 0,08 | 11,9 | succeeded | falha = `job startup timeout` |
| 8 | dispatch-email | `* * * * *` | 1.437 | 1 | 0,07 | 10,9 | succeeded | idem |
| 9 | automation-recovery | `*/2` | 718 | 1 | 0,09 | 11,9 | succeeded | idem |
| 10 | orchestrate-tenants | `*/5` | 287 | 0 | 0,08 | 1,9 | succeeded | gera o UPDATE #5 |
| 11 | meta-sync-worker | `*/5` | 287 | 0 | 0,07 | 1,9 | succeeded | |
| 14 | dispatch-call | `* * * * *` | 1.437 | 1 | 0,07 | 11,3 | succeeded | idem |
| 16 | reconcile-infobip-voice | `0 9 * * *` | 1 | 0 | 0,02 | 0,02 | succeeded | |
| 17 | scan-journeys | `* * * * *` | 789 | 1 | 0,10 | 11,6 | succeeded | |
| 18 | **refresh-dashboard-metrics** | `*/5` | 112 | **5** | **7,67** | **121,8** | succeeded | 5× `statement timeout` em `refresh_tenant_daily_metric_day` (17h UTC); depois disso, ~1,3 s |
| 20 | dispatch-journey | `* * * * *` | 460 | 0 | 0,02 | 0,07 | succeeded | job recente |
| 21 | shortio-sync | `* * * * *` | 433 | 0 | 0,02 | 0,21 | succeeded | |
| 22 | webhook-replay | `* * * * *` | 76 | 0 | 0,02 | 0,06 | succeeded | |
| 12, 13, 19 | (sem registro em `cron.job`) | n/d | 67 / 933 / 23 | 0 / 0 / 2 | | | 19 = failed | Jobs removidos hoje; histórico residual |

**Atenção:** "succeeded" nos jobs `net.http_post` só significa que a requisição foi enfileirada. Saúde real (de `net._http_response`, por hora UTC):

| Hora (UTC) | Timeout | 200 | 5xx |
|---|---|---|---|
| 14/10 19h (parcial, TTL 6 h) | 51 | 77 | 16 |
| 20h | 290 | 184 | 0 |
| 21h | 297 | 146 | 31 |
| 22h | 211 | 233 | 30 |
| 23h | 338 | 136 | 0 |
| 15/10 00h | 229 | 253 | 31 |
| 01h (pós-upgrade, vale) | 14 | 334 | 0 |

Duração real dos workers (`dispatcher_runs`, 24 h): sms média 6,8 s (máx. 390 s), email 8,1 s (máx. 572 s), **journey 354 s (máx. 3.573 s)**, journey_scan 36,7 s (máx. 633 s). A heartbeat real fica com OBS-04/OBS-05.

---

## 9. Pendências do OBS-01 (não coletadas nesta sessão)

| # | Pendência | Como coletar |
|---|---|---|
| P1 | CPU, RAM, IOPS e conexões **por 24 h** após o upgrade (até 15/10 22:10 BRT) | Dashboard → Reports → Database, ou endpoint Prometheus `https://<ref>.supabase.co/customer/v1/privileged/metrics` (exige service_role; não usado aqui) |
| P2 | Index Advisor / Performance Advisor | Dashboard → Advisors (extensão `index_advisor` não instalada) |
| P3 | Repetir este baseline em horário de pico (ex.: 15/10 às 20h BRT) | Reexecutar as consultas da seção 1; anotar `stats_reset` |
| P4 | Confirmar que o Realtime reconectou após o restart (0 replication slots e nenhum `list_changes` no delta) | Dashboard → Realtime → Inspector |
| P5 | Medir taxa de timeouts `authenticated` (não visível no pgss) | Logs do Postgres (`canceling statement due to statement timeout`) no Logs Explorer |

Recomendação operacional para medir o ganho das próximas fases: depois de coletar P1–P3, fazer `pg_stat_statements_reset()` (decisão do responsável; não executado aqui) e anotar a data e hora.

---

## 10. Meta de CPU revisada

- **Dado real:** a carga SQL medida equivale a ~0,055 backend ocupado em média em 12,4 dias (cerca de 3% de 2 vCPU). No vale pós-upgrade, a amostra deu 0,008. A meta de "< 60% sustentado" em média é folgada. **O risco está nos picos:** telas `authenticated` de 1–8 s em rajada, Realtime e pg_net com 200–340 timeouts por hora no Small.
- **Meta proposta (substitui "< 60% sustentado no Large"):**
  1. CPU **p95 por janela de 5 min < 60%** e **média diária < 35%** no Large, medidas nas 24 h de P1 e reavaliadas após NOVO-A e NOVO-B;
  2. **0 timeouts de `statement_timeout` em `authenticated` por hora** (P5);
  3. `net._http_response` com **timeout < 1% por hora**;
  4. nenhuma query `authenticated` com média > 500 ms entre as 20 maiores por tempo total.
- **Estimativa (inferida):** NOVO-A (RLS) e as RPCs agregadas de REP-01 removem a maior parte de ~45% do tempo medido. NOVO-B remove ~22% medido, mais a CPU de decodificação. Com isso, voltar ao Medium seria plausível, desde que validado com P1 pós-mudanças.

---

## 11. Ações priorizadas (impacto × risco)

| Prioridade | Ação | Ganho esperado | Item |
|---|---|---|---|
| 1 | Consolidar RLS em uma política por tabela com `(select …)` e passar `tenant_id` explícito nas leituras `authenticated` | ~44% do tempo medido; elimina timeouts de listas | **NOVO-A** (sugerido como CON-08) |
| 2 | Tirar `sms_send_logs`, `webhook_logs`, `events`, `players`, `deposits` e `sessions` da publicação Realtime; usar polling com `staleTime` ≥ 60 s | ~22% do tempo medido, mais CPU de WAL decoding; acaba com o refetch em cascata | **NOVO-B** (sugerido como REP-05) |
| 3 | Estatísticas e timeline de histórico como RPC agregada com `tenant_id` (`history.functions.ts`) | #2, #4, #17 e #18 (~27% do tempo medido) | REP-01 |
| 4 | Índices CON-01 e ENV-03 (seção 6) e contador materializado da reserva | redirect sem seq scan; reserva com custo constante | CON-01, ENV-03 |
| 5 | `refresh_tenant_daily_metric_day` sargável (intervalo `created_at >= dia_inicio AND < dia_fim`), um job por tenant com orçamento de tempo | fim dos timeouts do cron 18 e dos seq scans de `deposits` | REP-05 |
| 6 | Lista de players com `count: "planned"` e busca com trigram | #3, #9, #13, #14 | REP-05 / NOVO-A |
| 7 | Dedupe de campanha por (campanha, player) | #20 | ENV-07 |
| 8 | Retenção de `cron.job_run_details`, `dispatcher_runs` e `net._http_response`; partição de `webhook_logs` | crescimento contido | ESC-02 |
