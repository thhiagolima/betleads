# Console do superadmin — F2 Financeiro geral: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nova aba **Financeiro geral** em `/admin` (logo depois de Saúde): por mês, quanto o CRM recebeu (mensalidades + recargas), vendeu em consumo, gastou com Short Brasil e Infobip, pagou de taxa Pix e a margem; estado da mensalidade de cada casa com a lista de quem deve; tabela por casa e movimentos do mês.

**Architecture:** O cálculo por casa do CSV mensal (`adminBillingMonthlyCsvFor`, `src/lib/billing/billing-admin.functions.ts:1228`) sai para uma função pura compartilhada pelo CSV e pela tela, para os dois nunca divergirem; a leitura dos dados do mês sai para um loader compartilhado. Uma função pura resume os estados de cobrança (baldes, devedores, movimentos). Uma server function GET superadmin junta tudo; a aba React mostra cartões, baldes, devedores, tabela e o botão do CSV existente.

**Tech Stack:** TypeScript, TanStack Start (`createServerFn`), React Query, Supabase (`supabaseAdmin`), Vitest, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-05-console-superadmin-design.md` (§6 é esta fase). Leia antes de começar.

Worktree: `C:\Users\Carol\Desktop\betleads-synchealth`, branch `feat/financeiro-geral` (de origin/main aa8a4f7).

## Global Constraints

- Sem migração. Se algo exigir SQL novo, **pare e reporte**.
- Toda leitura só depois de `assertSuperAdmin(ctx.userId)`.
- Casas demo fora (`listDemoTenantIds()` de `src/lib/tenant-access.server.ts`, como o CSV já faz).
- Valores de cobrança são em **BRL** (Pix/carteira são em reais para todas as casas; `tenants.moeda` vale só para os números de jogo das casas). Formatar com `formatCentsBRL` (`src/components/billing/admin/billing-admin-ui.ts:73`) ou `brl` (`src/lib/format.ts`).
- Mês = mês-calendário de Brasília (`parseBrtDayStart` como no CSV); seletor `AAAA-MM`, padrão o mês atual.
- Fórmulas (iguais às do CSV, `billing-admin.functions.ts:1313-1318`): receita bruta = mensalidade paga + consumo SMS + voz + e-mail; recargas são caixa, **não** receita; receita líquida = bruta − custo fornecedor − taxa Pix; margem % = líquida ÷ bruta × 100, vazia quando bruta = 0.
- Custo por fornecedor: item `sms` → **Short Brasil**; `voice_30s` e `email` → **Infobip**. Unidades com `provider_unit_cost` nulo contam como "custo não cadastrado" e aparecem como aviso, nunca como R$ 0.
- O CSV continua byte a byte igual (mesmo cabeçalho, mesma ordem, mesmo formato); os testes atuais de `adminBillingMonthlyCsvFor` continuam passando sem alteração.
- Textos pt-BR, tema escuro, tabela com `overflow-x-auto`.
- `npm run build` verde na verificação final.

## Review Focus

1. Casa isenta (`plano interno`) com consumo → entra na tabela marcada "isenta", mensalidade "—", e o custo dela soma no custo total (o CRM paga o fornecedor por ela). Teste na Task 1.
2. Mês sem nenhuma movimentação → cartões em R$ 0, margem "—", tabela com as casas e zeros, sem erro. Teste nas Tasks 1 e 4.
3. Custo de fornecedor nulo em parte das linhas → total mostra o custo conhecido e um aviso "N unidades sem custo cadastrado" por fornecedor. Teste na Task 1.
4. Casa com fatura aberta vencida há 10 dias → aparece em "Vencida" com "10 dias de atraso" e na lista de devedores no topo (ordenada por valor desc, depois dias desc). Teste na Task 2.
5. Mais de 1000 linhas no ledger do mês → nada se perde (o loader usa `selectAllPages` como o CSV). Coberto por reaproveitar o loader do CSV (Task 1).

---

### Task 1: Cálculo mensal puro compartilhado + loader do mês

**Files:**
- Create: `src/lib/billing/billing-month-report.ts` (pure)
- Create: `src/lib/billing/billing-month-data.server.ts` (loader)
- Modify: `src/lib/billing/billing-admin.functions.ts:1228-1395` (CSV usa os dois)
- Test: `src/lib/billing/billing-month-report.test.ts`; existing `src/lib/billing/billing-admin.functions.test.ts` must pass unchanged

**Interfaces:**
- Produces:
  ```ts
  // billing-month-report.ts
  export type MonthTenant = { id: string; nome: string; slug: string; plano: string | null; exempt: boolean };
  export type MonthLedgerRow = { tenant_id: string; item: string | null; units: number; amount: number; provider_unit_cost: number | null; entry_type: string };
  export type MonthData = {
    month: string; tenants: MonthTenant[];
    invoicesPaid: Array<{ tenant_id: string; paid_amount_cents: number }>;
    topups: Array<{ tenant_id: string; paid_amount_cents: number }>;
    ledger: MonthLedgerRow[];
    pixFees: Array<{ tenant_id: string; fee_cents: number }>;
  };
  export type ProviderCost = { amount: number; missingCostUnits: number }; // reais
  export type MonthHouseRow = {
    tenantId: string; name: string; slug: string; plan: string | null; exempt: boolean;
    mensalidadeReais: number; topupReais: number; topupCount: number;
    consumoSms: number; consumoVoz: number; consumoEmail: number;
    shortBrasil: ProviderCost; infobip: ProviderCost; custoFornecedor: number; // = shortBrasil.amount + infobip.amount
    taxaPixReais: number; receitaBruta: number; receitaLiquida: number; margemPct: number | null;
  };
  export type MonthTotals = Omit<MonthHouseRow, "tenantId" | "name" | "slug" | "plan" | "exempt">;
  export function computeMonthRows(data: MonthData): MonthHouseRow[]; // paying first, then exempt; inside each, data.tenants order
  export function sumMonthRows(rows: MonthHouseRow[]): MonthTotals; // margemPct recomputed from the sums
  // billing-month-data.server.ts
  export async function loadMonthData(month: string): Promise<MonthData>; // demo tenants removed; throws on read error
  ```
- `custoFornecedor` must equal the CSV's current formula exactly (sign +1 for `usage_reservation`, −1 for `usage_refund`, `units × provider_unit_cost`, null cost = 0 in the amount but counted in `missingCostUnits`).

- [ ] **Step 1: Write the failing tests** (`billing-month-report.test.ts`):
  - one paying house: invoice 400000 cents, topup 100000 cents (×2 rows → `topupCount 2`), ledger sms reservation 1000 units amount −80 cost 0.059 and a refund 10 units amount +0.8 → `consumoSms 79.2`, `shortBrasil.amount ≈ 58.41`, `receitaBruta 4079.2`, margin computed per the formula, `topupReais 1000` not in `receitaBruta`.
  - voice and e-mail rows go to `infobip`; an e-mail row with `provider_unit_cost null` → `infobip.missingCostUnits` = its units and adds 0 to the amount (Review Focus 3).
  - exempt house with SMS usage amount 0 and cost 0.059 → row `exempt true`, `mensalidadeReais 0`, cost counted, and `sumMonthRows` includes its cost (Review Focus 1).
  - empty month → every number 0, `margemPct null` (Review Focus 2).
  - ordering: paying rows first, exempt after.
- [ ] **Step 2: Run** `npx vitest run src/lib/billing/billing-month-report.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `billing-month-report.ts`, then `billing-month-data.server.ts` by moving the reads out of `adminBillingMonthlyCsvFor` (same queries, same `selectAllPages` paging keys, plus `exempt` from `billing_plans.exempt_all`), then make `adminBillingMonthlyCsvFor` = `assertSuperAdmin` → `loadMonthData` → `computeMonthRows` → format cells exactly as today.
- [ ] **Step 4: Run** `npx vitest run src/lib/billing/billing-month-report.test.ts src/lib/billing/billing-admin.functions.test.ts` and `npx tsc --noEmit -p .` — Expected: PASS / no output.
- [ ] **Step 5: Commit** `refactor(billing): share the monthly per-house computation between the CSV and the admin finance view`

