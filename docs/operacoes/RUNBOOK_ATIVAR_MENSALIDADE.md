# Runbook — Ativação da mensalidade do plano (fatura mensal + bloqueio)

**Plano:** `docs/superpowers/plans/2026-10-22-mensalidade-plano-creditos.md`
**Escopo:** `docs/ESCOPO_GATEWAY_PAGAMENTO_UPPER_2026-10-21.md`
**Branch:** `feat/mensalidade-plano`
**Ledger de decisões:** `.superpowers/sdd/2026-10-22-mensalidade-plano-creditos/progress.md`

Este documento é um roteiro de execução, não um relato do que já foi feito.
Cada passo tem o comando ou SQL exato, o resultado esperado, o que fazer se
vier diferente e um campo **Resultado:** em branco para o operador preencher
na hora da ativação. Nenhuma escrita em produção, chamada real à Upper ou
envio real de e-mail acontece sem autorização explícita do usuário, pedida de
novo a cada passo marcado **(requer autorização)**.

Acesso ao banco: pooler de sessão (`aws-0-ca-central-1.pooler.supabase.com:5432`,
usuário `postgres.<VITE_SUPABASE_PROJECT_ID>`), via `pg` (npm) a partir de um
diretório de scratch — não há `psql` nesta máquina (ver memória
`db-access-pooler`). Para os passos de leitura, execute
`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;` logo depois de
conectar.

---

## Visão geral da ordem (não pule nem inverta)

**A migration `20261023100000` (tabelas `tenant_billing`/`billing_invoices`/
`billing_email_log`) tem que ser aplicada ANTES de colocar o código novo no
ar.** Isso não é só uma questão de função ausente: a guarda de acesso de toda
casa (`assertTenantCanOperate`/`assertTenantCanSendExternally`, em
`src/lib/tenant-access.server.ts`) passa a ler `tenant_billing.access_state`
assim que o deploy sobe — se a tabela não existir ainda, **todo** envio e
toda leitura de tenant quebram, para toda casa, não só para quem vai pagar.

1. Leitura (só consulta): casas pagantes hoje e o que `billing_tenant_exempt`
   diz de cada uma (Passo 1).
2. Env na VPS com as 3 flags desligadas/neutra por enquanto (Passo 2).
3. Migration `20261023100000` (tabelas) — **antes do deploy**, pelo motivo
   acima (Passo 3).
4. `npm run build` local, merge para `main`, deploy (Passo 4).
5. Migration `20261023100100` (o cron da hora) — **só depois do deploy**, pelo
   mesmo motivo do cron do PG2 (Passo 5).
6. Ligar `BILLING_INVOICES_ENABLED=true` (Passo 6).
7. Pagar a fatura real da QA, com preço próprio de teste (Passo 7).
8. Ligar `BILLING_ENFORCEMENT_ENABLED=true`, só depois do aviso às casas
   (Passo 8).
9. Monitoramento (Passo 9, rotina).
10. Rollback (Passo 10).

---

## Passo 1 — Leitura: casas pagantes hoje (só leitura, pedir aprovação ao final)

### 1a. Casas não-`interno` e o que `billing_tenant_exempt` diz de cada uma

`billing_tenant_exempt` vem da PG1 (`20261022100000_billing_price_book.sql`)
e já está em produção, então a consulta usa a própria função. O `status`
importa porque o backfill do Passo 3 não filtra por status: uma casa
`suspended` ou `canceled` não-isenta também recebe a fatura `upfront`.

```sql
select slug, plano, status from tenants where plano <> 'interno';

select t.id, t.slug, t.nome, t.plano, t.status, t.is_demo,
       public.billing_tenant_exempt(t.id) as billing_tenant_exempt
from public.tenants t
where t.plano <> 'interno'
order by t.slug;
```

**Esperado:** a lista completa de casas não-`interno`. O roteiro (Task 10)
afirma que hoje só existe uma casa pagante de verdade: **QA Jornadas P0**
(slug `journey-p0-1791418509270`, a mesma casa usada no teste real do PG2).
Confirme que ela aparece com `billing_tenant_exempt = false` e que nenhuma
outra casa inesperada também aparece como não-isenta — qualquer casa real
(não QA, não demo) que apareça aqui vai nascer com uma fatura `upfront`
assim que o Passo 3 rodar (ver a nota do Passo 3).

