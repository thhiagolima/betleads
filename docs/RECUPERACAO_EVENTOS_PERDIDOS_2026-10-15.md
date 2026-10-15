# Recuperação dos eventos perdidos pelo CON-04 — dry-run (15/10/2026)

> **Status:** análise SOMENTE LEITURA. Nada foi gravado no banco, nenhum endpoint de webhook/replay foi chamado e nenhum código ou migration foi alterado.
> Sessões com `default_transaction_read_only = on` e `statement_timeout = '30s'`. Medição feita em 15/10/2026, por volta de 03:30 UTC (00:30 BRT).
> Tenant afetado: **Sorte Alta** (`03b73a96-…8256b`). Nenhum outro tenant tem eventos nessa situação.

---

## 1. Resumo executivo

1. **A recuperação já aconteceu.** Entre **14/10 23:22 UTC e 15/10 03:27 UTC** o cron `betleads-webhook-replay` (modo *legacy*, roda a cada minuto) reprocessou logs antigos. Isso dá **646 eventos financeiros** concluídos e **195 eventos do universo CON-04** com o recibo fechado só nesse intervalo. Para isso, alguém (ou algo) voltou logs `duplicado` para `recebido`/`erro`. Não dá para auditar quem fez isso: `webhook_logs` não tem `updated_at` e o `pg_stat_statements` não mostra um UPDATE em massa.
2. **Conjunto residual estrito (critério do passo 2): 1 evento.** É um `deposito-pendente` de 02/10 (R$ 50) cujo depósito já está `aprovado` → classe (c). Outros 8 eventos têm o recibo travado em `processing`, mas já têm um log `processado` → também (c).
   **Conjunto seguro para re-enfileirar: 0 eventos.**
3. **O replay tardio deixou efeitos colaterais reais**, que precisam de decisão (seção 6):
   - **25 matrículas** em jornadas `nivel_alterado` criadas com `deposit_id` de depósitos aprovados pelo replay: 7 `active`, 13 `waiting`, 5 `exited`. Uma já tem passo `sent`.
   - **6 jogadores** ficaram com `ultimo_login` **mais antigo** que a última sessão (de 0,1 h a 82,6 h para trás).
   - **71 depósitos `aprovado`** passaram a ter `provider_status = 'awaiting_payment'`: 15 do universo CON-04 e 56 do lote de 02/10. O replay de um `deposito-pendente` sobrescreve `provider_status`, `raw_payload`, `event_id` e `valor` de um depósito já aprovado.
   - **18 jogadores** têm como PIX pendente mais recente um depósito gravado ou tocado pelo replay e ainda sem matrícula na jornada `pix_gerado_nao_pago`. Essa jornada é `per_occurrence` e não tem `start_after`, então pode mandar SMS de "PIX não pago" sobre PIX de 1 a 13 dias atrás.
4. **Não executar o UPDATE comentado no fim da migration `20261015092000`.** Ele (a) usa `next_replay_at`, coluna que **não existe em produção** (a migration CON-03 não foi aplicada; `claim_webhook_logs_for_replay` também não existe, por isso o replay roda em modo legacy); (b) não exclui eventos que já têm log `processado`; (c) não tem limite de data; (d) re-enfileira todos os logs duplicados de cada evento, não um por evento.

---

## 2. Método

1. Li `src/lib/webhook-process.server.ts` inteiro (1.516 linhas), `src/routes/api/public/hooks/webhook-replay.ts`, `src/lib/journey-scanner.server.ts`, `src/lib/journeys.server.ts` e `src/lib/triggers.server.ts`. As definições **vivas** de `claim_webhook_event`, `record_financial_webhook_event` e `transition_journey_level_on_deposit` foram lidas com `pg_get_functiondef`. A lista de triggers vem de `pg_trigger`.
2. **Universo CON-04 (por recibo):** recibos de `webhook_event_receipts` dos últimos 16 dias que estão (i) `processing` com `locked_at` há mais de 10 min, (ii) `failed` há mais de 30 s, ou (iii) `completed` depois de 14/10 23:00 UTC com `completed_at − created_at > 10 min` (fechados tarde). Para cada recibo, juntei os logs do mesmo `(tenant, provider_event_id)`.
   O id do evento segue a ordem do código: `payload.eventId → payload.event_id → data.eventId → data.event_id`, com `data = payload.data ?? payload.player ?? payload.user ?? payload`.
