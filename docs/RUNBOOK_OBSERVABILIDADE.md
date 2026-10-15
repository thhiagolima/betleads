# Runbook — Observabilidade (OBS-04 / OBS-05)

**Data:** 14/10/2026
**Escopo:** uptime, heartbeats de jobs, métricas de fila e logs do VPS.
**Origem:** `docs/ESCOPO_ESCALA_TRACKING_ATRIBUICAO_2026-10-14.md` (Fase A) e seção 9 de `docs/AUDITORIA_TRACKING_ATRIBUICAO_ESCALA_2026-10-14.md`.

## 1. Visão geral

| Peça | Onde | Responde a |
| --- | --- | --- |
| `dispatcher_runs` com `status`, `heartbeat_at`, `job`, `tenant_id` | migration `20261014220000_observability_job_runs_and_queue_metrics.sql` | O job começou? Está progredindo? Terminou? |
| `startJobRun()` / `recordRun()` | `src/lib/observability/job-monitor.server.ts`, `src/lib/dispatch-rate.server.ts` | Grava início, progresso (≤ 1 escrita/10 s) e fim; faz ping no Better Stack |
| `observability_job_health()` | RPC (somente `service_role`) | "O worker está vivo?" |
| `observability_queue_metrics()` | RPC (somente `service_role`) | "Qual tenant está atrasado?" |
| `GET /api/public/health` | `src/routes/api/public/health.ts` | O processo responde e o banco está acessível? |

Ciclo de vida de uma execução em `dispatcher_runs`:

1. Início: linha com `status='running'`, `started_at = heartbeat_at = agora`.
2. Progresso: `heartbeat_at` e contadores atualizados a cada onda/lote (no máximo 1 escrita a cada 10 s) e, independentemente disso, por um timer a cada 30 s enquanto o processo estiver vivo.
3. Fim: `status` = `succeeded` | `partial` (houve erros por item) | `failed` (exceção), com `finished_at`, `duration_ms`, `stop_reason`.
4. Worker morto/travado: a linha fica `running` e o `heartbeat_at` para de andar. Após 2 min a RPC de saúde conta como `stale_running`; após 15 min a próxima execução do mesmo job fecha a linha como `failed` / `stop_reason='abandoned'`.

Linhas antigas (antes da migration) têm `status`/`job` nulos e são tratadas como execuções concluídas.

## 2. Monitores de uptime (Better Stack)

Criar em **Uptime → Monitors**. Intervalo sugerido: 1 min; confirmação: 2 checagens; regiões: 2+.

| Monitor | Método / URL | Esperado | Observação |
| --- | --- | --- | --- |
| Home do CRM | `GET https://betleads.io/` | HTTP 200 | Prova que o container e o proxy respondem. |
| Health | `GET https://betleads.io/api/public/health` | HTTP 200 e corpo contendo `"db":"ok"` | Retorna **503** com `"db":"degraded"` se o banco não responder em 2 s. Sem autenticação, sem efeito colateral, `Cache-Control: no-store`. O resultado do banco fica em cache por 5 s no processo. |
| Redirect com token sintético | `GET https://betleads.io/api/public/click/obs-synthetic-token?s=invalid` | HTTP **404** | Assinatura inválida é rejeitada antes de qualquer acesso ao banco (`verifyClickTokenSignature`), então não grava clique. Prova que a rota de redirect está viva. 503 = falha interna. |
| Webhook (token inválido) | `POST https://betleads.io/api/public/webhook/obs-invalid-token/deposito` com corpo `{}` e `Content-Type: application/json` | HTTP **404** (`token inválido`) | Faz apenas a busca do tenant por `webhook_token`; nada é gravado. **503** = falha ao consultar o banco (configuração/credencial) e deve alertar. Usar `POST`: a rota não tem `GET`. |

Notas:

- Não usar token real de tenant em monitores.
- O monitor de redirect não exercita o Postgres; o monitor de health sim.