### Task 2: Resumo dos estados de cobrança (puro)

**Files:**
- Create: `src/lib/billing/billing-state-summary.ts`
- Test: `src/lib/billing/billing-state-summary.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  export type BillingStateInput = {
    tenantId: string; name: string; accessState: string; // tenant_billing.access_state
    openInvoice: { amountCents: number; dueDate: string } | null;
    firstPaidAt: string | null;   // earliest billing_invoices.paid_at ever
    paidInMonth: boolean;         // a paid invoice with paid_at inside the selected month
  };
  export type BillingBucket = "ok" | "due_soon" | "overdue" | "locked" | "awaiting_first_payment" | "exempt" | "frozen";
  export const BUCKET_LABELS: Record<BillingBucket, string>; // "Em dia", "Vence em 5 dias", "Vencida", "Bloqueada", "Aguardando 1º pagamento", "Isenta", "Congelada"
  export type BillingStateRow = BillingStateInput & { bucket: BillingBucket; daysOverdue: number | null };
  export type Debtor = { tenantId: string; name: string; amountCents: number; daysOverdue: number; bucket: BillingBucket };
  export type BillingStateSummary = {
    rows: BillingStateRow[];
    counts: Record<BillingBucket, number>;
    owedCents: number;            // sum of open invoices in overdue/locked/awaiting_first_payment
    debtors: Debtor[];            // those same houses, amount desc then daysOverdue desc
    movements: { newPaying: string[]; lost: string[] }; // tenant names
  };
  export function summarizeBillingStates(rows: BillingStateInput[], todayBrt: string, month: string): BillingStateSummary;
  ```
