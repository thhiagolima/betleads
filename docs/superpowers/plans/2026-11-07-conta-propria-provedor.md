# Conta própria de provedor por casa — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O super admin libera, por casa x canal, uma conta própria de provedor que o admin da casa cadastra; envios por ela não debitam a carteira, a casa paga uma taxa mensal na fatura e a Central usa o custo informado pela casa.

**Architecture:** `provider_accounts` ganha dono (`owner_tenant_id`). Uma concessão por casa x canal (`tenant_own_provider_grants`) controla quem pode ter conta própria e a taxa. O resolver de contas, `wallet_reserve`, a emissão de fatura e `refresh_crm_results_day` passam a reconhecer conta com dono. Callbacks ganham token por conta. Funções de servidor da casa ficam separadas das do super admin.

**Tech Stack:** TanStack Start (createServerFn), Supabase/Postgres (migrations SQL, RLS só service_role), Vitest + PGlite (`*.db.test.ts` via `scripts/demo/test-support/migrated-pglite.mjs`), React + shadcn.

**Spec:** `docs/superpowers/specs/2026-11-07-conta-propria-provedor-design.md`

## Global Constraints

- Canais com conta própria: `sms`, `email`, `voice`. Web push fora. Provedores: `short_brasil` (sms) e `infobip` (sms, email, voice). Nada de provedor genérico.
- Credenciais só de escrita para todos, inclusive super admin. Nenhuma resposta de servidor carrega credencial nem dica mascarada de credencial de conta com dono.
- Super admin nunca cadastra, edita ou testa credenciais de conta com dono; pode desativar a conta.
- Admin da casa = linha em `user_roles` com `tenant_id` da casa e `role = 'admin'`. **Não** usar `is_tenant_admin` (é true para super admin).
- Sem fallback automático de conta da casa para a rota da BetLeads, em nenhum caminho.
- Taxa mensal em centavos, `>= 0`; entra na fatura só se na emissão a concessão estiver ativa **e** a conta própria estiver ativa e ligada ao canal. Congelada na fatura. Desconto do plano não incide sobre ela.
- Envio por conta com dono: reserva com valor 0, sem franquia, `provider_unit_cost` 0, `metadata.provider_account_id` + `metadata.own_account = true`.
- Novas tabelas: RLS ligada sem políticas; `revoke all ... from public, anon, authenticated`; grant só a `service_role`.
- Migrations novas numeradas a partir de `20261217100000` e aplicadas **antes** do app. Cada uma com cabeçalho no padrão das existentes (O QUE FAZ / COMPATIBILIDADE / ROLLBACK).
- Toda mudança de concessão, conta com dono, ativação/desativação vai para `tenant_audit_logs` (sem credenciais). Ações do super admin continuam também em `admin_audit_logs`.
- Texto de UI e mensagens de erro em pt-BR.
- Antes de merge: `npm run test`, `npm run typecheck`, `npm run lint`, `npm run build` (o build pega vazamento de `*.server` para o cliente).
- Atualizar o tutorial do CRM (`src/lib/help/` / anchors do tour) em toda tela nova ou alterada.

## Review Focus

1. **A casa ativa a conta própria no meio de uma campanha/jornada.** A cobrança segue a conta usada de fato no envio: nenhum SMS sai pela rota BetLeads com reserva zerada, nem pela conta da casa com reserva cobrada. Teste na Task 6.
2. **Super admin "entra como a casa" e chama as funções da casa.** Recusado (não é linha `admin` em `user_roles` daquela casa). Teste na Task 10.
3. **Callback cruzado.** Token global aplicado a mensagem de conta com dono é ignorado; token da conta A aplicado a mensagem da conta B ou da plataforma é ignorado. Teste na Task 8.
4. **Conta com dono excluída (casa excluída) com logs antigos apontando para ela.** A Central não quebra; esses envios custam 0. Teste na Task 4.
5. **Expert manda campanha pela conta própria da casa.** Reserva 0; o teto do expert não é consumido. Teste na Task 2.

---

### Task 1: Schema de conta com dono e concessões

**Files:**
- Create: `supabase/migrations/20261217100000_own_provider_accounts.sql`
- Test: `src/lib/own-provider-schema.db.test.ts`

**Interfaces:**
- Produces (SQL):
  - `provider_accounts.owner_tenant_id uuid null references tenants(id) on delete cascade`
  - `provider_accounts.own_unit_cost numeric(12,4) null check (own_unit_cost >= 0)`
  - `provider_accounts.callback_token_encrypted text null`
  - `provider_accounts.last_callback_at timestamptz null`
  - Tabela `tenant_own_provider_grants(tenant_id uuid fk tenants on delete cascade, channel text check in ('sms','email','voice'), allowed boolean not null, monthly_fee_cents bigint not null default 0 check >= 0, granted_at timestamptz, granted_by uuid, revoked_at timestamptz, revoked_by uuid, pending_decision boolean not null default false, updated_at timestamptz not null default now(), primary key (tenant_id, channel))`. `pending_decision` = revogada e aguardando "Voltar para a padrão"/"Manter pausado".
  - Trigger `tenant_channel_providers_check_channel` passa a recusar conta com `owner_tenant_id` diferente de `NEW.tenant_id`.
  - Trigger `platform_channel_defaults_check` passa a recusar conta com `owner_tenant_id is not null`.

