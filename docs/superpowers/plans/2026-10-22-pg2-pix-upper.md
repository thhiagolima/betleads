# PG2 — Compra de créditos por Pix (Upper) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O admin de uma casa pagante compra créditos por Pix na página "Saldo e consumo". O saldo entra sozinho quando a Upper confirma o pagamento: pelo webhook em segundos, ou pela conciliação em até 5 minutos. Ninguém precisa creditar à mão.

**Architecture:**
- **Fluxo da compra:**
  1. Cada compra cria um `credit_topup_orders` e um `payment_charges` (`external_id = bl-top-<uuid>`).
  2. O cliente `upper-pix.server.ts` chama `POST /v1/pix/charges`.
  3. A tela mostra o QR e consulta o **nosso** banco a cada 3 s.
- **Confirmação do pagamento:**
  - O webhook assinado (`/api/public/upper/webhook`) grava o evento, faz `GET /v1/pix/charges/{externalId}` e, se a cobrança estiver `PAID` com o valor exato, chama o RPC `billing_credit_paid_charge`. Esse RPC é service_role e idempotente, e lança `purchase` no razão via `wallet_mutation`.
  - Um cron a cada 5 min (`/api/public/hooks/billing-reconcile`) faz a mesma confirmação para as cobranças pendentes.
- **Desligamento:** tudo fica atrás de `BILLING_GATEWAY_ENABLED`.

**Tech Stack:**
- TanStack Start (`createServerFn` + `requireSupabaseAuth` + zod, file routes com `server.handlers`).
- Supabase/Postgres: migrations, pg_cron + pg_net + Vault.
- Vitest + PGlite.
- React + shadcn/ui, tema escuro.

**Spec:** `docs/ESCOPO_GATEWAY_PAGAMENTO_UPPER_2026-10-21.md` (seções 2, 4, 5, 6 e a fase PG2; inclui a parte de créditos da PG5-01).

## Global Constraints

- **API da Upper:**
  - Base `UPPER_API_BASE` (padrão `https://api.uppersc.com.br/v1`).
  - Auth `Authorization: Bearer ${UPPER_API_KEY}`, com chave **só `pix_in`**.
  - JSON, datas ISO UTC.
  - Limite de 120 chamadas/min por chave; o cliente se limita a **100/min**.
- **Cobrança:** `POST /v1/pix/charges` com `{ amountCents: <inteiro>, description, externalId, expiresIn: 3600, metadata: { tenantId, kind: "credit_topup", refId } }`.
  - Resposta 201 com `id`, `status`, `amountCents` (texto), `pix.emv`, `pix.qrCodeImage`, `paymentUrl`, `expiresAt`, `paidAt`, `paidAmountCents`, `payer {name, document}`.
  - Repetir com o mesmo `externalId` devolve a cobrança existente com `idempotent: true`.
  - Consulta: `GET /v1/pix/charges/{externalId}`.
  - Cancelamento: `DELETE /v1/pix/charges/{externalId}`.
- **Status da Upper, gravados exatamente assim:** `PENDING`, `ACTIVE`, `PAID`, `EXPIRED`, `CANCELLED`, `FAILED`.
- **Erros da Upper:** `{ statusCode, message, code }`. Códigos: `INVALID_API_KEY` (401), `SCOPE_MISSING`, `FEATURE_DISABLED`, `RATE_LIMITED`, `ACCOUNT_BLOCKED` (403), `VALIDATION`, `PIX_KEY_TYPE`, `INVALID_PIX_KEY` (400), 404, 409, 422, 502. A mensagem em português da Upper vai para o log; o usuário vê só as mensagens fixas abaixo.
- **`externalId`:** `bl-top-<uuid do pedido>` (até 64 caracteres, `[A-Za-z0-9._:-]`).
- **`description`** (até 140 caracteres, aparece para quem paga, sem CNPJ nem e-mail): `"<Nome da casa> - Créditos BetLeads R$ 1.000,00"`. Se passar de 140, corte o nome da casa.
- **Webhook:**
  - Header `X-Upper-Signature: t=<unix>,v1=<hex>`, com `v1 = HMAC-SHA256(UPPER_WEBHOOK_SECRET, t + "." + corpoBruto)`.
  - Comparação em tempo constante.
  - Recusar com **400** se `|agora − t| > 300 s` ou se a assinatura não bater.
  - Deduplicar pelo `id` do evento (ou `X-Upper-Delivery`).
  - Responder 200 depois de gravar o evento.
  - Eventos tratados: `charge.paid`, `charge.expired`, `charge.cancelled`, `ping`. Os eventos `payment.*` são gravados e ignorados.
