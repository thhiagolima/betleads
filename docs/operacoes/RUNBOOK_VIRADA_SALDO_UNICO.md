# Runbook — Virada para o saldo único em BRL (PG1)

**Plano:** `docs/superpowers/plans/2026-10-21-pg1-precos-saldo-unico.md`
**Escopo:** `docs/ESCOPO_GATEWAY_PAGAMENTO_UPPER_2026-10-21.md`
**Branch:** `feat/pg1-saldo-unico`
**Ledger de decisões:** `.superpowers/sdd/2026-10-21-pg1-precos-saldo-unico/progress.md`

Este documento é um roteiro de execução, não um relato do que já foi feito.
Cada passo tem o comando exato, o resultado esperado, o que fazer se vier
diferente e um campo **Resultado:** em branco para o operador preencher na
hora da virada. Nenhuma escrita em produção acontece sem autorização explícita
do usuário, pedida de novo a cada passo que escreve (Passos 2, 3, 4, 5, 6, 8).

Acesso ao banco: pooler de sessão (`aws-0-ca-central-1.pooler.supabase.com:5432`,
usuário `postgres.<VITE_SUPABASE_PROJECT_ID>`), via `pg` (npm) a partir de um
diretório de scratch — não há `psql` nesta máquina (ver memória
`db-access-pooler`). Para os passos de leitura, execute
`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;` logo depois de
conectar (o pooler ignora a opção de startup).

---

## Passo 0 — Portão: não fazer deploy do `main` antes do Passo 4

O código novo (branch `feat/pg1-saldo-unico`) chama `wallet_reserve`/
`wallet_summary`/`admin_adjust_wallet` etc., que só existem depois das 5
migrations deste runbook. Se o deploy do `main` (merge desta branch) acontecer
**antes** do Passo 4, todo envio de SMS passa a errar (`wallet_reserve` não
encontrado) até o Passo 4 rodar.

**Regra:** faça o merge da branch no dia da virada, na mesma janela dos
Passos 1–4, nesta ordem: Passo 1 (leitura + aprovação) → Passo 2 (migrations)
→ Passo 3 (conversão) → Passo 4 (deploy do código). Não faça merge para
`main` fora dessa janela.

**Cosmético esperado entre os Passos 2 e 4:** a migration 20261022100400
redefine `dashboard_summary_v2` para devolver `walletBalance`/`exempt` em vez
do campo `smsCredits` que o Início antigo lê (`src/routes/index.tsx`,
`<MetricRow label="Créditos de SMS" value={num(data.smsCredits)} />`). Entre
o Passo 2 (migrations já aplicadas) e o Passo 4 (frontend novo no ar), o
frontend **antigo** ainda chama essa RPC esperando `smsCredits`, que não
existe mais no retorno — o card "Créditos de SMS" do Início antigo mostra
**0** nesse intervalo. É esperado e cosmético (não há perda de dado, só a
leitura de um campo que a RPC já não devolve); não é motivo para pausar a
virada.

**Resultado:** _______________________________________________

---

## Passo 1 — Checagens somente leitura (pedir aprovação ao final)

Todo este passo é só leitura. Rode cada consulta pelo pooler com
`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;` logo após conectar.

### 1a. Casas com `plano = 'interno'` hoje, e snapshot do `plano` que a migration vai sobrescrever

A consulta inclui as 3 casas e qualquer casa `is_demo` mesmo que o `plano`
delas hoje **não** seja `'interno'` — é exatamente esse conjunto que a
migration 20261022100000 sobrescreve (`update tenants set plano = 'interno'
where slug in (...) or is_demo`), então é esse o `plano` anterior que o
rollback do Passo 2.1 precisa restaurar, não só quem já estava `interno`.

```sql
select id, slug, nome, is_demo, plano
from public.tenants
where slug in ('pixpgf', 'pixreals', 'forrandobet')
   or is_demo
   or plano = 'interno'
order by slug;
```

**Esperado:** pelo menos 4 linhas (as 3 casas interno + a casa demo
`258b2d5b-50a6-3d66-8df4-a3bba0fde0c4`, slug `demo`), cada uma com o `plano`
que tem **agora** (antes da migration). Qualquer linha extra é uma casa que
já está `plano = 'interno'` sem ser nenhuma das 4.

**Se vier diferente:** qualquer casa na lista que não seja `pixpgf`,
`pixreals`, `forrandobet` ou uma casa `is_demo = true` precisa de aprovação
explícita do usuário antes de seguir — ela vai ficar (ou já está) isenta de
cobrança a partir do Passo 2. Sem essa aprovação, pare aqui.

**Guarde o resultado inteiro** (`id`/`slug`/`plano` de cada linha): é o
snapshot usado pelo rollback do Passo 2.1 para devolver cada casa ao `plano`
que tinha antes — a migration sobrescreve `plano` para as 4 casas e não
guarda o valor antigo em lugar nenhum.

**Resultado:** _______________________________________________

### 1b. Os 3 slugs existem exatamente uma vez cada

```sql
select slug, count(*)
from public.tenants
where slug in ('pixpgf', 'pixreals', 'forrandobet')
group by slug
order by slug;
```

**Esperado:** 3 linhas, cada uma com `count = 1`.

**Se vier diferente:** a migration 20261022100000 faz
`raise exception` se `count(*) <> 3` no total (ela conta as 3 juntas, não por
slug) — então qualquer slug ausente ou duplicado já aborta o Passo 2 sozinho.
Ainda assim, resolva a causa (slug duplicado/renomeado) antes de tentar de
novo; não prossiga com um slug faltando ou duplicado.

**Resultado:** _______________________________________________

### 1c. Casas com saldo legado > 0 e prévia da conversão (cálculo manual, à mão)