3. **Escolha do log por evento:** um `duplicado`, de preferência com valor (`amount/valor`) presente, e o mais antigo.
4. **Extração**, na mesma ordem do código:
   - `transactionId`: `data.transactionId → transaction_id → referenceId → operationId → subject.id (payment_transaction) → payload.eventId → event_id → deliveryId` (linhas 170-180).
   - `externalId`: `resolveExternalId`, linhas 1162-1212.
   - Valor: `abs(data.amount ?? data.valor ?? payload.amount ?? payload.valor)`, linhas 130-131.
5. **Estado downstream:** `deposits`/`withdrawals` por `(tenant, external_id)`, `events`/`sessions` por `(tenant, provider_event_id)`, `players` por `player_external_id`, `financial_webhook_attempts`, `player_attributions`, `journey_enrollments`/`journey_events`/`journey_step_executions` criados depois de 14/10 23:00.
6. Jogadores aparecem só como hash curto (sha256 do `player_id`, 8 caracteres). Não há nenhuma PII neste documento.

Scripts (scratchpad da sessão): `rec_inv.mjs`, `rec_cls.mjs`, `rec_side.mjs`, `rec_side2.mjs`, `rec_appr.mjs`, `rec_old*.mjs`, `rec_dry.sql`.

---

## 3. Efeitos colaterais por evento (`processWebhookEvent`)

Legenda: **I** = idempotente · **NI** = não idempotente, mas inofensivo · **N** = nocivo se repetido ou atrasado.