- [ ] **Step 1: Write the failing test** (`own-provider-schema.db.test.ts`, mesmo setup PGlite de `src/lib/tenant-channels.db.test.ts`, duas casas A e B)
  - `it("liga conta com dono só à própria casa")`: inserir conta short_brasil `owner_tenant_id = A`, `credentials_source 'db'`, `credentials_encrypted 'x'`; insert em `tenant_channel_providers (A,'sms',conta)` passa; `(B,'sms',conta)` rejeita com mensagem contendo `não pertence`.
  - `it("conta com dono nunca é padrão da plataforma")`: `update platform_channel_defaults set provider_account_id = conta where channel='sms'` rejeita.
  - `it("excluir a casa apaga a conta dela")`: `delete from tenants where id = A` → `select count(*) from provider_accounts where id = conta` = 0.
  - `it("concessão aceita só sms/email/voice e taxa >= 0")`: `channel 'webpush'` rejeita; `monthly_fee_cents -1` rejeita; `(A,'sms',true,0)` passa.
  - `it("tabela nova só para service_role")`: `has_table_privilege('authenticated','public.tenant_own_provider_grants','select')` = false.

- [ ] **Step 2: Run** `npx vitest run src/lib/own-provider-schema.db.test.ts` — Expected: FAIL (coluna/tabela inexistente).

- [ ] **Step 3: Write the migration.** Recriar as duas funções de trigger com o corpo atual (de `20261108100000` e `20261215100000`) mais a checagem de dono. Delete de casa: o FK `on delete cascade` de `tenant_channel_providers` já existe; garantir a ordem (a conta só some depois da linha de ligação — os dois cascatas da mesma casa resolvem).

- [ ] **Step 4: Run** o teste — Expected: PASS. Rodar também `npx vitest run src/lib/tenant-channels.db.test.ts` — PASS.

- [ ] **Step 5: Commit** `feat(providers): owner_tenant_id e concessões de conta própria`

---

### Task 2: `wallet_reserve` reconhece conta com dono

**Files:**
- Create: `supabase/migrations/20261217100100_wallet_reserve_own_account.sql`
- Test: `src/lib/billing/wallet-own-account.db.test.ts`

**Interfaces:**
- Consumes: Task 1 (`owner_tenant_id`).
- Produces:
  - `wallet_reserve(_tenant uuid, _item text, _units integer, _reference_type text, _reference_id text, _idempotency_key text, _provider_account_id uuid default null) returns jsonb` — resultado ganha `own_account boolean`.
  - `expert_wallet_reserve(..., _provider_account_id uuid default null)` repassa para `wallet_reserve`.

- [ ] **Step 1: Write the failing test**
  - `it("conta da própria casa: valor 0, sem franquia, custo 0, metadata")`: casa paga com saldo 0, conta com dono da casa; `wallet_reserve(casa,'sms',3,'sms_send',ref,key,conta)` não lança; `result->>'amount' = '0'`, `result->>'own_account' = 'true'`; linha do ledger com `provider_unit_cost = 0`, `free_units = 0`, `metadata->>'provider_account_id' = conta`, `metadata->>'own_account' = 'true'`.
  - `it("conta com dono de outra casa: cobra normal")`: mesma chamada com conta da casa B e saldo 0 → lança `insufficient_balance`.
  - `it("sem conta: comportamento de hoje")`: chamada sem o 7º argumento com saldo 0 → `insufficient_balance`; com saldo → `amount = -(3 * unit_price)`.
  - `it("e-mail por conta própria não gasta a franquia")`: `item 'email'` com conta da casa → `tenant_monthly_usage.free_units_used` inalterado.
  - `it("expert pela conta própria não consome o teto")` (Review Focus 5): expert com teto R$ 1 já consumido; `expert_wallet_reserve(..., conta)` passa com valor 0.

