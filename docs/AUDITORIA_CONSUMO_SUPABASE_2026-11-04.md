# Auditoria de consumo do Supabase

**Data:** 04/11/2026 (coleta 17h00–17h45 BRT)
**Projeto:** `fnonshammxhurrwwqkcp` (PostgreSQL 17.6, Large, ca-central-1)
**Comparação:** `BASELINE_BANCO_2026-10-14.md`
**Método:** somente leitura, via pooler em modo sessão, com `READ ONLY` na sessão. Nada foi alterado em produção: sem DDL, VACUUM, reset de estatísticas ou escrita.

---

## 1. Resumo

O banco **não está sobrecarregado por carga contínua de SQL**. Numa amostra de 5 min às 17h30, a execução somou 20 s, o que dá 0,07 backend ocupado em média e no máximo 2 queries ativas ao mesmo tempo. O "limite" vem de quatro fontes:

1. **Um job de CRM a cada 10 min** (`refresh_crm_results_recent`). Ele responde por **28% de todo o tempo de SQL** desde 02/10 e por **~1,66 TB de escrita em arquivo temporário**, cerca de 580 MB por execução. Leva de 30 a 50 s por rodada e satura disco e CPU nesses picos. Uma parte disso vem de um bug de tipo num join, já medido e com correção simples.
2. **Sync do Short.io.** A tabela `link_click_snapshots` tem **6,4 GB, 43% do banco**, e cresce ~120 mil linhas por dia. A coluna `payload` ocupa quase todo esse espaço e **nenhuma tela a lê**. O sync também gera o maior volume de WAL e de leituras de buffer.
3. **Varreduras de jornada a cada tick** (`sweep_dead_lead_revivals`, `sweep_journey_exits`). Elas reavaliam, a cada execução, todos os 25 mil leads mortos e todas as inscrições abertas. Somam centenas de milhões de lookups de índice em `deposits`, `withdrawals` e `link_dispatches`.
4. **Falta de retenção.** O banco passou de **2 GB (14/10) para 15 GB (04/11)**. `cron.job_run_details`, `dispatcher_runs`, `webhook_logs`, `events` e `financial_webhook_attempts` crescem sem limpeza.

O custo hoje vem de dois lugares: **disco** (15 GB, crescendo ~0,5 GB/dia, e o disco provisionado não encolhe sozinho) e o **tamanho do compute**, que é dimensionado pelos picos. Com os itens P0 e P1 da seção 4, a expectativa (inferida) é voltar a ~4–5 GB de banco e cortar a maior parte dos picos. Isso abre espaço para avaliar a volta ao Medium com dados.

---

## 2. Números gerais

| Indicador | 14/10 (baseline) | 04/11 | Leitura |
| --- | --- | --- | --- |
| Tamanho do banco | 1,99 GB | **15 GB** | 7,5× em 3 semanas |
| Arquivos temporários (acumulado desde 02/10) | 23 GB | **1.610 GB** | quase todo do job de CRM |
| WAL gerado (acumulado desde 02/10) | 12,96 GB (~1 GB/dia) | **172 GB (~5,2 GB/dia)** | sync Short.io e jornadas |
| Taxa de rollback | 11,4% | 9,2% | ainda alta |
| Cache hit | 99,90% | 99,91% | saudável; o gargalo não é RAM |
| Conexões | 12–14 | 18 (13 PostgREST idle) | folga grande (160) |
| Queries > 2 s no momento | 0 | 0 | |
| Replication slots | 0 | 0 | Realtime sem assinante ativo no momento |
| `pg_net` com timeout (últimas 6 h) | 200–340/h | 680 de 4.470 (15%) | workers HTTP demoram mais que o timeout |

### 2.1 Tempo de SQL por papel (02/10 → 04/11, 33 dias)

| Papel | Horas | % | O que é |
| --- | --- | --- | --- |
| `postgres` | 21,6 | **38,7%** | pg_cron (CRM, dashboard, outbox) |
| `service_role` | 19,9 | 35,7% | workers: Short.io, jornadas, webhooks |
| `authenticated` | 8,5 | 15,2% | telas do CRM |
| `supabase_admin` | 5,7 | 10,2% | Realtime (quase todo antes da correção NOVO-B) |