- Bucket mapping: `ok`→ok; `due_soon`→due_soon; `overdue`→overdue; `locked_unpaid` and `locked_manual`→locked; `awaiting_first_payment`→awaiting_first_payment; `exempt`→exempt; `frozen`→frozen; unknown → ok.
- `daysOverdue` = whole days from `openInvoice.dueDate` to `todayBrt` when > 0, else null.
- Movements: `newPaying` = `firstPaidAt` falls inside `month`; `lost` = bucket `locked` or `frozen` and not `paidInMonth`. *(Ruling: "reativadas" is left out — there is no lock history to compute it from without a migration.)*

- [ ] **Step 1: Write the failing tests:** each access_state maps to its bucket; open invoice due 2026-10-26 with today 2026-11-05 → `daysOverdue 10`, listed in `debtors` (Review Focus 4); debtors ordering (amount desc, then days desc); `owedCents` excludes `due_soon` and `ok`; `newPaying` and `lost` cases; counts include zero buckets.
- [ ] **Step 2: Run** `npx vitest run src/lib/billing/billing-state-summary.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin): billing state summary for the general finance view`

### Task 3: Loader e server function do Financeiro geral

**Files:**
- Create: `src/lib/billing/general-finance.server.ts`
- Create: `src/lib/billing/general-finance.functions.ts`
- Test: `src/lib/billing/general-finance.server.test.ts`

**Interfaces:**
- Consumes: `loadMonthData`, `computeMonthRows`, `sumMonthRows` (Task 1); `summarizeBillingStates`, `BillingStateInput` (Task 2); `assertSuperAdmin` (`src/lib/billing/billing-health.server.ts:412`).
- Produces:
  ```ts
  export type GeneralFinanceHouse = MonthHouseRow & { bucket: BillingBucket; daysOverdue: number | null; openInvoiceCents: number | null };
  export type GeneralFinance = {
    month: string; generatedAt: string;
    totals: MonthTotals;
    states: Omit<BillingStateSummary, "rows">;
    houses: GeneralFinanceHouse[];
  };
  export const generalFinanceInput: z.ZodObject<{ month: z.ZodString }>; // same regex as adminBillingMonthlyCsvInput
  export async function adminGeneralFinanceFor(ctx: { userId: string }, data: unknown): Promise<GeneralFinance>;
  // general-finance.functions.ts
  export const adminGeneralFinance; // createServerFn GET + requireSupabaseAuth + inputValidator → adminGeneralFinanceFor
  ```
- Extra reads (all after `assertSuperAdmin`, demo tenants excluded): `tenant_billing` (`tenant_id,access_state`), open `billing_invoices` (`tenant_id,amount_cents,due_date`), and the earliest paid invoice per tenant (`billing_invoices` `tenant_id,paid_at` where `status = 'paid'`, paged with `selectAllPages`; take the min per tenant). `paidInMonth` comes from `MonthData.invoicesPaid`. `todayBrt` from `brtDayKey(new Date())` (already used in billing-admin.functions.ts).
- `houses` order: debtors first (same order as `states.debtors`), then the rest by `margemPct` ascending (null last).