- [ ] **Step 2: Run** `npx vitest run src/lib/billing/wallet-own-account.db.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write the migration.** `drop function` das assinaturas antigas (6 e 7 argumentos) e recriar com o parâmetro novo — `create or replace` com parâmetro a mais criaria uma sobrecarga ambígua. Corpo = versão atual de `20261210100100_webpush_billing_item.sql` e de `20261126100000_expert_campaigns.sql` com: `v_own := exists(select 1 from provider_accounts where id = _provider_account_id and owner_tenant_id = _tenant)`; se `v_own`: `v_free := 0`, `v_amount := 0`, `v_provider_cost := 0`, metadata com as duas chaves e **sem** incrementar `tenant_monthly_usage.free_units_used` nem `billed_amount` (unidades sim). Refazer os `grant/revoke execute` das duas funções igual aos atuais.

- [ ] **Step 4: Run** o teste novo e `npx vitest run src/lib/billing` — Expected: PASS.

- [ ] **Step 5: Commit** `feat(billing): reserva zerada para envio por conta própria da casa`

---

### Task 3: Taxa mensal na fatura

**Files:**
- Create: `supabase/migrations/20261217100200_billing_channel_fees.sql`
- Test: `src/lib/billing/billing-channel-fees.db.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `billing_invoices.channel_fees_cents bigint not null default 0 check >= 0`, `billing_invoices.channel_fees jsonb not null default '{}'` (ex. `{"sms": 50000}`).
  - `billing_channel_fees(_tenant uuid) returns jsonb` → `{"total_cents": n, "channels": {"sms": n, ...}}`: soma `monthly_fee_cents > 0` das concessões `allowed` cuja conta ligada em `tenant_channel_providers` tem `owner_tenant_id = _tenant` e `status = 'active'`.
  - `billing_issue_invoice` grava as duas colunas e `amount_cents = base - discount + channel_fees_cents`.
  - `billing_reprice_open_invoice` mantém `channel_fees_cents` da fatura e soma ao final.

- [ ] **Step 1: Write the failing test**
  - `it("taxa entra só com concessão e conta própria ativas")`: concessão `sms` R$ 500 + conta ativa ligada → fatura emitida com `channel_fees_cents = 50000`, `amount_cents = 450000`, `channel_fees = {"sms":50000}`.
  - `it("concessão sem conta ativa não cobra")`: conta `disabled` ou sem linha em `tenant_channel_providers` → `channel_fees_cents = 0`.
  - `it("taxa zero não aparece")`: `monthly_fee_cents = 0` → `channel_fees = {}`.
  - `it("desconto não incide na taxa")`: desconto contínuo 100% → `amount_cents = 50000` e a fatura **não** é liquidada como `full_discount`.
  - `it("repreço mantém a taxa congelada")`: emitir; mudar `monthly_fee_cents` para 99900; `billing_reprice_open_invoice` → `channel_fees_cents` continua 50000.