**Se vier diferente:** uma casa `suspended` ou `canceled` não-isenta também
recebe fatura no Passo 3; passe-a para `plano = 'interno'` antes (escrita,
requer autorização) ou aceite a fatura conscientemente. Qualquer casa real
não-QA/não-demo nesta lista precisa
de aprovação explícita do usuário antes de seguir — ela vai começar a ser
cobrada (fatura upfront) no instante em que a migration do Passo 3 aplicar o
backfill. Sem essa aprovação, pare aqui.

**Resultado:** _______________________________________________

### 1b. A casa demo e as 3 casas `interno` continuam isentas

```sql
select id, slug, plano, is_demo
from public.tenants
where plano = 'interno' or is_demo
order by slug;
```

**Esperado:** pelo menos as 3 casas `interno` (`pixpgf`, `pixreals`,
`forrandobet`) e a casa demo (`258b2d5b-50a6-3d66-8df4-a3bba0fde0c4`, slug
`demo`), todas com `plano = 'interno'` — estas nunca recebem fatura (o
backfill do Passo 3 cria a linha de `tenant_billing` com `next_due_date =
null` e `access_state = 'exempt'` para elas).

**Resultado:** _______________________________________________

### → Mostrar 1a–1b ao usuário e pedir aprovação explícita antes do Passo 3

**Aprovação registrada em (data/hora/quem):** _______________________________

---

## Passo 2 — Env na VPS (requer autorização)

No `.env` da VPS (mesmo arquivo documentado em `docs/docker-deployment.md`),
adicione ou confirme as 3 variáveis (já documentadas em `.env.example` e em
`docs/docker-deployment.md`, seção "Mensalidade do plano"):

```env
BILLING_INVOICES_ENABLED=false
BILLING_ENFORCEMENT_ENABLED=false
PLATFORM_EMAIL_FROM=no-reply@betleads.io
```

- **`BILLING_INVOICES_ENABLED`**: desligada, o job da hora
  (`POST /api/public/hooks/billing-cycle`, cron `betleads-billing-cycle`) só
  recalcula o `access_state` de cada casa paga — nunca emite fatura nem manda
  e-mail; o botão de pagar uma fatura responde "Pagamento por Pix
  indisponível no momento." Confirmado em
  `src/lib/billing/invoices.server.ts` (`runBillingCycle`,
  `createInvoicePayment`) — o comentário do `.env.example` e de
  `docs/docker-deployment.md` já descreve exatamente esse comportamento
  (checado nesta ativação, nenhum ajuste necessário).
- **`BILLING_ENFORCEMENT_ENABLED`**: desligada, `locked_unpaid` e
  `awaiting_first_payment` nunca bloqueiam (a casa só vê a faixa vermelha,
  sem cartão de bloqueio e sem o e-mail "locked"); `frozen` e
  `locked_manual` bloqueiam sempre, com a flag ligada ou não; o superadmin
  nunca é bloqueado. Confirmado em `src/lib/tenant-access.server.ts` e
  `src/lib/billing/billing-state.server.ts` — mesma checagem acima, comentário
  já correto.
- **`PLATFORM_EMAIL_FROM`**: remetente dos 4 e-mails de cobrança (`issued`,
  `due_today`, `locked`, `paid`), nome fixo "BetLeads"; padrão
  `no-reply@betleads.io`. O domínio `betleads.io` já está verificado no
  Infobip (ver `.env` existente — o mesmo remetente de outros e-mails
  transacionais). Confirmado em `src/lib/billing/billing-emails.server.ts`.

Nenhuma das 3 precisa de `VITE_` (todas lidas só no servidor). Nenhum restart
do container é necessário ainda neste passo — o container só lê o `.env` na
inicialização; o restart efetivo é no Passo 4.

**Esperado:** as 3 variáveis presentes no `.env` da VPS.

**Resultado:** _______________________________________________

---

## Passo 3 — Migration `20261023100000` (tabelas de cobrança), antes do deploy (requer autorização)

Esta migration cria `tenant_billing`, `billing_invoices`, `billing_email_log`,
o índice `payment_charges_one_open_per_invoice` e todas as funções de ciclo,
baixa e ações do superadmin — e **termina rodando o backfill**
(`select public.billing_backfill_tenant_billing();`), que cria a linha de
`tenant_billing` de **toda casa já existente** no instante em que a migration
commita, não quando o flag for ligado depois.