Em relação ao baseline, o RLS (NOVO-A) e o Realtime (NOVO-B) **melhoraram**. `user_roles` ganhou só 3 milhões de seq scans em 3 semanas, contra 143 milhões antes, e `list_changes` já não aparece na amostra atual. O peso migrou para os **jobs de fundo**.

---

## 3. Achados

### A1. `refresh_crm_results_recent`: 28% do tempo e ~1,66 TB de temp (P0)

- Cron 26 (`*/10 * * * *`) chama `refresh_crm_results_recent(2)`. Para **cada uma das 13 casas não demo** e para **hoje e ontem**, a função roda `refresh_crm_results_day` + `refresh_player_lifecycle_day`. São 52 recomputações completas a cada 10 min.
- Números: 2.867 chamadas, **média de 19,8 s**, máximo de 80 s e 56.788 s no total. Nas últimas 24 h foram 144 execuções com média de 30,5 s e máximo de 50,6 s, o que dá **1,2 h/dia** de um backend, mais workers paralelos.
- **Bug de tipo:** `journey_step_executions.idempotency_key` é `uuid` e `sms_send_logs.idempotency_key` é `text`. O join `x.idempotency_key::text = s.idempotency_key` aparece duas vezes na função (CTE `sends` e `influenced_agg`) e anula o índice. Cada chamada lê o índice inteiro de 835 mil entradas.
  - EXPLAIN da casa pixpgf, 1 dia: **386.575 buffers e 393 ms** no join original, contra **28.338 buffers e 177 ms** com `x.idempotency_key = (s.idempotency_key)::uuid` protegido por regex. São **13,6× menos leitura**.
  - Isso explica boa parte das 59.686 seq scans de `journey_step_executions` (média de 425 mil linhas, **25 bilhões de linhas lidas**). É uma inferência: outras funções também podem varrer essa tabela.
- O temp vem dos `count(distinct …)` e das CTEs grandes com `work_mem` de 12 MB. Além disso, `crm_player_state()` roda **por linha enviada** e faz um `max(created_at)` em `deposits` para cada SMS.
- Também entram no loop casas sem operação: `journey-p0-1791418509270`, que é tenant de teste, `betleads-original` e `crm-expert-queiroz`.

### A2. `link_click_snapshots`: 6,4 GB (43% do banco) (P0)

- 3 milhões de linhas, heap de 5,9 GB, ~2 KB por linha. A coluna `payload` guarda a resposta inteira do Short.io (30 dias de série) **em toda gravação**.
- Ritmo atual: 104 a 131 mil linhas por dia. Em 33 dias foram 3,9 milhões de upserts e 939 mil updates, porque o upsert usa `snapshot_at` truncado na hora e o mesmo link é regravado várias vezes por hora.
- **Ninguém lê `payload`.** Os leitores (`conversion-report.functions.ts:515` e `:1136`) selecionam só `tracked_link_id, clicks, human_clicks, snapshot_at`. Desde 0a22499 o clique first-party (`click_events`) é a fonte da verdade, e o Short.io virou só reconciliação (memória `clicks-first-party-status`).
- O sync (`shortio.server.ts`) gera ainda:
  - `UPDATE tracked_links SET last_synced_at`: 3,6 milhões de vezes, com 5,5 milhões de blocos sujos e índices de 350 MB numa tabela de 600 mil linhas;
  - `SELECT tracked_links … ORDER BY last_synced_at, created_at`: 107.919 chamadas com média de 88 ms, **~56 mil blocos (~450 MB lógicos) por chamada** na amostra. O índice `(tenant_id, status, last_synced_at NULLS FIRST)` não cobre o desempate por `created_at`, então ordena tudo;
  - `UPDATE link_dispatches … WHERE tenant_id AND tracked_link_id`: 57 mil chamadas com média de 49 ms. **Não há índice em `link_dispatches.tracked_link_id`**, o que gera 62 mil seq scans com média de 38 mil linhas (2,4 bilhões de linhas lidas).
- O dispatcher `sync` roda **a cada minuto, com média de 43 s** e máximo de 131 s.

### A3. Varreduras de jornada a cada tick (P1)