- [ ] **Step 2: Run** `npx vitest run src/lib/billing/billing-channel-fees.db.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write the migration** recriando `billing_issue_invoice` e `billing_reprice_open_invoice` a partir do corpo atual (`20261023100000_billing_invoices.sql:394` e `:529`); `billing_monthly_amount` não muda. A regra do mínimo do Pix (1..9999) e a liquidação automática de valor 0 passam a olhar o valor final com a taxa. `billing_channel_fees`: `security definer`, só `service_role`/super admin.

- [ ] **Step 4: Run** o teste novo e `npx vitest run src/lib/billing` — PASS.

- [ ] **Step 5: Commit** `feat(billing): taxa mensal de conta própria na fatura`

---

### Task 4: Custo informado na Central

**Files:**
- Create: `supabase/migrations/20261217100300_crm_results_own_cost.sql`
- Test: `src/lib/crm-results-own-cost.db.test.ts`

**Interfaces:**
- Consumes: Task 1 (`own_unit_cost`).
- Produces: `refresh_crm_results_day(_tenant uuid, _day date)` com a mesma assinatura.

- [ ] **Step 1: Write the failing test**
  - `it("SMS da conta própria usa o custo informado")`: preço de venda 0,08; dois logs `sent` no dia, `billed_units` 2 cada: um com `provider_account_id` = conta com dono (`own_unit_cost 0.05`), outro sem → `cost` somado da fonte = `2*0.05 + 2*0.08 = 0.26`.
  - `it("conta própria sem custo informado custa 0")`: `own_unit_cost null` → 0 para aquele log.
  - `it("conta inexistente no log não quebra")` (Review Focus 4): log com `provider_account_id` aleatório (sem linha) → custo pelo preço de venda (conta da plataforma desconhecida = comportamento de hoje), sem erro.

- [ ] **Step 2: Run** `npx vitest run src/lib/crm-results-own-cost.db.test.ts` — FAIL.

- [ ] **Step 3: Write the migration** copiando o corpo atual de `20261129100000_supabase_consumo_p0.sql:33`. Mudar só: o CTE `sends` ganha `unit_cost` = `case when pa.owner_tenant_id = _tenant then coalesce(pa.own_unit_cost, 0) else v_price end` (left join `provider_accounts pa on pa.id = s.provider_account_id`); em `sends_agg`, `cost` = `coalesce(sum(coalesce(s.billed_units,1) * s.unit_cost) filter (where s.is_sent), 0)`.

- [ ] **Step 4: Run** o teste e os testes db existentes da Central (`npx vitest run src/lib -t crm_results`) — PASS.

- [ ] **Step 5: Commit** `feat(central): custo do SMS por conta própria`

---

### Task 5: Resolver de contas conhece o dono

**Files:**
- Modify: `src/lib/provider-accounts.server.ts` (AccountRow ~:172, loadSnapshot ~:216, buildDbAccount ~:280, accountFromRow ~:355)
- Test: `src/lib/provider-accounts.server.test.ts`

**Interfaces:**
- Produces:
  - `ShortBrasilAccount`, `InfobipAccount` e `OneSignalAccount` ganham `ownerTenantId: string | null`.
  - `isOwnedAccount(account: { ownerTenantId: string | null }): boolean`.
  - `OWNED_SHORT_BRASIL_URLS`: conta com dono da Short Brasil sempre usa `DEFAULT_SHORT_BRASIL_SINGLE_URL`, `DEFAULT_SHORT_BRASIL_BULK_URL`, `DEFAULT_SHORTCODE_MESSAGES_URL`, ignorando `config`.

- [ ] **Step 1: Write the failing tests**
  - `it("conta da casa vem com ownerTenantId")`: snapshot com conta `owner_tenant_id = T` ligada a T → `(await resolveSmsAccount(T)).ownerTenantId === T`.
  - `it("conta com dono da Short Brasil ignora URLs do config")`: `config.single_url = "http://evil"` → `singleUrl` é a padrão.
  - `it("conta da plataforma tem ownerTenantId null")`.

- [ ] **Step 2: Run** `npx vitest run src/lib/provider-accounts.server.test.ts` — FAIL.
- [ ] **Step 3: Implement** — selecionar `owner_tenant_id` no snapshot; contas env → `null`.
- [ ] **Step 4: Run** o teste e `npx vitest run src/lib/provider-accounts` — PASS.
- [ ] **Step 5: Commit** `feat(providers): resolver expõe o dono da conta`

---

### Task 6: Envios passam a conta para a reserva

**Files:**
- Modify: `src/lib/billing/wallet.server.ts` (`ReserveUsageArgs` :25, `reserveUsage` :78, `ReserveForDeliveryArgs`, `reserveForDelivery` :287)
- Modify: `src/lib/sms.functions.ts` (`reserveSmsCreditForDelivery` :775, `callSmsProvider` :265, `sendSmsInternal` reserve ~:981)
- Modify: `src/lib/sms-bulk.server.ts` (:682 `accountOf`, :903 reserve)
- Modify: `src/lib/email-send.server.ts` (:23-26, :308), `src/lib/infobip-email.server.ts` (:65)
- Modify: `src/lib/infobip-voice.server.ts` (:173 conta, :219 reserve)
- Test: `src/lib/sms-own-account-billing.test.ts`, mais casos em `src/lib/billing/wallet.server.test.ts`

**Interfaces:**
- Consumes: Task 2 (`_provider_account_id`), Task 5 (`ownerTenantId`).
- Produces:
  - `ReserveUsageArgs.providerAccountId?: string | null` → RPC `_provider_account_id` (wallet e expert).
  - `ReserveUsageResult` (ok) ganha `ownAccount: boolean`.
  - `reserveSmsCreditForDelivery(tenantId, deliveryKey, segments, expertId?, providerAccountId?)`.
  - `callSmsProvider(..., account?: SmsAccount)`: com `account`, não resolve de novo.
  - E-mail: o `sendInfobipEmail` recebe a conta resolvida antes da reserva (`input.account?: InfobipAccount`).

- [ ] **Step 1: Write the failing tests** (mocks no padrão de `src/lib/sms-dispatcher.provider-accounts.test.ts`)
  - `it("reserveUsage repassa _provider_account_id")`: RPC chamada com `_provider_account_id: "acc"`.
  - `it("sendSmsInternal reserva e envia com a mesma conta")` (Review Focus 1): o resolver devolve conta A na primeira chamada e B na segunda → a reserva recebe `A.id`, o envio usa A e o resolver é chamado **uma** vez por envio.
  - `it("conta da casa indisponível: nada reservado, nada enviado")`: o resolver lança `ProviderAccountUnavailableError` → `wallet_reserve` não chamado, log `misconfigured`.
  - `it("bulk agrupa por conta e reserva com a conta do grupo")`.
  - `it("voz e e-mail reservam com a conta resolvida")`.

- [ ] **Step 2: Run** `npx vitest run src/lib/sms-own-account-billing.test.ts src/lib/billing/wallet.server.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Em `sendSmsInternal`, chamar `smsAccountFor(billingTenantId)` antes da reserva; falha → mesmo log/resultado `misconfigured` de hoje, sem reservar. Passar `account` para `callSmsProvider`. Nenhum caminho reserva sem a conta que vai enviar.
- [ ] **Step 4: Run** a suíte de SMS/e-mail/voz: `npx vitest run src/lib/sms src/lib/email src/lib/infobip src/lib/journeys src/lib/billing` — PASS.
- [ ] **Step 5: Commit** `feat(billing): envio informa a conta usada à reserva`

---

### Task 7: URLs de conta seguras (SSRF)

**Files:**
- Create: `src/lib/provider-url-policy.server.ts`
- Modify: `src/lib/provider-accounts-admin.server.ts` (`assertHttpsUrl` :395 sai; save :463-473; teste :602-696)
- Test: `src/lib/provider-url-policy.server.test.ts`