**Atenção — isto acontece já, dentro desta transação, sem esperar o Passo 6:**
para cada casa não-isenta sem linha ainda (a QA, pela leitura do Passo 1a), o
backfill chama `billing_issue_invoice(tenant, upfront := true)`, que cria uma
fatura `open`, `upfront = true`, vencendo **hoje**, no valor do plano
(`billing_plans.price_cents` de `crm_unico`, R$ 4.000,00, salvo preço próprio
já cadastrado) — e a casa fica em `awaiting_first_payment` a partir daí. Isso
é esperado e é o comportamento desejado para a QA (é a casa que o Passo 7
usa para o teste real), mas é por isso que o Passo 1 pede para confirmar
**antes** que nenhuma casa real inesperada apareça como não-isenta: ela
nasceria com uma fatura de R$ 4.000,00 aberta sem aviso nenhum ao cliente.
As casas isentas (as 3 `interno` + a demo) recebem a linha com
`next_due_date = null` e `access_state = 'exempt'`, sem fatura.

Pelo pooler, em uma conexão de escrita (não a sessão read-only):

```sql
begin;
-- cole o conteúdo INTEGRAL de supabase/migrations/20261023100000_billing_invoices.sql aqui
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20261023100000', 'billing_invoices', array[$mig$<conteúdo integral do arquivo aqui>$mig$]);
commit;
```

Use um dollar-quote com tag própria (`$mig$...$mig$`) para o conteúdo do
arquivo, nunca aspas simples: o arquivo usa `$$` para delimitar corpo de
função em várias funções, então uma string entre aspas simples quebraria em
todo apóstrofo do SQL colado, e `$$...$$` colidiria com os blocos `$$` do
próprio arquivo. Mesmo padrão já usado nas viradas anteriores
(`docs/operacoes/RUNBOOK_VIRADA_SALDO_UNICO.md`,
`docs/operacoes/RUNBOOK_ATIVAR_PIX_UPPER.md`): registrar a migration em
`supabase_migrations.schema_migrations` dentro da mesma transação que aplica
o SQL, porque não há CLI/token do Supabase nesta máquina para
`supabase db push`.

**Esperado:** sucesso, sem notice (`billing_backfill_tenant_billing` não
emite `raise notice`, só `raise warning` por casa que falhar — não esperado
aqui).

**Se der erro:** a transação já fez rollback automático no servidor, mas a
sessão `pg` cliente ainda acha que está dentro de uma transação até você
mandar `rollback;` explicitamente — rode `rollback;` antes de recomeçar do
`begin`. Não há dado parcial.

**Verificação:**
```sql
select version from supabase_migrations.schema_migrations
where version = '20261023100000';

select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('tenant_billing', 'billing_invoices', 'billing_email_log')
order by table_name;
```
**Esperado:** a versão e as 3 tabelas.

**Verificação do backfill (compare com a leitura do Passo 1):**
```sql
select t.slug, tb.access_state, tb.next_due_date,
       i.id as open_invoice_id, i.amount_cents, i.due_date, i.upfront
from public.tenant_billing tb
join public.tenants t on t.id = tb.tenant_id
left join public.billing_invoices i on i.tenant_id = tb.tenant_id and i.status = 'open'
order by t.slug;
```
**Esperado:** toda casa com uma linha; a QA (`journey-p0-1791418509270`) com
`access_state = 'awaiting_first_payment'` e uma fatura aberta `upfront = true`,
`amount_cents = 400000` (R$ 4.000,00, salvo preço próprio já cadastrado antes
desta migration), `due_date = ` hoje (dia de Brasília); as 3 casas `interno` e
a demo com `access_state = 'exempt'` e nenhuma fatura.