`journeys.server.ts:1642-1656` chama, a cada tick do dispatcher de jornada (cron de 1 min):

| Função | Chamadas | Média | Total | Problema |
| --- | --- | --- | --- | --- |
| `sweep_journey_exits` | 28.359 | 334 ms | 9.473 s | Reavalia **todas** as inscrições abertas, com join em `players`, a cada minuto. Chama `is_demo_tenant()` e `journey_requires_phone()` **por linha**: 674 milhões de seq scans em `tenants` (eram 1,96 milhão) e 76 mil em `journey_steps` |
| `sweep_dead_lead_revivals` | 7.454 | 676 ms | 5.042 s | Para cada um dos **25.433 leads mortos em aberto**, roda `journey_player_last_action()`, que faz 3 subconsultas (`deposits`, `withdrawals`, `link_dispatches`). Isso dá ~100 mil lookups por execução e explica os **594 milhões de idx scans em `deposits`, 168 milhões em `withdrawals` e 168 milhões em `link_dispatches_first_party_click_idx`**. Na amostra: 340 mil blocos por chamada |
| `resume_priority_paused_journeys` | 30.232 | 61 ms | 1.834 s | Volume |
| `recover_orphaned_journey_claims` | 30.243 | 25 ms | 748 s | Volume |

Também a cada tick: `count: "exact"` em `journey_enrollments` (fila). `journey_enrollments` soma 33 mil seq scans com média de 93 mil linhas.

### A4. Dashboard e métricas (P2)

| Função | Chamadas | Média | Total | Observação |
| --- | --- | --- | --- | --- |
| `refresh_recent_dashboard_metrics_slot` (cron 25, a cada 5 min) | 46.208 | 209 ms | 9.666 s | Na amostra: 8 chamadas, 4,3 s e 343 mil blocos. **21% da janela** |
| `dashboard_summary_v2` (tela inicial) | 21.435 | 179 ms | 3.846 s | aceitável; cache curto ajuda |
| `refresh_player_lifecycle_day` | 618 | 5,1 s | 3.127 s | dentro do A1 |
| `billing_health_snapshot` | 3.510 | 176 ms | 619 s | |
| `finance_send_usage` | 1.008 | 748 ms | 754 s | Provável causa dos 4.069 seq scans de `wallet_ledger`, média de 168 mil linhas (inferido) |

### A5. Telas `authenticated` ainda lentas (P2)

O baseline já tinha mapeado esses casos e eles continuam iguais: as estatísticas de histórico de SMS (`history.functions.ts`, 9.703 + 4.858 chamadas, ~1 s de média, sem `tenant_id`) e a lista de players com `count: "exact"` (1.651 chamadas, **3,0 s de média**, até 7,9 s). A busca e os filtros comportamentais ficam entre 3 e 6 s. Em conjunto pesam menos que A1–A3, mas são o que o usuário sente.

### A6. Crescimento sem retenção (P1)

| Tabela | Tamanho | Linhas | Mais antiga | Crescimento | Proposta |
| --- | --- | --- | --- | --- | --- |
| `link_click_snapshots` | **6.449 MB** | 3,0 milhões | — | ~120 mil/dia | ver A2 |
| `webhook_logs` | 1.502 MB (795 MB TOAST) | 525 mil | 15/09 | 20–33 mil/dia | 100 mil com mais de 30 d; manter 30 d de payload |
| `events` | 981 MB (640 MB TOAST) | 391 mil | 17/09 | | 58 mil com mais de 30 d |
| `financial_webhook_attempts` | 890 MB (641 MB TOAST) | 267 mil | 08/10 | | apagar ou anular `raw_payload` após 30 d |
| `link_dispatches` | 691 MB | 620 mil | | | índices sem uso (A7) |
| `tracked_links` | 559 MB (350 MB de índice) | 620 mil | | | bloat de update (A2) |
| `cron.job_run_details` | **525 MB** | 385 mil | 03/10 | ~12 mil/dia | **sem limpeza**; manter 3 d |
| `journey_step_executions` | 446 MB | 709 mil | | | |
| `journey_events` | 366 MB | 1,26 milhão | 08/10 | ~35 mil/dia | manter 60–90 d |
| `dispatcher_runs` | 103 MB | 317 mil | 03/10 | ~13 mil/dia | 225 mil com mais de 7 d |
| `link_tracking_sync_runs` | 30 MB | 109 mil | 06/10 | | 30 mil com mais de 7 d |