**Interfaces:**
- Produces:
  - `assertInfobipBaseUrl(value: string): string` — aceita só `https://<sub>.api.infobip.com` ou `https://api.infobip.com`, sem path/porta/credencial; devolve normalizado sem barra final; senão lança `"URL base da Infobip inválida. Use o endereço https://xxxx.api.infobip.com do seu portal."`.
  - `assertShortBrasilUrl(field: "shortcode_url" | "single_url" | "bulk_url", value: string): string` — host em `{ "api.shortcode.com.br", "lp01-short.painelsms.com" }`; `https` exigido para `api.shortcode.com.br`.
  - `providerFetch(url: string, init: RequestInit & { timeoutMs: number }): Promise<Response>` — `redirect: "manual"` (3xx = falha), timeout obrigatório.
  - `PROVIDER_TEST_FAILURE_MESSAGE = "Não foi possível conectar com essa conta. Confira as credenciais e o endereço."`

- [ ] **Step 1: Write the failing tests**: aceita `https://abc12.api.infobip.com`; recusa `http://abc.api.infobip.com`, `https://abc.api.infobip.com.evil.io`, `https://169.254.169.254`, `https://user:pw@abc.api.infobip.com`, `https://abc.api.infobip.com:8443`; Short Brasil recusa host fora da lista; `providerFetch` com resposta 302 lança.
- [ ] **Step 2: Run** `npx vitest run src/lib/provider-url-policy.server.test.ts` — FAIL.
- [ ] **Step 3: Implement** e trocar no save/teste do admin. O "Testar" passa a responder só `ok` + saldo (Infobip) ou `PROVIDER_TEST_FAILURE_MESSAGE` (detalhe só no `console.error`).
- [ ] **Step 4: Run** `npx vitest run src/lib/provider-url-policy.server.test.ts src/lib/provider-accounts-admin.server.test.ts` — PASS (ajustar as asserções antigas de mensagem).
- [ ] **Step 5: Commit** `fix(providers): allowlist de host nas URLs de conta e teste sem oráculo`

---

### Task 8: Token de callback por conta

**Files:**
- Create: `src/lib/provider-callback-tokens.server.ts`
- Modify: `src/lib/infobip-sms.server.ts` (:41-56), `src/lib/infobip-voice.server.ts` (:99-108 `callbackUrl`), `src/lib/infobip-email.server.ts` (:44)
- Modify: `src/routes/api/public/sms-webhook.ts` (`authorizeCallback` :54 e onde casa o log), `src/routes/api/public/infobip/sms/events.ts`, `src/lib/infobip-sms-callback.server.ts`, `src/routes/api/public/infobip/email/events.ts`, `src/routes/api/public/infobip/voice/events.ts`, `src/routes/api/public/infobip/voice/cml.ts`
- Test: `src/lib/provider-callback-tokens.server.test.ts`, mais casos nos testes existentes de cada rota (`-events.test.ts`, `-cml.test.ts`, `sms-webhook` test)

**Interfaces:**
- Consumes: Task 1 (`callback_token_encrypted`, `last_callback_at`), Task 5.
- Produces:
  - `ensureCallbackToken(accountId: string): Promise<string>` — gera `pa_<accountId sem hífens>_<32 bytes base64url>`, grava cifrado (secret-box) se não existir, devolve o token.
  - `callbackTokenFor(account: { id: string; ownerTenantId: string | null }): Promise<string | null>` — conta com dono → token da conta; plataforma → `null` (quem chama usa o token global de hoje).
  - `type CallbackScope = { kind: "platform" } | { kind: "account"; accountId: string; tenantId: string }`.
  - `resolveCallbackScope(token: string | null, globalToken: string | undefined): Promise<CallbackScope | null>` — prefixo `pa_` → busca a conta pelo id, decifra e compara (timing-safe), exige `owner_tenant_id` não nulo; senão compara com o global.
  - `scopeAllowsRow(scope: CallbackScope, rowProviderAccountId: string | null, ownedAccountIds: ReadonlySet<string>): boolean` — `account` só aceita `row = scope.accountId`; `platform` recusa linha cujo id está em `ownedAccountIds`.
  - `touchCallbackReceived(accountId: string): Promise<void>` — `last_callback_at = now()`, no máximo 1 escrita/min por conta (memória do processo).

- [ ] **Step 1: Write the failing tests**
  - Token: `ensureCallbackToken` é idempotente; `resolveCallbackScope` aceita o token certo, recusa um token `pa_` com segredo errado e recusa o token de conta sem dono.
  - Rotas (Review Focus 3): para cada rota, (a) token global + mensagem de conta com dono → 200 sem aplicar; (b) token da conta A + mensagem da conta B → 200 sem aplicar; (c) token da conta A + mensagem da A → aplica e chama `touchCallbackReceived`; (d) comportamento atual com token global e conta da plataforma intacto.
  - `notifyUrl` de envio por conta com dono contém `token=pa_` e nunca o token global.
- [ ] **Step 2: Run** `npx vitest run src/lib/provider-callback-tokens.server.test.ts src/routes/api/public` — FAIL.
- [ ] **Step 3: Implement.** Cada rota resolve o escopo uma vez; o filtro por linha usa o `provider_account_id` do log (`sms_send_logs`, `email_send_logs`, `call_history`).
- [ ] **Step 4: Run** `npx vitest run src/routes/api/public src/lib/infobip src/lib/provider-callback-tokens.server.test.ts` — PASS.
- [ ] **Step 5: Commit** `fix(callbacks): token por conta e amarração ao provider_account_id`