| # | Efeito | Eventos | Onde | Class. | Observação |
|---|---|---|---|---|---|
| 1 | `claim_webhook_event` (recibo) | todos com eventId | `webhook-process.server.ts:185-227`; função SQL viva | I | Reivindica de novo se `processing` tem mais de 10 min ou `failed` mais de 30 s. Só um worker por evento. |
| 2 | Insert de `players` (se o external id não existe) | todos | `:231-289` | I | Unicidade por `(tenant, player_external_id)` + releitura em caso de conflito. |
| 3 | Update de `players`: `utm_*`, `origem`, `affiliate_id`/`expert` (se vazios), `cpf` (se vazio) | todos | `:293-326`, `:597-608` | NI/N | As UTMs são sobrescritas com o payload antigo (last-write-wins com dado velho). |
| 4 | `ultimo_login = eventIso` / `ultimo_jogo = eventIso` | login / jogo-iniciado | `:329-330` | **N** | Atribuição incondicional: um replay tardio **faz o campo voltar no tempo**. Confirmado em 6 jogadores. |
| 5 | Insert em `financial_webhook_attempts` | financeiros | `:357-377` | NI | Trilha de auditoria (só append). |
| 6 | RPC `record_financial_webhook_event` | deposito-*, saque-* | `:379-403`; SQL viva (origem `20261001170000`/`20261001174000`) | I no status / **N** nos campos | Lock consultivo por `tenant:kind:external_id`. **Nunca rebaixa `aprovado`**; `falhou` é terminal, exceto se depois vier `aprovado`. **Promove `pendente → aprovado`.** Incrementa `total_depositado`/`total_sacado`, `ultimo_deposito` e `ftd_em` **só quando `became_approved`**, então não conta duas vezes. **Porém** o UPDATE sobrescreve `valor`, `provider_status`, `event_id`, `raw_payload` e `player_id` mesmo quando o status não muda: um `pendente` tardio deixa um depósito aprovado com `provider_status='awaiting_payment'` (71 casos). |
| 7 | Trigger `trg_players_journey_level_transition` (`transition_journey_level_on_deposit`) | quando `total_depositado` sobe | `20261014200000_fix_journey_level_transition_event_order.sql` | **N** (atraso) | Tira o jogador das jornadas `progressao_niveis` e matricula na `nivel_alterado` do novo nível (`entry_key = level:<nível>`, `on conflict do nothing`). Com o replay tardio, a mensagem de "subiu de nível" sai 1 dia ou mais depois. **25 matrículas** criadas. |
| 8 | `cashback_payments` + `total_cashback_paid` (ler → somar → gravar) | cashback-pago | `:406-457`, `:580-594` | I no insert (23505) / NI na soma | Só soma quando o insert é novo. |
| 9 | Matrícula **imediata** em `sms_flow_leads`/`email_flow_leads` (`cashback_pago`, prioridade `next_run_at = 1970`) | cashback-pago | `:474-579` | **N** | Matrícula `completed` é **reiniciada** (passo 0) → reenvio. Nenhum cashback no universo atual. |
| 10 | Atribuição de conversão (`attributeFromLastFirstPartyClick`) | cadastro, login, jogo, deposito-aprovado | `:609-650`; `conversion-attribution.server.ts:115-144` | I | Upsert em `(tenant, event_type, event_id, model, classification)`. Usa `occurredAt` do evento. |
| 11 | `player_attributions` (signup) | cadastro | `:651-662`, `:1388-1424` | I | Upsert em `(tenant, player, event_type)`. |
| 12 | `sessions` (abrir) | login | `:664-699` | I | Checa `provider_event_id` + upsert com `ignoreDuplicates`. |
| 13 | `sessions` (fechar a sessão aberta mais recente) | logout | `:700-737` | **N** | Um logout tardio pode fechar uma sessão **mais nova**. Nenhum logout no universo atual. |
| 14 | `events` | todos com jogador | `:739-776` | I (com eventId) | Sem eventId, duplica. |
| 15 | Matrícula `lead_cadastrado` (SMS/email/ligação) | cadastro em tenant CRM_EXPERT | `:783-902` | **N** | Pula só se houver `pending/running`; depois de `completed`, matricula de novo. Sorte Alta é CRM_PLATAFORMA, então não se aplica aqui. |
| 16 | `webhook_logs`/recibo/tentativa (markLog) | todos | `:39-83` | I | — |
| 17 | Espelho para CRM_EXPERT (`processWebhookEvent` recursivo, `mirror:false`) | todos com `affiliate_id` na allowlist | `:932-1012` | I (recibo por tenant) | Cria um log novo no tenant expert. Nenhum espelho dos eventos recuperados foi encontrado. |
| 18 | Scanner de jornadas `pix_gerado_nao_pago` (estado: último depósito `pendente`, método PIX) | deposito-pendente | `journey-scanner.server.ts:64-90,114-117`; `journeys.server.ts:95-112` | **N** (atraso) | `per_occurrence` com `deposit.id`, sem `start_after`: um `pendente` gravado tarde vira uma ocorrência nova → SMS "PIX não pago" sobre PIX antigo. |
| 19 | Scanner `saque_pago` (último saque `aprovado`) | saque-aprovado/concluido | idem | **N** (atraso) | Nenhuma matrícula `saque_pago` hoje (nem antes), mas o risco é o mesmo. |
| 20 | `primeiro_deposito` (via `ftd_em`) | deposito-aprovado | `journey-scanner.server.ts:104-112` | N (atraso) | A Sorte Alta não tem essa jornada ativa. `ftd_em` foi definido pelo replay para 2 jogadores. |

Jornadas ativas da Sorte Alta: `cadastrados_sem_deposito` (once), `cashback_pago`, `inactivity` ×3, `nivel_alterado` ×5 (bronze → diamond), `pix_gerado_nao_pago` e `saque_pago`. Todas `per_occurrence` exceto a primeira, e **nenhuma com `start_after`**.

---

## 4. Classificação e valores

### 4.1 Universo CON-04 (204 eventos distintos, Sorte Alta)

| Evento | Recuperados pelo replay (14/10 23:22 → 15/10 03:27) | Valor | Residual (recibo travado) | Valor |
|---|---:|---:|---:|---:|
| deposito-aprovado | 108 | R$ 21.345,03 | 2 | R$ 120,24 |
| deposito-pendente | 44 | R$ 4.010,81 | 6 | R$ 199,99 |
| saque-pendente | 9 | R$ 3.597,30 | 0 | — |
| saque-concluido | 5 | R$ 582,00 | 0 | — |
| saque-aprovado | 2 | R$ 400,00 | 0 | — |
| login | 17 | — | 1 | — |
| cadastro | 10 | — | 0 | — |
| **Total** | **195** | **R$ 29.935,14** | **9** | **R$ 320,23** |

Distribuição pela data do primeiro log: 02/10 (3), 11/10 (5), 13/10 (3), 14/10 (168: o incidente), 15/10 (25).