## 3. Heartbeats de jobs

Cada job faz ping ao concluir. Sucesso (`succeeded` ou `partial`) chama `<URL>`; falha chama `<URL>/fail`. Sem a variável de ambiente, o ping é desligado (no-op). O ping usa timeout de 3 s, nunca derruba o job e é limitado a 1 por 30 s por job/resultado (o mínimo do Better Stack).

Criar em **Uptime → Heartbeats** um heartbeat por linha, copiar a URL e colocar na variável correspondente no `.env` do VPS (não commitar).

| Job (`dispatcher_runs.job`) | Variável de ambiente | Rota / origem | Cron (migrations) | Período no Better Stack | Tolerância (grace) |
| --- | --- | --- | --- | --- | --- |
| `journey_dispatch` | `BETTERSTACK_HEARTBEAT_JOURNEY_DISPATCH` | `POST /api/public/hooks/dispatch?channel=journey` | `* * * * *` (`20261014192000`) | 1 min | 3 min |
| `journey_scan` | `BETTERSTACK_HEARTBEAT_JOURNEY_SCAN` | `POST /api/public/hooks/journey-scan` | `* * * * *` (`20261014124000`) | 1 min | 3 min |
| `sms_campaign_dispatch` | `BETTERSTACK_HEARTBEAT_SMS_CAMPAIGN_DISPATCH` | `POST /api/public/hooks/dispatch?channel=sms` (campanhas agendadas) | `* * * * *` (`20261003143000`) | 1 min | 3 min |
| `sms_tick` | `BETTERSTACK_HEARTBEAT_SMS_TICK` | mesmo request (fluxos SMS, via `recordRun`) | `* * * * *` | 1 min | 3 min |
| `email_tick` | `BETTERSTACK_HEARTBEAT_EMAIL_TICK` | `POST /api/public/hooks/dispatch?channel=email` (via `recordRun`) | `* * * * *` (`20261003143000`) | 1 min | 3 min |
| `email_campaign` | `BETTERSTACK_HEARTBEAT_EMAIL_CAMPAIGN` | `POST /api/public/email-campaigns/tick` (via `recordRun`) | sem cron versionado nas migrations; conferir `cron.job` | conforme cron | 3× período |
| `webhook_replay` | `BETTERSTACK_HEARTBEAT_WEBHOOK_REPLAY` | `POST /api/public/hooks/webhook-replay` | `* * * * *` (`20261014213000`) | 1 min | 3 min |
| `shortio_sync` | `BETTERSTACK_HEARTBEAT_SHORTIO_SYNC` | `POST /api/public/shortio/sync` | `* * * * *` (`20261014193000`) | 1 min | 3 min |
| `recovery` | `BETTERSTACK_HEARTBEAT_RECOVERY` | `POST /api/public/hooks/recovery` | `*/2 * * * *` (`20261003143000`) | 2 min | 4 min |
| refresh do dashboard | — | `select public.refresh_recent_dashboard_metrics()` direto no pg_cron | `*/5 * * * *` (`20261014153000`) | — | — |

Regra geral para nomes: `BETTERSTACK_HEARTBEAT_<JOB em MAIÚSCULAS>`.

Particularidades:

- `journey_dispatch` faz ping mesmo com `JOURNEYS_DISPATCH_ENABLED` desligado (registra `stop_reason='disabled'`). Se o alerta deve refletir envio real, acompanhar `sent` em `observability_job_health()`/`dispatcher_runs`.
- `journey_scan` **não** faz ping quando `JOURNEYS_SCANNER_ENABLED` está desligado ou o escopo canário não permite; nesse caso não crie o heartbeat (ou pause-o).
- `sms_campaign_dispatch` e `webhook_replay` só gravam linha em `dispatcher_runs` quando há trabalho (campanha reservada / backlog). Ticks vazios apenas fazem ping. `dry_run` do replay não faz ping.
- Refresh do dashboard roda inteiramente no Postgres; o app não participa. Opções: (a) consultar `cron.job_run_details` (seção 6.4); (b) acrescentar ao comando do cron um `net.http_get` para a URL do heartbeat após o refresh, guardando a URL no Vault (não aplicar sem revisão).