---

### Task 9: Isolamento de conta com dono

**Files:**
- Modify: `src/lib/infobip-sms.server.ts` (`REQUEST_TIMEOUT_MS` :149), adaptador Short Brasil em `src/lib/sms.functions.ts`, `src/lib/infobip-email.server.ts` (:116), `src/lib/infobip-voice.server.ts` (:289)
- Modify: `src/lib/sms-account-gates.server.ts`
- Test: `src/lib/sms-owned-isolation.test.ts`

**Interfaces:**
- Produces:
  - `OWNED_ACCOUNT_REQUEST_TIMEOUT_MS = 8_000` (as contas da plataforma ficam como hoje).
  - `OWNED_ACCOUNT_MAX_INFLIGHT = 4` por conta com dono, por instância (semáforo por `account.id`); o que passar do limite volta para a fila (recuo do item, não falha nem gasta tentativa).
  - Timeout de conta com dono conta como falha da conta para o breaker `sms:<id>`.

- [ ] **Step 1: Write the failing tests**: (a) conta com dono que nunca responde → envio aborta em ≤ 8 s e registra falha da conta; (b) com 10 itens da conta com dono pendurados e 1 item de outra casa no mesmo tick, o da outra casa termina sem esperar os pendurados (fake timers); (c) breaker `sms:<id>` abre depois do limiar de timeouts e o `sms` global continua fechado.
- [ ] **Step 2: Run** `npx vitest run src/lib/sms-owned-isolation.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/lib/sms src/lib/sms-provider-breaker*` — PASS.
- [ ] **Step 5: Commit** `feat(providers): timeout e concorrência isolados por conta da casa`

---

### Task 10: Servidor — concessões (super admin) e conta própria (casa)

**Files:**
- Create: `src/lib/own-provider.shared.ts` (zod + labels, client-safe)
- Create: `src/lib/own-provider-admin.server.ts`, `src/lib/own-provider.server.ts`, `src/lib/own-provider.functions.ts`
- Modify: `src/lib/provider-accounts-admin.server.ts` (save :408, status :565, teste :602, setTenantChannelProvider :703, delete :886, listagem :297)
- Test: `src/lib/own-provider-admin.server.test.ts`, `src/lib/own-provider.server.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 5, 7, 8.
- Produces (super admin, `assertSuperAdmin`):
  - `adminSetOwnProviderGrantFor(ctx, { tenantId, channel: "sms"|"email"|"voice", allowed: boolean, monthlyFeeCents: number })`. `allowed false` em concessão ativa = revogar: `revoked_at/by`, `pending_decision = true`, conta com dono do canal → `status 'disabled'`, `invalidateProviderAccountsCache()`.
  - `adminResolveRevokedOwnProviderFor(ctx, { tenantId, channel, action: "use_default" | "keep_paused" })`: `use_default` apaga a linha de `tenant_channel_providers`; os dois limpam `pending_decision`.
  - `adminListOwnProviderGrantsFor(ctx) → Array<{ tenantId, channel, allowed, monthlyFeeCents, pendingDecision, account: { id, provider, label, status, lastCallbackAt, lastAcceptedSendAt } | null, active: boolean }>`.
  - Guardas novas nas funções existentes: save/teste/delete de conta com `owner_tenant_id` → `"Conta da casa: só o admin da casa altera."`; `setTenantChannelProvider` para conta com dono → recusa; a listagem marca `ownerTenantId` e não manda dica de credencial dessas contas.
- Produces (casa):
  - `requireHouseAdmin(userId: string, tenantId: string): Promise<void>` — `user_roles` com `role = 'admin'` daquela casa; senão `"Só o admin da casa pode fazer isso."`.
  - `requirePasswordReauth(email: string, password: string): Promise<void>` — `signInWithPassword` num cliente anon sem sessão persistida; falha → `"Senha incorreta."`.
  - `getOwnProviderStateFor(ctx) → Array<{ channel, monthlyFeeCents, account: OwnAccountView | null, usingOwnAccount: boolean, callbackUrl: string | null }>` só dos canais com concessão `allowed`. `OwnAccountView = { id, provider, label, status, ownUnitCost, smsFrom, voiceFrom, baseUrl, lastCallbackAt, lastAcceptedSendAt, credentialsSet: string[] }` (`credentialsSet` = nomes dos campos gravados, nunca valores).
  - `saveOwnProviderAccountFor(ctx, { channel, provider, label, config, credentials, ownUnitCost, password })` — cria ou atualiza a conta com `owner_tenant_id` da casa e `channels = [channel]`; campo em branco mantém; trocar o provedor de uma conta existente recusa; `ensureCallbackToken`.
  - `testOwnProviderAccountFor(ctx, { channel, phone? })` — mesma lógica do teste do admin (Task 7).
  - `activateOwnProviderFor(ctx, { channel, password })` — upsert em `tenant_channel_providers` e, se a conta estava `disabled` por uma revogação e a concessão voltou a `allowed`, `status = 'active'`; e-mail → `refreshTenantDomain` dos domínios da casa (fica `pending`).
  - `adminSetOwnProviderGrantFor` com `allowed true` limpa `revoked_at`, `revoked_by` e `pending_decision` (não reativa a conta sozinho; quem reativa é o admin da casa).
  - `deactivateOwnProviderFor(ctx, { channel })` — "Voltar para a rota da BetLeads": apaga a linha.
  - `removeOwnProviderAccountFor(ctx, { channel, password })` — só com a conta não ativa; apaga a conta.
  - Todas: `requireHouseAdmin` + concessão `allowed` (menos `deactivate`) + conta com `owner_tenant_id` = casa; audit em `tenant_audit_logs` (`own_provider.save|activate|deactivate|remove|grant|revoke|resolve`); save/activate/remove mandam e-mail aos outros admins da casa via `sendPlatformEmail` (assunto `"Conta de provedor alterada na sua casa"`).

- [ ] **Step 1: Write the failing tests**
  - Admin: revogar desativa a conta e marca `pending_decision`; `use_default` apaga a ligação; save/teste/delete do admin em conta com dono recusam; a listagem não tem campo de dica de credencial em conta com dono.
  - Casa (Review Focus 2): super admin sem linha `admin` em `user_roles` → recusa; gestor → recusa; canal sem concessão → recusa; senha errada → `"Senha incorreta."` e nada gravado.
  - Casa: save com campo em branco mantém o valor gravado; trocar provedor recusa; nenhuma resposta contém o valor de credencial (serializar o retorno e procurar o segredo de teste); activate grava a ligação e audita; e-mail aos outros admins sai com o próprio admin fora da lista.
- [ ] **Step 2: Run** `npx vitest run src/lib/own-provider-admin.server.test.ts src/lib/own-provider.server.test.ts src/lib/provider-accounts-admin.server.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Extrair do `adminSaveProviderAccountFor` o miolo de validação/cifragem para `buildAccountPayload(provider, channels, config, credentials, stored)` reaproveitado pelos dois lados.
- [ ] **Step 4: Run** os mesmos testes — PASS.
- [ ] **Step 5: Commit** `feat(providers): concessões do super admin e conta própria da casa`