Detalhe do que o replay de fato aplicou:
- **deposito-aprovado:** 105 de 108 (R$ 21.248,03) não tinham nenhuma tentativa financeira `aprovado` concluída antes do replay. Esse é o **limite superior** de promoções `pendente/ausente → aprovado` feitas pelo replay; parte pode ter sido aplicada pelo worker original, que morreu depois do RPC. Hoje todos os 108 estão `aprovado` (102 com `provider_status='completed'`, 6 com `awaiting_payment`).
- **deposito-pendente:** 35 de 44 linhas (R$ 3.467,81) foram gravadas pela primeira vez pelo replay. Status atual: 31 `aprovado` (16 `completed` + 15 `awaiting_payment`) e 13 `pendente` PIX (R$ 697,53).
- **saques:** os 7 aprovados/concluídos (R$ 982,00) foram promovidos pelo replay, o que soma em `total_sacado`.

### 4.2 Classificação do estado ATUAL (o que fazer agora)

| Classe | Critério | Eventos | Valor |
|---|---|---:|---:|
| (a) ausente → replay necessário | sem linha downstream | **0** | — |
| (b) parcial → replay necessário | ex.: depósito `pendente` com evento `aprovado` | **0** | — |
| (c) já aplicado → marcar resolvido, **não** reprocessar | estado downstream coerente | **204** (195 pelo replay + 9 residuais) | R$ 30.255,37 |
| (d) risco de efeito colateral → decisão manual | ver seção 6 (efeitos **já materializados**) | 25 matrículas de nível, 18 jogadores com risco PIX, 6 `ultimo_login` regredidos, 71 depósitos com `provider_status` rebaixado | — |

Os 9 residuais:
- **8** já têm log `processado`, mas o recibo ficou `processing` (`attempt_count = 1`). Um evento que chegou depois reivindicou o recibo e morreu, ou o processamento original não fechou o recibo. Depósitos/sessões/eventos estão presentes. Inofensivo. Só uma nova entrega do mesmo evento reprocessaria tudo, de forma idempotente quanto a status.
- **1** `deposito-pendente` de 02/10 (R$ 50, jogador `53c00624`) só com logs `duplicado`. O replay reivindicou o recibo às 01:07 UTC e morreu antes da tentativa financeira. O depósito já está **`aprovado`** por outro evento; falta só a linha em `events` (tipo `deposito-pendente`), o que é cosmético. **Não reprocessar**: o replay só rebaixaria `provider_status` e `raw_payload` de um depósito aprovado.

### 4.3 Achado adjacente (fora do CON-04): lote de 02/10 "pré-recibo"

O mesmo replay processou **438 tentativas financeiras de logs de 02/10 15:46–16:28 UTC**, anteriores à criação de `webhook_event_receipts` (primeiro recibo em 02/10 17:57). Para esses eventos foram criados recibos novos. Resultado atual:

| Tipo | Evento | Status atual | Qtde | Valor |
|---|---|---|---:|---:|
| depósito | aprovado | aprovado | 55 | R$ 5.022,21 |
| depósito | pendente | aprovado | 134 | R$ 10.399,13 |
| depósito | pendente | pendente | 29 | R$ 1.381,99 |
| saque | aprovado | aprovado | 19 | R$ 7.504,61 |
| saque | pendente | aprovado / falhou / pendente | 24 / 2 / 1 | R$ 6.974,80 / 1.000,00 / 500,00 |

Nenhuma matrícula de nível ou de saque saiu desse lote. Mesmo assim, ele contribui com **56 depósitos aprovados com `provider_status='awaiting_payment'`** e **10 jogadores com risco de jornada PIX** sobre PIX de 13 dias atrás.

Fora isso, 41 tentativas financeiras de 14–15/10 vieram de logs **sem eventId**, sem proteção de recibo. Elas dependem só da idempotência do RPC.

---

## 5. Riscos de reprocessar (a)/(b) agora, dias depois