A função `billing_convert_legacy_sms_credits` ainda não existe antes do
Passo 2 (ela é criada pela migration 20261022100200). Esta consulta reproduz
à mão a mesma regra de preview (`_apply = false`): preço efetivo de SMS é o
preço padrão vigente (`billing_price_book`, hoje R$ 0,08, sem overrides por
casa aplicados ainda); a casa é pulada (`amount = 0`, não `null` — é o que a
função real faz: `v_skip := 'interno'; v_amount := 0;`) quando `plano`
já é `'interno'`, `is_demo` é verdadeiro, **ou** o slug é `pixpgf`,
`pixreals` ou `forrandobet` — estas 3 ainda não têm `plano = 'interno'`
antes do Passo 2 (ele só é setado por essa migration), mas vão virar isentas
assim que ela rodar, então o preview já deve tratá-las como tal, igual ao
que a função vai calcular depois de 2.1. A lista omite casas com
`balance_credits = 0` (nada a converter nelas, `delta` seria 0 de qualquer
forma) — a função real não as pula, só a prévia à mão aqui pula por não
terem nada a mostrar.

```sql
select
  b.tenant_id,
  t.slug,
  t.plano,
  b.balance_credits as legacy_balance,
  case when t.plano = 'interno' or coalesce(t.is_demo, false)
         or t.slug in ('pixpgf', 'pixreals', 'forrandobet')
       then 0
       else round(b.balance_credits * 0.08, 4) end as preview_amount,
  case when t.plano = 'interno' or coalesce(t.is_demo, false)
         or t.slug in ('pixpgf', 'pixreals', 'forrandobet')
       then 'interno' else null end as skipped_reason
from public.tenant_sms_credit_balances b
join public.tenants t on t.id = b.tenant_id
where b.balance_credits > 0
order by t.slug;
```

**Esperado:** uma linha por casa com saldo legado positivo; `preview_amount`
preenchido para toda casa não-`interno`/não-demo/não-(`pixpgf`/`pixreals`/
`forrandobet`) (créditos × R$ 0,08); `0` com `skipped_reason = 'interno'`
para as 4 casas isentas.

**Se vier diferente:** se alguma casa não-`interno` tiver `plano` sem preço
cadastrado o suficiente para calcular (não deveria acontecer — o preço padrão
cobre todo mundo sem override), ou se o preview mostrar um número que o
usuário não espera, mostre a lista completa ao usuário antes do Passo 2.

**Resultado:** _______________________________________________

### 1d. Pedidos de crédito SMS pendentes (`sms_credit_orders`, status `pending`)

```sql
select o.id, o.tenant_id, t.slug, o.credits, o.unit_price, o.amount_cents,
       o.checkout_provider, o.created_at
from public.sms_credit_orders o
join public.tenants t on t.id = o.tenant_id
where o.status = 'pending'
order by o.created_at;
```

**Esperado:** a lista completa (pode vir vazia). Depois do Passo 8, a RPC
`admin_mark_sms_credit_order_paid` perde o EXECUTE de `authenticated`, então
nenhum desses pedidos pode mais ser marcado como pago pela RPC antiga. Cada
linha pendente nesta lista deve ser liquidada manualmente depois da virada,
pela tela (**não** por uma chamada SQL direta a `admin_adjust_wallet` — ela
exige `is_super_admin()`, que verifica `auth.uid()`; conectado pelo pooler
como `postgres`, `auth.uid()` é nulo e a chamada cai em `forbidden`): em
`/admin` → aba "Saldo", no diálogo de ajuste de carteira da casa do pedido,
logado como super admin, com `amount = credits × 0,08` (o preço novo da
casa — não `unit_price`/`amount_cents` do pedido legado, que é o preço
antigo) e o motivo `"Pedido pendente <id do pedido> quitado na virada"`. Essa
via passa pela sessão do usuário (auditada em `tenant_audit_logs`) — ver
o detalhe completo no Passo 8.2.

**Se vier diferente:** nenhuma ação aqui além de guardar a lista — ela só é
usada no Passo 8.

**Resultado:** _______________________________________________

### 1e. Linha de base do mundo legado (para comparar depois, Passo 6)

As tabelas novas (`tenant_wallets`, `wallet_ledger`, `billing_price_book`,
`tenant_price_overrides`) ainda não existem antes do Passo 2 — não há nada a
contar nelas ainda. A linha de base que importa aqui é do **lado legado**:
usada no Passo 6 para saber se o refresh da Central de Resultados pós-virada
bateu com o que já existia.

```sql
select
  (select coalesce(sum(balance_credits), 0) from public.tenant_sms_credit_balances) as legacy_balance_total,
  (select count(*) from public.sms_credit_ledger) as legacy_ledger_rows,
  (select count(*) from public.crm_results_health
     where check_name = 'cost' and ok = false and metric_date >= current_date - 29) as cost_health_failures_now;
```

**Esperado:** `cost_health_failures_now` é o número de falhas de checagem de
custo que **já existiam antes da virada** (preço antigo, R$ 0,12 ou o que
estiver em `tenant_sms_pricing`/`sms_credit_settings`) — qualquer coisa além
disso depois do Passo 6 é nova e precisa de investigação; qualquer uma destas
que já existia antes não é culpa do Passo 6. `legacy_balance_total` e
`legacy_ledger_rows` são o tamanho do saldo legado que o Passo 3 vai
converter — compare com o total somado das linhas do Passo 1c.

**Resultado:** _______________________________________________

### → Mostrar 1a–1d ao usuário e pedir aprovação explícita antes do Passo 2

**Aprovação registrada em (data/hora/quem):** _______________________________

---

## Passo 2 — Aplicar as 5 migrations (uma transação cada, com autorização)

Migrations, na ordem (todas em `supabase/migrations/`):

