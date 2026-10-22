# Runbook — Ativação do Pix (Upper) para compra de créditos (PG2)

**Plano:** `docs/superpowers/plans/2026-10-22-pg2-pix-upper.md`
**Escopo:** `docs/ESCOPO_GATEWAY_PAGAMENTO_UPPER_2026-10-21.md`
**Branch:** `feat/pg2-pix-upper`
**Ledger de decisões:** `.superpowers/sdd/2026-10-22-pg2-pix-upper/progress.md`

Este documento é um roteiro de execução, não um relato do que já foi feito.
Cada passo tem o comando exato, o resultado esperado, o que fazer se vier
diferente e um campo **Resultado:** em branco para o operador preencher na
hora da ativação. Nenhuma escrita em produção, cadastro de webhook na Upper
ou chamada real à Upper acontece sem autorização explícita do usuário, pedida
de novo a cada passo marcado **(requer autorização)**.

Acesso ao banco: pooler de sessão (`aws-0-ca-central-1.pooler.supabase.com:5432`,
usuário `postgres.<VITE_SUPABASE_PROJECT_ID>`), via `pg` (npm) a partir de um
diretório de scratch — não há `psql` nesta máquina (ver memória
`db-access-pooler`). Para os passos de leitura, execute
`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;` logo depois de
conectar.

---

## Visão geral da ordem (não pule nem inverta)

1. Pré-requisitos (PG0, fora deste app).
2. Env na VPS, com `BILLING_GATEWAY_ENABLED=false` por enquanto.
3. Migration `20261022110000` (tabelas e a RPC `billing_credit_paid_charge`) —
   segura antes do deploy porque nada ainda lê essas tabelas.
4. `npm run build` local, merge para `main`, deploy. Anotar o SHA pré-deploy.
5. Migration `20261022110100` (o cron) **só depois** do deploy — se ela
   rodasse antes, o cron chamaria uma rota que ainda não existe no ar.
6. Cadastrar o webhook na Upper.
7. Ligar `BILLING_GATEWAY_ENABLED=true` e recriar o container.
8. Teste real de R$ 100,00 na casa QA Jornadas P0.

---

## Passo 1 — Pré-requisitos (PG0)

**Fora deste app** — confirme com quem administra a conta Upper antes de
seguir:

- Conta Upper com KYC aprovado e a função "receber Pix" liberada.
- Chave de API gerada com escopo **só `pix_in`** (nunca uma chave com outros
  escopos).
- `GET /v1/balance` com essa chave responde `200`.

**Se vier diferente:** pare aqui. Nenhum passo seguinte funciona sem conta
aprovada e chave `pix_in`.

**Resultado:** _______________________________________________

---

## Passo 2 — Env na VPS (requer autorização)

No `.env` da VPS (mesmo arquivo documentado em `docs/docker-deployment.md`),
adicione ou confirme:

```env
UPPER_API_BASE=https://api.uppersc.com.br
UPPER_API_KEY=<chave da Upper, escopo só pix_in>
UPPER_WEBHOOK_SECRET=<segredo forte e aleatório, gerado agora>
BETTERSTACK_HEARTBEAT_BILLING_RECONCILE=<URL do heartbeat do Better Stack>
BILLING_GATEWAY_ENABLED=false
```

`UPPER_API_BASE` aceita a raiz (como acima) ou já com `/v1` no final — o
cliente (`src/lib/billing/upper-pix.server.ts`) normaliza para sempre ter
exatamente um `/v1` no path. `BILLING_GATEWAY_ENABLED` fica `false` até o
Passo 7 — enquanto isso a tela de compra mostra "Compra por Pix indisponível
no momento." e o botão de comprar fica **oculto** (não desabilitado) para
quem não pode comprar, mas webhook e conciliação continuam funcionando
normalmente.

Nunca prefixe nenhuma dessas 4 variáveis com `VITE_`, e nunca logue o valor de
`UPPER_API_KEY` ou `UPPER_WEBHOOK_SECRET`.

**Esperado:** as 4 variáveis presentes no `.env` da VPS; nenhum restart do
container ainda é necessário neste passo (o container só lê o `.env` na
inicialização — o restart efetivo é no Passo 4/7).

