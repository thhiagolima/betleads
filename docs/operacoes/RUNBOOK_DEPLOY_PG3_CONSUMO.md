# Runbook — Deploy do PG3 (consumo: voz, e-mail, alertas de saldo, baixa manual com data)

**Spec:** `docs/superpowers/specs/2026-10-23-pg3-consumo-design.md`
**Plano:** `docs/superpowers/plans/2026-10-23-pg3-consumo.md`
**Branch:** `feat/pg3-consumo`
**Ledger de decisões:** `.superpowers/sdd/2026-10-23-pg3-consumo/progress.md`

Este documento é um roteiro de execução, não um relato do que já foi feito.
Nenhuma escrita em produção acontece sem autorização explícita do usuário,
pedida de novo a cada passo marcado **(requer autorização)**. Cada passo tem
um campo **Resultado:** em branco para o operador preencher na hora.

Acesso ao banco: pooler de sessão (`aws-0-ca-central-1.pooler.supabase.com:5432`,
usuário `postgres.<VITE_SUPABASE_PROJECT_ID>`), via `pg` (npm) a partir de um
diretório de scratch (ver memória `db-access-pooler`). Para as leituras,
execute `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;` logo depois de
conectar.

Pré-requisito: a mensalidade (`20261023100000`/`20261023100100`, ver
`RUNBOOK_ATIVAR_MENSALIDADE.md`) já está aplicada — a `20261024100200`
substitui `billing_admin_manual_settle`, criada pela `20261023100000`.

---

## Visão geral da ordem (não pule nem inverta)

**As 3 migrations do PG3 têm que ser aplicadas ANTES do deploy do código.**
O código novo chama `wallet_settle`, `wallet_settle_voice`,
`billing_claim_wallet_alert`, `billing_low_balance_candidates`,
`billing_set_low_balance_threshold` e grava colunas novas em `call_history` e
`email_send_logs`. Sem as migrations, todo envio de voz e de e-mail que tenta
reservar/liquidar falha, e a tela de saldo quebra.

1. Migration `20261024100000_billing_wallet_settle.sql` (Passo 1).
2. Migration `20261024100100_billing_wallet_alerts.sql` (Passo 2).
3. Migration `20261024100200_billing_manual_settle_paid_at.sql` (Passo 3).
4. Verificação (Passo 4).
5. Deploy (Passo 5).
6. Monitoramento (Passo 6).
7. Rollback (Passo 7).

---

## Passo 1 — Migration `20261024100000` (requer autorização)

Cria `wallet_settle` e `wallet_settle_voice` (só `service_role`), a coluna
`billing_price_book.charge_unanswered_blocks`, as colunas de cobrança em
`call_history` (`billing_reference_id`, `billed_blocks`, `billed_amount`,
`billing_settled_at`) e em `email_send_logs` (`billing_reference_id`,
`billed_amount`), recria `admin_set_price` com um 5º parâmetro opcional e
aceita o status `'pausada'` em `sms_campaigns` (campanha de SMS pausada por
falta de saldo).

Aplicar o arquivo inteiro numa transação. Esperado: sem erro.

**Resultado:**

## Passo 2 — Migration `20261024100100` (requer autorização)

Cria `tenant_wallets.low_balance_threshold` (padrão R$ 200), a tabela
`wallet_alerts`, `billing_claim_wallet_alert`, `billing_set_low_balance_threshold`,
`billing_low_balance_candidates` e recria `wallet_summary` (mesmos campos de
antes mais o limite).

Atenção: `add column low_balance_threshold` não tem `if not exists`; se o
passo falhar no meio, confira o estado antes de reaplicar.

**Resultado:**

## Passo 3 — Migration `20261024100200` (requer autorização)

Troca `billing_admin_manual_settle(uuid, bigint, text, text)` pela versão com
`_paid_at timestamptz default null`. O código novo só envia `_paid_at` quando
há data, então a baixa manual sem data funciona com qualquer das duas
assinaturas.

**Resultado:**

## Passo 4 — Verificação (só leitura)

