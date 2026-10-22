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
| `billing-reconcile` | `BETTERSTACK_HEARTBEAT_BILLING_RECONCILE` | `POST /api/public/hooks/billing-reconcile` (conciliação Pix Upper) | `*/5 * * * *` (`20261022110100`) | 5 min | 10 min |
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

## 9. Provedor SMS sem saldo (circuit breaker do SMS)

Incidente de 15/10/2026: desde 11:38 BRT a Short Brasil respondeu `{"status": 101, "statusDetalhe": "Erro de Autenticação"}` a todo envio. A causa real era a **rota sem saldo** (o provedor responde 101 em vez de 505). Como o app tratava isso como erro do lead, cada item de jornada queimou as 3 tentativas e terminou `failed`.

### 9.1 Como o sistema se defende agora

* **Classificação** (`src/lib/rate-limit/transport-errors.ts`, `smsProviderAccountReason`): `status` 101 ou 505 no corpo, ou HTTP 401/402/403 do provedor, são erros de **conta** (`errorKind = provider_account`). `sendSmsInternal` e o envio em lote marcam o resultado assim, devolvem o crédito e avisam o breaker. Erros do lead (número inválido, 303/404, recusa por item) continuam como antes. HTTP 402 de **crédito do tenant** (`Saldo de créditos SMS insuficiente`) não vem do provedor e não abre o breaker.
* **Breaker global** (`public.provider_circuit_breakers`, migração `20261015123000_sms_provider_breaker.sql`; código em `src/lib/sms-provider-breaker.server.ts`): uma conta Short Brasil para todos os tenants, então o estado é por canal (`sms`).
  * `closed`: envio normal.
  * `open`: ninguém envia SMS. Backoff de 2 min na primeira abertura, dobrando a cada reabertura (2, 4, 8, 16, 30 min).
  * `half_open`: passado o backoff, **um** worker pega a vez (`provider_breaker_acquire` devolve `probe`) e envia **um** item real da fila. Aceito: `closed`. Recusado por conta: `open` com backoff dobrado. Sem resposta conclusiva (o item saiu da jornada, consentimento etc.): a vez é devolvida (`provider_breaker_release_probe`). Se o worker sumir, outro assume a prova após 5 min.
  * Cada transição é uma função SQL que trava a única linha (`FOR UPDATE`). Processos concorrentes não abrem duas vezes, não fazem duas provas e não alertam em dobro. Um envio iniciado antes da última (re)abertura não fecha nem dobra o breaker.
* **Comportamento durante o incidente:**
  * Jornadas: com o breaker aberto, o claim exclui `(tenant, sms)` via `p_exclude`. Itens SMS ficam `waiting` no mesmo passo e **nenhuma tentativa é consumida**. Um item que recebe 101/505 no meio da execução gera `step_deferred` (`reason = provider_account`, `attempt_consumed = false`) e volta em `backoff_until`, com a execução `retrying`. E-mail e voz seguem normalmente.
  * Campanhas: o tick para antes do próximo lote com `stop_reason = provider_unavailable`, sem mover o cursor nem marcar destinatários como falha, e grava a mensagem do breaker em `last_error`. Um destinatário recusado por conta no meio do lote é `retryable`, e o lote é cortado nele. O envio imediato ("enviar agora") deixa os destinatários pendentes para o worker.
  * Fluxos SMS (`sms_flow_leads`): o tick não faz claim (`dispatcher_runs.stop_reason = provider_unavailable`). Um lead recusado por conta volta com `attempts` intacto.
* **Alertas:** na abertura e, enquanto não fecha, no máximo a cada 15 min: Sentry `captureServerMessage` nível `error` (tags `job = sms_provider` e `reason = auth|no_balance`) e heartbeat **fail** de `sms_provider` (`BETTERSTACK_HEARTBEAT_SMS_PROVIDER`). Com o breaker fechado, o heartbeat recebe **ok** (no máximo 1 a cada 30 s por processo). O fechamento também manda ok, mais um evento `info` no Sentry.
* **Painel:** em Campanhas > "Operação dos canais" (super admin), o card SMS mostra: *"Envio de SMS suspenso: provedor recusou (sem saldo/autenticação) desde HH:MM — tentando novamente às HH:MM"*.

