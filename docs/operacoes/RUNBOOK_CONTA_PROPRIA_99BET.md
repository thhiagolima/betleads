# Runbook — Conta própria da 99Bet (SMS via Short Brasil)

**Spec:** `docs/superpowers/specs/2026-11-07-conta-propria-provedor-design.md`
**Escopo anterior:** `docs/ESCOPO_PROVEDORES_POR_CASA_2026-10-28.md`
**Plano:** `.superpowers/sdd/2026-11-07-conta-propria-provedor/`
**Branch:** `feat/conta-propria-provedor`
**Casa piloto:** 99Bet (slug `99bet`, id `b5c4fec6-3adf-412d-868e-0bc18ad1b7c6`),
canal SMS, provedor Short Brasil.

Este documento é um roteiro de execução, não um relato do que já foi feito.
Nenhuma escrita em produção (migration, deploy, cadastro de conta, taxa,
ativação) acontece sem autorização explícita do usuário, pedida de novo a
cada passo marcado **(requer autorização)**.

Acesso ao banco: pooler de sessão
(`aws-0-ca-central-1.pooler.supabase.com:5432`, usuário
`postgres.<VITE_SUPABASE_PROJECT_ID>`), via `pg` (npm) a partir de um
diretório de scratch — não há `psql` nesta máquina (memória
`db-access-pooler`). Para os passos de leitura, rode
`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;` logo depois de
conectar.

---

## Visão geral da ordem (não pule nem inverta)

**As 5 migrations (`20261217100000`..`20261217100400`) têm que ser aplicadas,
nesta ordem, ANTES do deploy do app novo.** Cada uma é aditiva (não objetiva
— global constraints) e o app antigo ignora as colunas/tabelas novas, mas o
app **novo** lê `owner_tenant_id`, `tenant_own_provider_grants`,
`disabled_reason` e o parâmetro novo de `wallet_reserve` desde o primeiro
request — se alguma migration não tiver rodado, a tela de "Provedor por casa"
do super admin e a aba "Canais" da 99Bet quebram, e o envio de SMS por conta
com dono cai no `catch` genérico (a UI mostra erro, não envia — não há
fallback para a rota BetLeads, por constraint).

1. Migration `20261217100000_own_provider_accounts` (Passo 1).
2. Migration `20261217100100_wallet_reserve_own_account` (Passo 2).
3. Migration `20261217100200_billing_channel_fees` (Passo 3).
4. Migration `20261217100300_crm_results_own_cost` (Passo 4).
5. Migration `20261217100400_own_provider_disabled_reason` (Passo 5).
6. `npm run build` local, merge para `main`, deploy (Passo 6).
7. Super admin libera SMS para a 99Bet com a taxa mensal (Passo 7).
8. Admin da 99Bet cadastra a conta Short Brasil, configura o webhook, testa e
   ativa (Passo 8).
8b. **Teste obrigatório no painel real da Short Brasil** antes do piloto
   (Passo 8b) — callback com o token no caminho atualizando `delivery_status`.
9. Verificação do primeiro envio e do primeiro callback (Passo 9).
10. O que a 99Bet precisa saber (Passo 10, comunicar antes do Passo 8).
11. Rollback (Passo 11).

---

## Passo 1 — Migration `20261217100000_own_provider_accounts` (requer autorização)

Cria `provider_accounts.owner_tenant_id` (NULL = conta da BetLeads;
preenchido = conta própria de uma casa, só ligável à própria casa, nunca
padrão da plataforma — `ON DELETE CASCADE`), `provider_accounts.own_unit_cost`,
`provider_accounts.callback_token_encrypted`/`last_callback_at`, e a tabela
nova `tenant_own_provider_grants` (casa, canal → `allowed`,
`monthly_fee_cents`, `pending_decision`, histórico de quem liberou/revogou).
RLS ligada sem políticas; só `service_role`.

Pelo pooler, em uma conexão de escrita:

```sql
begin;
-- cole o conteúdo INTEGRAL de supabase/migrations/20261217100000_own_provider_accounts.sql aqui
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20261217100000', 'own_provider_accounts', array[$mig$<conteúdo integral do arquivo aqui>$mig$]);
commit;
```