```sql
select proname from pg_proc
where proname in ('wallet_settle','wallet_settle_voice','billing_claim_wallet_alert',
                  'billing_low_balance_candidates','billing_set_low_balance_threshold')
order by proname;
```
Esperado: as 5 linhas.

```sql
select charge_unanswered_blocks from billing_price_book limit 1;
```
Esperado: a consulta roda (valor `0` em todas as linhas).

```sql
select table_name, column_name from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'call_history' and column_name in
        ('billing_reference_id','billed_blocks','billed_amount','billing_settled_at'))
    or (table_name = 'email_send_logs' and column_name in ('billing_reference_id','billed_amount'))
    or (table_name = 'tenant_wallets' and column_name = 'low_balance_threshold'))
order by 1, 2;
```
Esperado: 7 linhas (4 de `call_history`, 2 de `email_send_logs`, 1 de
`tenant_wallets`).

```sql
select pg_get_function_identity_arguments(oid) from pg_proc
where proname = 'billing_admin_manual_settle';
```
Esperado: uma linha terminando em `_paid_at timestamp with time zone`.

```sql
select pg_get_constraintdef(oid) from pg_constraint
where conname = 'sms_campaigns_status_chk';
```
Esperado: a lista inclui `'pausada'`.

**Resultado:**

## Passo 5 — Deploy

`npm run build` local, merge para `main`, deploy como de costume
(`docs/docker-deployment.md`).

Env opcional na VPS: `VOICE_MAX_CALL_SECONDS` (teto da ligação em segundos,
usado para reservar os blocos de voz; padrão 120). Não é obrigatório.

**Resultado:**

## Passo 6 — Monitoramento

- A cada hora o ciclo de cobrança (`/api/public/hooks/billing-cycle`) também
  liquida reservas de voz paradas: ligação ainda `pending` sem callback
  `cml_answered` depois de 60 minutos liquida como não atendida (grátis);
  ligação atendida ou reserva sem linha em `call_history` liquida depois de
  24 h. A reconciliação diária roda a mesma rotina.
- Conferir no log linhas `[billing/invoices]` com falha de algum estágio (o
  JSON de resposta do cron traz `failures`, por exemplo `voice_settle: ...`).
- Casas sem saldo: SMS e voz param. Campanha de SMS fica `pausada` com
  "Saldo insuficiente" (a casa clica em "Retomar" depois de recarregar); na
  fila de voz, nenhuma ligação falha por falta de saldo: todos os itens da
  casa ficam `audio_ready` e são discados depois da recarga. E-mail segue
  dentro da franquia mensal.

### Limitação conhecida (voz)

Em produção, os eventos finais de voz da Infobip nunca chegam — só o callback
`cml_answered` (nosso pedido de discagem não envia `notifyUrl`). Por isso, hoje
toda ligação atendida é cobrada pelo teto (`VOICE_MAX_CALL_SECONDS`) pela
reconciliação de 24 h; não atendida sai grátis. Perguntar à Infobip junto com
o PG0-05 (configurar `notifyUrl` / relatório de entrega de voz).

## Passo 7 — Rollback

Voltar o código para o deploy anterior basta. Os objetos das 3 migrations são
aditivos e seguros com o código antigo:

- funções novas não são chamadas pelo código antigo;
- o status `'pausada'` de `sms_campaigns` não é pego pelo claim (nem no
  código antigo); uma campanha pausada no momento do rollback fica parada até
  alguém mudar o status para `'enviando'` à mão;
- colunas novas têm default ou aceitam nulo;
- `admin_set_price` e `billing_admin_manual_settle` mantêm os parâmetros
  antigos e só ganham um último parâmetro com default, então as chamadas do
  código antigo (por nome) continuam resolvendo;
- `wallet_summary` devolve os mesmos campos de antes mais o limite.

Não há necessidade de desfazer as migrations. Reservas de voz/e-mail abertas
no momento do rollback ficam no ledger; ao voltar o código novo, a
reconciliação as liquida. Nunca apagar linhas de `wallet_ledger`.