**Se vier diferente:** se `UPPER_API_KEY` não estiver disponível ainda
(aguardando o Passo 1), não prossiga para os Passos 6–8 — os Passos 3–5
(migrations e deploy) não dependem da chave e podem seguir.

**Resultado:** _______________________________________________

---

## Passo 3 — Migration `20261022110000` (tabelas e RPC) (requer autorização)

Esta migration cria `credit_topup_orders`, `payment_charges`,
`payment_webhook_events`, `payment_fee_settings` e a função
`billing_credit_paid_charge`. É segura antes do deploy: nenhum código em
produção ainda lê ou escreve nessas tabelas (o código novo só existe na
branch), então aplicá-la agora não muda nenhum comportamento visível.

Pelo pooler, em uma conexão de escrita (não a sessão read-only):

```sql
begin;
-- cole o conteúdo INTEGRAL de supabase/migrations/20261022110000_billing_pix_charges.sql aqui
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20261022110000', 'billing_pix_charges', array[$mig$<conteúdo integral do arquivo aqui>$mig$]);
commit;
```

Use um dollar-quote com tag própria (`$mig$...$mig$`) para o conteúdo do
arquivo, nunca aspas simples: o arquivo usa `$$` para delimitar o corpo da
função `billing_credit_paid_charge`, então uma string entre aspas simples
quebraria em todo apóstrofo do SQL colado, e `$$...$$` colidiria com os
blocos `$$` do próprio arquivo. Alternativa igualmente válida: passar o
conteúdo do arquivo como parâmetro da consulta (`$1`) em vez de literal
inline, se a ferramenta usada (script Node com `pg`) permitir.

Mesmo padrão já usado nas viradas anteriores (`docs/operacoes/RUNBOOK_VIRADA_SALDO_UNICO.md`):
registrar a migration em `supabase_migrations.schema_migrations` dentro da
mesma transação que aplica o SQL, porque não há CLI/token do Supabase nesta
máquina para `supabase db push`.

**Esperado:** sucesso, sem notice. A migration só cria tabelas/função novas.

**Se der erro:** a transação já fez rollback automático; não há dado
parcial. Leia a mensagem, corrija a causa e recomece do `begin`.

**Verificação:**
```sql
select version from supabase_migrations.schema_migrations
where version = '20261022110000';

select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('credit_topup_orders', 'payment_charges',
                      'payment_webhook_events', 'payment_fee_settings')
order by table_name;
```
**Esperado:** a versão e as 4 tabelas.

**Rollback desta migration** (se precisar desfazer antes do próximo passo):
```sql
begin;
revoke execute on function public.billing_credit_paid_charge(uuid) from service_role;
drop function if exists public.billing_credit_paid_charge(uuid);
drop table if exists public.payment_fee_settings;
drop table if exists public.payment_webhook_events;
alter table public.credit_topup_orders drop constraint if exists credit_topup_orders_charge_id_fkey;
drop table if exists public.payment_charges;
drop table if exists public.credit_topup_orders;
delete from supabase_migrations.schema_migrations where version = '20261022110000';
commit;
notify pgrst, 'reload schema';
```

**Resultado:** _______________________________________________

---

## Passo 4 — Build local, merge e deploy do código (requer autorização)

**Antes de mergear**, confirme o build local e anote o SHA do `main` atual
(o código que vai ficar no ar até este passo) — é o que o rollback usa para
reverter:

```bash
npm run build
```
**Esperado:** build Nitro conclui sem erro (preset `node-server`).

```bash
git rev-parse main
```
**SHA do `main` antes do merge:** _______________________________________

Depois do merge desta branch (`feat/pg2-pix-upper`) no `main`, na VPS, a
partir do diretório do `docker-compose.yml` (ver `docs/docker-deployment.md`):

```bash
docker compose up -d --build --force-recreate crm
docker compose ps
docker compose logs --since=5m crm
```

**Esperado:** container `crm` `healthy`, sem erro nos últimos 5 min de log.
Como `BILLING_GATEWAY_ENABLED` ainda está `false` (Passo 2), nenhuma rota de
Pix é exercitada de verdade ainda — o webhook (`/api/public/upper/webhook`) e
a rota de conciliação (`/api/public/hooks/billing-reconcile`) já existem no
código, mas o cron que chama a segunda só é cadastrado no Passo 5.