Use um dollar-quote com tag própria (`$mig$...$mig$`) para o conteúdo do
arquivo, nunca aspas simples — o mesmo padrão de
`docs/operacoes/RUNBOOK_ATIVAR_MENSALIDADE.md` (Passo 3) e dos runbooks
anteriores: a transação que aplica o SQL é a mesma que registra em
`supabase_migrations.schema_migrations`, porque não há CLI/token do Supabase
nesta máquina para `supabase db push`.

**Esperado:** sucesso, sem erro.

**Verificação:**
```sql
select version from supabase_migrations.schema_migrations
where version = '20261217100000';

select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'provider_accounts'
  and column_name in ('owner_tenant_id', 'own_unit_cost', 'callback_token_encrypted', 'last_callback_at')
order by column_name;

select table_name from information_schema.tables
where table_schema = 'public' and table_name = 'tenant_own_provider_grants';
```
**Esperado:** a versão, as 4 colunas e a tabela nova.

**Rollback** (ver cabeçalho do arquivo):
```sql
begin;
drop table if exists public.tenant_own_provider_grants;
alter table public.provider_accounts drop column if exists last_callback_at;
alter table public.provider_accounts drop column if exists callback_token_encrypted;
alter table public.provider_accounts drop column if exists own_unit_cost;
alter table public.provider_accounts drop column if exists owner_tenant_id;
delete from supabase_migrations.schema_migrations where version = '20261217100000';
commit;
notify pgrst, 'reload schema';
```

**Resultado:** _______________________________________________

---

## Passo 2 — Migration `20261217100100_wallet_reserve_own_account` (requer autorização)

`wallet_reserve` ganha o 7º parâmetro `_provider_account_id uuid default
null`; `expert_wallet_reserve`, o 8º. Quando a conta informada pertence à
própria casa (`owner_tenant_id = _tenant`), a reserva é gratuita: franquia
não consumida, `provider_unit_cost = 0`, `unit_price = 0`,
`metadata.provider_account_id` + `metadata.own_account = true` gravados no
razão. `tenant_monthly_usage.units` continua somando (a casa enviou a
unidade); `free_units_used`/`billed_amount` não sobem porque os valores que
alimentam o incremento já são 0. As duas funções são recriadas via `drop`
antes do `create` (não `create or replace`) para não deixar uma sobrecarga
antiga ambígua — chamadas existentes com 6/7 argumentos continuam
funcionando, resolvidas por nome em tempo de chamada.

```sql
begin;
-- cole o conteúdo INTEGRAL de supabase/migrations/20261217100100_wallet_reserve_own_account.sql aqui
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20261217100100', 'wallet_reserve_own_account', array[$mig$<conteúdo integral do arquivo aqui>$mig$]);
commit;
```

**Esperado:** sucesso, sem erro.

**Verificação:**
```sql
select version from supabase_migrations.schema_migrations
where version = '20261217100100';

select proname, pronargs from pg_proc
where proname in ('wallet_reserve', 'expert_wallet_reserve');
```
**Esperado:** a versão; `wallet_reserve` com 7 argumentos, `expert_wallet_reserve`
com 8 (cada nome aparecendo uma única vez — se aparecer duas linhas para o
mesmo nome, o `drop` anterior não limpou a sobrecarga antiga; investigue
antes de seguir).

**Rollback** (sequência exata do cabeçalho do arquivo — primeiro apagar as
assinaturas novas de 7/8 argumentos, só depois recriar as antigas; na ordem
inversa da criação, `expert_wallet_reserve` antes de `wallet_reserve`, porque
a primeira chama a segunda):
```sql
begin;
drop function public.expert_wallet_reserve(uuid, uuid, text, integer, text, text, text, uuid);
drop function public.wallet_reserve(uuid, text, integer, text, text, text, uuid);
-- recriar as duas com o corpo anterior, sem o 7º/8º parâmetro:
--   wallet_reserve        <- corpo de 20261210100100_webpush_billing_item.sql
--   expert_wallet_reserve <- corpo de 20261126100000_expert_campaigns.sql
-- (CREATE FUNCTION, não CREATE OR REPLACE — a assinatura antiga não existe
-- mais depois dos DROPs acima) e reaplicar os mesmos grant/revoke execute
-- que essas duas migrations já tinham para a assinatura antiga.
delete from supabase_migrations.schema_migrations where version = '20261217100100';
commit;
notify pgrst, 'reload schema';
```