Aceite OBS-04 ("derrubar um job em homologação dispara alerta em < 5 min"): com período 1 min e grace 3 min, a ausência de ping alerta em ~4 min; um `/fail` alerta imediatamente.

## 4. Limiares de alerta

Da seção 9 da auditoria, com a fonte de dado disponível agora:

| Indicador | Meta | Alerta | Fonte |
| --- | --- | --- | --- |
| redirect p95 | < 150 ms | > 300 ms por 5 min | Better Stack (tempo de resposta do monitor de redirect) / Sentry tracing |
| click disponível no relatório p95 | < 5 s | > 30 s | — (não instrumentado nesta entrega) |
| ACK de webhook p95 | < 2 s | > 5 s | Better Stack (monitor de webhook) / logs |
| processamento webhook p95 | < 30 s | > 2 min | `webhook_logs` + `webhook_replay` em `observability_job_health()` |
| idade da fila pronta p95 | < 5 min | > 10 min | `observability_queue_metrics().ready_age_p95_seconds > 600` |
| duplicação de envio | 0 | qualquer ocorrência | — |
| falha de dispatch | < 1% | > 2% por 5 min | `errors_15m / (sent_15m + errors_15m)` em `observability_queue_metrics()` |
| `recipient_player_id` em dispatches | 100% | qualquer ausência | — |
| atribuição sem grau A | 0 | qualquer ocorrência | — |
| DLQ sem resolução | 0 > 15 min | qualquer ocorrência | — (DLQ ainda não existe) |
| staleness de métricas | < 60 s | > 5 min | `seconds_since_last_start` do job correspondente |
| rollback DB | baseline + limite | desvio 2× | Supabase |
| disco/temp | < 70% | > 80% ou crescimento anormal | Supabase / VPS |

Complementares desta entrega:

- Qualquer `stale_running > 0` em `observability_job_health()` → worker travado/morto.
- `failed_last_hour > 0` em `journey_dispatch`, `journey_scan`, `webhook_replay` ou `shortio_sync` → investigar no Sentry.
- `seconds_since_last_start > 180` para jobs de 1 min → cron parado ou rota inacessível.
- `duration_ms > 55 000` (timeout do `net.http_post`) → job longo demais para HTTP.

## 5. Logs do container no Better Stack (roteiro)

Sem tokens neste documento. Passos:

1. Better Stack → **Telemetry → Sources → Connect source** → tipo **Docker** (ou **Vector**). Anotar o *source token* e o *ingesting host* fornecidos; guardá-los somente no VPS.
2. No VPS, escolher **uma** das opções:
   - **Vector** como container lateral lendo o socket do Docker (`/var/run/docker.sock`, somente leitura) com source `docker_logs` filtrando o container do app e sink `http` para o host de ingestão, autenticado pelo token (variável de ambiente do Vector, não arquivo commitado).
   - **Logspout/driver de log** apontando para o endpoint fornecido pelo Better Stack.
3. Limitar a coleta ao container do app (filtro por nome/label) para não enviar logs de outros serviços.
4. Conferir que os logs não carregam PII: o app não deve logar telefone, e-mail, nome, payload de webhook nem tokens. Os logs de `[job-monitor]` só registram nome do job e mensagem de erro.
5. Criar no Better Stack alertas de log para `"[job-monitor]"`, `"[journey dispatcher] execution failed"` e `"Webhook tenant lookup failed"` com limiar por minuto.
6. Validar: `docker restart <container>` deve aparecer no Live tail em segundos.

## 6. Consultas SQL