Estado atual:

```sql
select state, reason, first_opened_at, opened_at, open_count, backoff_until,
       probe_holder, probe_started_at, last_alert_at, left(last_error, 120) as last_error
from public.provider_circuit_breakers where channel = 'sms';
```

Depois da recarga não é preciso fazer nada: a próxima prova fecha o breaker. Para testar na hora, envie um SMS de teste pelo app: um envio aceito fecha o breaker. Só em emergência mexa na linha à mão, e apenas para antecipar a próxima prova: `update public.provider_circuit_breakers set state = 'open', backoff_until = now(), probe_holder = null where channel = 'sms';`.

### 9.2 Recuperar jornadas que falharam por erro de conta

Use a função `requeueProviderAccountFailures` (`src/lib/sms-provider-recovery.server.ts`), exposta ao super admin como a server function `requeueSmsProviderFailures({ since, dryRun })` em `src/lib/channel-observability.functions.ts`. Ela age no tenant operacional, roda em **dry-run por padrão** e fica auditada em `tenant_audit_logs`. Tanto ela quanto o SQL abaixo recolocam no **mesmo passo** (`waiting`, `next_run_at = now()`, `attempts = 0`) somente as inscrições que:

* estão `failed` desde `since`, com `exit_reason` de erro de conta (`Short Brasil: erro de autenticacao`, `Short Brasil: saldo insuficiente`, `Provedor SMS recusou as credenciais…`);
* são de uma jornada `active` cujo passo atual é um SMS habilitado ainda não aceito (sem `journey_step_executions` `sent`/`delivered` para o passo e a volta);
* são de um lead que **não depositou desde a entrada** (`ultimo_deposito` ou `ftd_em` > `entered_at`, sempre), respeitando também `exit_rules.login` e `voltou_jogar` da jornada;
* têm consentimento SMS não revogado (`channel_consents`);
* não têm outra inscrição viva do mesmo lead na mesma jornada (reentrada).

Na hora do envio, o dispatcher ainda reavalia `shouldExit`, consentimento, janela, limites e idempotência. Rode a recuperação **depois** que o breaker fechar; antes disso, os itens apenas esperam o breaker.

**1) Diagnóstico (somente leitura):**