**Resultado:** _______________________________________________

---

## Passo 3 — Migration `20261217100200_billing_channel_fees` (requer autorização)

`billing_invoices` ganha `channel_fees_cents` (bigint, >= 0, default 0) e
`channel_fees` (jsonb, default `'{}'`). `billing_channel_fees(_tenant)` soma
`monthly_fee_cents` das concessões ativas (`allowed` na emissão) em que (a)
a conta ligada em `tenant_channel_providers` é da própria casa e está
`active`, **ou** (b) a casa usou conta própria naquele canal desde a emissão
da fatura anterior (`wallet_ledger` `usage_reservation` com
`metadata->>'own_account' = 'true'`; sem fatura anterior, desde `granted_at`)
— desligar a conta própria pouco antes da emissão não tira a taxa de quem
usou. Sem concessão, taxa zero, ou sem uso próprio no período e sem conta
própria ativa ligada: não entra. `billing_issue_invoice`, `billing_reprice_open_invoice` e
`billing_admin_one_off_discount` são recriadas para gravar/preservar
`channel_fees_cents` dentro de `amount_cents` (taxa congelada na emissão,
desconto continua incidindo só sobre a base do plano).

```sql
begin;
-- cole o conteúdo INTEGRAL de supabase/migrations/20261217100200_billing_channel_fees.sql aqui
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20261217100200', 'billing_channel_fees', array[$mig$<conteúdo integral do arquivo aqui>$mig$]);
commit;
```

**Esperado:** sucesso, sem erro.

**Verificação:**
```sql
select version from supabase_migrations.schema_migrations
where version = '20261217100200';

select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'billing_invoices'
  and column_name in ('channel_fees_cents', 'channel_fees');

select public.billing_channel_fees('b5c4fec6-3adf-412d-868e-0bc18ad1b7c6'::uuid);
```
**Esperado:** a versão, as 2 colunas, e `{"total_cents": 0, "channels": {}}`
(a 99Bet ainda não tem concessão nem conta própria liberada neste ponto).

**Rollback:** reaplicar os corpos anteriores de `billing_issue_invoice`
(`20261023100000:394`), `billing_reprice_open_invoice`
(`20261023100000:529`) e `billing_admin_one_off_discount`
(`20261023100000:1023`); depois:
```sql
begin;
alter table public.billing_invoices drop column if exists channel_fees_cents;
alter table public.billing_invoices drop column if exists channel_fees;
drop function if exists public.billing_channel_fees(uuid);
delete from supabase_migrations.schema_migrations where version = '20261217100200';
commit;
notify pgrst, 'reload schema';
```
Só rode este rollback se nenhuma fatura já tiver sido emitida com
`channel_fees_cents > 0` (checar antes:
`select count(*) from billing_invoices where channel_fees_cents > 0`).

**Resultado:** _______________________________________________

---

## Passo 4 — Migration `20261217100300_crm_results_own_cost` (requer autorização)

`refresh_crm_results_day` recriada (corpo de
`20261129100000_supabase_consumo_p0.sql:33`): o custo do SMS, por linha, passa
a usar `own_unit_cost` da conta quando o log tem `provider_account_id` de uma
conta da própria casa; senão (conta da plataforma ou conta apagada), usa o
preço de venda de sempre. Um log apontando para uma conta própria que não
existe mais (casa excluída) não quebra a Central — o `left join` não acha
linha e o envio custa pelo preço de venda (Review Focus 4).

```sql
begin;
-- cole o conteúdo INTEGRAL de supabase/migrations/20261217100300_crm_results_own_cost.sql aqui
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20261217100300', 'crm_results_own_cost', array[$mig$<conteúdo integral do arquivo aqui>$mig$]);
commit;
```

**Esperado:** sucesso, sem erro.

**Verificação:**
```sql
select version from supabase_migrations.schema_migrations
where version = '20261217100300';
```
**Esperado:** a versão. (Sem efeito visível ainda — nenhum envio por conta
própria existe até o Passo 9.)

**Rollback:** reaplicar `20261129100000_supabase_consumo_p0.sql` (`create or
replace` devolve o corpo anterior) e:
```sql
delete from supabase_migrations.schema_migrations where version = '20261217100300';
```