- **Jornadas imediatas:** a única entrada "imediata" no webhook é `cashback_pago` (SMS/email com prioridade máxima, item 9) e `lead_cadastrado` no CRM Expert (item 15). Nenhum cashback ou cadastro de expert está no universo. As jornadas da Sorte Alta são de scanner/estado e reagem ao **estado** que o replay grava:
  - `deposito-aprovado` tardio → sobe `total_depositado` → trigger de nível → matrícula `nivel_alterado` (confirmado: 25).
  - `deposito-pendente` tardio (PIX) → ocorrência nova de `pix_gerado_nao_pago` (18 jogadores expostos, 0 matriculados até agora).
  - saque tardio aprovado → `saque_pago`.
- **Dupla contagem de `total_depositado`:** **não** acontece pelo webhook. O incremento depende de `became_approved` (status anterior diferente de `aprovado`) sob lock consultivo. O único risco é rodar `scripts/sync-sortealta-export.mjs` com um export **posterior** a 14/10: ele grava `total_depositado` absoluto a partir do CSV, e os depósitos aprovados pelo replay também foram somados. Hoje o export é de 01/10, então não há sobreposição.
- **Transições de nível:** sim, disparam (item 7). O nível final fica correto, mas a mensagem sai atrasada.
- **Regressões de dados:** `ultimo_login` (item 4) e `provider_status`/`raw_payload`/`valor`/`event_id` de depósitos aprovados (item 6).

### Mitigações propostas (só descritas, não implementadas)

1. **Modo de replay "recovery"** (`options.recovery = true` em `processWebhookEvent`, ou `payload._recovery`):
   - não matricular em fluxos imediatos (itens 9 e 15);
   - não alterar `ultimo_login`/`ultimo_jogo` quando o valor atual for mais novo (`greatest`);
   - não sobrescrever UTMs;
   - não fechar sessões (logout);
   - pular o espelho para o CRM Expert.
2. **RPC financeira:** quando `v_previous = 'aprovado'` e `p_status <> 'aprovado'`, não atualizar `valor`/`provider_status`/`raw_payload`/`event_id`. Hoje um `pendente` tardio "suja" um aprovado.
3. **Trigger de nível com janela:** gravar `metadata.late_by_hours` (`now() − deposit.completed_at`) e, acima de N horas, criar a matrícula como `exited`/`skipped`. A outra opção é o dispatcher pular o passo de mensagem.
4. **Jornadas por ocorrência** (`pix_gerado_nao_pago`, `saque_pago`): definir `trigger_config.start_after`, ou exigir no scanner `deposits.created_at >= now() − 24h` para PIX. Isso pede mudança de produto e código.
5. **Antes de qualquer novo re-enfileiramento,** aplicar a migration CON-03 (`next_replay_at`, `replay_attempts`, DLQ) e o fix do CON-04 (`readReceiptState`/`deferLogForReplay`, já no código em `webhook-process.server.ts:195-224`). Não foi possível confirmar se essa versão está em produção: nenhum log `deferred: receipt_in_progress` foi observado.

---

## 6. Ação recomendada

1. **Não re-enfileirar nada agora.** O conjunto seguro está vazio. Os 204 eventos do universo estão aplicados.
2. **Registrar como resolvidos** os 9 recibos residuais. Fechar o recibo é opcional e manual, fora deste dry-run:
   `update webhook_event_receipts set status='completed', completed_at=now() where …`
   Isso evita que uma nova entrega do mesmo evento reprocesse tudo. Vale para os 8 com log `processado` e para o de 02/10.
3. **Decisões de produto, com dono definido:**
   - **25 matrículas `nivel_alterado`** com `deposit_id` aprovado pelo replay: manter (o nível é real) ou encerrar as `waiting`/`active` com `exit_reason='late_webhook_recovery'`. Uma já teve passo enviado.
   - **18 jogadores com risco de SMS PIX antigo:** antes do próximo ciclo do scanner, colocar `start_after` na jornada `pix_gerado_nao_pago` da Sorte Alta (`29a87af9-…`) ou excluir essas ocorrências.
4. **Correções de dados**, em script revisado e em transação (só descritas):
   - `ultimo_login = greatest(ultimo_login, max(sessions.iniciado_em))` para os 6 jogadores. Na prática dá para aplicar a todos com `ultimo_login < max(sessions.iniciado_em)`.
   - `provider_status`/`raw_payload` dos 71 depósitos `aprovado` com `awaiting_payment` tocados depois de 14/10 23:00: restaurar a partir da última `financial_webhook_attempts` `aprovado` do mesmo `external_id`. Ver também os 106 casos antigos com o mesmo sintoma.