Só existe retenção para `sms_callback_raw` (cron 30) e para os públicos de seleção (cron 35).

### A7. Índices sem uso ou duplicados (P2, ~400 MB)

Cada índice extra também custa em todo INSERT/UPDATE e no WAL.

| Tabela | Índice | Tamanho | Uso desde 02/10 |
| --- | --- | --- | --- |
| sms_send_logs | `idx_sms_send_logs_provider_message_id` | 105 MB | 2 scans. O callback da Short Brasil só envia o nosso token (memória `sms-dlr-callback`). Confirmar no `sms-webhook.ts` antes de remover |
| sms_send_logs | `idx_sms_send_logs_flow_created` | 44 MB | 0 |
| deposits | `deposits_tenant_status_created_idx` | 40 MB | 0; **duplicado exato** de `deposits_tenant_status_idx` |
| sms_credit_ledger | `idx_sms_credit_ledger_tenant_created` / `sms_credit_ledger_tenant_created_idx` | 43 MB (par) | duplicados |
| sms_credit_ledger | `idx_sms_credit_ledger_reference` | 34 MB | 1 |
| withdrawals | `withdrawals_tenant_status_created_idx` / `withdrawals_tenant_status_idx` | 16 MB (par) | duplicados |
| link_dispatches | `link_dispatches_tenant_source_idx` | 66 MB | 57 |
| link_dispatches | `link_dispatches_tenant_created_idx` | 35 MB | 42 |
| journey_enrollments | `journey_enrollments_tenant_player_due_idx` | 10 MB | 5 |
| players | `idx_players_ultimo_login` (duplicado de `_nulls_last`) | 2,5 MB | |

### A8. Outros pontos

- **pg_net:** 15% das chamadas dos crons HTTP terminam em timeout. O worker continua rodando, mas o cron não sabe disso. Não pesa no banco, mas esconde falhas (achado 4 do baseline).
- **`pg_stat_statements` nunca foi resetado desde 02/10.** Os números acumulados misturam código antigo. Resetar logo depois das correções P0 permite medir o ganho.
- **Realtime:** a publicação `supabase_realtime` já não tem tabelas de alta escrita. Resolvido.

---

## 4. Plano de ação priorizado

**Ganho** = redução estimada. **Risco** = chance de quebrar algo. Os itens marcados como DDL exigem migration e autorização explícita para aplicar em produção.

### P0: esta semana (maior ganho, baixo risco)

| # | Ação | Onde | Ganho | Risco |
| --- | --- | --- | --- | --- |
| 1 | Corrigir os dois joins `x.idempotency_key::text = s.idempotency_key` para comparar como uuid, com guarda de formato | migration de `refresh_crm_results_day` | ~13× menos leitura nesse trecho; corta boa parte do A1 | baixo; o resultado é o mesmo |
| 2 | Mudar a cadência do CRM: **hoje** a cada 15 min e **ontem** só numa rodada às 00h10 BRT; o recálculo de 8 dias das 03h20 BRT (cron 27) pega os atrasados. Medição de 14 dias: atribuições e cliques nunca chegam depois do dia; 47 depósitos chegaram até 4 min após a meia-noite; só 2 (R$ 135) depois das 03h20 | cron 26 → `refresh_crm_results_recent(1)` a cada 15 min + cron `10 3 * * *` (UTC) para `(2)` | −33% das rodadas (144 → 97 por dia) e −66% dos recálculos de dia (288 → 98) | baixo; atraso real após 03h20 é raro |
| 3 | Pular casas sem envio no dia (`exists` em `sms_send_logs`/`deposits` no intervalo) e excluir o tenant de teste `journey-p0-…` | `refresh_crm_results_recent` | −3 a −5 casas por rodada | baixo |
| 4 | **Parar de gravar `payload`** em `link_click_snapshots` (gravar `null`, ou só a série resumida se alguém pedir) | `shortio.server.ts:1184` | ~2 KB → ~100 B por linha; corta a maior parte do WAL do sync | nenhum; nada lê o campo |
| 5 | Aplicar o env pendente do sync: `SHORTIO_SYNC_BATCH_SIZE=600`, `SHORTIO_SYNC_CONCURRENCY=10`. Melhor ainda: rodar a cada 5–15 min em vez de 1 min, já que o first-party é a fonte da verdade | env de produção + cron 21 | −80% ou mais do sync | baixo |
| 6 | Retenção de `cron.job_run_details`: cron diário `delete … where end_time < now() - interval '3 days'` | migration | −500 MB | nenhum |