1. `20261022100000_billing_price_book.sql`
2. `20261022100100_billing_wallet.sql`
3. `20261022100200_billing_legacy_sms_conversion.sql`
4. `20261022100300_billing_prices_in_reports.sql`
5. `20261022100400_billing_dashboard_and_grants.sql`

Para cada uma, pelo pooler (não a sessão read-only do Passo 1 — abra uma
conexão de escrita):

```sql
begin;
-- cole o conteúdo INTEGRAL do arquivo de migration aqui
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('<versão, ex: 20261022100000>', '<nome, ex: billing_price_book>', array[$mig$<conteúdo integral do arquivo aqui>$mig$]);
commit;
```

Use um dollar-quote com tag própria (`$mig$...$mig$`) para o conteúdo do
arquivo, nunca aspas simples: todos os 5 arquivos de migration usam `$$` para
delimitar corpo de função, então uma string entre aspas simples quebraria em
todo apóstrofo/aspas simples do SQL colado, e `$$...$$` colidiria com os
blocos `$$` do próprio arquivo. Alternativa igualmente válida: passar o
conteúdo do arquivo como parâmetro da consulta (`$1`) em vez de literal
inline, se a ferramenta usada (script Node com `pg`) permitir — nesse caso
não há escaping para pensar.

Isso é o mesmo padrão já usado na virada de 19/10 (`docs/operacoes/2026-10-19_aquisicao-ltv-al1.md`):
registrar a migration em `supabase_migrations.schema_migrations` dentro da
mesma transação que aplica o SQL, porque não há CLI/token do Supabase nesta
máquina para `supabase db push`.

### 2.1 — `20261022100000_billing_price_book.sql`

**Esperado:** sucesso; o bloco `do $$ ... $$` pode emitir
`raise notice 'billing_price_book: casa % já estava com plano = interno...'`
— **só é esperado** para as casas já aprovadas no Passo 1a. Qualquer notice
para uma casa **não** aprovada é um sinal de que o Passo 1a mudou entre a
leitura e agora (outra pessoa alterou `plano`); pare e refaça o Passo 1a.

**Se der erro `billing_price_book: esperava exatamente 3 casas...`:** é o
Passo 1b falhando dentro da transação — a transação já fez `rollback`
automático (erro aborta a transação inteira). Resolva a causa e recomece do
`begin`.

**Rollback desta migration** (se precisar desfazer **antes** de aplicar a
próxima): em uma transação,
```sql
begin;
drop trigger if exists tenants_plan_guard on public.tenants;
drop function if exists public.guard_tenants_plan();
drop function if exists public.admin_clear_tenant_price(uuid, text);
drop function if exists public.admin_set_tenant_price(uuid, text, numeric);
drop function if exists public.admin_set_price(text, numeric, numeric, integer);
drop function if exists public.billing_report_unit_price(uuid, text, timestamptz);
drop function if exists public.billing_effective_price(uuid, text, timestamptz);
drop function if exists public.billing_tenant_exempt(uuid);
drop table if exists public.tenant_price_overrides;
drop table if exists public.billing_price_book;
drop table if exists public.billing_plans;
-- Restaurar o plano anterior das casas da lista do Passo 1a, uma a uma:
-- update public.tenants set plano = '<valor anotado em 1a>' where id = '<id>';
delete from supabase_migrations.schema_migrations where version = '20261022100000';
commit;
notify pgrst, 'reload schema';
```

**Resultado:** _______________________________________________

### 2.2 — `20261022100100_billing_wallet.sql`

**Esperado:** sucesso, sem notices (a migration só cria tabelas/funções novas,
não lê dados existentes).

**Se der erro:** verifique se 2.1 de fato commitou (`select version from
supabase_migrations.schema_migrations where version = '20261022100000';`)
antes de tentar de novo — esta migration depende de `billing_price_book`,
`billing_tenant_exempt` e `billing_effective_price`, criados em 2.1.

**Rollback desta migration:**
```sql
begin;
revoke execute on function public.billing_wallet_integrity() from service_role;
revoke execute on function public.wallet_summary(uuid) from authenticated, service_role;
revoke execute on function public.admin_adjust_wallet(uuid, numeric, text, text) from authenticated, service_role;
revoke execute on function public.wallet_refund(uuid, text, text, text) from service_role;
revoke execute on function public.wallet_reserve(uuid, text, integer, text, text, text) from service_role;
revoke execute on function public.wallet_mutation(uuid, numeric, text, text, integer, integer, date, numeric, numeric, text, text, text, text, jsonb, uuid, uuid) from service_role;
revoke execute on function public.billing_now() from authenticated, service_role;
drop function if exists public.billing_wallet_integrity();
drop function if exists public.wallet_summary(uuid);
drop function if exists public.admin_adjust_wallet(uuid, numeric, text, text);
drop function if exists public.wallet_refund(uuid, text, text, text);
drop function if exists public.wallet_reserve(uuid, text, integer, text, text, text);
drop function if exists public.wallet_mutation(uuid, numeric, text, text, integer, integer, date, numeric, numeric, text, text, text, text, jsonb, uuid, uuid);
drop table if exists public.tenant_monthly_usage;
drop table if exists public.wallet_ledger;
drop table if exists public.tenant_wallets;
drop function if exists public.billing_now();
delete from supabase_migrations.schema_migrations where version = '20261022100100';
commit;
notify pgrst, 'reload schema';
```

**Resultado:** _______________________________________________

### 2.3 — `20261022100200_billing_legacy_sms_conversion.sql`

**Esperado:** sucesso — esta migration só `create or replace function` (sem
tabela, sem dados), então não há notice nem leitura aqui.

**Rollback desta migration:**
```sql
begin;
revoke execute on function public.billing_convert_legacy_sms_credits(boolean) from service_role;
drop function if exists public.billing_convert_legacy_sms_credits(boolean);
delete from supabase_migrations.schema_migrations where version = '20261022100200';
commit;
notify pgrst, 'reload schema';
```