**Rollback desta migration** — só para uma ativação que falhou com **zero
faturas pagas** (nunca depois do Passo 7, quando já pode haver uma fatura
real paga). O bloco abaixo primeiro checa que não há fatura paga e aborta com
`raise exception` se houver — nunca apague linhas com dinheiro associado,
mesmo por engano:
```sql
begin;
do $$
begin
  if exists (select 1 from public.billing_invoices where status = 'paid') then
    raise exception 'paid invoices exist — do not drop';
  end if;
end $$;
drop trigger if exists tenants_billing_plano on public.tenants;
drop function if exists public.billing_on_tenant_plano();
drop function if exists public.billing_admin_set_custom_price(uuid, bigint);
drop function if exists public.billing_admin_set_frozen(uuid, boolean);
drop function if exists public.billing_admin_set_cycle_day(uuid, date);
drop function if exists public.billing_admin_cancel_invoice(uuid, text);
drop function if exists public.billing_admin_manual_settle(uuid, bigint, text, text);
drop function if exists public.billing_admin_set_continuous_discount(uuid, text, numeric, date, date);
drop function if exists public.billing_admin_one_off_discount(uuid, text, numeric);
drop function if exists public.billing_admin_free_days(uuid, int);
drop function if exists public.billing_admin_extend_due(uuid, int);
drop function if exists public.billing_admin_set_block(uuid, boolean, text);
drop function if exists public.billing_admin_result(uuid);
drop function if exists public.billing_admin_lock_open_invoice(uuid);
drop function if exists public.billing_admin_lock_tenant(uuid, boolean);
drop function if exists public.billing_backfill_tenant_billing();
drop function if exists public.billing_cancel_open_invoice(uuid, text);
drop function if exists public.billing_reprice_open_invoice(uuid);
drop function if exists public.billing_issue_invoice(uuid, boolean);
drop function if exists public.billing_generate_due_invoices();
drop function if exists public.billing_settle_invoice(uuid, text, bigint, text, text, uuid, timestamptz);
drop function if exists public.billing_refresh_access_state(uuid);
drop function if exists public.billing_invoice_phase(uuid, date);
drop function if exists public.billing_monthly_amount(uuid, date);
drop function if exists public.billing_discount_cents(bigint, text, numeric);
drop function if exists public.billing_assert_pix_minimum(bigint);
drop function if exists public.billing_add_months(date, int);
drop function if exists public.billing_today();
-- billing_credit_paid_charge volta à versão sem o ramo `invoice`
-- (restaurar o CREATE OR REPLACE de 20261022110000_billing_pix_charges.sql).
drop index if exists public.payment_charges_one_open_per_invoice;
drop table if exists public.billing_email_log;
drop table if exists public.billing_invoices;
drop table if exists public.tenant_billing;
delete from supabase_migrations.schema_migrations where version = '20261023100000';
commit;
notify pgrst, 'reload schema';
```
Se este bloco falhar no meio (por exemplo, o `raise exception` acima), mande
`rollback;` na sessão antes de investigar — o servidor já abortou a
transação, mas o cliente só sabe disso depois do `rollback;` explícito.

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

Na VPS, a partir do diretório do checkout (mesmo diretório do
`docker-compose.yml`, ver `docs/docker-deployment.md`), **antes de puxar o
merge**, anote também o SHA que está de fato no ar ali:

```bash
git rev-parse HEAD
```
**SHA no ar na VPS antes do deploy:** _______________________________________

Depois do merge desta branch (`feat/mensalidade-plano`) no `main`, puxe o
código novo para a VPS:

```bash
git fetch
git checkout main
git pull --ff-only
git rev-parse HEAD
```
**Esperado:** o `git rev-parse HEAD` final bate exatamente com o SHA do
`main` recém-mergeado. Se `pull --ff-only` recusar, pare e investigue antes
de forçar qualquer coisa.

Só então construa e suba o container:

```bash
docker compose up -d --build --force-recreate crm
docker compose ps
docker compose logs --since=5m crm
```

**Esperado:** container `crm` `healthy`, sem erro nos últimos 5 min de log
relacionado a `tenant_billing`, `billing_refresh_access_state` ou
`billing_generate_due_invoices` ("function/relation ... does not exist"
indicaria que o Passo 3 não terminou ou o `notify pgrst, 'reload schema';`
daquela migration não propagou — rode manualmente
`notify pgrst, 'reload schema';` pelo pooler e reinicie o container).

Confirme que o container recriado de fato carregou as 3 variáveis do Passo 2:
```bash
docker compose exec crm node -e "console.log(process.env.BILLING_INVOICES_ENABLED, process.env.BILLING_ENFORCEMENT_ENABLED, process.env.PLATFORM_EMAIL_FROM)"
```
**Esperado:** `false false no-reply@betleads.io`.

**Smoke check manual:** abrir o app, logar como super admin
(`thiago@businesscode.com.br`) e abrir `/admin` → aba "Faturamento" — deve
carregar sem erro 500, mostrando a QA em `awaiting_first_payment` (do backfill
do Passo 3) e todas as outras casas (as `interno` e a demo) como isentas.
Abrir também uma casa não-QA, não-isenta qualquer (se existir) e confirmar
que ela carrega normalmente — é exatamente a guarda de acesso citada na
"Visão geral" que quebraria aqui se a migration do Passo 3 não tivesse rodado.