**Smoke check manual:** abrir o app, logar como super admin
(`thiago@businesscode.com.br`) e abrir uma casa qualquer em
`/creditos-sms` (ou `/tenants` → aba "Saldo") — deve carregar sem erro 500.
O botão de comprar créditos por Pix deve estar **oculto** (gateway ainda
desligado).

**Se vier diferente:** "function ... does not exist" indicaria que o Passo 3
não terminou ou o `notify pgrst, 'reload schema';` daquela migration não
propagou — rode manualmente `notify pgrst, 'reload schema';` pelo pooler e
reinicie o container.

**Resultado:** _______________________________________________

---

## Passo 5 — Migration `20261022110100` (o cron de conciliação), só depois do deploy (requer autorização)

**Por que só agora:** esta migration cadastra o job `betleads-billing-reconcile`
no `pg_cron`, que chama `POST https://betleads.io/api/public/hooks/billing-reconcile`
a cada 5 minutos. Se ela rodasse antes do Passo 4, o cron ficaria chamando uma
rota que ainda não existe no código em produção (404), gerando ruído de
alerta sem nenhum efeito útil. Com o deploy do Passo 4 já no ar, a rota já
responde.

Pelo pooler, em uma conexão de escrita:

```sql
begin;
-- cole o conteúdo INTEGRAL de supabase/migrations/20261022110100_billing_reconcile_cron.sql aqui
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20261022110100', 'billing_reconcile_cron', array[$mig$<conteúdo integral do arquivo aqui>$mig$]);
commit;
```

**Esperado:** sucesso. A migration cria as extensões `pg_cron`/`pg_net` (se
ainda não existirem) e agenda `betleads-billing-reconcile` para `*/5 * * * *`.
Ela lê o segredo do cron (`betleads_cron_secret`) do Supabase Vault — **não**
do `CRON_SECRET` do `.env` da VPS; confirme antes de aplicar que esse nome
existe em `vault.decrypted_secrets` (já deveria, de crons anteriores — ver
`docs/RUNBOOK_OBSERVABILIDADE.md`) e que o valor é o mesmo configurado em
`CRON_SECRET` na VPS (é esse valor que `requireSharedSecret` em
`src/lib/cron-auth.server.ts` compara contra o header `Authorization: Bearer`
que o `pg_net` envia).

**Se der erro `extension "pg_cron" does not exist` (ou `pg_net`):** confirme
que as extensões estão disponíveis no projeto Supabase (normalmente já estão,
de crons anteriores); se não, habilite pelo painel do Supabase antes de
repetir.

**Verificação do agendamento:**
```sql
select jobname, schedule, active
from cron.job
where jobname = 'betleads-billing-reconcile';
```
**Esperado:** 1 linha, `schedule = '*/5 * * * *'`, `active = true`.

**Verificação da execução, 5 minutos depois:**
```sql
select id, job, status, started_at, finished_at, heartbeat_at, counters
from public.dispatcher_runs
where job = 'billing-reconcile'
order by started_at desc
limit 5;
```
**Esperado:** pelo menos 1 linha com `status` em `succeeded`/`partial` nos
últimos ~5–10 min, `counters` com `claimed`/`sent`/`errors` preenchidos
(todos `0` é esperado se não houver nenhuma cobrança pendente ainda — não é
erro). Confirme também no Better Stack (`BETTERSTACK_HEARTBEAT_BILLING_RECONCILE`)
que o heartbeat está "up".

**Se não aparecer nenhuma linha em `dispatcher_runs`:** confira
`cron.job_run_details` para o erro do `pg_net` (provável: `CRON_SECRET`/
`betleads_cron_secret` divergentes entre o Vault e a VPS, causando 401 antes
mesmo de abrir o job run) ou que o container está de pé e respondendo em
`https://betleads.io`.

**Rollback desta migration:**
```sql
begin;
do $$
declare v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'betleads-billing-reconcile' loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;
delete from supabase_migrations.schema_migrations where version = '20261022110100';
commit;
notify pgrst, 'reload schema';
```

**Resultado:** _______________________________________________

---

## Passo 6 — Cadastrar o webhook na Upper (requer autorização)

No painel da Upper, em **API → Webhook**:

- **URL:** `https://betleads.io/api/public/upper/webhook`
- **Eventos:** `charge.paid`, `charge.expired`, `charge.cancelled`, `ping`
  (os eventos `payment.*`, se existirem na lista, são aceitos e gravados mas
  ignorados pelo código — tanto faz marcá-los ou não).
- **Segredo:** o mesmo valor configurado em `UPPER_WEBHOOK_SECRET` na VPS
  (Passo 2) — é contra ele que `verifyUpperSignature`
  (`src/lib/billing/upper-webhook.ts`) valida o header `X-Upper-Signature`.

Use o botão **"Testar"** do painel da Upper.

**Esperado:** a Upper envia um evento `ping`; pelo pooler,
```sql
select event_id, event, outcome, received_at, processed_at
from public.payment_webhook_events
where event = 'ping'
order by received_at desc
limit 1;
```
mostra uma linha recente com `outcome = 'ping'` e `processed_at` preenchido.

**Se vier diferente:**
- Nenhuma linha nova: confira `UPPER_WEBHOOK_SECRET` idêntico nos dois lados
  (Upper e `.env` da VPS) e que o container está no ar; a rota responde `400`
  para assinatura inválida/ausente ou corpo malformado, e `500` se
  `UPPER_WEBHOOK_SECRET` não estiver configurado no servidor — nenhum desses
  dois casos grava linha em `payment_webhook_events`.
- Linha presente mas `processed_at` nulo e `error` preenchido: a rota
  respondeu `503` (erro depois de já ter gravado o evento) — a Upper deve
  reentregar automaticamente; confira `error` na linha e os logs do
  container por `[upper-webhook]`.

**Resultado:** _______________________________________________

### 6.1 — Política de retry/desativação da Upper (checar com o painel/suporte da Upper)

Confirme com o painel ou o suporte da Upper:

- Depois de quantas falhas consecutivas a Upper **desativa** o endpoint do
  webhook automaticamente (política comum em gateways de pagamento).
- Como reativar pelo painel (**API → Webhook**) se isso acontecer.

Nosso lado sempre responde `503` (nunca `200`) quando o processamento falha
depois do evento já estar gravado (`src/routes/api/public/upper/webhook.ts`,
estágio 2), exatamente para que a Upper reentregue — mas se a conta tiver um
limite de falhas antes de desativar o endpoint, uma instabilidade prolongada
do nosso lado (deploy quebrado, banco fora do ar) pode acabar desativando o
webhook. Nesse caso a conciliação por cron (Passo 5, a cada 5 min) continua
cobrindo — nenhuma cobrança fica sem crédito por mais que ~5–10 min — mas o
webhook precisa ser reativado manualmente no painel depois que o problema for
corrigido.

**Resultado:** _______________________________________________

---

## Passo 7 — Ligar o gateway (requer autorização)

No `.env` da VPS:
```env
BILLING_GATEWAY_ENABLED=true
```

**Antes de marcar este passo como feito, confirme que `UPPER_API_KEY` já
está preenchida com uma chave válida** (Passo 2) — o `canBuy` que decide se
o botão de comprar aparece (`src/lib/sms-credits.functions.ts`) só checa
`BILLING_GATEWAY_ENABLED`, **não** verifica se `UPPER_API_KEY` está presente.
Ligar o flag sem a chave configurada não quebra nada visivelmente (o botão
aparece, mas ao clicar a criação da cobrança falha com "Upper não
configurado: UPPER_API_KEY ausente." vindo do backend, numa mensagem genérica
de erro na tela) — é só um jeito mais confuso de descobrir o mesmo problema.

```bash
docker compose up -d --force-recreate crm
docker compose ps
docker compose logs --since=5m crm
```

**Esperado:** container `crm` `healthy`. Logar como admin de uma casa
pagante (não isenta, não demo) e abrir `/creditos-sms` — o botão de comprar
créditos por Pix agora aparece.

**Se vier diferente:** o botão continua oculto para: gestor (não admin),
casa isenta (`plano = 'interno'`), casa demo, ou gateway ainda lido como
desligado pelo processo (confirme que o container foi de fato recriado, não
só reiniciado — variáveis de ambiente só são lidas na inicialização).

**Resultado:** _______________________________________________

---

## Passo 8 — Teste real de R$ 100,00 (requer autorização, gasta dinheiro real)