**Resultado:** _______________________________________________

---

## Passo 5 — Migration `20261217100400_own_provider_disabled_reason` (requer autorização)

Antes de aplicar, confirme que não há duas contas com dono da mesma casa no
mesmo canal (não deveria haver — conta própria ainda não foi liberada para
nenhuma casa):
```sql
select owner_tenant_id, channels[1], count(*) from public.provider_accounts
where owner_tenant_id is not null group by 1, 2 having count(*) > 1;
```
**Esperado:** 0 linhas. Se vier alguma, pare e investigue antes de aplicar —
o índice único do Passo 5 falha com dados duplicados.

`provider_accounts.disabled_reason` (`'platform'` = super admin desativou,
só ele reativa; `'revoked'` = concessão revogada, o admin da casa reativa
quando a concessão volta; `NULL` = ativa ou desativada antes desta coluna) e
o índice único parcial `provider_accounts_owner_channel_key`
(`owner_tenant_id`, `channels[1]`, só onde `owner_tenant_id is not null`):
no máximo uma conta própria por casa e canal.

```sql
begin;
-- cole o conteúdo INTEGRAL de supabase/migrations/20261217100400_own_provider_disabled_reason.sql aqui
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20261217100400', 'own_provider_disabled_reason', array[$mig$<conteúdo integral do arquivo aqui>$mig$]);
commit;
```

**Esperado:** sucesso, sem erro.

**Verificação:**
```sql
select version from supabase_migrations.schema_migrations
where version = '20261217100400';

select indexname from pg_indexes
where schemaname = 'public' and indexname = 'provider_accounts_owner_channel_key';

select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'provider_accounts'
  and column_name = 'disabled_reason';
```
**Esperado:** a versão, o índice e a coluna.

**Rollback:**
```sql
begin;
drop index if exists public.provider_accounts_owner_channel_key;
alter table public.provider_accounts drop column if exists disabled_reason;
delete from supabase_migrations.schema_migrations where version = '20261217100400';
commit;
notify pgrst, 'reload schema';
```

**Resultado:** _______________________________________________

---

## Passo 6 — Build local, merge e deploy do código (requer autorização)

**Antes de mergear**, confirme o build local e anote o SHA do `main` atual
(usado no rollback de código):

```bash
npm run build
npm run test
npm run typecheck
npm run lint
```
**Esperado:** build Nitro conclui sem erro; `npm run test` sem `failed`
(exceto a falha pré-existente conhecida `scripts/demo/seed-demo-finance.db.test.ts`,
se ainda existir); `typecheck`/`lint` sem erro. Se algo além disso falhar,
pare — não mergeie nem faça deploy.

```bash
git rev-parse main
```
**SHA do `main` antes do merge:** _______________________________________

Na VPS, a partir do diretório do checkout (`docs/docker-deployment.md`),
**antes de puxar o merge**, anote o SHA que está de fato no ar:
```bash
git rev-parse HEAD
```
**SHA no ar na VPS antes do deploy:** _______________________________________

Depois do merge de `feat/conta-propria-provedor` no `main`:
```bash
git fetch
git checkout main
git pull --ff-only
git rev-parse HEAD
docker compose up -d --build --force-recreate crm
docker compose ps
docker compose logs --since=5m crm
```
**Esperado:** o `rev-parse HEAD` final bate com o SHA do `main` recém
mergeado; container `crm` `healthy`; sem erro de `column ... does not exist`
nem `function ... does not exist` relacionado a `provider_accounts`,
`tenant_own_provider_grants`, `wallet_reserve` ou `billing_channel_fees` (se
aparecer, uma das 5 migrations não terminou ou o `notify pgrst, 'reload
schema';` não propagou).

**Smoke check manual:** logar como super admin, abrir Admin → Integrações →
aba "Provedor por casa" da 99Bet — deve carregar sem erro 500, SMS ainda sem
"Permitir conta própria" ligado.

**Resultado:** _______________________________________________

---

## Passo 7 — Super admin libera SMS para a 99Bet (requer autorização)