- **Crédito, sempre confirmado:** o webhook é só um aviso. O saldo só entra depois de um `GET` que devolva `status = 'PAID'` e `paidAmountCents == amount_cents` do nosso registro. Valor diferente marca `needs_review = true` e não credita.
- **Valores da compra (D9):**
  - Pacotes de R$ 500, R$ 1.000, R$ 2.500 e R$ 5.000.
  - Valor livre a partir de **R$ 100,00** (mínimo por cobrança da Upper) até R$ 50.000,00.
  - Centavos inteiros calculados no servidor.
  - Sem bônus.
- **Quem compra (D10):** só o **admin da casa** (`requireTenantAdmin`). A casa demo e as casas isentas (`interno`) não compram, e o servidor recusa com mensagem.
- **Saldo creditado:** `amount = amount_cents / 100`, em lançamento `entry_type = 'purchase'` com chave `charge:<payment_charges.id>`, `reference_type = 'payment_charge'`, `reason = 'Compra de créditos por Pix'`. Créditos nunca expiram.
- **Dados do pagador (LGPD):** `payer_document_masked` guarda o CPF como `***.456.789-**` (só os dígitos 4 a 9 visíveis) e o CNPJ como `**.345.678/****-**` (só os dígitos 3 a 8 visíveis). O documento completo nunca é gravado.
- **Taxa do Pix (D11):** a tabela `payment_fee_settings` (`fee_percent`, `fee_fixed_cents`, `valid_from`) começa vazia. Na hora de creditar, grava `fee_cents` = `round(amount_cents × fee_percent / 100) + fee_fixed_cents` com a taxa vigente, ou null se não houver taxa. A tela do superadmin para editar a taxa fica para a PG5.
- **Liga/desliga:** `BILLING_GATEWAY_ENABLED` (`"true"` liga). Desligado, criar compra lança `"Compra por Pix indisponível no momento."`, e o webhook e a conciliação continuam funcionando.
- **Env novas:** `UPPER_API_BASE`, `UPPER_API_KEY`, `UPPER_WEBHOOK_SECRET`, `BILLING_GATEWAY_ENABLED`. Documentar em `.env.example` e `docs/docker-deployment.md`. Nunca `VITE_`, nunca logar.
- **Custo do fornecedor** continua só para o superadmin (regra da PG1).
- **Migrations:** prefixo `20261022110…`, terminam com `notify pgrst, 'reload schema';`. Atualizar `src/integrations/supabase/types.ts` à mão.
- **Funções SECURITY DEFINER:** `set search_path = public`, `revoke execute ... from public, anon`, grants explícitos.
- **RLS:** leitura para `is_super_admin() OR tenant_id = ANY(accessible_tenant_ids())`; escrita só por service_role/RPC.
- **Produção:** escrita em produção, cadastro do webhook na Upper e chamadas reais à Upper só com autorização explícita do usuário.
- **Textos:** pt-BR.

## Review Focus