### P1: próximas 2 semanas

| # | Ação | Ganho | Risco |
| --- | --- | --- | --- |
| 7 | `link_click_snapshots`: guardar **só o snapshot mais recente por link** (ou 1 por dia) e apagar o histórico com mais de 7 dias em lotes. Depois disso, **`VACUUM FULL` ou `pg_repack`** na tabela para devolver o espaço (a tabela trava durante o `VACUUM FULL`; fazer de madrugada) | −6 GB | médio; validar o relatório de conversão (`conversion-report.functions.ts:515/1136`) |
| 8 | Índice `link_dispatches (tracked_link_id)` (DDL, `CONCURRENTLY`) | elimina 62 mil seq scans e 2,4 bilhões de linhas lidas | baixo |
| 9 | Sync: tirar o `order by created_at` de desempate, ou criar `(tenant_id, status, last_synced_at NULLS FIRST, created_at)` | ~450 MB → poucos MB lógicos por chamada | baixo |
| 10 | `sweep_dead_lead_revivals`: rodar **a cada 15 min** (não a cada tick) e só para leads cujo player mudou desde a última varredura (`players.updated_at > last_sweep`) ou por evento no webhook | −95% dos 100 mil lookups/min | baixo |
| 11 | `sweep_journey_exits`: calcular `is_demo_tenant` e `journey_requires_phone` uma vez por query (CTE com a lista de jornadas e casas) e avaliar só inscrições de players alterados desde a última varredura; rodar a cada 5 min | −90% (inferido) | médio; regra de saída S-01/S-02 com atraso de até 5 min |
| 12 | Retenção em lote noturno: `dispatcher_runs` e `link_tracking_sync_runs` > 7 d; `webhook_logs` e `events` > 30 d (ou anular o payload e manter a linha); `financial_webhook_attempts.raw_payload` > 30 d; `journey_events` > 90 d | −2 a −3 GB, mais crescimento contido | médio; confirmar se algum relatório ou replay de webhook precisa de mais de 30 d |
| 13 | Remover os índices duplicados e sem uso do A7 (DDL, `DROP INDEX CONCURRENTLY`) | −400 MB e escrita mais barata | baixo (exceto `provider_message_id`: confirmar antes) |

### P2: melhorias de experiência e custo fino

| # | Ação | Ganho |
| --- | --- | --- |
| 14 | `crm_player_state` por linha → join único com o último depósito por player do dia (CTE) | menos lookups em `deposits` no CRM |
| 15 | Lista de players com `count: "planned"` e busca com `pg_trgm` (`players-list.functions.ts`) | telas de 3–6 s → < 500 ms |
| 16 | Estatísticas de histórico de SMS como RPC agregada com `tenant_id` (`history.functions.ts:478/828`) | ~7% do tempo `authenticated` |
| 17 | `refresh_recent_dashboard_metrics_slot` a cada 10–15 min | −50% do job |
| 18 | Investigar o seq scan de `wallet_ledger` (`finance_send_usage`) | |
| 19 | `pg_stat_statements_reset()` logo depois do P0 e nova amostra em horário de pico (20h BRT) | medição do ganho |

---

## 5. Custo e compute