Use a casa **QA Jornadas P0** (slug `journey-p0-1791418509270`), já `plano =
'enterprise'` (ou seja, pagante — não isenta), logado como **admin dessa
casa** (não como super admin — a compra exige `requireTenantAdmin`).

### 8.1 — Gerar o Pix

Em `/creditos-sms` (ou a página de "Saldo e consumo" dessa casa), abrir o
diálogo de compra, escolher o valor livre **R$ 100,00** (o mínimo da Upper) e
clicar em "Gerar Pix".

**Esperado:** o diálogo mostra o QR code e o "Copia e Cola", com contagem
regressiva até a expiração.

### 8.2 — Pagar o Pix de verdade e conferir o crédito

Pague o Pix (dinheiro real). Depois do pagamento ser confirmado (pela tela,
que faz polling de `getTopupStatus` a cada 3 s), confira:

```sql
select event_id, event, outcome, received_at, processed_at, raw_body
from public.payment_webhook_events
where event = 'charge.paid'
order by received_at desc
limit 1;
```
**Esperado:** 1 linha com `outcome = 'credited'` (ou `'already_credited'` se
a conciliação já tiver creditado primeiro — ambos são o resultado correto;
só um dos dois credita de verdade, nunca os dois).

```sql
select id, external_id, status, credited_at, paid_amount_cents, amount_cents, needs_review
from public.payment_charges
where tenant_id = (select id from public.tenants where slug = 'journey-p0-1791418509270')
order by created_at desc
limit 1;
```
**Esperado:** `status = 'PAID'`, `credited_at` preenchido, `paid_amount_cents
= amount_cents = 10000`, `needs_review = false`.

```sql
select status, paid_at
from public.credit_topup_orders
where tenant_id = (select id from public.tenants where slug = 'journey-p0-1791418509270')
order by created_at desc
limit 1;
```
**Esperado:** `status = 'paid'`.

```sql
select balance from public.tenant_wallets
where tenant_id = (select id from public.tenants where slug = 'journey-p0-1791418509270');
```
**Esperado:** `balance = 100` (assumindo que a carteira dessa casa estava
zerada antes do teste — se já tinha saldo, confirme que subiu exatamente
R$ 100,00).

```sql
select entry_type, amount, reason, reference_type, reference_id
from public.wallet_ledger
where tenant_id = (select id from public.tenants where slug = 'journey-p0-1791418509270')
order by created_at desc
limit 1;
```
**Esperado:** `entry_type = 'purchase'`, `amount = 100`, `reason = 'Compra de
créditos por Pix'`, idempotency key `charge:<id da cobrança>` — confira o
`charge:<id>` batendo com o `id` da linha de `payment_charges` acima
(a chave fica no `wallet_ledger`/`wallet_mutation`, não numa coluna exposta
aqui diretamente — ver `billing_credit_paid_charge`).

Na tela: o diálogo deve mostrar **"Pagamento confirmado"** (com o valor
creditado) — se continuar em "confirmando…" por mais de ~1 min, veja o Passo
"Se vier diferente" abaixo.

**Se vier diferente:**
- Nenhuma das condições acima bate, mas a cobrança está `PAID`: espere até
  5 min — a conciliação por cron credita mesmo que o webhook falhe.
- Depois de 5 min ainda sem crédito: veja as consultas de monitoramento do
  Passo 9 (`needs_review`, `PAID` sem `credited_at`) para diagnosticar.
- `needs_review = true`: o valor pago não bateu com `amount_cents` — pare e
  trate como incidente antes de repetir o teste (não é esperado para um
  pagamento exato de R$ 100,00).

### 8.3 — Capturar o corpo real do webhook e validar as suposições do código

```sql
select raw_body, headers
from public.payment_webhook_events
where event = 'charge.paid'
order by received_at desc
limit 1;
```

O `raw_body` já vem com qualquer campo `document` mascarado (LGPD — ver
`maskDocumentsDeep`), mas o resto do corpo é exatamente o que a Upper enviou.
Confira e registre no campo **Resultado:** abaixo:

- **Onde está o `externalId`:** o código (`externalIdFrom` em
  `src/routes/api/public/upper/webhook.ts`) procura primeiro em
  `data.externalId`, depois em `externalId` na raiz. Confirme qual dos dois
  (ou se é outro caminho) a Upper realmente usa.