1. **Webhook chega antes da resposta do `POST` ter sido gravada** (ou de outra conta Upper). Um `externalId` desconhecido é gravado e ignorado com 200, e o crédito vem depois pela conciliação. Teste na Task 3.
2. **Mesmo pagamento avisado duas vezes, ou webhook e cron ao mesmo tempo.** Crédito exatamente uma vez (chave `charge:<id>` em `wallet_mutation`). Teste na Task 1 (RPC chamado duas vezes) e na Task 3 (evento repetido).
3. **Admin fecha o modal antes de pagar e gera outra compra.** Cada clique cria pedido e cobrança novos. Uma cobrança `ACTIVE` antiga, se paga depois, credita normalmente. Teste na Task 4 (duas compras seguidas, duas cobranças distintas).
4. **Upper fora do ar ou com timeout na criação.** O pedido fica `failed` com a cobrança `FAILED`, a tela mostra "Não foi possível gerar o Pix agora. Tente de novo em instantes." e nada é creditado. Repetir gera um pedido novo. Teste na Task 4.
5. **Pagamento com valor diferente do cobrado.** `needs_review = true`, sem crédito, e o superadmin vê o caso (coluna na tabela). Teste na Task 3.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20261022110000_billing_pix_charges.sql` | Tabelas `credit_topup_orders`, `payment_charges`, `payment_webhook_events`, `payment_fee_settings`; RPC `billing_credit_paid_charge` |
| `supabase/migrations/20261022110100_billing_reconcile_cron.sql` | Job pg_cron `betleads-billing-reconcile` (a cada 5 min) |
| `src/lib/billing/upper-pix.server.ts` | Cliente HTTP da Upper (criar, consultar, cancelar), erros tipados, limitador |
| `src/lib/billing/upper-webhook.ts` | `verifyUpperSignature` (puro, sem I/O) |
| `src/lib/billing/payment-charges.server.ts` | `confirmChargeFromUpper`, `recordChargeSnapshot`, `reconcilePendingCharges` |
| `src/lib/billing/payer.ts` | `maskPayerDocument` (puro) |
| `src/lib/billing/topup.ts` | Pacotes, validação de valor, `topupDescription` (puros) |
| `src/lib/billing/topup.functions.ts` | Server fns `createCreditTopup`, `getTopupStatus` |
| `src/routes/api/public/upper/webhook.ts` | Rota do webhook |
| `src/routes/api/public/hooks/billing-reconcile.ts` | Rota do cron de conciliação |
| `src/components/billing/buy-credits-dialog.tsx` | Modal de compra (pacotes/valor livre → QR, Copia e Cola, tempo, confirmação ao vivo) |
| `docs/operacoes/RUNBOOK_ATIVAR_PIX_UPPER.md` | Ativação em produção (env, webhook na Upper, migrations, teste de R$ 100) |

---

### Task 1: Tabelas de cobrança e o crédito da cobrança paga

**Files:**
- Create: `supabase/migrations/20261022110000_billing_pix_charges.sql`
- Test: `src/lib/billing/billing-pix-charges.db.test.ts` (reusar `src/lib/billing/billing-db-test-support.ts` e aplicar as migrations `20261022100000`, `20261022100100` antes)

**Interfaces:**
- **Consumes:** `wallet_mutation(_tenant, _amount, _entry_type, _item, _units, _free_units, _usage_month, _unit_price, _provider_unit_cost, _reference_type, _reference_id, _idempotency_key, _reason, _metadata, _created_by, _reverses_ledger_id default null)`, de `20261022100100`.
- **Produces — tabelas:**
  - `credit_topup_orders`:
    - `id uuid pk default gen_random_uuid()`, `tenant_id`, `amount_cents bigint check (>= 10000)`, `package_code text null`;
    - `status text check in ('pending','paid','expired','cancelled','failed') default 'pending'`;
    - `charge_id uuid null`, `created_by uuid`, `created_at`, `paid_at`.
  - `payment_charges`:
    - `id uuid pk`, `tenant_id`, `kind text check in ('credit_topup','invoice')`, `ref_id uuid`;
    - `provider text default 'upper'`, `external_id text unique not null`, `provider_charge_id text`;
    - `status text check in ('PENDING','ACTIVE','PAID','EXPIRED','CANCELLED','FAILED')`, `needs_review boolean default false`;
    - `amount_cents bigint`, `paid_amount_cents bigint`, `fee_cents bigint null`;
    - `emv text`, `qr_code_image text`, `payment_url text`, `expires_at`, `paid_at`;
    - `payer_name text`, `payer_document_masked text`;
    - `last_provider_payload jsonb`, `last_error text`, `credited_at timestamptz`, `created_by uuid`, `created_at`, `updated_at`.
  - `payment_webhook_events`:
    - `event_id text pk`, `event text`, `delivery_id text`, `signature_valid boolean`;
    - `raw_body text`, `headers jsonb`, `received_at default now()`, `processed_at`, `error text`.
  - `payment_fee_settings`: `id uuid pk`, `provider text default 'upper'`, `fee_percent numeric(6,4) default 0`, `fee_fixed_cents bigint default 0`, `valid_from timestamptz`, `updated_by uuid`.
- **Produces — RPC:** `billing_credit_paid_charge(_charge_id uuid) returns jsonb` (service_role apenas).
  - Trava a linha de `payment_charges` com `for update`.
  - Exige `status = 'PAID'`, `needs_review = false` e `paid_amount_cents = amount_cents`; senão devolve `{ok:false, reason:'not_paid'|'needs_review'|'amount_mismatch'}`.
  - Se `credited_at` já existe, devolve `{ok:true, idempotent:true}`.
  - Para `kind = 'credit_topup'`:
    - chama `wallet_mutation(tenant, amount_cents/100.0, 'purchase', null, 0, 0, null, null, null, 'payment_charge', id::text, 'charge:'||id, 'Compra de créditos por Pix', jsonb_build_object('external_id', external_id), null)`;
    - grava `fee_cents` pela taxa vigente e `credited_at = now()`;
    - marca o pedido `paid`, com `paid_at`.
  - Para `kind = 'invoice'`: `raise exception 'invoice_not_supported'` (PG4).
- **Acesso:** RLS de leitura nas 4 tabelas.
  - Casa: lê `credit_topup_orders` e `payment_charges`.
  - Superadmin: lê tudo.
  - `payment_webhook_events` e `payment_fee_settings`: só superadmin lê.
  - Ninguém escreve via `authenticated`.

- [ ] **Step 1: Write the failing tests.** Seed: uma casa paga, um pedido de 50000 e uma cobrança `PAID` com `paid_amount_cents = 50000`.
  - Chamar `billing_credit_paid_charge` como service_role: saldo vai a `500.0000`, lançamento `purchase` com chave `charge:<id>`, pedido `paid`, `credited_at` preenchido.
  - Chamar de novo: `idempotent: true` e saldo continua 500.
  - Cobrança `ACTIVE`: `{ok:false, reason:'not_paid'}`.
  - `paid_amount_cents = 49999`: `{ok:false, reason:'amount_mismatch'}`, sem crédito.
  - Com `payment_fee_settings` (1,5% + 0) → `fee_cents = 750`. Sem linha de taxa → `fee_cents` null.
  - `authenticated` não executa o RPC (permission denied).
  - Casa lê os próprios pedidos e não os de outra casa.
- [ ] **Step 2: Run `npx vitest run src/lib/billing/billing-pix-charges.db.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Write the migration.**
- [ ] **Step 4: Run the tests.** Expected: PASS. Then `npm run typecheck` after updating `types.ts`.
- [ ] **Step 5: Commit** — `feat(billing): Pix charge tables and idempotent credit of a paid charge`