**Resultado:** _______________________________________________

---

## Passo 5 — Migration `20261023100100` (o cron da hora), só depois do deploy (requer autorização)

**Por que só agora:** esta migration cadastra o job `betleads-billing-cycle`
no `pg_cron` (schedule `7 * * * *`), que chama
`POST https://betleads.io/api/public/hooks/billing-cycle`. Se ela rodasse
antes do Passo 4, o cron ficaria chamando uma rota que ainda não existe no
código em produção (404), gerando ruído de alerta sem nenhum efeito útil.

Pelo pooler, em uma conexão de escrita:

```sql
begin;
-- cole o conteúdo INTEGRAL de supabase/migrations/20261023100100_billing_cycle_cron.sql aqui
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20261023100100', 'billing_cycle_cron', array[$mig$<conteúdo integral do arquivo aqui>$mig$]);
commit;
```

**Esperado:** sucesso. A migration cria as extensões `pg_cron`/`pg_net` (se
ainda não existirem, já deveriam existir pelo cron do PG2) e agenda
`betleads-billing-cycle` para `7 * * * *` (aos 7 minutos de cada hora). Ela
lê o segredo do cron (`betleads_cron_secret`) do Supabase Vault — **não** do
`CRON_SECRET` do `.env` da VPS. A rota (`src/routes/api/public/hooks/billing-cycle.ts`)
valida esse segredo via `requireSharedSecret(request, "CRON_SECRET")`
(`src/lib/cron-auth.server.ts`), comparando contra o header
`Authorization: Bearer` que o `pg_net` envia. Confirme antes de aplicar que
esse nome existe no Vault (já deveria, de crons anteriores), **sem nunca ler
o valor descriptografado pela sessão SQL**:
```sql
select name from vault.decrypted_secrets where name = 'betleads_cron_secret';
```
**Esperado:** 1 linha.

**Se der erro `extension "pg_cron" does not exist` (ou `pg_net`):** mande
`rollback;` na sessão antes de tentar de novo; habilite as extensões pelo
painel do Supabase se ainda não estiverem disponíveis.

**Verificação do agendamento:**
```sql
select jobname, schedule, active
from cron.job
where jobname = 'betleads-billing-cycle';
```
**Esperado:** 1 linha, `schedule = '7 * * * *'`, `active = true`.

**Verificação da execução, até 1 hora depois** (o job roda uma vez por hora,
no minuto 7):
```sql
select id, job, status, started_at, finished_at, heartbeat_at, claimed, sent, errors, stop_reason
from public.dispatcher_runs
where job = 'billing-cycle'
order by started_at desc
limit 5;
```
**Esperado:** pelo menos 1 linha com `status` em `succeeded`/`partial` depois
do primeiro minuto-7 seguinte ao deploy; `claimed` = número de casas não
isentas com `access_state` recalculado (pelo menos a QA), `sent` = 0 faturas
geradas (flag ainda desligada no Passo 2), `errors` = 0.

**Se não aparecer nenhuma linha em `dispatcher_runs`:** o `pg_cron` chama a
rota por `net.http_post`, que é assíncrono — "succeeded" no `cron.job` só
significa que a chamada foi *enfileirada*. A saúde real está em
`net._http_response`:
```sql
select status_code, left(content::text, 200), created
from net._http_response
order by created desc
limit 5;
```
Um `status_code` ausente ou de erro de rede indica timeout/DNS/TLS contra
`https://betleads.io`; um `401` indica `CRON_SECRET`/`betleads_cron_secret`
divergentes entre o Vault e a VPS.

**Rollback desta migration:**
```sql
begin;
do $$
declare v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'betleads-billing-cycle' loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;
delete from supabase_migrations.schema_migrations where version = '20261023100100';
commit;
notify pgrst, 'reload schema';
```

**Resultado:** _______________________________________________

---

## Passo 6 — Ligar `BILLING_INVOICES_ENABLED=true` (requer autorização)

No `.env` da VPS:
```env
BILLING_INVOICES_ENABLED=true
```

```bash
docker compose up -d --force-recreate crm
docker compose ps
docker compose exec crm node -e "console.log(process.env.BILLING_INVOICES_ENABLED)"
```
**Esperado:** `true`; container `crm` `healthy`.