- [ ] **Step 1: Write the failing tests** with `createFakeDb` mocked as `@/integrations/supabase/client.server` (pattern: `src/lib/billing/billing-admin.functions.test.ts:1-60`) and `listDemoTenantIds` mocked: non-super-admin rejected before any other read; demo house absent; an overdue house is first in `houses` and in `states.debtors`; invalid month (`"2026-13"` or `"nov"`) rejected with the Portuguese message.
- [ ] **Step 2: Run** `npx vitest run src/lib/billing/general-finance.server.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** both files (`.functions.ts` holds only the `createServerFn`, like `src/lib/billing/billing-health.functions.ts`).
- [ ] **Step 4: Run** the test and `npx tsc --noEmit -p .` — Expected: PASS / no output.
- [ ] **Step 5: Commit** `feat(admin): general finance loader for the super admin console`

### Task 4: Aba Financeiro geral em /admin

**Files:**
- Create: `src/components/admin/general-finance/general-finance-tab.tsx`
- Create: `src/components/admin/general-finance/billing-state-cards.tsx`
- Create: `src/components/admin/general-finance/general-finance-table.tsx`
- Test: `src/components/admin/general-finance/general-finance-tab.test.tsx`
- Modify: `src/components/billing/admin/billing-csv-download.tsx` (export `downloadCsv` and `currentYyyyMmBrt` only)
- Modify: `src/routes/admin.tsx` (`AdminView`, `ADMIN_VIEWS` — new entry `{ value: "general-finance", label: "Financeiro geral", hash: "financeiro-geral" }` right after Saúde — and the panel switch)

**Interfaces:**
- Consumes: `adminGeneralFinance` (Task 3), types `GeneralFinance`, `GeneralFinanceHouse` (`import type` only), `BUCKET_LABELS` (Task 2 — pure file, runtime import allowed); from `src/components/billing/admin/billing-csv-download.tsx` export (and reuse) its existing `downloadCsv(month, csv)` and `currentYyyyMmBrt()` helpers — that file's card keeps working as is; the new tab calls `adminBillingMonthlyCsv` itself through `useServerFn` + `useMutation` for its "Baixar CSV" button.
- Produces: `export function GeneralFinanceTab(): JSX.Element`.

Layout (top to bottom):
1. Month selector (`AAAA-MM`, default current month; previous/next buttons and a native month input) + "Baixar CSV" for the selected month (see Consumes).
2. Cards (`MetricCard`): Mensalidades recebidas · Recargas recebidas · Consumo vendido · Custo Short Brasil · Custo Infobip · Taxa Pix · Margem (R$ and %). A provider card with `missingCostUnits > 0` shows the hint `N unidades sem custo cadastrado`.
3. Billing state cards, one per bucket with its count (`BUCKET_LABELS`), plus "Em aberto: R$ X" (`owedCents`). Clicking a bucket filters the table below to that bucket; clicking again clears.
4. "Quem está devendo" list (`states.debtors`): casa, valor, "N dias de atraso" (or the bucket label when null), link that opens `/admin#faturamento`. Empty → "Ninguém devendo."
5. Movements line: `Novas pagantes no mês: A, B` · `Perdidas (bloqueadas/congeladas sem pagar): C` (omit empty parts).
6. Table per house: Casa (+ "isenta" badge) · Situação · Mensalidade · Recargas (count + value) · Consumo · Short Brasil · Infobip · Taxa Pix · Receita líquida · Margem. Values with `formatCentsBRL`/`brl`; margin "—" when null; negative margin in the destructive color. Default order = server order; header click sorts by that column (toggle asc/desc). `overflow-x-auto`.
7. Footer note: `Custos de fornecedor estimados: unidades × tarifa cadastrada. SMS → Short Brasil; voz e e-mail → Infobip.`

- [ ] **Step 1: Write the failing tests** (`renderToStaticMarkup`, mocks as in `src/components/admin/platform-health/platform-health-tab.test.tsx`): cards render the totals; a provider with missing cost units shows the hint; debtors list shows `10 dias de atraso`; empty month renders `Ninguém devendo.` and margin `—` (Review Focus 2); exempt house shows the `isenta` badge; table renders houses in the given order; loading and error states.
- [ ] **Step 2: Run** `npx vitest run src/components/admin/general-finance` — Expected: FAIL.
- [ ] **Step 3: Implement** the components and wire the tab. Query: `useQuery({ queryKey: ["admin-general-finance", month], queryFn: () => fn({ data: { month } }) })` (no auto-refresh).
- [ ] **Step 4: Run** `npx vitest run src/components/admin/general-finance src/lib/navigation.test.ts` and `npx tsc --noEmit -p .` — Expected: PASS / no output.
- [ ] **Step 5: Commit** `feat(admin): Financeiro geral tab with monthly results, billing states and debtors`

### Task 5: Verificação final (controller)

- [ ] `npx vitest run --maxWorkers=4` — only the month-dependent `scripts/demo/seed-demo-finance.db.test.ts` may fail (fails on main too).
- [ ] `npm run build` — exit 0.
- [ ] Read-only production run of `adminGeneralFinanceFor` for 2026-10 and 2026-11 with a real super-admin id; compare the per-house numbers with `adminBillingMonthlyCsvFor` for the same month (must match) and sanity-check against the 05/11 snapshot (4 houses awaiting first payment with R$ 16.000 open; 6 paid top-ups R$ 5.900 in total).