---

### Task 11: Revogação — aviso "Ciente" e passos que esperam

**Files:**
- Modify: `src/lib/tenant-channel-notices.server.ts`, `src/lib/tenant-channel-notices.functions.ts`, `src/components/channels/channel-disabled-notice-gate.tsx`
- Modify (se o teste abaixo falhar): `src/lib/journeys.server.ts`, `src/lib/sms-account-gates.server.ts`
- Test: `src/lib/tenant-channel-notices.server.test.ts`, `src/components/channels/channel-disabled-notice-gate.test.tsx`, `src/lib/journeys.own-revoked.test.ts`

**Interfaces:**
- Consumes: Task 1 (`revoked_at`).
- Produces: `PendingChannelNotice` ganha `kind: "disabled" | "own_revoked"`; o ack de revogação grava `channel = "own:<canal>"` e `disabled_at = revoked_at`.

- [ ] **Step 1: Write the failing tests**: revogação gera aviso `own_revoked` para admin, gestor e expert da casa; depois do "Ciente" some; revogar de novo (novo `revoked_at`) volta; texto do gate: `"A conta própria de {canal} da sua casa foi desligada pela BetLeads. Os envios desse canal estão pausados até a BetLeads definir o próximo passo."`
  - `journeys.own-revoked.test.ts`: casa com conta própria SMS `disabled` por revogação (`pending_decision = true`) → o passo SMS da jornada não é consumido nem marcado `skipped`/`failed`, e a matrícula continua no mesmo passo; depois de `use_default`, o próximo tick envia pela padrão (com reserva cobrada). Campanha SMS da casa nesse estado para como `pausada` com `last_error` `"Conta própria do canal pausada pela BetLeads"`.
- [ ] **Step 2: Run** os três testes — FAIL.
- [ ] **Step 3: Implement.** Uma casa com concessão `pending_decision` no canal entra no mesmo caminho de "conta da casa bloqueada" que hoje tira a casa do claim (`SmsAccountGates`); e-mail e voz recuam o item do mesmo jeito.
- [ ] **Step 4: Run** os três testes e `npx vitest run src/lib/journeys src/lib/sms-campaign` — PASS.
- [ ] **Step 5: Commit** `feat(channels): revogação da conta própria pausa e avisa a casa`

---

### Task 12: Telas do super admin

**Files:**
- Modify: `src/components/admin/provider-accounts-panel.tsx` (`AccountsCard` :158, `TenantProvidersCard` :659)
- Modify: componentes de fatura do console (`src/components/billing/admin/billing-tenant-list.tsx`, `src/routes/tenants.tsx` `BillingHistoryCard` :857) e o Financeiro geral (`src/components/admin/general-finance/general-finance-tab.tsx`)
- Test: `src/components/admin/provider-accounts-panel.test.tsx` (criar se não existir)