Logado como super admin: **Admin → Integrações → Provedor por casa → 99Bet →
SMS → "Permitir conta própria"**. O diálogo de confirmação
("Permitir conta própria de SMS para 99Bet?") pede a **taxa mensal** cobrada
da casa por isso (centavos, pode ser 0) — confirmar o valor com o usuário
antes de salvar; nada muda no envio até a casa cadastrar e ativar a conta
dela (Passo 8).

**Verificação:**
```sql
select tenant_id, channel, allowed, monthly_fee_cents, granted_at, granted_by
from public.tenant_own_provider_grants
where tenant_id = 'b5c4fec6-3adf-412d-868e-0bc18ad1b7c6' and channel = 'sms';
```
**Esperado:** 1 linha, `allowed = true`, `monthly_fee_cents` = valor
combinado, `granted_at` preenchido.

```sql
select tenant_id, channel, allowed, monthly_fee_cents
from public.tenant_audit_logs
where tenant_id = 'b5c4fec6-3adf-412d-868e-0bc18ad1b7c6'
order by created_at desc limit 3;
```
(ajustar colunas ao schema real de `tenant_audit_logs` — confirmar que a
liberação ficou registrada, sem credencial nenhuma.) Confirmar também em
`admin_audit_logs` (ação do super admin).

**Resultado:** _______________________________________________

---

## Passo 8 — Admin da 99Bet cadastra e ativa a conta (requer autorização; feito pela própria casa)

A partir daqui, quem executa é o **admin da 99Bet** (linha `admin` em
`user_roles` com `tenant_id` da 99Bet — nunca `is_tenant_admin`, que também é
`true` para super admin). O super admin não participa — não cadastra, não
edita, não testa credencial de conta com dono (global constraint); só pode
desativar.

1. **99Bet → Integrações → Canais → "Usar minha conta"** (aba SMS, aparece
   só porque o Passo 7 liberou o canal).
2. Provedor: Short Brasil. Credenciais (shortcode + token, ou usuário/chave —
   o que a Short Brasil emitiu para a conta separada da 99Bet). Campo só de
   escrita; nada volta do servidor, nem mascarado.
3. Custo por SMS (R$ por segmento) — usado depois na Central de resultados.
4. **Copiar a URL do webhook** (com o token **próprio dessa conta**, gerado
   pelo servidor) e colar no painel Short Brasil da 99Bet — "sem isso você
   não verá entregas". O formato é
   `https://betleads.io/api/public/sms-webhook/pa_<...>` — o token vai **no
   caminho**, não em `?token=`: com `?token=` a Short Brasil manda só
   `{"lote":[{"token":...}]}`, sem id nem status (origin/main `40e5ba5`), e
   nenhuma entrega seria marcada. Não acrescente `?token=` à URL.
5. **Testar** — envia 1 SMS de teste para um celular informado (não cobrado
   da carteira da 99Bet).
6. **Ativar** — exige senha (reautenticação). Os outros admins da 99Bet
   recebem e-mail avisando. A partir daqui, `tenant_channel_providers` liga
   SMS da 99Bet a essa conta; a cobrança por envio deixa de existir nesse
   canal (passa a valer só a taxa mensal do Passo 7, a partir da próxima
   fatura).

**Resultado:** _______________________________________________

---

## Passo 8b — Teste obrigatório no painel real da Short Brasil (antes do piloto)

O formato que a Short Brasil manda com o token **no caminho** ainda não foi
visto em produção (só o com `?token=`, que vinha sem id/status). Antes de
liberar envios reais da 99Bet:

1. Confirmar que a URL configurada no painel Short Brasil da 99Bet é
   exatamente a do Passo 8.4 (`/api/public/sms-webhook/pa_...`, sem query).
2. Enviar **1 SMS** pela conta própria (o "Testar" do Passo 8.5 ou um
   avulso para um celular da equipe) e esperar a entrega no aparelho.
3. Conferir, em leitura:
```sql
select id, provider_account_id, status, delivery_status, delivered_at,
       last_callback, created_at
from public.sms_send_logs
where tenant_id = 'b5c4fec6-3adf-412d-868e-0bc18ad1b7c6'
order by created_at desc
limit 3;

select id, created_at, method, query_string, left(body, 300) as body,
       processed, matched, unidentified
from public.sms_callback_raw
order by created_at desc
limit 10;
```
**Esperado:** o envio de teste com `delivery_status = 'delivered'` (ou
`'failed'` com motivo), `delivered_at` e `last_callback` preenchidos, e uma
linha de `sms_callback_raw` com `matched = 1` no mesmo minuto.