- **Onde está o `payer`:** o código de mascaramento (`maskDocumentsDeep`)
  percorre o objeto inteiro procurando qualquer chave `document` em qualquer
  profundidade, então funciona independente de onde `payer` esteja — mas
  registre o caminho exato (`data.payer`? `payer` na raiz?) para referência
  futura.
- **As strings de status reais:** confirme que vêm exatamente como
  `PENDING`/`ACTIVE`/`PAID`/`EXPIRED`/`CANCELLED`/`FAILED` (maiúsculas) — o
  parser (`parseStatus` em `src/lib/billing/upper-pix.server.ts`) rejeita
  qualquer outro valor com `UpperError(INVALID_RESPONSE)`.
- **`qrCodeImage`:** confirme se vem como data URI (`data:image/...;base64,...`)
  ou como uma URL `https://...` — o componente de exibição
  (`src/lib/billing/pix-display.ts`) precisa aceitar o formato real para
  renderizar o `<img>` com segurança (`safePixImageSrc`).

**Se algum desses pontos vier diferente do que o código espera:** **pare
aqui** e abra uma correção antes de confiar no caminho do webhook — a
conciliação por cron (Passo 5) ainda credita a cobrança dentro de 5 minutos
mesmo que o webhook esteja quebrado, então não há perda de dinheiro enquanto
isso é corrigido, só um atraso no crédito.

**Resultado (externalId / payer / status / qrCodeImage, como vieram de
verdade):** _______________________________________________

---

## Passo 9 (opcional) — Segundo teste: Pix não pago, até expirar

Não há cancelamento disponível pela tela ou por SQL direto para este teste
(cancelar exigiria chamar `cancelUpperCharge` manualmente, fora do fluxo
normal do produto). Duas opções:

- **Esperar a expiração natural:** gerar outro Pix (R$ 100,00, mesma casa) e
  **não pagar**. Com `expiresIn = 3600` (1 h, fixo no código —
  `src/lib/billing/topup.functions.ts`), o teste leva 1 hora.
- **Deixar este teste para depois:** não é bloqueante para a ativação — a
  lógica de expiração (`maybeExpireStaleActiveCharge`, em
  `src/lib/billing/payment-charges.server.ts`) já tem cobertura de teste
  automatizado; este passo é só uma confirmação end-to-end em produção.

**Esperado**, se executado: ~10 minutos depois de `expires_at` (o "grace"
`EXPIRY_GRACE_MS` da conciliação), a próxima execução do cron marca a
cobrança `EXPIRED` e o pedido correspondente `expired`:

```sql
select status from public.payment_charges where external_id = '<externalId do teste>';
select status from public.credit_topup_orders where charge_id = (
  select id from public.payment_charges where external_id = '<externalId do teste>'
);
```
**Esperado:** `EXPIRED` / `expired`.

**Se vier diferente:** confira se o cron está rodando (Passo 5, verificação
de `dispatcher_runs`) e se `expires_at` da cobrança já passou há mais de 10
min.

**Resultado:** _______________________________________________

---

## Passo 10 — Consultas de monitoramento (rotina, sem autorização — só leitura)

Rode periodicamente (ou sempre que houver suspeita de problema):

**Cobranças que precisam de revisão humana** (valor pago não bateu com o
cobrado):
```sql
select id, tenant_id, external_id, amount_cents, paid_amount_cents, status, created_at
from public.payment_charges
where needs_review = true
order by created_at desc;
```

**`PAID` há mais de 10 min sem crédito** (webhook e cron falharam os dois —
não deveria ficar aqui por muito tempo; a conciliação credita direto o que
está `PAID` localmente sem nem chamar a Upper de novo):
```sql
select id, tenant_id, external_id, paid_at, credited_at
from public.payment_charges
where status = 'PAID' and credited_at is null
  and created_at < now() - interval '10 minutes'
order by created_at;
```

**Eventos de webhook com erro** (processamento falhou depois de gravado —
ficam com `processed_at` nulo até a Upper reentregar ou a conciliação
cobrir):
```sql
select event_id, event, error, received_at
from public.payment_webhook_events
where error is not null
order by received_at desc
limit 50;
```