**Efeito imediato:** a próxima execução do cron (minuto 7 da hora) passa a
chamar `billing_generate_due_invoices()` de verdade (emite fatura para toda
casa com `next_due_date - 5 <= hoje` e sem fatura aberta — a QA já tem uma
fatura aberta desde o backfill do Passo 3, então não gera outra) e a mandar
os e-mails pendentes (`sendPendingBillingEmails`,
`src/lib/billing/billing-emails.server.ts`) de verdade, **só na janela
08:00–20:00 de Brasília** e **no máximo um e-mail de cada tipo por fatura**
(`billing_email_log`).

**Conferir os e-mails com um e-mail de teste do admin da QA:** peça (ou use)
o reenvio pela tela — `/admin` → aba "Faturamento" → linha da QA → ação
"Reenviar e-mail" (`src/components/billing/admin/tenant-actions.tsx`,
`ResendBillingEmailAction`) — reenvia o último tipo de e-mail da fatura
aberta da QA para os `admin`/`owner`/`gestor` dessa casa. **Rode isto dentro
da janela 08:00–20:00 de Brasília**; fora dela o envio não sai (nem este,
nem nenhum dos 4 tipos), mesmo pedido pela tela.

```sql
select invoice_id, kind, sent_at, recipients
from public.billing_email_log
where invoice_id = (
  select id from public.billing_invoices
  where tenant_id = (select id from public.tenants where slug = 'journey-p0-1791418509270')
    and status = 'open'
)
order by sent_at desc;
```
**Esperado:** uma linha `kind = 'issued'` (do backfill do Passo 3, mandada na
próxima execução do cron dentro da janela) e, depois do reenvio manual, a
confirmação de recebimento no e-mail real do admin da QA.

**Se vier diferente:** nenhuma linha depois de mais de 1 hora de o flag
estar ligado e dentro da janela — confira o log do container por
`[billing/invoices]` ou `[billing/emails]` e que o cron do Passo 5 está
rodando (`dispatcher_runs`).

**Resultado:** _______________________________________________

---

## Passo 7 — Pagar a fatura da QA (R$ 4.000, com preço próprio de teste) (requer autorização, gasta dinheiro real)

**Depende de:** a compra por Pix da PG2 estar ativa (gateway Upper ligado —
roteiro `docs/operacoes/RUNBOOK_ATIVAR_PIX_UPPER.md`), porque uma fatura se
paga pela mesma infraestrutura de cobrança Upper (`payment_charges`,
`kind = 'invoice'`) que os créditos.

### 7.1 — Preço próprio de teste, para não gastar R$ 4.000,00

Logado como super admin (`thiago@businesscode.com.br`), em `/admin` → aba
"Faturamento" → linha da QA → ação **"Preço próprio"** → preencher
**R$ 100,00** (o mínimo do Pix) com o motivo **"teste de ativação"**.

**Esperado:** o diálogo exige motivo com pelo menos 5 caracteres (ruling das
global constraints) — "teste de ativação" tem mais que isso; a fatura aberta
da QA é reprecificada na hora (`billing_reprice_open_invoice`, chamada por
`billing_admin_set_custom_price`) para `amount_cents = 10000`.

```sql
select amount_cents, base_amount_cents, status
from public.billing_invoices
where tenant_id = (select id from public.tenants where slug = 'journey-p0-1791418509270')
  and status = 'open';
```
**Esperado:** `amount_cents = 10000`, `base_amount_cents = 10000`,
`status = 'open'`.

**Resultado:** _______________________________________________

### 7.2 — Gerar e pagar o Pix de verdade

Na mesma tela (ou como admin da própria QA), gerar o Pix da fatura aberta e
pagar de verdade (R$ 100,00, dinheiro real).

**Esperado, depois do pagamento confirmado:**
```sql
select status, paid_at, paid_via, paid_amount_cents
from public.billing_invoices
where tenant_id = (select id from public.tenants where slug = 'journey-p0-1791418509270')
order by created_at desc
limit 1;
```
**Esperado:** `status = 'paid'`, `paid_via = 'pix'`, `paid_amount_cents = 10000`.

```sql
select access_state, next_due_date
from public.tenant_billing
where tenant_id = (select id from public.tenants where slug = 'journey-p0-1791418509270');
```
**Esperado:** `access_state = 'ok'`; `next_due_date` = dia do pagamento + 1
mês (a QA estava em `awaiting_first_payment`, então a regra usa o dia do
pagamento, não o `cycle_due_date` antigo — `billing_settle_invoice`).

