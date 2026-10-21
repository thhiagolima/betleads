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

**Resultado:** _______________________________________________

---

## Passo 1 — Checagens somente leitura (pedir aprovação ao final)

Todo este passo é só leitura. Rode cada consulta pelo pooler com
`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;` logo após conectar.

### 1a. Casas com `plano = 'interno'` hoje (antes da migration)

```sql
select id, slug, nome, is_demo, plano
from public.tenants
where plano = 'interno'
order by slug;
```

**Esperado:** zero linhas, ou só casas que o usuário já aprovou como `interno`
antes desta virada (a migration 20261022100000 vai setar `plano = 'interno'`
para `pixpgf`, `pixreals`, `forrandobet` e qualquer casa com `is_demo = true` —
hoje isso deveria ser só a casa demo `258b2d5b-50a6-3d66-8df4-a3bba0fde0c4`,
slug `demo`).

**Se vier diferente:** qualquer casa aqui que não seja `pixpgf`, `pixreals`,
`forrandobet` ou uma casa `is_demo = true` precisa de aprovação explícita do
usuário antes de seguir — ela vai ficar isenta de cobrança a partir do
Passo 2. Sem essa aprovação, pare aqui.

**Guarde o resultado** (lista de `id`/`slug`/`plano`): é o valor anterior de
`plano`, necessário para o rollback do Passo 2 (a migration sobrescreve
`plano` para as 4 casas acima e não guarda o valor antigo).

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
casa aplicados ainda) e casas `interno` (passo 1a) são puladas.

```sql
select
  b.tenant_id,
  t.slug,
  t.plano,
  b.balance_credits as legacy_balance,
  case when t.plano = 'interno' or coalesce(t.is_demo, false)
       then null
       else round(b.balance_credits * 0.08, 4) end as preview_amount,
  case when t.plano = 'interno' or coalesce(t.is_demo, false)
       then 'interno' else null end as skipped_reason
from public.tenant_sms_credit_balances b
join public.tenants t on t.id = b.tenant_id
where b.balance_credits > 0
order by t.slug;
```

**Esperado:** uma linha por casa com saldo legado positivo; `preview_amount`
preenchido para toda casa não-`interno`/não-demo (créditos × R$ 0,08); null
só para `interno`/demo.

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
linha pendente nesta lista deve ser liquidada manualmente, depois da virada,
com `admin_adjust_wallet(tenant_id, amount, reason)` (R$ = `amount_cents / 100`,
motivo citando o `id` do pedido) — e então marcada à mão
(`update sms_credit_orders set status = 'canceled' where id = ...` ou `'paid'`
se o valor realmente foi cobrado fora do sistema).

**Se vier diferente:** nenhuma ação aqui além de guardar a lista — ela só é
usada no Passo 8.

**Resultado:** _______________________________________________

### 1e. Linha de base para comparar depois (contagens)

```sql
select
  (select count(*) from public.tenant_wallets) as wallet_rows,
  (select count(*) from public.wallet_ledger) as ledger_rows,
  (select count(*) from public.billing_price_book) as price_book_rows,
  (select count(*) from public.tenant_price_overrides) as overrides_rows;
```

**Esperado:** todas as tabelas ainda não existem antes do Passo 2 — esta
consulta **falha** com `relation does not exist` (esperado e normal: as
tabelas são criadas na migration 20261022100100/20261022100000). Anote isso
como a linha de base ("0 porque a tabela não existe ainda").

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
values ('<versão, ex: 20261022100000>', '<nome, ex: billing_price_book>', array['<conteúdo integral do arquivo como string>']);
commit;
```

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

**Esperado:** sucesso. Esta migration redefine `refresh_crm_results_day` e
`check_crm_results_day` (sem apagar dados) e adiciona a coluna
`sms_send_logs.billed_units` (nullable, `add column if not exists`).

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
-- recriar billing_report_unit_price com o corpo de
-- 20261022100000_billing_price_book.sql (sem o tratamento de is_demo)
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

**Esperado:** quase todas as linhas com `delta_credits = 0` (nada de novo a
converter — o saldo legado não mudou desde o Passo 3.2). Só vêm linhas com
`delta_credits <> 0` para casas onde o código antigo (ainda rodando entre o
Passo 3 e o deploy do Passo 4) processou um envio de SMS que debitou o saldo
legado (`tenant_sms_credit_balances`) nesse intervalo — essas linhas lançam a
diferença no saldo novo.

**Nota (item adiado, ruling Task 5):** um SMS que reservou no razão **legado**
antes do deploy, mas cuja resposta do provedor (e portanto o estorno, se
rejeitado) só chega **depois** do deploy, vai cair no caminho novo
(`wallet_refund`) procurando uma reserva que não existe no `wallet_ledger` —
`wallet_refund` devolve `{"ok": false, "reason": "reservation_not_found"}` em
vez de lançar exceção (não quebra o envio), mas o crédito legado daquele envio
nunca é devolvido pelo lado antigo. Esta reconversão do Passo 5 é o que cobre
esse caso: ela relê o saldo legado atual (já líquido do que não foi devolvido)
e lança só a diferença.

**Se vier `skipped_reason` começando com `'error:'`:** mesmo procedimento do
Passo 3.2 — corrigir e rodar de novo.

**Resultado:** _______________________________________________

---

## Passo 6 — Refresh dos últimos 30 dias da Central de Resultados

A função de refresh é `public.refresh_crm_results_day(_tenant uuid, _day date)`
— por casa e por dia (não existe uma variante em lote); rode em loop para cada
casa ativa e cada um dos últimos 30 dias:

```sql
do $$
declare
  v_tenant record;
  v_day date;