---

### Task 2: Cliente da Upper

**Files:**
- Create: `src/lib/billing/upper-pix.server.ts`
- Test: `src/lib/billing/upper-pix.server.test.ts` (fetch simulado)

**Interfaces:**
- **Produces — tipos:**
  - `type UpperCharge = { id: string; externalId: string | null; status: "PENDING"|"ACTIVE"|"PAID"|"EXPIRED"|"CANCELLED"|"FAILED"; amountCents: number; emv: string | null; qrCodeImage: string | null; paymentUrl: string | null; expiresAt: string | null; paidAt: string | null; paidAmountCents: number | null; payer: { name: string | null; document: string | null } | null; raw: unknown }`.
  - Converte `amountCents`/`paidAmountCents` de texto para número.
- **Produces — erro:** `class UpperError extends Error { status: number; code: string | null; retryable: boolean }`.
  - `retryable` é `true` para timeout, rede, 429, `RATE_LIMITED`, 5xx e 502.
- **Produces — funções:**
  - `createUpperCharge(input: { amountCents: number; description: string; externalId: string; expiresIn: number; metadata: Record<string, string> }): Promise<UpperCharge>`
  - `getUpperCharge(externalId: string): Promise<UpperCharge>`
  - `cancelUpperCharge(externalId: string): Promise<UpperCharge>`