As RPCs só podem ser executadas por `service_role` (SQL editor do Supabase usa `postgres`, que também pode). Aplique `statement_timeout` na sessão que chamar as RPCs (ex.: `set statement_timeout = '15s';`); são diagnósticos sob demanda, não para cron.

### 6.1 "O worker está vivo?"

```sql
select job,
       last_status,
       seconds_since_last_start,
       running,
       stale_running,
       runs_last_hour,
       failed_last_hour,
       partial_last_hour,
       last_stop_reason
from public.observability_job_health()
order by stale_running desc, seconds_since_last_start desc;
```

Leitura: `seconds_since_last_start` alto = cron não está chamando; `stale_running > 0` = processo travado/morto no meio da execução; `failed_last_hour` alto = erro recorrente (ver Sentry).

Execuções travadas em detalhe:

```sql
select id, job, tenant_id, started_at, heartbeat_at,
       now() - heartbeat_at as sem_heartbeat, claimed, sent, errors
from public.dispatcher_runs
where status = 'running'
order by heartbeat_at;
```

### 6.2 "Qual tenant está atrasado?"

```sql
select q.tenant_id,
       t.nome as tenant,
       q.channel,
       q.ready,
       q.oldest_ready_age_seconds,
       q.ready_age_p95_seconds,
       q.claimed,
       q.retrying,
       q.paused,
       q.journey_inactive,
       q.sent_15m,
       q.errors_15m
from public.observability_queue_metrics() q
left join public.tenants t on t.id = q.tenant_id
where q.ready > 0 or q.errors_15m > 0
order by q.ready_age_p95_seconds desc nulls last;
```

Leitura: `ready` alto com `sent_15m = 0` = tenant parado; `ready_age_p95_seconds > 600` = viola o SLO; `errors_15m` alto = provedor/configuração do tenant; `journey_inactive` > 0 = matrículas vencidas em jornada pausada (não é atraso do worker).

Definições: `ready` = active/waiting, `next_run_at <= now()`, jornada ativa, não reservada (ou reserva > 10 min); `claimed` = reservada nos últimos 10 min; `retrying` = waiting com `attempts > 0` (sobrepõe ready/future); canal = `step_type` do passo atual (`none` após o último passo).

### 6.3 Consulta única (vivo + atrasado)

```sql
select 'job' as tipo, job as chave, null::uuid as tenant_id,
       seconds_since_last_start as valor, stale_running as stale
from public.observability_job_health()
union all
select 'fila', channel, tenant_id, ready_age_p95_seconds, ready::integer
from public.observability_queue_metrics()
where ready > 0
order by valor desc nulls last;
```

### 6.4 Refresh do dashboard (somente pg_cron)

```sql
select d.status, d.start_time, d.end_time, d.return_message
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where j.jobname = 'betleads-refresh-dashboard-metrics'
order by d.start_time desc
limit 10;
```

## 7. Procedimentos

**Job sem heartbeat (alerta do Better Stack):**

1. `observability_job_health()` → o job iniciou recentemente?
2. Se não iniciou: verificar `cron.job_run_details` do job HTTP e o status do `net.http_post` (`net._http_response`), o monitor de health e o container.
3. Se iniciou e está `running` com heartbeat parado: checar logs do container e Sentry; reiniciar o container se o processo estiver travado. A linha será fechada como `abandoned` pela próxima execução após 15 min.
4. Se terminou com `failed`: ver `last_stop_reason` e o evento no Sentry (tag `job`).

**Fila atrasada:** rodar 6.2; se um único tenant concentra `ready`, verificar pausa de canal (`dispatch_pause_state`), saldo do provedor e `errors_15m`; se todos atrasam, verificar `journey_dispatch` em 6.1.

## 8. Sentry

> Seção a ser preenchida (DSN, ambientes, releases, tags `job`/`tenant_id`, alertas e regras de scrub de PII).