begin
  for v_tenant in select id from public.tenants where coalesce(is_demo, false) = false or id = '258b2d5b-50a6-3d66-8df4-a3bba0fde0c4' loop
    for v_day in select generate_series(current_date - 29, current_date, interval '1 day')::date loop
      perform public.refresh_crm_results_day(v_tenant.id, v_day);
      perform public.check_crm_results_day(v_tenant.id, v_day);
    end loop;
  end loop;
end $$;
```

Rode isso pelo pooler **sem** `SET SESSION CHARACTERISTICS AS TRANSACTION
READ ONLY` (é uma escrita) e com `SET statement_timeout` generoso (ex.:
`SET statement_timeout = '10min';` antes do bloco) — 30 dias × todas as casas
pode levar alguns minutos.

**Esperado:** o bloco termina sem erro.

**Checagem de saúde:**
```sql
select tenant_id, metric_date, check_name, expected, actual
from public.crm_results_health
where check_name = 'cost' and ok = false and metric_date >= current_date - 29
order by metric_date desc, tenant_id;
```
**Esperado:** zero linhas para dias **a partir de 2026-10-01** (a data de
`valid_from` do preço inicial no price book). Dias **antes de 2026-10-01**
usam o preço legado via `crm_sms_report_price` (cai no fallback
`tenant_sms_pricing.sale_price_per_sms` → `sms_credit_settings.default_sale_price_per_sms`
→ R$ 0,12) — a checagem de custo desses dias compara contra esse preço
legado, não contra R$ 0,08, então não deveria dar `ok = false` por esse
motivo. Se os últimos 30 dias não cruzarem 01/10, esta ressalva não se
aplica.

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

Mesmo envio, de uma das 4 casas isentas (`pixpgf`, `pixreals`, `forrandobet`
ou `demo` — usar `demo` evita qualquer ligação com um número real da operação).

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

Para cada pedido `pending` da lista do Passo 1d:

```sql
select public.admin_adjust_wallet(
  '<tenant_id do pedido>',
  <amount_cents / 100.0>,
  'Liquidação manual do pedido sms_credit_orders <id do pedido> (RPC de marcar pago removida na virada do saldo único)'
);
update public.sms_credit_orders set status = 'paid', paid_at = now() where id = '<id do pedido>';
```

Use `status = 'paid'` só se o valor foi de fato cobrado fora do sistema (Pix
manual, boleto etc. já confirmado); use `'canceled'` se o pedido nunca foi
pago e deve ser descartado (sem rodar `admin_adjust_wallet` nesse caso).

**Esperado:** uma linha nova em `wallet_ledger` (`entry_type =
'manual_adjustment'`) por pedido liquidado, e o pedido correspondente saindo
da lista de `pending`.

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

**Código:** reimplantar a imagem Docker anterior (`docker compose up -d
--force-recreate` apontando para a tag/imagem anterior) e confirmar
`docker compose logs` sem erro. As tabelas novas (`tenant_wallets`,
`wallet_ledger`, `tenant_monthly_usage`, `billing_price_book`,
`tenant_price_overrides`, `billing_plans`) são **aditivas**: o código antigo
não as lê nem as escreve, então reverter o código não precisa desfazer as
migrations.

**Dados:** as tabelas legadas (`tenant_sms_credit_balances`,
`sms_credit_ledger`, `sms_credit_orders`, `tenant_sms_pricing`,
`sms_credit_settings`) **não são tocadas** até o Passo 8 (as RPCs continuam
gravando nelas se o código antigo rodar, e a conversão só lê — nunca escreve
nelas). Se o rollback do código acontecer **antes** do Passo 8, o sistema
volta a funcionar exatamente como antes da virada, sem perda: o saldo legado
ainda está intacto (modulo o que a conversão já havia deduzido do lado novo,
que é só leitura do lado legado). Se o rollback acontecer **depois** do
Passo 8 (RPCs legadas já revogadas de `authenticated`), o código antigo
volta a chamar essas RPCs como `authenticated` e vai receber `permission
denied` — nesse caso, reconceda o EXECUTE antes de reverter o código:

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