**Cobranças `FAILED` com o último erro** (geralmente `upper_not_found` — a
Upper nunca recebeu a criação, travou mais de 15 min):
```sql
select id, tenant_id, external_id, last_error, created_at, updated_at
from public.payment_charges
where status = 'FAILED'
order by updated_at desc
limit 50;
```

**Resultado:** _______________________________________________

---

## Notas operacionais (não são passos, não precisam de "Resultado")

- **Botão de comprar oculto, não desabilitado:** com o gateway desligado (ou
  para quem não pode comprar — gestor, casa isenta, casa demo), o botão de
  Pix simplesmente não aparece na tela, em vez de aparecer desabilitado com
  uma explicação (decisão aceita na revisão final da PG2).
- **`canBuy` não checa `UPPER_API_KEY`:** só checa `BILLING_GATEWAY_ENABLED`
  — configure a chave antes de ligar o flag (Passo 7), não depois.
- **Teto de 3 Pix abertos por casa:** uma casa com 3 cobranças
  `PENDING`/`ACTIVE` ao mesmo tempo recebe "Você já tem Pix em aberto. Pague
  ou aguarde expirar antes de gerar outro." ao tentar gerar uma quarta — é
  uma proteção da cota compartilhada da Upper (120 chamadas/min por chave; o
  cliente se limita a 100/min), não um limite por produto.
- **Rate limiter em memória é por container:** hoje há só 1 container `crm`,
  então o limite de 100/min é efetivo. Se um dia houver mais de uma réplica,
  o limite real por conta Upper (120/min) pode ser excedido sem que nenhum
  container individual perceba — reavaliar nesse momento (item adiado na
  revisão final da PG2, não bloqueante para esta ativação).

---

## Passo 11 — Plano de rollback

### Parar só compras novas (mantém webhook e cron confirmando o que já existe)

```env
BILLING_GATEWAY_ENABLED=false
```
```bash
docker compose up -d --force-recreate crm
```
**Efeito:** o botão de comprar some de novo; qualquer tentativa de criar uma
cobrança nova recebe "Compra por Pix indisponível no momento."; cobranças já
criadas continuam sendo confirmadas pelo webhook e pela conciliação por cron
normalmente — **não interrompa o cron nem o webhook só porque desligou o
flag**, ou cobranças já pagas por uma casa deixam de ser creditadas.

### Parar tudo (inclusive confirmação do que já está em aberto)

Só faça isto se o objetivo for parar **completamente** o fluxo de Pix,
inclusive deixar de confirmar cobranças já criadas:

```sql
begin;
do $$
declare v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'betleads-billing-reconcile' loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;
commit;
```

E remova (ou desative) o webhook no painel da Upper (**API → Webhook**).

**Atenção:** com o cron desligado e o webhook removido, qualquer cobrança já
criada e paga (`PAID` na Upper) **não será mais creditada automaticamente**
em nenhuma casa até o cron/webhook voltarem. Verifique antes
(`select * from payment_charges where status in ('PENDING','ACTIVE') and
credited_at is null;`) se há cobranças em aberto que ficariam penduradas, e
avise as casas afetadas.

### Dados

As tabelas são **aditivas**: `credit_topup_orders`, `payment_charges`,
`payment_webhook_events`, `payment_fee_settings` não substituem nem apagam
nada do saldo único (PG1, `tenant_wallets`/`wallet_ledger`) — reverter o
código ou desligar o gateway não exige desfazer a migration `20261022110000`.

**Nunca apague** uma linha de `payment_charges` ou `credit_topup_orders` que
tenha dinheiro associado (qualquer `status` diferente de `'pending'`/`'ACTIVE'`
sem pagamento, ou qualquer linha com `credited_at` preenchido) — é o único
registro de auditoria daquele pagamento. Se uma cobrança precisar ser
corrigida manualmente (caso de `needs_review`), isso é tratado caso a caso
pelo superadmin, nunca por `delete`.

### Código

Reverter para o SHA anotado no Passo 4:
```bash
git checkout <SHA anotado no Passo 4>
docker compose up -d --build --force-recreate crm
docker compose ps
docker compose logs --since=5m crm
```

### Migrations

Reverter na ordem inversa (110100 → 110000), usando os blocos de rollback
dos Passos 5 e 3 — só depois de o código que as usa já ter sido revertido.

**Resultado:** _______________________________________________