**Interfaces:**
- Consumes: Task 10 (`adminListOwnProviderGrants`, `adminSetOwnProviderGrant`, `adminResolveRevokedOwnProvider`), Task 3 (`channel_fees_cents`, `channel_fees`).

- [ ] **Step 1: Write the failing tests**
  - Conta com dono aparece com selo `"Conta da casa {nome}"`, sem Editar/Testar/Excluir, só Desativar/Reativar.
  - Linha da casa por canal (sms/email/voice): chave `"Permitir conta própria"`, campo `"Taxa mensal (R$)"`, estado `Plataforma` / `Conta da casa: {label}` / `Pausado: aguardando decisão` com botões `"Voltar para a padrão"` e `"Manter pausado"`.
  - Desligar a chave abre confirmação: `"Os envios de {canal} desta casa vão pausar e a equipe da casa verá um aviso. Nada sai pela rota da BetLeads até você decidir."`
  - O seletor de conta por casa não lista conta com dono de outra casa.
- [ ] **Step 2: Run** `npx vitest run src/components/admin/provider-accounts-panel.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** Fatura e Financeiro geral: linha `"Taxa de canal próprio"` separada da base do plano quando `channel_fees_cents > 0`.
- [ ] **Step 4: Run** o teste e `npx vitest run src/components/admin src/components/billing` — PASS.
- [ ] **Step 5: Commit** `feat(admin): concessão de conta própria por casa e taxa na fatura`

---

### Task 13: Tela da casa (Integrações → Canais)

**Files:**
- Modify: `src/routes/webhooks.tsx` (tabs :59)
- Create: `src/components/integrations/own-provider-tab.tsx`, `src/components/integrations/own-provider-wizard.tsx`
- Modify: fatura da casa em `/plano-e-creditos` (linha da taxa) e tutorial (`src/lib/help/`)
- Test: `src/components/integrations/own-provider-tab.test.tsx`

**Interfaces:**
- Consumes: Task 10 (funções da casa), Task 11.

- [ ] **Step 1: Write the failing tests**
  - Aba `"Canais"` só aparece para admin da casa com pelo menos uma concessão; gestor não vê.
  - Card por canal liberado: sem conta → `"Provedor: Plataforma BetLeads"` + `"Usar minha conta"`; com conta ativa → nome do provedor, `"Último retorno recebido há {x}"` (ou `"Nenhum retorno recebido ainda — confira o webhook no painel do provedor"`), `"Voltar para a rota da BetLeads"`.
  - Assistente, nesta ordem: provedor → credenciais/remetente → `"Custo por SMS na sua conta (R$)"` (só SMS) → webhook (URL com botão copiar; Infobip: `"A URL vai automaticamente em cada envio"`) → testar → ativar com senha.
  - Confirmação de ativação lista: `"Sem troca automática: se sua conta falhar, os envios deste canal pausam."`, `"A BetLeads deixa de cobrar por envio neste canal; a taxa mensal de R$ {taxa} entra na próxima fatura."` e, no e-mail, `"Seus domínios de e-mail voltam a pendente e precisam dos novos registros DNS."`
  - Campos de credencial salvos mostram `"Salvo — preencha só para substituir"` e vêm vazios.
- [ ] **Step 2: Run** `npx vitest run src/components/integrations/own-provider-tab.test.tsx` — FAIL.
- [ ] **Step 3: Implement.** Erros de conta própria nas telas de SMS/e-mail/voz da casa trocam a mensagem genérica por `"Sua conta de {canal} recusou o envio. Confira saldo e credenciais em Integrações → Canais."`
- [ ] **Step 4: Run** o teste e `npx vitest run src/components src/routes` — PASS.
- [ ] **Step 5: Commit** `feat(integracoes): conta própria da casa por canal`

---

### Task 14: Fechamento

**Files:**
- Modify: `docs/ESCOPO_PROVEDORES_POR_CASA_2026-10-28.md` (decisões "Dono das contas", "Visibilidade" e "Webhooks sem segredo por conta" com ponteiro para o spec novo)
- Create: `docs/operacoes/RUNBOOK_CONTA_PROPRIA_99BET.md` — ordem: aplicar as 4 migrations (`20261217100000..100300`) e registrar em `schema_migrations`; deploy; super admin libera SMS da 99Bet com a taxa; admin da 99Bet cadastra a conta Short Brasil dela, configura no painel dela a URL com o token da conta, testa e ativa; conferir o primeiro envio (`sms_send_logs.provider_account_id`, ledger com `own_account`) e o primeiro retorno (`last_callback_at`).

- [ ] **Step 1:** `npm run test` — Expected: tudo verde, exceto a falha pré-existente `scripts/demo/seed-demo-finance.db.test.ts`, se ainda existir.
- [ ] **Step 2:** `npm run typecheck`, `npm run lint`, `npm run build` — sem erros.
- [ ] **Step 3: Commit** `docs: runbook da conta própria da 99Bet e escopo atualizado`