- **Comportamento:**
  - Timeout de 10 s por chamada (`AbortController`).
  - Uma nova tentativa automática, só para erro `retryable` e só em `createUpperCharge`, com o **mesmo** `externalId`.
  - Limitador em memória de 100 chamadas por janela de 60 s: acima disso espera, nunca falha.
  - Sem `UPPER_API_KEY`: lança `UpperError` com `code: "NOT_CONFIGURED"`.
  - A chave nunca aparece em mensagem de erro nem em log.

- [ ] **Step 1: Write the failing tests:**
  - 201 → `UpperCharge` com `amountCents: 15000` (número);
  - resposta com `idempotent: true` é tratada igual;
  - 401 `INVALID_API_KEY` → `UpperError` não retryable;
  - 403 `FEATURE_DISABLED` → não retryable;
  - 502 na criação → tenta de novo uma vez com o mesmo corpo e devolve a 2ª resposta;
  - timeout → `retryable: true`;
  - header `Authorization: Bearer <chave>` enviado;
  - mensagem de erro sem a chave;
  - 101 chamadas dentro de 60 s → a 101ª espera (fake timers).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(billing): Upper Pix API client`

---

### Task 3: Webhook da Upper e confirmação do pagamento

**Files:**
- Create: `src/lib/billing/upper-webhook.ts`, `src/lib/billing/payer.ts`, `src/lib/billing/payment-charges.server.ts`, `src/routes/api/public/upper/webhook.ts`
- Test: `src/lib/billing/upper-webhook.test.ts`, `src/lib/billing/payer.test.ts`, `src/lib/billing/payment-charges.server.test.ts`, `src/routes/api/public/-upper-webhook.test.ts` (padrão de teste de rota com prefixo `-`)

**Interfaces:**
- Consumes: `getUpperCharge` (Task 2) e `billing_credit_paid_charge` (Task 1).
- **Produces — `upper-webhook.ts`:**
  - `verifyUpperSignature(rawBody: string, header: string | null, secret: string, nowSec: number): { ok: true; t: number } | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" }`.
  - Usa `node:crypto` (`createHmac`, `timingSafeEqual`).
- **Produces — `payer.ts`:** `maskPayerDocument(doc: string | null): string | null`. Só dígitos; 11 → CPF, 14 → CNPJ; qualquer outro tamanho → `"***"`; null → null.
- **Produces — `payment-charges.server.ts`:**
  - `recordChargeSnapshot(chargeId: string, upper: UpperCharge): Promise<void>`:
    - atualiza status, `paid_amount_cents`, `paid_at`, `payer_name`, `payer_document_masked` (via `maskPayerDocument`), `last_provider_payload` e `updated_at`;
    - liga `needs_review = true` se `status = 'PAID'` e o valor pago for diferente;
    - para `EXPIRED`/`CANCELLED`/`FAILED`, marca o pedido de compra correspondente com o status em minúsculas (`expired`/`cancelled`/`failed`).
  - `confirmChargeFromUpper(externalId: string): Promise<{ outcome: "credited" | "already_credited" | "not_paid" | "needs_review" | "unknown_charge" }>`:
    - busca `payment_charges` por `external_id`; se não achar → `unknown_charge`;
    - chama `getUpperCharge` e depois `recordChargeSnapshot`;
    - se `PAID` e o valor bate, chama `billing_credit_paid_charge`.
- **Produces — rota `POST /api/public/upper/webhook`:**
  1. Lê `await request.text()` (corpo bruto).
  2. Verifica a assinatura com `UPPER_WEBHOOK_SECRET`; se inválida → 400. Sem secret configurado → 500.
  3. Faz o parse e grava em `payment_webhook_events` (`on conflict (event_id) do nothing`). Se a linha já existia e tem `processed_at`, responde 200 sem reprocessar.
  4. Para `charge.*`, chama `confirmChargeFromUpper(data.externalId)` e grava `processed_at` (ou `error`).
  5. Responde `200 {ok:true}`. Um erro no processamento também responde 200 depois de gravar o evento: a conciliação cobre.