5. **Retirar ou corrigir o UPDATE comentado na migration `20261015092000`** (ver seção 1, item 4) e trocá-lo pelo bloco da seção 7.

---

## 7. SQL de re-enfileiramento (NÃO EXECUTADO, só para uso futuro)

Hoje o dry-run (7.1) devolve **1 linha, classe `c_resolvido`**. Portanto, o UPDATE (7.2) não altera nada. Ele fica documentado para o caso de surgirem eventos (a)/(b) antes do deploy do fix CON-04.

### 7.1 Dry-run: candidatos e classificação

```sql
-- Sessão: set statement_timeout = '60s';
-- Obs.: o Postgres proíbe CREATE (inclusive de temp view) em transação read-only.
-- Para um dry-run estritamente read-only, use o corpo abaixo como CTE
-- (with … select …) em vez de criar a view. A temp view existe só na sessão
-- e não altera o schema.
-- Visão temporária com o critério completo.
create temp view con04_candidates as
with lg as (
  -- Logs do tenant afetado com o mesmo id de evento usado pelo código
  -- (payload.eventId → payload.event_id → data.eventId → data.event_id).
  select w.id, w.tenant_id, w.evento, w.status, w.created_at, w.payload, x.d,
         coalesce(nullif(btrim(w.payload->>'eventId'), ''), nullif(btrim(w.payload->>'event_id'), ''),
                  nullif(btrim(x.d->>'eventId'), ''),       nullif(btrim(x.d->>'event_id'), '')) as pev
    from public.webhook_logs w
   cross join lateral (
     select case
              when jsonb_typeof(w.payload->'data')   = 'object' then w.payload->'data'
              when jsonb_typeof(w.payload->'player') = 'object' then w.payload->'player'
              when jsonb_typeof(w.payload->'user')   = 'object' then w.payload->'user'
              else w.payload
            end as d) x
   where w.tenant_id = '03b73a96-aef7-414d-94fc-93a996f8256b'
     and w.created_at >= timestamptz '2026-10-01 00:00-03'
),
ev as (
  -- Evento com pelo menos um 'duplicado' e NENHUM log processado/sem_player
  -- nem já na fila (recebido/erro).
  select tenant_id, pev
    from lg
   where pev is not null
   group by tenant_id, pev
  having bool_or(status = 'duplicado')
     and not bool_or(status in ('processado', 'sem_player', 'recebido', 'erro'))
),
stuck as (
  -- Recibo vencido: o claim_webhook_event vai conseguir reivindicar.
  select ev.tenant_id, ev.pev, r.status as receipt_status
    from ev
    join public.webhook_event_receipts r
      on r.tenant_id = ev.tenant_id and r.provider_event_id = ev.pev
   where (r.status = 'processing' and r.locked_at  < now() - interval '10 minutes')
      or (r.status = 'failed'     and r.updated_at < now() - interval '30 seconds')
),
pick as (
  -- Um log por evento: duplicado, com valor presente, o mais antigo.
  select distinct on (l.tenant_id, l.pev)
         l.id, l.tenant_id, l.pev, l.evento, l.created_at, s.receipt_status,
         coalesce(nullif(btrim(l.d->>'transactionId'), ''), nullif(btrim(l.d->>'transaction_id'), ''),
                  nullif(btrim(l.d->>'referenceId'), ''),   nullif(btrim(l.d->>'operationId'), ''),
                  case when l.payload->'subject'->>'type' = 'payment_transaction'
                       then nullif(btrim(l.payload->'subject'->>'id'), '') end,
                  nullif(btrim(l.payload->>'eventId'), ''), nullif(btrim(l.payload->>'event_id'), ''),
                  nullif(btrim(l.payload->>'deliveryId'), '')) as tx,
         coalesce(nullif(btrim(l.d->>'userId'), ''), nullif(btrim(l.d->>'user_id'), ''),
                  nullif(btrim(l.d->>'external_id'), ''), nullif(btrim(l.d->>'player_external_id'), ''),
                  nullif(btrim(l.d->>'playerId'), ''), nullif(btrim(l.d->>'player_id'), ''),
                  nullif(btrim(l.d->>'customerId'), ''), nullif(btrim(l.d->>'customer_id'), ''),
                  nullif(btrim(l.d->>'id'), ''), nullif(btrim(l.payload->>'userId'), ''),
                  nullif(btrim(l.payload->>'user_id'), ''), nullif(btrim(l.payload->>'player_id'), '')) as ext,
         abs(nullif(coalesce(l.d->>'amount', l.d->>'valor', l.payload->>'amount', l.payload->>'valor'), '')::numeric) as amount,
         coalesce(case when l.evento like '%aprovado%' or l.evento like '%concluido%' then l.d->>'completedAt' end,
                  l.d->>'completed_at', l.d->>'paid_at', l.d->>'paidAt', l.d->>'startedAt', l.d->>'started_at',
                  l.d->>'createdAt', l.d->>'created_at', l.d->>'timestamp', l.payload->>'occurredAt',
                  l.payload->>'occurred_at', l.payload->>'timestamp', l.payload->>'createdAt',
                  l.payload->>'created_at') as event_at_raw
    from lg l
    join stuck s on s.tenant_id = l.tenant_id and s.pev = l.pev
   where l.status = 'duplicado'
   order by l.tenant_id, l.pev,
            (coalesce(l.d->>'amount', l.d->>'valor', l.payload->>'amount', l.payload->>'valor') is not null) desc,
            l.created_at asc
),
state as (
  select p.*,
         pl.id as player_id, pl.ultimo_login,
         dep.status as dep_status, wd.status as wd_status,
         exists (select 1 from public.events e
                  where e.tenant_id = p.tenant_id and e.provider_event_id = p.pev) as has_event,
         exists (select 1 from public.sessions s
                  where s.tenant_id = p.tenant_id and s.provider_event_id = p.pev) as has_session
    from pick p
    left join public.players pl
      on pl.tenant_id = p.tenant_id and pl.player_external_id = p.ext
    left join public.deposits dep
      on p.evento like 'deposito-%' and dep.tenant_id = p.tenant_id and dep.external_id = p.tx
    left join public.withdrawals wd
      on p.evento like 'saque-%' and wd.tenant_id = p.tenant_id and wd.external_id = p.tx
)
select s.*,
  case
    -- (d) dispara SMS/email imediato; decisão manual.
    when s.evento = 'cashback-pago' then 'd_manual'
    -- (d) PIX pendente tardio vira ocorrência nova de pix_gerado_nao_pago.
    when s.evento = 'deposito-pendente' and s.dep_status is null then 'd_manual'
    when s.evento like 'deposito-%' and s.dep_status is null then 'a_ausente'
    when s.evento = 'deposito-aprovado' and s.dep_status = 'pendente' then 'b_parcial'
    when s.evento like 'deposito-%' then 'c_resolvido'
    when s.evento like 'saque-%' and s.wd_status is null then 'a_ausente'
    when s.evento in ('saque-aprovado', 'saque-concluido') and s.wd_status = 'pendente' then 'b_parcial'
    when s.evento like 'saque-%' then 'c_resolvido'
    when s.evento = 'login' and s.has_session then 'c_resolvido'
    -- (d) login tardio faria ultimo_login regredir.
    when s.evento = 'login' and s.ultimo_login is not null
         and s.ultimo_login > (s.event_at_raw)::timestamptz then 'd_manual'
    when s.has_event then 'c_resolvido'
    else 'a_ausente'
  end as classe
from state s;

-- Resumo (resultado em 15/10 03:30 UTC: 1 linha, c_resolvido, deposito-pendente, R$ 50).
select classe, evento, receipt_status, count(*) as eventos, coalesce(sum(amount), 0) as valor
  from con04_candidates
 group by 1, 2, 3
 order by 1, 2;

-- Lista para revisão (sem PII): id do log, evento, classe, valor.
select id as webhook_log_id, evento, classe, amount, created_at
  from con04_candidates
 where classe in ('a_ausente', 'b_parcial')
 order by created_at;
```