**Se o callback chegar sem id/status (`unidentified > 0`, `matched = 0`) ou
não chegar:** a Short Brasil também está descartando o token do caminho.
**Pare e pergunte ao usuário** — não libere o piloto. Plano B (decisão do
usuário, não implementado): aceitar callbacks sem token também para envios
de conta própria (hoje o escopo sem token nunca toca envio de conta com
dono), o que deixa qualquer um que conheça um id de mensagem da 99Bet marcar
o status dela.

**Resultado:** _______________________________________________

---

## Passo 9 — Verificação do primeiro envio e do primeiro callback (leitura)

Depois que a 99Bet mandar o primeiro SMS de verdade pela conta própria
(campanha, jornada, bulk ou avulso):

**Envio gravado com a conta certa:**
```sql
select id, provider_account_id, status, created_at
from public.sms_send_logs
where tenant_id = 'b5c4fec6-3adf-412d-868e-0bc18ad1b7c6'
order by created_at desc
limit 5;
```
**Esperado:** `provider_account_id` = id da conta própria da 99Bet (não null,
não a conta padrão Short Brasil da plataforma).

**Reserva gratuita no ledger:**
```sql
select id, amount, provider_unit_cost, metadata->>'provider_account_id' as acc,
       metadata->>'own_account' as own_account, created_at
from public.wallet_ledger
where tenant_id = 'b5c4fec6-3adf-412d-868e-0bc18ad1b7c6'
order by created_at desc
limit 5;
```
**Esperado:** `amount = 0`, `provider_unit_cost = 0`,
`metadata->>'own_account' = 'true'`, `metadata->>'provider_account_id'` =
mesmo id da conta própria.

**Entregas sendo marcadas (o que importa):**
```sql
select delivery_status, count(*), max(delivered_at) as ultima_entrega
from public.sms_send_logs
where tenant_id = 'b5c4fec6-3adf-412d-868e-0bc18ad1b7c6'
  and provider_account_id = '<id da conta própria da 99Bet>'
  and created_at > now() - interval '1 day'
group by 1 order by 2 desc;
```
**Esperado:** a maior parte em `delivered` (e algum `failed`), não tudo
parado em `sent` — `sent` sem mudar depois de alguns minutos é callback não
aplicado.

**Primeiro callback aceito:**
```sql
select id, label, owner_tenant_id, last_callback_at
from public.provider_accounts
where owner_tenant_id = 'b5c4fec6-3adf-412d-868e-0bc18ad1b7c6';
```
**Esperado:** `last_callback_at` preenchido, posterior ao envio de teste ou
ao primeiro envio real. Ele só é gravado quando um callback com o token da
conta **atualizou** um envio dela (um `lote` vazio ou sem id não conta), mas
sozinho não basta — a verificação de `delivery_status` acima é a que vale.

**Taxa na próxima fatura:**
```sql
select id, status, due_date, amount_cents, base_amount_cents, channel_fees_cents, channel_fees
from public.billing_invoices
where tenant_id = 'b5c4fec6-3adf-412d-868e-0bc18ad1b7c6'
order by created_at desc
limit 3;
```
**Esperado:** a próxima fatura emitida depois da ativação (Passo 8) com
`channel_fees_cents > 0` e `channel_fees` contendo `{"sms": <valor do Passo
7>}`; a fatura que já estava aberta no momento da liberação **não** muda
(taxa não é retroativa, por constraint).

**Se vier diferente:** `provider_account_id` nulo no log indica que o
resolver caiu para a conta padrão — confira `tenant_channel_providers` da
99Bet/sms; `last_callback_at` nunca preenchido / tudo em `sent` indica token
errado no painel Short Brasil da 99Bet, URL copiada errada no Passo 8 ou a
Short Brasil descartando o token do caminho (Plano B do Passo 8b — pare e
pergunte ao usuário).

**Resultado:** _______________________________________________

---

## Passo 10 — O que a 99Bet precisa saber (comunicar antes do Passo 8)