- [ ] **Step 1: Write the failing tests.**
  - **`maskPayerDocument`:** `"123.456.789-09"` → `"***.456.789-**"`; `"12345678000199"` → `"**.345.678/****-**"`; `"123"` → `"***"`; null → null.
  - **`verifyUpperSignature`:**
    - assinatura válida com o exemplo da doc (gere o HMAC no teste) → ok;
    - `v1` trocado → mismatch;
    - `t` 301 s atrás → stale;
    - header ausente ou malformado.
  - **`confirmChargeFromUpper`** (com `getUpperCharge` e supabase simulados):
    - `PAID` com valor igual → chama o RPC → `credited`;
    - `PAID` com valor diferente → `needs_review`, sem RPC;
    - `ACTIVE` → `not_paid`;
    - `externalId` desconhecido → `unknown_charge`, sem chamada à Upper;
    - `EXPIRED` → pedido `expired`.
  - **Rota:**
    - assinatura ruim → 400 e nada gravado;
    - evento válido → gravado e processado, 200;
    - mesmo `event_id` de novo → 200, sem segunda chamada a `confirmChargeFromUpper`;
    - `ping` → 200 sem processamento;
    - `externalId` de outra conta → 200 e evento gravado com o resultado `unknown_charge`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(billing): signed Upper webhook confirms and credits Pix payments`

---

### Task 4: Criar a compra (servidor)

**Files:**
- Create: `src/lib/billing/topup.ts`, `src/lib/billing/topup.functions.ts`
- Test: `src/lib/billing/topup.test.ts`, `src/lib/billing/topup.functions.test.ts`

**Interfaces:**
- Consumes: `createUpperCharge`/`UpperError` (Task 2), `resolveOperationalTenantForRequest`, `requireTenantAdmin`, `assertTenantNotDemo`, `assertTenantCanOpenBilling` (`src/lib/tenant-access.server.ts`), `billing_tenant_exempt` (PG1).
- **Produces — `topup.ts`:**
  - `TOPUP_PACKAGES = [{code:"p500",amountCents:50000},{code:"p1000",amountCents:100000},{code:"p2500",amountCents:250000},{code:"p5000",amountCents:500000}] as const`.
  - `MIN_TOPUP_CENTS = 10000`, `MAX_TOPUP_CENTS = 5000000`.
  - `resolveTopupAmount(input: { packageCode?: string | null; amountCents?: number | null }): { amountCents: number; packageCode: string | null }`.
    - Lança `"Valor mínimo de compra: R$ 100,00"`, `"Valor máximo de compra: R$ 50.000,00"` ou `"Pacote inválido"`.
  - `topupDescription(tenantName: string, amountCents: number): string`.
- **Produces — `topup.functions.ts`:**
  - `createCreditTopup` (POST; input `{ tenantId?: uuid|null, packageCode?: string|null, amountCents?: number|null }`), que devolve `{ orderId, chargeId, status, amountCents, emv, qrCodeImage, paymentUrl, expiresAt }`. Ordem:
    1. gateway ligado;
    2. resolver a casa;
    3. `requireTenantAdmin` (mensagem `"Só o admin da casa pode comprar créditos"`);
    4. não demo;
    5. não isenta (`"Esta casa é isenta e não precisa comprar créditos"`);
    6. `assertTenantCanOpenBilling`;
    7. valor;
    8. inserir pedido + cobrança `PENDING`;
    9. `createUpperCharge` com `expiresIn: 3600`;
    10. `recordChargeSnapshot`;
    11. ligar `charge_id` no pedido.
    - Se a Upper falhar: cobrança `FAILED` com `last_error` (sem dados sensíveis), pedido `failed`, e lança `"Não foi possível gerar o Pix agora. Tente de novo em instantes."`.
  - `getTopupStatus` (GET; input `{ chargeId: uuid }`) → `{ status, paidAt, credited: boolean }`.
    - Lê `payment_charges` com o cliente do usuário (RLS garante a casa).
    - Nunca chama a Upper.

- [ ] **Step 1: Write the failing tests.**
  - **`topup.test.ts`:**
    - pacote `p1000` → 100000;
    - valor livre 10000 aceita, 9999 → mínimo;
    - 5000001 → máximo;
    - pacote inexistente → inválido;
    - `topupDescription("Sorte Alta", 100000)` = `"Sorte Alta - Créditos BetLeads R$ 1.000,00"`;
    - nome de 200 caracteres → resultado com até 140.
  - **`topup.functions.test.ts`** (Upper e supabase simulados):
    - gateway desligado → mensagem;
    - gestor → recusado;
    - demo → recusado;
    - casa isenta → recusado;
    - sucesso → um pedido e uma cobrança, `external_id` começa com `bl-top-` e tem até 64 caracteres;
    - duas chamadas seguidas → dois `external_id` distintos;
    - Upper 502 duas vezes → pedido `failed`, cobrança `FAILED` e a mensagem genérica;
    - `getTopupStatus` de cobrança de outra casa → não encontrado (RLS simulada).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS. Then `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(billing): create Pix credit top-ups for paying houses`

---

### Task 5: Conciliação a cada 5 minutos

**Files:**
- Create: `src/routes/api/public/hooks/billing-reconcile.ts`, `supabase/migrations/20261022110100_billing_reconcile_cron.sql`
- Modify: `src/lib/billing/payment-charges.server.ts` (adiciona `reconcilePendingCharges`)
- Test: `src/lib/billing/payment-charges.server.test.ts` (novos casos)

**Interfaces:**
- Consumes: `confirmChargeFromUpper`, `getUpperCharge`, `withJobRun` (`src/lib/observability/job-monitor.server.ts`), `requireSharedSecret(request, "CRON_SECRET")` (`src/lib/cron-auth.server.ts`).
- **Produces — `reconcilePendingCharges(opts?: { limit?: number; now?: Date }): Promise<{ checked: number; credited: number; expired: number; errors: number }>`:**
  - Seleciona `payment_charges` com `status in ('PENDING','ACTIVE')` e `created_at < now − 2 min`, mais antigas primeiro, `limit` padrão 30.
  - Para cada uma, chama `confirmChargeFromUpper(external_id)`, contando os resultados.
  - Um erro de uma cobrança não interrompe as outras.
  - Uma cobrança com `expires_at` vencido há mais de 10 min, que a Upper ainda devolve como `ACTIVE`, é gravada como `EXPIRED` localmente.
  - Também credita qualquer cobrança `PAID` com `credited_at` nulo e `needs_review = false` (pega um crédito que falhou depois do snapshot).
- **Produces — rota `POST /api/public/hooks/billing-reconcile`:** `requireSharedSecret(CRON_SECRET)`, depois `withJobRun("billing-reconcile", {}, ...)`, responde `{ok:true, ...contadores}`.
- **Produces — migration:** agenda `betleads-billing-reconcile` com `*/5 * * * *` para `https://betleads.io/api/public/hooks/billing-reconcile`, no mesmo padrão de `20261003140000_schedule_automation_crons.sql` (desagenda pelo nome antes; Bearer do Vault `betleads_cron_secret`).