- **Disco:** com 15 GB, o banco já passou da franquia incluída no plano e cresce ~0,5 GB/dia. O disco provisionado **não diminui sozinho** quando os dados são apagados: o espaço só volta depois de `VACUUM FULL`/`pg_repack`, e reduzir o disco provisionado é uma ação no painel (Settings → Compute and Disk). Os itens 4, 6, 7 e 12 levam o banco de volta a **~4–5 GB** (estimativa).
- **Compute:** a carga média é baixa (0,07 backend). O Large é exigido pelos **picos** de 30–50 s do job de CRM a cada 10 min, pelo sync de 43 s a cada minuto e pelo volume de IO (temp + WAL). Depois de P0 e P1, a decisão de voltar ao Medium deve se basear em 48 h de gráfico de CPU e de **Disk IO budget**, que não ficam visíveis por SQL.
- **Para confirmar no painel** (não acessível daqui): Reports → Database (CPU, RAM, **Disk IO % consumido**) e Billing → Usage (disco, egress, PITR). Se o **Disk IO budget** estiver zerando nos horários dos crons, o A1 e o A2 são a causa direta.

---

## 6. Evidência de EXPLAIN (somente leitura)

| Consulta | Buffers | Tempo |
| --- | --- | --- |
| `sms_send_logs ⟕ journey_step_executions ON x.idempotency_key::text = s.idempotency_key` (pixpgf, 24 h) | 386.575 | 393 ms (2,75 s na casa de maior volume) |
| Mesma consulta com `x.idempotency_key = s.idempotency_key::uuid` (guardado por regex) | **28.338** | **177 ms** |
| `SELECT tracked_links … ORDER BY last_synced_at, created_at` (amostra de 5 min) | ~56 mil por chamada | 97 ms |
| `sweep_dead_lead_revivals` (amostra de 5 min) | ~340 mil por chamada | 850 ms |

---

## 7. Status em 05/11/2026

### 7.1 Aplicado em produção

| Fase | O que entrou | Commit | Migration | Aplicada |
| --- | --- | --- | --- | --- |
| P0 | Join do CRM em uuid; dias sem atividade pulados; CRM de hoje a cada 15 min e de ontem às 00h10 BRT; sync do Short.io a cada 5 min; retenção de 3 dias do `cron.job_run_details`; snapshots sem `payload` | `f28685e`, `f12cdec` | `20261129100000_supabase_consumo_p0` | 04/11 20h07 BRT |
| P1 | Retenção noturna (`purge_operational_history`, 02h50 BRT); varreduras de jornada com trava (5 e 15 min); índices `link_dispatches(tracked_link_id)` e `financial_webhook_attempts(webhook_log_id)`; BRIN nos logs; 5 índices removidos; RPC `shortio_sync_recent_links` | `0e4a1dc` | `20261130100000_supabase_consumo_p1` | 04/11 21h10 BRT (índices com `CONCURRENTLY` antes) |
| Limpeza do acúmulo | 1,94 milhão de snapshots apagados e 734 mil `payload` zerados; −100.681 `webhook_logs`; −135 mil `dispatcher_runs`; −32,6 mil `link_tracking_sync_runs` | — | — | 04/11 21h15–22h21 BRT |
| `VACUUM FULL` | `link_click_snapshots`, job único do pg_cron (removido depois) | — | — | 05/11 04h00 BRT, 38 s |

Decisões de retenção (04/11): `webhook_logs` 30 dias; `events` **não mexer** (lido pelo dashboard e pela timeline do player); `financial_webhook_attempts.raw_payload` zerado após 30 dias; `dispatcher_runs` 14 dias; `link_tracking_sync_runs` 7 dias; `journey_events` 90 dias.

### 7.2 Resultados medidos

| Indicador | Antes | Depois |
| --- | --- | --- |
| Tamanho do banco | 15 GB (16,2 GB no dia) | **9,1 GB** (disco usado 38%) |
| `link_click_snapshots` | 6,5 GB, ~120 mil linhas/dia de ~2 KB | **176 MB**, linhas novas sem `payload` |
| Rodada do CRM | 34–47 s a cada 10 min (2 dias × 13 casas) | **7,6 s** a cada 15 min (1 dia); ontem 1×/dia |
| Escolha de links recentes do sync | 317 mil buffers por chamada | **8,8 mil** (23 ms) |
| CPU da VM (métricas `node_cpu_seconds_total`) | — | média **24,7%** desde 15/10; ~15% às 07h30 de 05/11 |

O "Compute 97%" do painel do Supabase é o **pico** de cada intervalo do gráfico, não o uso contínuo. A medição direta da VM (2 núcleos) dá a média acima, com iowait de 0,5% e load average de ~0,5.