### 7.2 Re-enfileiramento restrito às classes (a)/(b)

```sql
-- NÃO EXECUTADO. Rodar só se 7.1 listar linhas a_ausente/b_parcial e depois
-- da decisão sobre os efeitos colaterais (seção 5). Mesma sessão da temp view,
-- agora SEM default_transaction_read_only.
--
-- Por que não o UPDATE comentado da migration 20261015092000:
--   * next_replay_at não existe em produção (migration CON-03 não aplicada);
--   * não exclui eventos já processados nem limita a data;
--   * reabre TODOS os logs duplicados de um evento (até 7 por evento em 02/10).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- 1) Congela a lista aprovada (ids do dry-run revisado).
create temp table con04_requeue on commit drop as
select id, evento, amount
  from con04_candidates
 where classe in ('a_ausente', 'b_parcial');

-- 2) Conferência: o número tem que bater com o dry-run revisado. Se não bater, ROLLBACK.
select count(*) as a_reenfileirar, coalesce(sum(amount), 0) as valor from con04_requeue;

-- 3) Volta só o log escolhido de cada evento para 'recebido'. O replay legacy
--    (status in ('recebido','erro'), ordem por created_at) pega esses logs; o recibo
--    vencido deixa o claim acontecer. O marcador _recovery serve de auditoria e para
--    o pós-check. Atenção: ele vai junto para events.metadata / deposits.raw_payload.
update public.webhook_logs w
   set status  = 'recebido',
       payload = w.payload || jsonb_build_object(
                   '_recovery', jsonb_build_object('ticket', 'CON-04', 'requeued_at', now()))
  from con04_requeue q
 where w.id = q.id
   and w.status = 'duplicado';           -- guarda contra corrida
-- Se a migration CON-03 já estiver aplicada, incluir também:
--   , next_replay_at = now(), replay_attempts = 0, dead_lettered_at = null

-- 4) O row count do UPDATE tem que ser igual ao passo 2. Se for, COMMIT; se não, ROLLBACK.
commit;
```