```sql
SET default_transaction_read_only = on;
SET statement_timeout = '15s';
with params as (select timestamptz '2026-10-15 14:38:00+00' as since),
failed as (
  select e.id, e.tenant_id, e.journey_id, e.player_id, e.current_position, e.loop_iteration, e.entered_at,
         j.status::text as journey_status, coalesce(j.exit_rules, '{}'::jsonb) as exit_rules,
         s.step_type::text as step_type, p.telefone, p.ultimo_deposito, p.ftd_em, p.ultimo_login, p.ultimo_jogo
  from public.journey_enrollments e
  cross join params
  join public.journeys j on j.id = e.journey_id
  left join public.journey_steps s on s.journey_id = e.journey_id and s.position = e.current_position and s.is_enabled
  left join public.players p on p.id = e.player_id
  where e.status = 'failed'
    and e.updated_at >= params.since
    and (e.exit_reason like 'Short Brasil: erro de autenticacao%'
      or e.exit_reason like 'Short Brasil: saldo insuficiente%'
      or e.exit_reason like 'Provedor SMS recusou as credenciais%')
),
classified as (
  select f.*,
    case
      when f.journey_status <> 'active' then 'journey_inactive'
      when f.step_type is distinct from 'sms' then 'step_not_sms'
      when f.player_id is null or f.telefone is null then 'no_player'
      when f.ultimo_deposito > f.entered_at or f.ftd_em > f.entered_at then 'deposited'
      when (f.exit_rules->>'login')::boolean is true and (f.ultimo_login > f.entered_at or f.ultimo_jogo > f.entered_at) then 'exit_rule'
      when (f.exit_rules->>'voltou_jogar')::boolean is true and f.ultimo_jogo > f.entered_at then 'exit_rule'
      when exists (
        select 1 from public.channel_consents c
        where c.tenant_id = f.tenant_id and c.channel = 'sms' and c.status = 'revoked'
          and c.subject = case when length(regexp_replace(f.telefone, '\D', '', 'g')) in (10, 11)
                               then '55' || regexp_replace(f.telefone, '\D', '', 'g')
                               else regexp_replace(f.telefone, '\D', '', 'g') end) then 'consent_revoked'
      when exists (
        select 1 from public.journey_enrollments o
        where o.journey_id = f.journey_id and o.player_id = f.player_id and o.id <> f.id
          and o.status in ('active', 'waiting', 'paused', 'paused_by_priority')) then 'reentered'
      when exists (
        select 1 from public.journey_step_executions x
        where x.enrollment_id = f.id and x.step_position = f.current_position
          and x.loop_iteration = f.loop_iteration and x.status in ('sent', 'delivered')) then 'already_sent'
      else 'eligible'
    end as decision
  from failed f
)
select t.nome as tenant, j.name as journey, c.decision, count(*) as enrollments
from classified c
join public.tenants t on t.id = c.tenant_id
join public.journeys j on j.id = c.journey_id
group by 1, 2, 3
order by 1, 3, 4 desc;
```

**2) Reenfileirar (NÃO executado; revisar antes a contagem do passo 1):**

```sql
BEGIN;
SET LOCAL statement_timeout = '30s';
with params as (select timestamptz '2026-10-15 14:38:00+00' as since),
failed as (
  select e.id, e.tenant_id, e.journey_id, e.player_id, e.current_position, e.loop_iteration, e.entered_at,
         j.status::text as journey_status, coalesce(j.exit_rules, '{}'::jsonb) as exit_rules,
         s.step_type::text as step_type, p.telefone, p.ultimo_deposito, p.ftd_em, p.ultimo_login, p.ultimo_jogo
  from public.journey_enrollments e
  cross join params
  join public.journeys j on j.id = e.journey_id
  left join public.journey_steps s on s.journey_id = e.journey_id and s.position = e.current_position and s.is_enabled
  left join public.players p on p.id = e.player_id
  where e.status = 'failed'
    and e.updated_at >= params.since
    and (e.exit_reason like 'Short Brasil: erro de autenticacao%'
      or e.exit_reason like 'Short Brasil: saldo insuficiente%'
      or e.exit_reason like 'Provedor SMS recusou as credenciais%')
),
classified as (
  select f.*,
    case
      when f.journey_status <> 'active' then 'journey_inactive'
      when f.step_type is distinct from 'sms' then 'step_not_sms'
      when f.player_id is null or f.telefone is null then 'no_player'
      when f.ultimo_deposito > f.entered_at or f.ftd_em > f.entered_at then 'deposited'
      when (f.exit_rules->>'login')::boolean is true and (f.ultimo_login > f.entered_at or f.ultimo_jogo > f.entered_at) then 'exit_rule'
      when (f.exit_rules->>'voltou_jogar')::boolean is true and f.ultimo_jogo > f.entered_at then 'exit_rule'
      when exists (
        select 1 from public.channel_consents c
        where c.tenant_id = f.tenant_id and c.channel = 'sms' and c.status = 'revoked'
          and c.subject = case when length(regexp_replace(f.telefone, '\D', '', 'g')) in (10, 11)
                               then '55' || regexp_replace(f.telefone, '\D', '', 'g')
                               else regexp_replace(f.telefone, '\D', '', 'g') end) then 'consent_revoked'
      when exists (
        select 1 from public.journey_enrollments o
        where o.journey_id = f.journey_id and o.player_id = f.player_id and o.id <> f.id
          and o.status in ('active', 'waiting', 'paused', 'paused_by_priority')) then 'reentered'
      when exists (
        select 1 from public.journey_step_executions x
        where x.enrollment_id = f.id and x.step_position = f.current_position
          and x.loop_iteration = f.loop_iteration and x.status in ('sent', 'delivered')) then 'already_sent'
      else 'eligible'
    end as decision
  from failed f
)
, requeued as (
  update public.journey_enrollments e
     set status = 'waiting', next_run_at = now(), attempts = 0, exit_reason = null,
         claimed_at = null, claimed_by = null, lease_expires_at = null,
         metadata = coalesce(e.metadata, '{}'::jsonb) || jsonb_build_object(
           'provider_outage_requeue', jsonb_build_object('at', now(), 'previous_exit_reason', e.exit_reason))
    from classified c
   where c.id = e.id and c.decision = 'eligible' and e.status = 'failed'
  returning e.id, e.tenant_id, e.journey_id
)
insert into public.journey_events (tenant_id, journey_id, enrollment_id, event_type, detail)
select tenant_id, journey_id, id, 'provider_outage_requeued', jsonb_build_object('reason', 'provider_account_outage')
from requeued;
-- Conferir o número de linhas inseridas (= reenfileiradas); então COMMIT (ou ROLLBACK).
COMMIT;
```