**Se vier diferente:** ver as consultas de monitoramento do Passo 9
(`needs_review`, `PAID` sem baixa) para diagnosticar; a conciliação por cron
do PG2 (`billing-reconcile`, a cada 5 min) ainda credita/baixa a cobrança
mesmo que o webhook falhe.

**Resultado:** _______________________________________________

### 7.3 — Remover o preço próprio de teste

Depois de confirmada a baixa, em `/admin` → aba "Faturamento" → linha da QA
→ "Preço próprio" de novo, **deixar o campo vazio** e confirmar (motivo:
"fim do teste de ativação" ou similar, 5+ caracteres) — isso volta a QA para
o preço padrão do plano (R$ 4.000,00) a partir do próximo ciclo.

```sql
select custom_price_cents from public.tenant_billing
where tenant_id = (select id from public.tenants where slug = 'journey-p0-1791418509270');
```
**Esperado:** `null`.

**Resultado:** _______________________________________________

---

## Passo 8 — Ligar `BILLING_ENFORCEMENT_ENABLED=true` (requer autorização, só depois do aviso por escrito)

**Pré-condição obrigatória:** aviso por escrito (e-mail ou outro canal
formal) a toda casa que for passar a pagar de verdade, avisando a data em
que o bloqueio por falta de pagamento entra em vigor. Não ligue esta flag
sem essa comunicação já ter saído.

**Comportamento a que isto expõe as casas, documentado aqui para quem for
decidir a data:** uma vez que `locked_unpaid`/`awaiting_first_payment`
passam a bloquear de verdade, qualquer envio (SMS, e-mail, WhatsApp, voz) de
uma casa bloqueada falha como erro **final** — `postBulk`/`sendSmsBatch`
(`src/lib/sms-bulk.server.ts`) e os equivalentes de e-mail/WhatsApp tratam
`TenantBillingLockedError` como `isSendBlockedError`, liberando os créditos
já reservados como **falha definitiva, nunca reenviada automaticamente**.
Isso significa que **um passo de jornada que estava programado para disparar
durante o bloqueio não retoma por conta própria depois que a casa paga** — o
envio já foi marcado como falho e não há reprocessamento desse passo
específico; a jornada segue adiante a partir do próximo passo, mas aquele
disparo específico se perde. Avise as casas disso também, se relevante para
o produto.

No `.env` da VPS:
```env
BILLING_ENFORCEMENT_ENABLED=true
```

```bash
docker compose up -d --force-recreate crm
docker compose ps
docker compose exec crm node -e "console.log(process.env.BILLING_ENFORCEMENT_ENABLED)"
```
**Esperado:** `true`; container `crm` `healthy`.

**Smoke check manual:** logar como admin de uma casa não isenta, não
superadmin, com `access_state` em `overdue` ou `locked_unpaid` (se houver
alguma no momento — senão, adiar este check até existir uma, ou simular com
`billing_admin_free_days`/ajustando `next_due_date` numa casa de teste
isolada, nunca na QA em produção sem necessidade). Deve ver a faixa vermelha
e, se `locked_unpaid`, o cartão de bloqueio com o texto "Acesso suspenso por
falta de pagamento" e o botão "Ir para o pagamento". Confirmar que o
superadmin, olhando a mesma casa, navega normalmente e só vê a faixa (nunca
o cartão de bloqueio).

**Resultado:** _______________________________________________

---

## Passo 9 — Consultas de monitoramento (rotina, sem autorização — só leitura)

Rode periodicamente (ou sempre que houver suspeita de problema):

**Casas bloqueadas por falta de pagamento agora:**
```sql
select t.slug, tb.access_state, tb.access_state_at, i.due_date, i.amount_cents
from public.tenant_billing tb
join public.tenants t on t.id = tb.tenant_id
left join public.billing_invoices i on i.tenant_id = tb.tenant_id and i.status = 'open'
where tb.access_state = 'locked_unpaid'
order by tb.access_state_at;
```

**Faturas abertas vencidas (passaram do `due_date`, ainda não bloqueadas ou
já bloqueadas):**
```sql
select t.slug, i.id, i.due_date, i.amount_cents, tb.access_state
from public.billing_invoices i
join public.tenants t on t.id = i.tenant_id
join public.tenant_billing tb on tb.tenant_id = i.tenant_id
where i.status = 'open' and i.due_date < public.billing_today()
order by i.due_date;
```