### 7.3 Pós-checagem (rodar 10–30 min depois, só leitura)

```sql
-- a) Destino dos logs re-enfileirados: esperado 100% 'processado' (ou 'duplicado'
--    se outra entrega fechou o recibo antes). 'recebido'/'erro' persistente = investigar.
select w.status, count(*)
  from public.webhook_logs w
 where w.payload->'_recovery'->>'ticket' = 'CON-04'
 group by 1;

-- b) Recibos dos eventos re-enfileirados: esperado 'completed'.
select r.status, count(*)
  from public.webhook_logs w
  join public.webhook_event_receipts r
    on r.tenant_id = w.tenant_id
   and r.provider_event_id = coalesce(w.payload->>'eventId', w.payload->>'event_id',
                                      w.payload->'data'->>'eventId', w.payload->'data'->>'event_id')
 where w.payload->'_recovery'->>'ticket' = 'CON-04'
 group by 1;

-- c) O universo tem que zerar: rodar de novo o resumo de 7.1. Esperado: nenhuma
--    linha a_ausente/b_parcial.

-- d) Efeitos colaterais desde o re-enfileiramento (ajustar :t0 para a hora do commit):
select j.trigger_type, e.status, count(*)
  from public.journey_enrollments e
  join public.journeys j on j.id = e.journey_id
 where e.tenant_id = '03b73a96-aef7-414d-94fc-93a996f8256b'
   and e.created_at >= :t0
   and j.trigger_type in ('nivel_alterado', 'pix_gerado_nao_pago', 'saque_pago', 'cashback_pago')
 group by 1, 2;

-- e) Regressão de ultimo_login (esperado 0 a mais que antes):
select count(*)
  from public.players p
  join lateral (select max(iniciado_em) m from public.sessions s where s.player_id = p.id) s on true
 where p.tenant_id = '03b73a96-aef7-414d-94fc-93a996f8256b'
   and s.m > p.ultimo_login + interval '1 second';

-- f) Aprovados com provider_status de pendente (esperado: sem aumento):
select count(*)
  from public.deposits
 where tenant_id = '03b73a96-aef7-414d-94fc-93a996f8256b'
   and status = 'aprovado' and provider_status = 'awaiting_payment';
```

Linha de base em 15/10 03:30 UTC, para comparar com (d)–(f):
- `ultimo_login` regredido entre os logins recuperados: 6;
- `aprovado` + `awaiting_payment`: 187 no total (81 tocados depois de 14/10 23:00);
- matrículas `nivel_alterado` da Sorte Alta desde 14/10 23:00: 147 (25 ligadas aos depósitos do replay).