- **Sem fallback automático.** Se a conta própria da 99Bet falhar (sem
  saldo, credencial recusada, timeout), o SMS da 99Bet **pausa** — não volta
  a sair pela rota da BetLeads em nenhuma hipótese. Só a 99Bet é afetada;
  outras casas continuam normais.
- A equipe da 99Bet (admin/gestor/expert) vê um aviso "Ciente" quando isso
  acontecer, igual ao padrão já existente de canal indisponível.
- Enquanto a conta própria estiver pausada, jornadas da 99Bet **esperam** o
  passo de SMS (não pulam, não cancelam) até alguém decidir (voltar para a
  conta própria corrigida, ou super admin mover de volta para a rota
  BetLeads).
- "Voltar para a rota da BetLeads" é reversível pela própria casa a qualquer
  momento (botão na aba Canais) — a cobrança por envio volta na hora; a taxa
  mensal sai da próxima fatura.

**Resultado:** _______________________________________________

---

## Passo 11 — Plano de rollback

### Revogar a conta própria sem reverter migrations

Super admin: Admin → Integrações → Provedor por casa → 99Bet → SMS →
desligar "Permitir conta própria". Efeito: `tenant_own_provider_grants.allowed
= false`; o canal SMS da 99Bet pausa. Quem vê o quê, e quem decide, são
telas diferentes:

- **Quem decide "Voltar para a padrão" ou "Manter pausado": o super admin**,
  na mesma tela (Admin → Integrações → Provedor por casa), onde a linha da
  99Bet/SMS passa a mostrar "Pausado: aguardando decisão"
  (`provider-accounts-panel.tsx`). "Voltar para a padrão" remove a ligação
  em `tenant_channel_providers` e a cobrança por envio volta; "Manter
  pausado" só reconhece a decisão e deixa o canal pausado até o super admin
  mudar de ideia.
- **O que a 99Bet vê:** na aba Canais (Integrações da casa), o card do canal
  mostra "Conta própria revogada pela BetLeads — aguardando decisão."
  (`own-provider-tab.tsx`, `OwnProviderChannelCard`) — a casa **não** vê nem
  escolhe entre "voltar para a padrão" e "manter pausado" (isso é decisão do
  super admin, não da casa). O único botão que a casa pode ver ali é "Voltar
  para a rota da BetLeads", e só aparece se `usingOwnAccount` ainda estiver
  true (a casa desliga a própria conta por conta própria, independente da
  decisão do super admin sobre a concessão).

A conta e as credenciais da 99Bet continuam no banco (cifradas), só
suspensas — nenhum dado é perdido.

Alternativa mais direta: desativar a conta (não a concessão) pela mesma tela
— o super admin pode desativar (`disabled_reason = 'platform'`), mas não
editar credenciais nem reativar em nome da casa sem o admin dela pedir.

### Reverter o código

Antes de reverter, confirme que nenhuma fatura ainda a emitir depende das
funções novas (o `amount_cents` de faturas já emitidas não muda ao reverter
código — só muda SQL, que fica). Reverter para o SHA anotado no Passo 6:
```bash
git checkout <SHA anotado no Passo 6>
docker compose up -d --build --force-recreate crm
docker compose ps
docker compose logs --since=5m crm
```
Com o código revertido, a 99Bet (se já tiver ativado a conta própria) passa a
ter `tenant_channel_providers` apontando para uma conta que o código antigo
não sabe tratar como "própria" — **confirme com o usuário antes**: o
comportamento mais seguro é revogar a concessão (acima) antes de reverter o
código, não depois.

### Migrations

Reverter na ordem inversa (100400 → 100000), usando os blocos de rollback
dos Passos 5, 4, 3, 2 e 1 — só depois do código revertido, e só se:
- nenhuma fatura tiver `channel_fees_cents > 0` (Passo 3);
- nenhum `wallet_ledger` tiver `metadata->>'own_account' = 'true'` que
  precise continuar legível pela função antiga (Passo 2) — esses registros
  continuam existindo como dados, só a função de gravação futura muda;
- nenhuma conta com dono estiver em uso (Passo 1, 5).

Nunca apague `provider_accounts`/`tenant_own_provider_grants` com dados reais
de uma casa — são registro de auditoria e billing. Qualquer correção é via
ação do super admin (desativar/revogar), nunca `delete`.

**Resultado:** _______________________________________________