- [ ] **Step 1: Write the failing tests.**
  - 3 cobranças pendentes, uma `PAID` na Upper → `credited: 1`, `checked: 3`;
  - uma que dá erro de rede → `errors: 1` e as outras seguem;
  - cobrança criada há 1 min → ignorada;
  - `PAID` local sem `credited_at` → credita sem chamar a Upper;
  - `limit` respeitado.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(billing): reconcile pending Pix charges every 5 minutes`

---

### Task 6: Tela de compra

**Files:**
- Create: `src/components/billing/buy-credits-dialog.tsx`
- Modify:
  - `src/routes/creditos-sms.tsx` (botão "Comprar créditos" ao lado do saldo, só para admin de casa pagante);
  - `src/lib/billing/wallet-notice.ts` e o teste (o texto aponta para "Comprar créditos" quando a compra está disponível);
  - `src/components/billing/wallet-balance-notice.tsx`;
  - `.env.example`, `docs/docker-deployment.md`.
- Test: `src/lib/billing/wallet-notice.test.ts` (casos novos).

**Interfaces:**
- Consumes: `createCreditTopup`, `getTopupStatus` (Task 4), `TOPUP_PACKAGES`, `MIN_TOPUP_CENTS` (Task 4).
- **Produces:**
  - `walletBalanceNotice({ balance, exempt, smsUnitPrice, canBuy })`, onde `canBuy: boolean` é novo. Com `canBuy`, o texto termina com `"Compre créditos por Pix nesta página."`; sem, mantém o texto atual de suporte.
  - O servidor informa `canBuy` em `getSmsCreditPortal`: `gateway ligado && admin da casa && não isenta && não demo`.
- **Comportamento do modal:**
  1. **Passo 1:** 4 pacotes em botões (R$ 500 / 1.000 / 2.500 / 5.000) mais o campo "Outro valor" (R$, mínimo 100), e o botão "Gerar Pix".
  2. **Passo 2:**
     - QR (`<img src={qrCodeImage}>`), Copia e Cola com botão "Copiar" e o link "Abrir página de pagamento" (`paymentUrl`).
     - Contagem regressiva até `expiresAt`.
     - Consulta `getTopupStatus` a cada 3 s até `credited` ou status final.
  3. **Pago:** "Pagamento confirmado — R$ X adicionados ao saldo", e invalida as queries `["sms-credits"]`.
  4. **Expirado/cancelado:** "Este Pix expirou" e o botão "Gerar outro".
  5. **Erro:** a mensagem do servidor.

- [ ] **Step 1: Write the failing tests** for `walletBalanceNotice` with `canBuy` (texto com "Compre créditos por Pix nesta página." quando `canBuy`; texto de suporte quando não), and for `getSmsCreditPortalFor` returning `canBuy` (gateway off → false; gestor → false; isenta → false; admin pagante com gateway on → true).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the server flag, the dialog and the page button. Copy from Global Constraints.
- [ ] **Step 4: Run `npm test`, `npm run typecheck`, `npm run lint`.** Expected: PASS, 0 erros.
- [ ] **Step 5: Commit** — `feat(billing): buy credits by Pix on Saldo e consumo`

---

### Task 7: Roteiro de ativação em produção (só documento)

**Files:**
- Create: `docs/operacoes/RUNBOOK_ATIVAR_PIX_UPPER.md` (mais uma linha em `docs/INDEX.md`)

Passos, cada um com comando, resultado esperado, o que fazer se der diferente e o campo **Resultado:**

1. **Pré-requisitos (PG0):**
   - conta Upper com KYC aprovado e a função "receber Pix" liberada;
   - chave **só `pix_in`**;
   - teste `GET /v1/balance` → 200.
2. **Env na VPS:** `UPPER_API_KEY`, `UPPER_API_BASE`, `UPPER_WEBHOOK_SECRET` e `BILLING_GATEWAY_ENABLED=false`, por enquanto.
3. **Migrations:** aplicar `20261022110000` e `20261022110100` (padrão do roteiro da PG1, com `schema_migrations` e dollar-quote). Conferir o job `betleads-billing-reconcile` em `cron.job`.
4. **Deploy** do código.
5. **Cadastrar o webhook** em API → Webhook da Upper: `https://betleads.io/api/public/upper/webhook`. O botão "Testar" deve registrar um evento `ping` em `payment_webhook_events`.
6. **Ligar o gateway** com `BILLING_GATEWAY_ENABLED=true` e recriar o container.
7. **Teste real de R$ 100,00** (o mínimo da Upper) numa casa pagante de teste. A QA Jornadas P0 já está `enterprise`.
   - Pagar o Pix e conferir: evento `charge.paid`, cobrança `PAID` com `credited_at`, pedido `paid`, saldo R$ 100,00, extrato `purchase`.
   - Gerar outro Pix e deixar vencer: com `expiresIn` 3600 o teste leva 1 h; alternativa: cancelar pela API com `cancelUpperCharge`.
   - Conferir que a conciliação marca `EXPIRED`/`CANCELLED`.
8. **Rollback:** desligar `BILLING_GATEWAY_ENABLED` e despublicar o webhook na Upper. As tabelas são aditivas.

- [ ] **Step 1: Write the runbook.**
- [ ] **Step 2: Commit** — `docs(billing): Pix (Upper) activation runbook`

---

## Fora deste plano

- Mensalidade e fatura: PG4.
- Cobrança de voz e de e-mail: PG3.
- Tela do superadmin para a taxa do Pix e o relatório de receita: PG5-02/PG5-03.
- Estorno: não existe na API.
- `pix_out`: fora do escopo.