Com o app novo, os itens que ainda estavam em retry (`waiting` com `attempts` 1–2 e último `retry_scheduled` com erro 101) **não** falham mais: a próxima recusa por conta não consome tentativa. Para zerar as tentativas deles também:

```sql
-- NÃO executado
update public.journey_enrollments e set attempts = 0
where e.status = 'waiting' and e.attempts > 0
  and e.updated_at >= timestamptz '2026-10-15 14:38:00+00'
  and exists (select 1 from public.journey_events ev
              where ev.enrollment_id = e.id and ev.event_type = 'retry_scheduled'
                and ev.created_at >= timestamptz '2026-10-15 14:38:00+00'
                and ev.detail->>'error' like 'Short Brasil:%');
```

### 9.3 Campanhas atingidas (listar para reenvio, sem reenviar automaticamente)

A consulta abaixo lista os destinatários de campanha com erro de conta desde o início do incidente. Quem não tem envio aceito para a mesma campanha e jogador pode receber de novo: crie uma campanha nova com a lista ou reagende a original.

```sql
SET default_transaction_read_only = on;
select t.nome as tenant, l.trigger_name, l.player_id, l.to_phone, max(l.created_at) as last_error_at,
       min(l.error) as error
from public.sms_send_logs l
join public.tenants t on t.id = l.tenant_id
where l.created_at >= timestamptz '2026-10-15 14:38:00+00'
  and l.status = 'error'
  and l.trigger_name like 'campanha:%'
  and (l.error like 'Short Brasil: erro de autenticacao%'
    or l.error like 'Short Brasil: saldo insuficiente%'
    or l.error like 'Provedor SMS recusou as credenciais%')
  and not exists (
    select 1 from public.sms_send_logs ok
    where ok.tenant_id = l.tenant_id and ok.player_id = l.player_id
      and ok.trigger_name = l.trigger_name and ok.status = 'sent'
      and ok.created_at >= l.created_at)
group by 1, 2, 3, 4
order by 1, 2;
```

Campanhas com o cursor parado pelo breaker retomam sozinhas quando ele fecha. Para listá-las: `select id, tenant_id, status, sent_cursor, total_count, last_error from public.sms_campaigns where last_error like 'Envio de SMS suspenso%';`.

Situação em 15/10/2026, por volta de 16:30 UTC (somente leitura): **nenhum** log de campanha com 101/505 (os 797 logs de erro eram todos de jornadas) e nenhum lead de fluxo SMS falhou.

## 10. Transição de nível fora do depósito (WHK-01)