**Resultado:** _______________________________________________

### 2.4 — `20261022100300_billing_prices_in_reports.sql`

Antes de colar o conteúdo da migration dentro do `begin;`, rode
`set lock_timeout = '5s';` na mesma transação — o `alter table
public.sms_send_logs add column if not exists billed_units smallint null`
pode ficar esperando um lock de escrita em `sms_send_logs` se houver envios
de SMS em andamento no momento exato da virada (tabela de alto volume).
Mesmo sendo `add column ... null` (rápido, sem reescrever a tabela), ele
ainda precisa de um `ACCESS EXCLUSIVE` lock para a alteração de catálogo.

**Esperado:** sucesso. Esta migration redefine `refresh_crm_results_day` e
`check_crm_results_day` (sem apagar dados) e adiciona a coluna
`sms_send_logs.billed_units` (nullable, `add column if not exists`).

**Se der erro `canceling statement due to lock timeout`:** a transação já
fez rollback automático; não há dado parcial. Espere um minuto (os envios em
andamento liberam o lock rápido) e rode a mesma transação de novo — repita
até passar.

**Rollback desta migration:** restaurar as definições anteriores das 3
funções a partir de `20261019120000_crm_click_conversion_incremental.sql` e
`20261003133000_fix_admin_user_directory_call_duration.sql` (copiar o `create
or replace function` de cada uma); a coluna `billed_units` pode ficar (é
nullable e inofensiva) ou:
```sql
begin;
-- recriar refresh_crm_results_day, check_crm_results_day e
-- admin_list_users_with_usage com o corpo de
-- 20261019120000_crm_click_conversion_incremental.sql e
-- 20261003133000_fix_admin_user_directory_call_duration.sql
drop function if exists public.crm_sms_report_price(uuid, timestamptz);
alter table public.sms_send_logs drop column if exists billed_units;
delete from supabase_migrations.schema_migrations where version = '20261022100300';
commit;
notify pgrst, 'reload schema';
```

**Resultado:** _______________________________________________

### 2.5 — `20261022100400_billing_dashboard_and_grants.sql`

**Esperado:** sucesso. Redefine `dashboard_summary_v2` (lê
`crm_results_daily`/`tenant_wallets` em vez do saldo legado) e
`billing_report_unit_price` (demo reporta preço de venda, não custo).

**Rollback desta migration:** restaurar `dashboard_summary_v2` a partir de
`20261019150000_conversion_reports_exclude_active.sql` e
`billing_report_unit_price` a partir de `20261022100000_billing_price_book.sql`
(a versão sem a exceção da demo):
```sql
begin;
-- recriar dashboard_summary_v2 com o corpo de
-- 20261019150000_conversion_reports_exclude_active.sql
-- recriar billing_report_unit_price com O CORPO (a função) de
-- 20261022100000_billing_price_book.sql (sem o tratamento de is_demo) —
-- copiar SÓ o "create or replace function", NÃO o "grant execute ...
-- to authenticated" que acompanha essa função em 20261022100000: esta
-- migration (100400) revogou esse grant de authenticated de propósito
-- (vazava o custo do fornecedor por essa RPC; só service_role deveria
-- chamá-la). Re-rodar aquele grant reabriria o vazamento.
delete from supabase_migrations.schema_migrations where version = '20261022100400';
commit;
notify pgrst, 'reload schema';
```

**Resultado:** _______________________________________________

**Verificação depois das 5:**
```sql
select version from supabase_migrations.schema_migrations
where version in ('20261022100000','20261022100100','20261022100200','20261022100300','20261022100400')
order by version;
```
**Esperado:** as 5 versões, nessa ordem.

**Resultado:** _______________________________________________

---

## Passo 3 — Converter os créditos legados (com autorização)

### 3.1 — Preview: `select * from billing_convert_legacy_sms_credits(false);`

**Esperado:** uma linha por casa com saldo legado (igual ao Passo 1c, agora
pela função real em vez do cálculo à mão — os números devem coincidir).

**Atenção (item adiado, ruling Task 4):** o modo preview NÃO passa por preço
ausente — ele faz `v_amount := v_delta * v_unit_price` sem checar se
`v_unit_price is null` primeiro. Então, **se alguma linha vier com
`amount` nulo** (em vez de um número), é sinal de que `billing_effective_price`
não achou preço de SMS para aquela casa (catálogo incompleto) — **pare e
corrija o catálogo antes do Passo 3.2** (o modo apply, esse sim, levantaria
`price_not_found` para essa casa e marcaria a linha com
`skipped_reason = 'error: price_not_found'`, sem travar as outras).

**Se vier `skipped_reason` começando com `'error:'`:** só pode acontecer no
modo apply (3.2), nunca no preview — se aparecer aqui, é bug; pare e investigue
antes de continuar.

**Resultado:** _______________________________________________

### 3.2 — Apply: `select * from billing_convert_legacy_sms_credits(true);`

**Esperado:** mesmas linhas do preview, agora com `skipped_reason` nulo para
toda casa não-interno (a não ser que o clamp tenha entrado: `'clamped'`, só
possível se `tenant_wallets` já tivesse saldo negativo pendente, o que não
deveria acontecer logo depois do Passo 2 — carteiras são criadas com saldo 0);
`skipped_reason = 'interno'` para as casas isentas. O saldo de cada casa
não-isenta deve ficar em `legacy_balance × unit_price` (R$ 0,08 por crédito,
salvo override de preço já cadastrado para a casa).