Pendente de medição: 48–72 h de CPU por hora (Reports → Database) para decidir a volta ao Medium.

---

## 8. Incidente de 04–05/11: webhooks atrasados (não causado pelo banco)

- **Casas:** Betgreen, PixPGF (Sorte Alta) e PixReals, as três da mesma plataforma (envelope `deliveryId`/`eventId`/`occurredAt`).
- **Janela:** atraso crescente de ~16h BRT de 04/11 até ~07h BRT de 05/11, com pico de ~7h24 às 03h BRT. Normalizou com a plataforma entregando 7.972 webhooks na hora das 06h.
- **Gatilho provável:** pico da Betgreen às 15h–16h BRT, com ~5× o volume normal de eventos (~10× saques, ~8× cadastros e logins). Depois do pico, a plataforma entregou só ~400–550 webhooks por hora até ~03h.
- **Do nosso lado:** handler completo (`webhook_logs.created_at` → `webhook_event_receipts.completed_at`) com mediana de ~0,85 s e p90 de 1,3–2,5 s, estável. Única piora às 14h BRT, com p90 de 7,5 s. O banco ficou ocioso e o processo do app abaixo do limite (CPU 2% na VPS).
- **Prova independente do horário dos eventos:** o cookie `_fbp` (época em ms, gravada pelo navegador do jogador) confirma que os PIX entregues às 22h24 BRT foram feitos às ~18h50 BRT.
- **Lições:** (1) falta alerta de atraso de webhooks por casa; (2) cada webhook faz ~18 chamadas sequenciais à API, e reduzir isso para uma RPC deixa a resposta mais rápida e menos sujeita a a plataforma desacelerar o envio (item R1 abaixo).

---

## 9. Próxima fase: reduzir requisições à API (P2)

**Por quê:** ~39 milhões de requisições PostgREST em 33 dias (~1,2 milhão por dia, `set_config` do `service_role` no `pg_stat_statements`). Cada requisição custa CPU (rede, JWT, `set_config`, transação, JSON) e gera uma linha no log do gateway. O **Log Ingestion** está em 46 GB no período, contra 20 GB inclusos (~1,2–1,6 GB/dia); a cobrança começa no início de 2027. A configuração de log do Postgres já é enxuta (`log_statement=ddl`, sem log de duração), então o volume vem do gateway.

| # | Origem (33 dias) | Requisições | % | Ação | Redução estimada |
| --- | --- | --- | --- | --- | --- |
| — | Sync do Short.io | ~7,6 milhões | ~20% | Feito no P0/P1 (5 min, sem payload, RPC) | −80% dessa parte |
| **R1** | **Webhooks**: ~18 chamadas sequenciais por webhook × 456 mil webhooks | ~8 milhões (estimado) | ~20% | Processar cada webhook numa RPC única no banco, com o mesmo resultado | −90% dessa parte; resposta de ~0,9 s para ~0,1 s (estimado) |
| R2 | Dispatcher de jornadas: leituras por item (`tenants` ~2,5 mi, `players` ~3 mi, `channel_consents` ~1,4 mi, `journey_steps`/`journeys`/`journey_enrollments` ~1 mi cada) | ~12 milhões | ~32% | Cache em memória de 60 s para casa, jornada e passos; leitura em lote de players, inscrições e consentimentos por lote | −50% a −70% dessa parte |
| R3 | Resto (telas, campanhas, cobrança) | ~11 milhões | ~28% | Caso a caso | pequena |

Estimativa total: **−50% a −60% das requisições** (e do log do gateway), com queda proporcional nos picos de CPU.

**Outros itens da fase:**
- **Alerta de atraso de webhooks** por casa (por exemplo, acima de 15 min entre `occurredAt` e o recebimento).
- **Compute Large → Medium:** decidir com 2–3 dias de CPU por hora depois de P0/P1, de preferência também depois de R1/R2, conferindo o cache hit.
- **Disco provisionado:** reduzir no painel, se for permitido.
- **`events`** (981 MB, ~46 MB/dia): avaliar apagar só o `metadata` após 90 dias, depois de revisar as funções do dashboard que leem a tabela.
- **Telas de 3–6 s:** lista de players com `count` exato e estatísticas de histórico de SMS (`history.functions.ts`).