**E-mails de cobrança com falha** (nenhum log central de erro de envio nesta
feature — o envio real passa pelo provedor de e-mail transacional já em uso;
confira o log do container por `[billing/emails]` e cruze com
`billing_email_log` para ver o que *devia* ter saído e não saiu):
```sql
select t.slug, i.id as invoice_id, i.status, i.due_date,
       array_agg(bel.kind order by bel.sent_at) as emails_sent
from public.billing_invoices i
join public.tenants t on t.id = i.tenant_id
left join public.billing_email_log bel on bel.invoice_id = i.id
where i.status = 'open'
group by t.slug, i.id, i.status, i.due_date
order by i.due_date;
```
**Esperado:** toda fatura `open` já emitida há mais de 1 hora deve ter pelo
menos `emails_sent` contendo `'issued'` (salvo se emitida fora da janela
08:00–20:00 de Brasília, caso em que o e-mail só sai na próxima execução
dentro da janela); uma fatura vencida sem `'due_today'` no dia do vencimento,
ou bloqueada sem `'locked'` (com enforcement ligado), indica falha de envio
a investigar nos logs.

**Resultado:** _______________________________________________

---

## Passo 10 — Plano de rollback

### Desligar só o bloqueio, mantendo fatura e e-mail

```env
BILLING_ENFORCEMENT_ENABLED=false
```
```bash
docker compose up -d --force-recreate crm
```
**Efeito:** nenhuma casa fica bloqueada por `locked_unpaid`/
`awaiting_first_payment` a partir daí (volta a só mostrar a faixa vermelha);
`frozen`/`locked_manual` continuam bloqueando sempre. Faturas continuam
sendo emitidas e e-mails continuam saindo normalmente — isto não desfaz
nenhum bloqueio em jornadas já perdido (ver a nota do Passo 8), só impede
que aconteça de novo a partir de agora.

### Desligar fatura e e-mail também

```env
BILLING_INVOICES_ENABLED=false
BILLING_ENFORCEMENT_ENABLED=false
```
```bash
docker compose up -d --force-recreate crm
```
**Efeito:** o cron volta a só recalcular `access_state` (sem gerar fatura
nova nem mandar e-mail); o pagamento de uma fatura já aberta responde
"Pagamento por Pix indisponível no momento." — uma fatura `open` que já
existir **continua aberta e vencendo normalmente** (as datas não param; só a
emissão de faturas novas e o envio de e-mail param). Não desligue o cron em
si (a migration do Passo 5) só por desligar estas 2 flags — ele continua
útil para o recálculo de `access_state`.

### Dados

As tabelas (`tenant_billing`, `billing_invoices`, `billing_email_log`) são
**aditivas**: nenhuma tabela da PG1 (saldo único) ou da PG2 (créditos Pix) é
tocada por esta feature, salvo o índice `payment_charges_one_open_per_invoice`
e o ramo `invoice` de `billing_credit_paid_charge` (que só atua em cobranças
`kind = 'invoice'`, nunca em `kind = 'credit_topup'`). Desligar as flags não
exige desfazer as migrations.

**Nunca apague faturas pagas** (`billing_invoices` com `status = 'paid'`) —
são o registro de auditoria da cobrança. Qualquer correção (fatura cobrada
errado, valor divergente) é feita pelo superadmin via as ações de desconto
pontual/cancelamento, nunca por `delete`.

### Código

**Antes de reverter o código, desligue as 2 flags acima** ou aceite
explicitamente que, sem isso, o código antigo (sem `tenant_billing`) passa a
quebrar a guarda de acesso de toda casa (a mesma observação da "Visão geral"
no sentido contrário: reverter o código sem reverter antes a dependência
numa tabela que ele não conhece). Reverter para o SHA anotado no Passo 4:
```bash
git checkout <SHA anotado no Passo 4>
docker compose up -d --build --force-recreate crm
docker compose ps
docker compose logs --since=5m crm
```

### Migrations

Reverter na ordem inversa (100100 → 100000), usando os blocos de rollback
dos Passos 5 e 3 — só depois de o código que as usa já ter sido revertido, e
só se não houver nenhuma fatura paga (o bloco de rollback do Passo 3 recusa
rodar se houver).

**Resultado:** _______________________________________________