Migration `20261015130000_level_transition_outbox.sql` (Fase D de `docs/ESCOPO_ESCALA_TRACKING_ATRIBUICAO_2026-10-14.md`).

### 10.1 Como funciona

- O trigger `trg_players_journey_level_transition` (função `transition_journey_level_on_deposit()`, mesmo nome) agora só calcula os dois níveis e, se mudou, grava uma linha em `public.journey_level_outbox` (com o `deposit_id` aprovado mais recente). Nada em `journey_enrollments`/`journey_events` roda na transação do depósito: lock, FK ou timeout da jornada não desfazem mais o depósito.
- `public.process_journey_level_outbox(500)` roda no pg_cron (`betleads-journey-level-outbox`, `* * * * *`, SQL puro, `statement_timeout` 50 s, `lock_timeout` 5 s). Cada linha é aplicada em subtransação com a mesma semântica de antes (sai das inscrições `progressao_niveis` com `exit_reason='level_changed'` + evento `level_changed`; entra na jornada do novo nível com `entry_key='level:<nível>'` + evento `level_entered`).
- **Latência:** a jornada de nível começa até ~1 min (+ processamento) após o commit do depósito. Jornadas por evento (`enrollPlayerOnEvent`) não mudam.
- Ordem por jogador: uma linha só é processada quando não há linha anterior pendente do mesmo jogador. Erro em uma linha só segura as linhas seguintes daquele jogador.
- Erro: `attempts + 1`, `last_error = '<SQLSTATE>: <mensagem>'`, nova tentativa em 1, 2, 4, 8, 16, 30… min. Após 10 tentativas: `dead_at` preenchido (não tenta mais e libera as próximas linhas do jogador).
- Cada execução grava uma linha em `dispatcher_runs` (`job='journey_level_outbox'`), então aparece em `observability_job_health()`. Linhas processadas há mais de 30 dias são apagadas pelo próprio worker (até 1000 por execução).

### 10.2 Consultas

```sql
SET default_transaction_read_only = on;
SET statement_timeout = '15s';
select * from public.observability_journey_level_outbox();
select * from public.observability_job_health() where job = 'journey_level_outbox';
select jobid, status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'betleads-journey-level-outbox')
order by start_time desc limit 10;
```

| Indicador | Normal | Alerta |
| --- | --- | --- |
| `oldest_pending_age_seconds` | < 120 | > 300 (worker parado ou travado) |
| `ready` | 0 entre execuções | > 0 por 3 min |
| `retrying` | 0 | > 0 por 15 min → ver `last_error` |
| `dead_last_24h` | 0 | qualquer ocorrência |
| `seconds_since_last_start` (`journey_level_outbox`) | < 90 | > 180 → cron parado |

### 10.3 Procedimentos

- Ver as linhas com erro: `select id, tenant_id, current_level, attempts, last_error, next_attempt_at, dead_at from public.journey_level_outbox where processed_at is null and last_error is not null order by id;`
- Reenfileirar após corrigir a causa (escrita, fora do modo somente leitura): `update public.journey_level_outbox set dead_at = null, attempts = 0, next_attempt_at = now() where id = <id>;`. Atenção: uma linha morta reprocessada depois de linhas posteriores do mesmo jogador sairia da jornada do nível atual; nesse caso, marcar como processada (`processed_at = now(), result = 'manual_skip'`) em vez de reenfileirar.
- Rodar já, sem esperar o cron: `select public.process_journey_level_outbox(500);` (service_role/postgres).
- Pausar: `select cron.unschedule('betleads-journey-level-outbox');` — os depósitos continuam gravando na outbox; ao reagendar, o backlog é aplicado em ordem.
- Rollback do WHK-01: reaplicar a função de `20261014200000_fix_journey_level_transition_event_order.sql` **depois** de drenar a outbox (`ready = 0` e `pending = 0`), senão as linhas pendentes ficam sem aplicar.