**Se vier `skipped_reason` começando com `'error:'`:** aquela casa específica
não converteu (erro isolado por casa — ruling do fix round 1, cada casa roda
em `begin/exception` próprio, então as outras já converteram). Leia a
mensagem depois de `'error: '`, corrija a causa (preço ausente é o caso mais
provável) e rode `billing_convert_legacy_sms_credits(true)` de novo — ele é
re-executável e só lança a diferença (`delta_credits`) para quem já converteu.

**Verificação do saldo:**
```sql
select w.tenant_id, t.slug, w.balance, b.balance_credits as legacy_credits,
       round(b.balance_credits * 0.08, 4) as expected_balance
from public.tenant_wallets w
join public.tenants t on t.id = w.tenant_id
left join public.tenant_sms_credit_balances b on b.tenant_id = w.tenant_id
where t.plano <> 'interno'
order by t.slug;
```
**Esperado:** `balance = expected_balance` para toda casa com override `sms`
em `tenant_price_overrides` vazio; para casa com override, `balance` usa o
preço do override, não 0,08.

**Resultado:** _______________________________________________

---

## Passo 4 — Deploy do código (com autorização)

**Antes de mergear**, anote o SHA do `main` atual (o código que vai ficar no
ar até este passo) — é o que o Passo 10 usa para reverter:
```bash
git rev-parse main
```
**SHA do `main` antes do merge:** _______________________________________

Na VPS, a partir do diretório do `docker-compose.yml` (depois do merge desta
branch no `main` e do build da imagem — ver `docs/docker-deployment.md`):

```bash
docker compose up -d --build --force-recreate crm
docker compose ps
docker compose logs --since=5m crm
```

**Esperado:** container `crm` `healthy`, sem erro nos últimos 5 min de log
relacionado a `wallet_reserve`, `wallet_summary`, `billing_effective_price`
ou `admin_set_price`/`admin_set_tenant_price`/`admin_clear_tenant_price`
("function ... does not exist" indicaria que o Passo 2 não terminou ou o
`notify pgrst, 'reload schema'` de alguma migration não propagou — nesse caso,
rode manualmente `notify pgrst, 'reload schema';` pelo pooler e reinicie o
container).

**Smoke check manual:** abrir o app, logar como super admin
(`thiago@businesscode.com.br`), abrir `/admin` → aba "Saldo" e "Preços" (devem
carregar sem erro) e `/creditos-sms` de uma casa qualquer (deve mostrar saldo
em R$, não erro 500).

**Resultado:** _______________________________________________

---

## Passo 5 — Reconversão (cobre os envios do código antigo entre os Passos 3 e 4)

```sql
select * from public.billing_convert_legacy_sms_credits(true);
```

**Esperado, casas não-`interno` (`skipped_reason` nulo):** quase todas as
linhas com `delta_credits = 0` (nada de novo a converter — o saldo legado
não mudou desde o Passo 3.2). Só vêm linhas com `delta_credits <> 0` para
casas onde o código antigo (ainda rodando entre o Passo 3 e o deploy do
Passo 4) processou um envio de SMS que debitou o saldo legado
(`tenant_sms_credit_balances`) nesse intervalo — essas linhas lançam a
diferença no saldo novo.

**Esperado, casas `interno` (`skipped_reason = 'interno'`):** `delta_credits`
**não** vai a 0 depois da primeira conversão, nem aqui nem em execuções
futuras — a função só chama `wallet_mutation` (que é quem grava a linha
`migration` usada para calcular `already_converted` da próxima vez) dentro
do ramo não-isento; para uma casa isenta ela nunca grava essa linha, então
`already_converted` fica para sempre em 0 e `delta_credits` sempre mostra o
`legacy_balance` inteiro da casa, de novo, a cada execução (preview, apply
ou esta reconversão). Isso é esperado e sem efeito: `amount` continua 0
sempre que `skipped_reason = 'interno'`, então repetir não cobra nada — é só
um artefato de leitura que reaparece.

**Nota (item adiado, ruling Task 5 — perda pequena aceita, não coberta por
este passo):** um SMS que reservou no razão **legado** antes do deploy, mas
cuja resposta do provedor (e portanto o estorno, se rejeitado) só chega
**depois** do deploy, cai no caminho novo (`wallet_refund`) procurando uma
reserva que não existe no `wallet_ledger` — `wallet_refund` devolve
`{"ok": false, "reason": "reservation_not_found"}` em vez de lançar exceção
(não quebra o processamento do callback), mas o crédito daquele envio
**nunca é devolvido em nenhum dos dois lados**: não no legado (o código
antigo que faria o estorno já não está mais rodando) nem no novo (não há
reserva correspondente para estornar). Esta reconversão do Passo 5 relê o
saldo legado atual e lança a diferença para o saldo novo — ela cobre a
diferença de saldo entre os dois lados, mas **não recupera** o crédito
específico perdido nesse SMS rejeitado: é uma perda pequena e aceita (no
máximo 1 segmento por envio nessa janela estreita entre os Passos 3 e 4),
não algo que este passo resolve.

**Se vier `skipped_reason` começando com `'error:'`:** mesmo procedimento do
Passo 3.2 — corrigir e rodar de novo.

**Resultado:** _______________________________________________

---

## Passo 6 — Refresh dos últimos 30 dias da Central de Resultados

`refresh_crm_results_day(_tenant uuid, _day date)` é por casa e por dia, mas
já existe um orquestrador em lote para o refresh: `refresh_crm_results_recent(_days
integer default 2)` (criado em `20261016130000_crm_results_daily.sql`,
redefinido por último em `20261018110000_demo_tenant_skip_workers.sql`) pega
um advisory lock de transação (`betleads.refresh_crm_results`), roda todas as
casas **não-demo** (`where not is_demo`), isola cada casa num bloco
`begin/exception` próprio e devolve a contagem de casas que falharam, ou
`-1` se outra execução (o próprio cron, que já roda isso a cada 5/10 min)
está com o lock. Use-o em vez de escrever um loop do zero:

```sql
set statement_timeout = '30min';
select public.refresh_crm_results_recent(30);
```

**Esperado:** `0` (nenhuma casa falhou). Rode pelo pooler **sem** `SET
SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` (é uma escrita).

**Se vier `-1`:** outra execução (o cron) está com o advisory lock agora.
Espere 1–2 min (o cron roda rápido, só 2 ou 8 dias por padrão) e rode de
novo — não force destravar o lock.

**Se vier um número `> 0`:** alguma(s) casa(s) falhou/falharam (a função só
registra `raise warning`, visível no log do Postgres, não no retorno — pela
sessão SQL você só sabe a contagem). Para saber quais casas, rode o loop
manual só nas suspeitas (qualquer casa com saldo legado alto do Passo 1c é
candidata) com `refresh_crm_results_day` direto e leia o erro.

**A casa demo fica de fora** desse refresh em lote (`where not is_demo`) de
propósito — o worker nunca toca a demo (é um clone congelado, não dados
reais). Se quiser os números dela atualizados com o preço novo (ela reporta
o preço de **venda**, não o custo, pela regra da migration 100400), rode-a
separada, num statement próprio:

```sql
do $$
declare v_day date;
begin
  for v_day in select generate_series(current_date - 29, current_date, interval '1 day')::date loop
    perform public.refresh_crm_results_day('258b2d5b-50a6-3d66-8df4-a3bba0fde0c4', v_day);
  end loop;
end $$;
```

Isso é opcional: a demo é re-clonada periodicamente
(`scripts/demo/clone-tenant-demo.mjs`, ver memória `demo-tenant`) e o próximo
reset já traz os números corretos sem precisar deste passo. Faça-o só se um
prospect for olhar a Central de Resultados da demo antes do próximo reset.

**Checagem de saúde** — `refresh_crm_results_recent` não roda a checagem;
rode `check_crm_results_day` à parte, casa a casa, para os últimos 30 dias
(use o dia civil de Brasília, igual à própria função):

```sql
set statement_timeout = '15min';
do $$
declare
  v_tenant uuid;
  v_day date;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  for v_tenant in select id from public.tenants where not is_demo order by id loop
    for v_day in select generate_series(v_today - 29, v_today, interval '1 day')::date loop
      perform public.check_crm_results_day(v_tenant, v_day);
    end loop;
  end loop;
end $$;
```

```sql
select tenant_id, metric_date, check_name, expected, actual
from public.crm_results_health
where check_name = 'cost' and ok = false and metric_date >= current_date - 29
order by metric_date desc, tenant_id;
```
**Esperado:** o número de linhas aqui não deve ser maior que o
`cost_health_failures_now` anotado no Passo 1e (a linha de base de antes da
virada) — qualquer linha **nova** em relação a esse baseline, em dias **a
partir de 2026-10-01** (a data de `valid_from` do preço inicial no price
book), é uma regressão do refresh desta virada. Dias **antes de
2026-10-01** usam o preço legado via `crm_sms_report_price` (cai no
fallback `tenant_sms_pricing.sale_price_per_sms` →
`sms_credit_settings.default_sale_price_per_sms` → R$ 0,12) — a checagem de
custo desses dias compara contra esse preço legado, não contra R$ 0,08,
então não deveria dar `ok = false` por esse motivo. Se os últimos 30 dias
não cruzarem 01/10, esta ressalva não se aplica.

**Se vier alguma linha com `ok = false`:** anote `tenant_id`/`metric_date` e
compare `expected` (crua, somada de `wallet_ledger`+`sms_credit_ledger`) com
`actual` (a coluna `cost` gravada em `crm_results_daily`) — uma diferença
grande indica que o refresh daquele dia/casa não rodou (reexecute só aquele
par) ou que há sends não cobertos pela regra de `check_crm_results_day`
(ver comentário da função em `20261022100300_billing_prices_in_reports.sql`).

**Resultado:** _______________________________________________

---

## Passo 7 — Integridade da carteira e envios de teste

### 7.1 — `select * from billing_wallet_integrity();`

**Esperado:** zero linhas (nenhuma casa com `balance` diferente da soma do
`wallet_ledger`).

**Se vier alguma linha:** alguém escreveu direto em `tenant_wallets` fora das
RPCs (`wallet_mutation`/`wallet_reserve`/`wallet_refund`/`admin_adjust_wallet`
/`billing_convert_legacy_sms_credits`). Não corrija escrevendo direto no
saldo — identifique a causa (grant indevido, script fora de banda) antes de
decidir o ajuste.

**Resultado:** _______________________________________________

### 7.2 — Envio de teste: 1 SMS de uma casa normal

Envie 1 SMS de teste (via `/sms`, envio individual) de uma casa não-`interno`
para um número autorizado de teste. Depois:

```sql
select balance, lifetime_used from public.tenant_wallets where tenant_id = '<tenant da casa de teste>';
select * from public.wallet_ledger where tenant_id = '<tenant da casa de teste>' order by created_at desc limit 3;
```

**Esperado:** o saldo caiu `segmentos × R$ 0,08` (ou o preço com override, se
houver); uma linha nova `entry_type = 'usage_reservation'`, `item = 'sms'`,
`amount` negativo.

**Resultado:** _______________________________________________

### 7.3 — Envio de teste: 1 SMS de uma casa `interno`

Mesmo envio, de uma das 3 casas isentas operacionais: `pixpgf`, `pixreals`
ou `forrandobet`. **Não use a casa demo aqui** — ela tem o envio bloqueado
no código (`DEMO_SEND_BLOCKED`, "Ambiente de demonstração: nenhum envio é
feito"); o teste falharia por esse motivo, não por nada relacionado à
carteira. Use um número de teste autorizado, exatamente como no 7.2.

```sql
select balance from public.tenant_wallets where tenant_id = '<tenant interno>';
select * from public.wallet_ledger where tenant_id = '<tenant interno>' order by created_at desc limit 3;
```

**Esperado:** `balance` não muda; a linha nova de `usage_reservation` tem
`amount = 0` e `provider_unit_cost` preenchido (o custo do fornecedor, R$ 0,059,
continua registrado no razão mesmo não sendo cobrado).

**Resultado:** _______________________________________________

---

## Passo 8 — Hardening pós-virada (com autorização)

### 8.1 — Revogar EXECUTE de `authenticated` nas RPCs legadas de crédito

As 6 funções abaixo são as únicas formas de mexer no saldo **legado**
(`tenant_sms_credit_balances`/`sms_credit_ledger`). Depois da reconversão do
Passo 5, nenhuma delas deve continuar acessível a um usuário autenticado — se
continuar, alguém ainda poderia mover o saldo legado sem que isso seja
refletido no saldo novo. Assinaturas atuais (confirmadas em
`supabase/migrations/20260922193000_create_sms_credit_billing.sql` e
`20261015100000_fix_rls_privilege_escalation.sql`, que é o último grant
vigente: todas as 6 estão hoje com `GRANT EXECUTE ... TO authenticated,
service_role`):

```sql
begin;
revoke execute on function public.reserve_sms_credits(uuid, integer, text, text, text) from authenticated;
revoke execute on function public.refund_sms_credits(uuid, integer, text, text, text, text) from authenticated;
revoke execute on function public.create_sms_credit_checkout(uuid, uuid, integer) from authenticated;
revoke execute on function public.admin_adjust_sms_credits(uuid, integer, text, text) from authenticated;
revoke execute on function public.admin_mark_sms_credit_order_paid(uuid, text, text, jsonb) from authenticated;
revoke execute on function public.apply_sms_credit_mutation(uuid, integer, text, text, text, text, text, jsonb, uuid) from authenticated;
commit;
notify pgrst, 'reload schema';
```

`service_role` continua podendo chamar todas as 6 (não revogado) — não há
caminho de código novo que as chame, mas isso evita um erro de rollback
futuro quebrar algo que dependa delas via service role.

**Esperado:** sucesso.

**Verificação:**
```sql
select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in ('reserve_sms_credits','refund_sms_credits','create_sms_credit_checkout',
                        'admin_adjust_sms_credits','admin_mark_sms_credit_order_paid','apply_sms_credit_mutation')
order by routine_name, grantee;
```
**Esperado:** nenhuma linha com `grantee = 'authenticated'` para essas 6
funções; `service_role` e o dono (`postgres`) continuam aparecendo.

**Resultado:** _______________________________________________

### 8.2 — Liquidar os pedidos pendentes anotados no Passo 1d

`admin_adjust_wallet` só aceita quem passa `is_super_admin()` (checa
`auth.uid()`, nulo numa sessão do pooler) — **não existe SQL direto para
este passo**; ele é feito pela tela, numa sessão de super admin autenticada,
para que a escrita fique auditada em `tenant_audit_logs` (como qualquer
outro ajuste manual de carteira).

Para cada pedido `pending` da lista do Passo 1d, nesta ordem:

1. Logar como super admin (`thiago@businesscode.com.br`). Abrir `/admin` →
   aba "Saldo" (ou `/tenants` → casa do pedido → aba "Saldo") → diálogo de
   ajuste de carteira dessa casa.
2. Preencher `amount = credits × 0,08` (créditos do pedido × o preço **novo**
   de SMS da casa — não `unit_price`/`amount_cents` do pedido, que são o
   preço antigo) e o motivo exatamente
   `"Pedido pendente <id do pedido> quitado na virada"`.
3. Confirmar o ajuste e **checar que a linha apareceu** no razão antes de
   tocar no pedido legado:
   ```sql
   select id, amount, reason, created_at
   from public.wallet_ledger
   where tenant_id = '<tenant_id do pedido>'
     and reason like 'Pedido pendente <id do pedido>%'
   order by created_at desc limit 1;
   ```
   **Esperado:** uma linha, `entry_type = 'manual_adjustment'`,
   `amount = credits × 0,08` do pedido.
4. **Só depois de confirmar o passo 3**, marcar o pedido legado — a condição
   `exists (...)` repete a mesma checagem dentro da transação, para nunca
   marcar um pedido como liquidado sem o lançamento correspondente já
   gravado:
   ```sql
   begin;
   update public.sms_credit_orders
   set status = 'paid', paid_at = now()
   where id = '<id do pedido>'
     and exists (
       select 1 from public.wallet_ledger
       where tenant_id = '<tenant_id do pedido>'
         and reason like 'Pedido pendente <id do pedido>%'
     );
   commit;
   ```
   **Esperado:** 1 linha afetada (`UPDATE 1`). Se vier `UPDATE 0`, o
   lançamento do passo 3 não foi encontrado — não insista; volte ao passo 1
   e refaça o ajuste pela tela antes de tentar marcar o pedido de novo.

Use `status = 'paid'` só se o valor foi de fato cobrado fora do sistema (Pix
manual, boleto etc. já confirmado); se o pedido nunca foi pago e deve ser
descartado, marque `status = 'canceled'` direto (sem passar pelos passos
1–3, que são só para quem está sendo de fato creditado agora).

**Verificação final:**
```sql
select count(*) from public.sms_credit_orders where status = 'pending';
```
**Esperado:** 0.

**Resultado:** _______________________________________________

---

## Passo 9 — Checklist visual por tela

Testar como três perfis: uma casa normal, uma casa `interno` (`pixpgf`,
`pixreals` ou `forrandobet`) e a casa demo (`demo`). Lista do relatório da
Task 8 (`.superpowers/sdd/2026-10-21-pg1-precos-saldo-unico/task-8-report.md`):

- [ ] **`/creditos-sms`** (casa normal e demo): saldo em R$ (não inteiro);
  demo mostra badge "Isenta"; as três linhas de preço mostram 0,08 / 0,09 /
  0,002; a franquia de e-mail só aparece com uso no mês; tabela do razão com
  rótulos pt-BR e cor certa no valor.
- [ ] **`/tenants` → aba "Saldo"** (superadmin, casa não isenta): card de
  margem mostra `0,08 − 0,059 = R$ 0,021`; linha de custo só visível ao
  superadmin; "Voltar ao padrão" só aparece com override ativo.
- [ ] **`/tenants` → aba "Configuração"**: trocar `plano` de/para `interno`
  revela o campo de motivo e bloqueia salvar com menos de 5 caracteres;
  trocar entre dois planos não-`interno` nunca mostra o campo.
- [ ] **`/admin` → aba "Saldo"**: lista exclui o tenant demo; badge "Isenta"
  bate com `plano = 'interno'`; diálogo de ajuste usa R$, não inteiro; o
  lançamento aparece na hora no `/creditos-sms`/`/tenants` da própria casa.
- [ ] **`/admin` → aba "Preços"**: editar um campo e salvar não zera os
  outros dois do mesmo item.
- [ ] **Início (`/`)**: card "Saldo"/"Isenta" mostra o saldo novo (R$) e o
  flag de isenção certo para casa normal, `interno` e demo.

**Resultado:** _______________________________________________

---

## Passo 10 — Plano de rollback

**Código:** usar o SHA anotado no Passo 4 (o `main` de antes do merge) —
não uma imagem Docker antiga sem referência, para ter certeza de qual
código volta ao ar:

```bash
git checkout <SHA anotado no Passo 4>
docker compose up -d --build --force-recreate crm
docker compose ps
docker compose logs --since=5m crm
```

(mesmo comando do Passo 4/`docs/docker-deployment.md`, só com o código do
SHA anterior). As tabelas novas (`tenant_wallets`, `wallet_ledger`,
`tenant_monthly_usage`, `billing_price_book`, `tenant_price_overrides`,
`billing_plans`) são **aditivas**: o código antigo não as lê nem as escreve,
então reverter o código não precisa desfazer as migrations 100000–100300.

**Atenção — `dashboard_summary_v2` (migration 100400) não tem essa
propriedade aditiva:** ela redefine a função para devolver
`walletBalance`/`exempt` em vez do `smsCredits` que o Início antigo lê (ver
a nota do Passo 0). Depois do Passo 4, o saldo **legado**
(`tenant_sms_credit_balances`) também já ficou estático — o código novo só
debita a carteira nova, nunca mais o saldo legado — então, se o rollback do
código acontecer depois do Passo 4, o Início antigo de volta no ar não tem
um número correto para mostrar de nenhum dos dois lados: o campo que ele lê
não existe mais na RPC (mostra 0, igual à janela cosmética do Passo 0) e o
saldo legado, mesmo que a RPC ainda devolvesse, já estaria desatualizado
(não reflete o consumo real depois do Passo 4). Duas opções, sem meio-termo
melhor: (a) aceitar o card "Créditos de SMS" zerado enquanto o código antigo
estiver no ar (mesma situação cosmética do Passo 0, sem perda de dado real —
o saldo de verdade mora na carteira nova); ou (b) reverter também a migration
100400 (bloco de rollback da seção 2.5) para que `dashboard_summary_v2`
volte a devolver `smsCredits` a partir do saldo legado — mas nesse caso ele
vai mostrar um número **desatualizado** (parado no valor do Passo 3/5), não
o consumo real desde o Passo 4. Prefira (a): é mais simples e não esconde
que o saldo mostrado é obsoleto.

**Dados:** as tabelas legadas (`tenant_sms_credit_balances`,
`sms_credit_ledger`, `sms_credit_orders`, `tenant_sms_pricing`,
`sms_credit_settings`) **não são tocadas** até o Passo 8 (as RPCs continuam
gravando nelas se o código antigo rodar, e a conversão só lê — nunca escreve
nelas). Se o rollback do código acontecer **antes** do Passo 4 (ainda não
fez o deploy do código novo), o sistema volta a funcionar exatamente como
antes da virada, sem perda: o saldo legado ainda está intacto (módulo o que
a conversão já havia deduzido do lado novo, que é só leitura do lado
legado). Se o rollback acontecer **depois** do Passo 8 (RPCs legadas já
revogadas de `authenticated`), o código antigo volta a chamar essas RPCs
como `authenticated` e vai receber `permission denied` — nesse caso,
reconceda o EXECUTE antes de reverter o código:

```sql
begin;
grant execute on function public.reserve_sms_credits(uuid, integer, text, text, text) to authenticated;
grant execute on function public.refund_sms_credits(uuid, integer, text, text, text, text) to authenticated;
grant execute on function public.create_sms_credit_checkout(uuid, uuid, integer) to authenticated;
grant execute on function public.admin_adjust_sms_credits(uuid, integer, text, text) to authenticated;
grant execute on function public.admin_mark_sms_credit_order_paid(uuid, text, text, jsonb) to authenticated;
grant execute on function public.apply_sms_credit_mutation(uuid, integer, text, text, text, text, text, jsonb, uuid) to authenticated;
commit;
notify pgrst, 'reload schema';
```

**Migrations:** reverter uma a uma, na ordem inversa (100400 → 100000), com
os blocos de rollback de cada subseção do Passo 2. Só faça isso se o código
que as usa já foi revertido (a ordem inversa do Passo 0: desligar o código
novo antes de tirar o schema de baixo dele).

**Resultado:** _______________________________________________
