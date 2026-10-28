# Financeiro — painel de resultado Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a results dashboard (KPI cards, 12-month profit, cost breakdown) in front of the house finance, reuse it for group and super-admin scopes, deduct the Betleads cost automatically, and give "outros custos" categories.

**Architecture:** All money math stays in the pure `src/lib/finance/calc.ts`; `summarize` gains a Betleads cost and two new pure helpers build the cost breakdown and the monthly series. Two new service-role SQL functions expose Betleads usage per day and the plan fee per month. One new server function, `getFinanceDashboardFor`, serves the three scopes (house, group, all) and replaces `getGroupOverviewFor`. The UI is one `FinanceDashboard` component used by `/financeiro`, `/grupo` and `/grupo/casa`.

**Tech Stack:** TanStack Start (`createServerFn`), React, TanStack Query, Supabase/Postgres, zod, recharts 2.15, vitest + PGlite.

**Spec:** `docs/superpowers/specs/2026-10-27-financeiro-painel-design.md` (builds on `docs/superpowers/specs/2026-10-24-grupos-de-casas-design.md`). Approved mockup: `.superpowers/brainstorm/28046-1793138051/content/financeiro-painel-v1.html` in the main checkout `C:\Users\Carol\Desktop\betleads`.

## Global Constraints

- Work in the worktree `C:\Users\Carol\Desktop\betleads-financeiro`, branch `feat/financeiro-painel`.
- All UI copy is pt-BR. Money uses `formatBRL`, ratios use `formatRatio`, and counts use `formatInt` from `src/components/finance/format.ts`. A missing value renders as `n.a.`.
- No change to the existing formulas in `computeDay`. The only new deduction is the Betleads cost (spec §2).
- Betleads usage counts **per day** (São Paulo day of `wallet_ledger.created_at`) as `−Σ amount` over `entry_type in ('usage_reservation','usage_refund')`.
- The plan fee counts per **month of `period_start`**, uses `amount_cents / 100` and includes invoices with `status in ('open','paid')`. It enters a window only when other costs do: a closed calendar month, or the "Mês" preset (`currentCostMonth`/`previousCostMonth` rule in `getGroupOverviewFor`).
- Fixed categories, in this order: `Afiliados e influenciadores`, `Equipe`, `Ferramentas`, `Impostos`, `Outros`. A null category means `Outros`. Categories are merged by name, case-insensitive and trimmed.
- Super admin "Todas as casas" = `tenants.status = 'active'` and not demo (`is_demo` false).
- Permissions are unchanged: tenant scope → `finance_can_view`; group scope → `managedGroupIds(userId)` includes it; all scope → super admin only.
- Writes still refuse the demo house (`assertTenantNotDemo`).
- New migration: `supabase/migrations/20261103100000_finance_dashboard.sql`. Its functions are `security definer` and executable by `service_role` only, like `finance_days`.
- Before handing off: `npm test`, `npm run typecheck`, `npm run build`. `build` catches `*.server` imports leaking into the client bundle.

## Review Focus

1. A house with no wallet ledger and no invoices (plano interno, or a month before the wallet existed) → Betleads = R$ 0, no error, and months before its first ledger/invoice date carry `betleadsMissing: true` (UI note "sem dado de consumo antes de …"). Test in Task 1 and Task 3.
2. A refund dated on a later day (or month) than its reservation → each row counts on its own day, and a day's usage may be negative. Test in Task 1.
3. A period with zero ad spend, or a previous period with a negative profit → ROI `n.a.`, never `Infinity`. The variation divides by `|prev|`, so improving from negative shows ▲. Test in Task 2.
4. A group with no houses, or "Todas as casas" when every house is demo or inactive → an empty dashboard (zeros, empty table and series), not an error. Test in Task 3.
5. Scope abuse: a group manager asking for a house outside their groups, a house admin asking for a group, a non-super-admin asking for `all` → each fails with "Sem permissão". Test in Task 3.

---

### Task 1: Migration — Betleads cost functions and category column

**Files:**
- Create: `supabase/migrations/20261103100000_finance_dashboard.sql`
- Test: `src/lib/finance-dashboard.db.test.ts`

**Interfaces:**
- Produces (SQL, service_role only):
  - `alter table public.tenant_finance_other_costs add column categoria text null check (categoria is null or length(btrim(categoria)) between 1 and 60)`
  - `public.finance_betleads_usage(_tenants uuid[], _from date, _to date) returns table (tenant_id uuid, metric_date date, amount numeric)`: one row per house × São Paulo day that has ledger usage rows.
  - `public.finance_betleads_fees(_tenants uuid[], _from_month date, _to_month date) returns table (tenant_id uuid, month date, amount numeric)`: month = `date_trunc('month', period_start)::date`, for both bounds inclusive.
  - `public.finance_betleads_since(_tenants uuid[]) returns table (tenant_id uuid, since date)`: the earliest São Paulo date among the house's usage ledger rows and its invoices' `period_start`. A house with neither has no row.

- [ ] **Step 1: Write the failing test** `src/lib/finance-dashboard.db.test.ts`. Follow the PGlite setup of `src/lib/tenant-finance.db.test.ts`: stub roles, `public.tenants`, and minimal `public.wallet_ledger` (`tenant_id, entry_type, amount, created_at`) and `public.billing_invoices` (`tenant_id, period_start, amount_cents, status`) tables, plus `tenant_finance_other_costs` from the real finance migration. Then load the new migration. Cases:
  - `usage sums reservations minus refunds per São Paulo day`: reservation −10.00 at `2026-10-05T02:30Z` (→ 2026-10-04 SP), reservation −5.00 and refund +2.00 at `2026-10-05T15:00Z` → rows `(A, 2026-10-04, 10.00)` and `(A, 2026-10-05, 3.00)`.
  - `a refund on a later day counts on its own day`: reservation −8 on 10-06 and refund +8 on 10-07 → `(10-06, 8)` and `(10-07, -8)`.
  - `purchase and manual_adjustment rows are ignored`.
  - `fees by month of period_start, open and paid only`: invoices `(2026-09-15 → 400000 paid)`, `(2026-10-15 → 400000 open)` and `(2026-10-15 → 400000 canceled)` → `(2026-09-01, 4000)` and `(2026-10-01, 4000)`.
  - `since is the earliest usage or invoice date; absent house has no row`.
  - `other cost categoria rejects blank and accepts null`.
  - `authenticated cannot execute the functions` (`has_function_privilege('authenticated', …, 'execute')` is false).

- [ ] **Step 2: Run** `npx vitest run src/lib/finance-dashboard.db.test.ts`. Expected: FAIL (migration file missing).

- [ ] **Step 3: Write the migration.** Use plain SQL `stable security definer set search_path = public`, filter by `tenant_id = any(_tenants)` and the window in São Paulo time (`created_at >= (_from::timestamp at time zone 'America/Sao_Paulo') and created_at < ((_to + 1)::timestamp at time zone 'America/Sao_Paulo')`, the same pattern as `ftd_sums` in `finance_days`). Finish with `revoke all … from public, anon, authenticated; grant execute … to service_role`.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/20261103100000_finance_dashboard.sql src/lib/finance-dashboard.db.test.ts
git commit -m "feat(finance): SQL for Betleads cost per day/month and other-cost category"
```

### Task 2: Pure calc — Betleads in the summary, cost breakdown, monthly series, categories

**Files:**
- Modify: `src/lib/finance/types.ts`, `src/lib/finance/calc.ts`
- Create: `src/lib/finance/categories.ts`
- Test: `src/lib/finance/calc.test.ts`, `src/lib/finance/categories.test.ts`

**Interfaces:**
- Produces in `types.ts`:
  ```ts
  export type BetleadsCost = { usage: number; fee: number | null };
  // PeriodSummary gains:
  //   betleadsUsage: number;        // 0 when not given
  //   betleadsFee: number | null;   // null when the window is not a closed month
  export type CostLineKey = "ad_spend" | "ggr_fee" | "movement_fee" | "betleads" | `category:${string}`;
  export type CostLine = { key: CostLineKey; label: string; amount: number; previous: number | null; auto: boolean };
  export type MonthPoint = {
    month: string;               // "YYYY-MM"
    cashResult: number;
    adSpend: number;
    roi: number | null;
    incomplete: boolean;         // pendingDays > 0 or pendingToday
    inProgress: boolean;         // the current month
    betleadsMissing: boolean;
    byTenant: Record<string, number>; // tenantId -> cashResult
  };
  ```
- Produces in `calc.ts`:
  - `summarize(days, otherCosts, today?, betleads?: BetleadsCost): PeriodSummary`. `cashResult = round2(rawCashResult − (otherCosts ?? 0) − betleads.usage − (betleads.fee ?? 0))`. ROI and `avgDailyCashResult` follow from that `cashResult`, as today.
  - `costBreakdown(current: PeriodSummary, previous: PeriodSummary | null, categories: Record<string, number>, previousCategories: Record<string, number> | null, ggrFeePct: number | null): CostLine[]`. Labels: `Anúncios`, `Taxa de GGR (16%)` (or `Taxa de GGR` when `ggrFeePct` is null), `Taxa de movimentação`, `Betleads` (`auto: true`, amount = usage + fee), then one line per category. Sorted by amount, descending; lines with amount 0 and previous 0/null are dropped.
- Produces in `categories.ts`:
  - `FIXED_COST_CATEGORIES: readonly string[]` (Global Constraints order)
  - `categoryLabel(categoria: string | null): string` → trimmed with spaces collapsed, or `"Outros"`
  - `categoryKey(label: string): string` → `label.toLocaleLowerCase("pt-BR")`
  - `mergeCategories(fixed: readonly string[], used: string[]): string[]` → fixed first, then the used ones not already present by key, sorted pt-BR
  - `looksLikeBetleadsCost(descricao: string, categoria: string | null): boolean` → true when either matches `/\b(sms|betleads|mensalidade|voz|e-?mail|crm)\b/i`

- [ ] **Step 1: Write failing tests**
  - calc: `summarize deducts Betleads usage and fee from cashResult and ROI`: two complete days with known cashResult sum 1000, adSpend 500, other 100, betleads `{usage: 50, fee: 4000}` → `cashResult === -3150`, `roi === -6.3`, `betleadsUsage === 50`, `betleadsFee === 4000`.
  - calc: `summarize without betleads keeps today's numbers` (an existing fixture total is unchanged, with `betleadsUsage === 0` and `betleadsFee === null`).
  - calc: `zero ad spend gives null ROI and pctChange from negative previous is positive` → `summary.roi === null`, `pctChange(-50, -100) === 0.5`.
  - calc: `costBreakdown orders by amount, labels the GGR rate, marks Betleads auto, drops empty lines`.
  - categories: `categoryLabel(null) === "Outros"`, `categoryLabel("  equipe  ") === "equipe"`; `mergeCategories(FIXED, ["Contador","equipe"])` ends with `"Contador"` and does not repeat Equipe; `looksLikeBetleadsCost("SMS outubro", null) === true`, `looksLikeBetleadsCost("Aluguel", "Equipe") === false`, `looksLikeBetleadsCost("x", "Mensalidade") === true`.
- [ ] **Step 2: Run** `npx vitest run src/lib/finance/calc.test.ts src/lib/finance/categories.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above. Update every `PeriodSummary` literal the compiler flags (tests and fixtures).
- [ ] **Step 4: Run** the same command plus `npm run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(finance): Betleads cost in the period summary, cost breakdown and categories`.

### Task 3: Server — dashboard data for house, group and all scopes

**Files:**
- Create: `src/lib/finance/finance-data.server.ts` (helpers moved out of `finance.functions.ts`: `db`, `num`, `numOrNull`, `todaySaoPaulo`, `clampToToday`, `inRange`, `can`, `requirePermission`, `toFinanceDay`, `fetchFinanceDays`, `fetchGoalDays`, `evaluateGoals`, the cost-month rule as `costMonthsFor(range, compare, preset) => { current: string | null; previous: string | null }`, plus new `fetchBetleadsUsage`, `fetchBetleadsFees`, `fetchBetleadsSince`)
- Create: `src/lib/finance-dashboard.functions.ts`
- Modify: `src/lib/finance.functions.ts` (import the moved helpers; delete `getGroupOverviewFor`/`getGroupOverview` and the `overviewInput` schema)
- Test: `src/lib/finance-dashboard.functions.test.ts` (port the group-overview cases out of `src/lib/finance.functions.test.ts` and delete them there)

**Interfaces:**
- Consumes: `summarize`, `costBreakdown`, `categoryLabel`/`categoryKey` (Task 2); the SQL functions (Task 1).
- Produces:
  ```ts
  export type DashboardScope =
    | { kind: "tenant"; tenantId: string }
    | { kind: "group"; groupId: string }
    | { kind: "all" };
  export type DashboardInput = { scope: DashboardScope; range: DateRange; compare: CompareMode; preset: PeriodPreset };
  export type DashboardTenantRow = {
    id: string; nome: string;
    current: PeriodSummary; previous: PeriodSummary;
    goals: GoalEvaluation[];
    pendingDates: string[];     // past dates in the current window missing GGR or Anúncios
  };
  export type FinanceDashboard = {
    scope: DashboardScope; label: string;            // house name, group name or "Todas as casas"
    range: DateRange; compareRange: DateRange;
    totals: { current: PeriodSummary; previous: PeriodSummary };
    costs: CostLine[];
    months: MonthPoint[];                            // 12 points ending at the month of range.to
    tenants: DashboardTenantRow[];                   // one row for tenant scope
    betleadsSince: string | null;                    // earliest across the scope
    duplicateBetleadsCosts: number;                  // flagged other costs in the current cost month
  };
  export async function getFinanceDashboardFor(ctx: { userId: string }, data: DashboardInput): Promise<FinanceDashboard>;
  export const getFinanceDashboard; // createServerFn POST, requireSupabaseAuth, zod-validated
  export async function listDashboardScopesFor(ctx): Promise<{ groups: { id: string; nome: string }[]; tenants: { id: string; nome: string }[] }>; // super admin only
  export const listDashboardScopes;
  ```
- `months`: fetch `finance_days` once over `[first day of month(range.to) − 11 months, min(today, end of month(range.to))]` merged with the compare windows' span. Each month is summarized with that month's other costs, usage and fee. `betleadsMissing` = month is before the month of `betleadsSince` (or `betleadsSince` is null).
- A month's ggr-rate label in `costBreakdown`: tenant scope passes the rate of `range.to` (from the day rows); group/all pass `null`.
- `duplicateBetleadsCosts`: the count of other costs in the current cost month where `looksLikeBetleadsCost` holds and the month is ≥ the month of that house's `since`.

- [ ] **Step 1: Write failing tests** (same `createFakeDb` style as `src/lib/finance.functions.test.ts`; register fake RPCs for the three new SQL functions):
  - `tenant scope month total equals the month view total`: same fixture → `dashboard.totals.current.cashResult === (await getTenantFinanceMonthFor(...)).summary.cashResult`. Task 4 makes the month view include Betleads, so this test pins both.
  - `Betleads usage enters any window; fee only a closed month`: preset `7d` → `betleadsFee === null`, `betleadsUsage` = sum of the window; preset `month` → fee = that month's invoice.
  - `months has 12 points, oldest first, flags incomplete and betleadsMissing`.
  - `group scope sums houses and lists one row per house`; `all scope excludes demo and inactive houses`.
  - `empty group and all-with-no-houses return zeros and empty arrays`.
  - `permissions`: group manager → tenant outside their groups rejects `Sem permissão`; house admin → group scope rejects; non-super-admin → `all` rejects; gestor without grant → tenant scope rejects.
  - `duplicateBetleadsCosts counts an "SMS" other cost only from the since month on`.
  - `costs merges categories with the same name across houses`.
- [ ] **Step 2: Run** `npx vitest run src/lib/finance-dashboard.functions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the helpers first and keep `src/lib/finance.functions.test.ts` green. Then write `getFinanceDashboardFor`, generalizing the body of `getGroupOverviewFor` (tenant set by scope → windows → one `Promise.all` of days, goals, other costs, usage, fees, since). Zod input: `scope` is a discriminated union on `kind` using `dbUuid()`. `range`/`compare`/`preset` reuse the `dateRange` schema (move it to `finance-data.server.ts`).
- [ ] **Step 4: Run** `npx vitest run src/lib/finance-dashboard.functions.test.ts src/lib/finance.functions.test.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(finance): dashboard server function for house, group and all scopes`.

### Task 4: Server — month view and other costs carry Betleads and categories

**Files:**
- Modify: `src/lib/finance.functions.ts` (`getTenantFinanceMonthFor`, `saveOtherCostFor` + `saveOtherCostInput`)
- Test: `src/lib/finance.functions.test.ts`

**Interfaces:**
- Consumes: `fetchBetleadsUsage`/`fetchBetleadsFees`/`fetchBetleadsSince` (Task 3), `looksLikeBetleadsCost`, `categoryLabel`, `mergeCategories`, `FIXED_COST_CATEGORIES` (Task 2).
- Produces (additions to the `getTenantFinanceMonthFor` result):
  ```ts
  summary: PeriodSummary;                                  // now with betleads usage of the month + fee of the month
  otherCosts: { id: string; descricao: string; valor: number; categoria: string; suspectedBetleads: boolean }[];
  categories: string[];                                    // mergeCategories(FIXED, every categoria the house ever used)
  ```
  `saveOtherCostInput` gains `categoria: z.string().trim().min(1).max(60).nullable().optional()`, stored through `categoryLabel`, with `"Outros"` stored as null.

- [ ] **Step 1: Write failing tests**: `month summary deducts the month's Betleads usage and fee`; `other costs return categoria (null → "Outros") and suspectedBetleads only from the since month on`; `categories lists fixed first then the house's own`; `saveOtherCost stores a new category and it shows in categories next month`.
- [ ] **Step 2: Run** `npx vitest run src/lib/finance.functions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Distinct used categories: `select categoria from tenant_finance_other_costs where tenant_id = … and categoria is not null`, deduplicated in TS.
- [ ] **Step 4: Run** the same command plus `npx vitest run src/lib/finance-dashboard.functions.test.ts`. Expected: PASS, including the "month total equals" test from Task 3.
- [ ] **Step 5: Commit** `feat(finance): Betleads cost and categories in the month view and other costs`.

### Task 5: Dashboard UI components

**Files:**
- Create: `src/components/finance/dashboard/finance-dashboard.tsx` (composes the parts below from a `FinanceDashboard`)
- Create: `src/components/finance/dashboard/kpi-cards.tsx`, `profit-trend-chart.tsx`, `cost-breakdown.tsx`, `pending-banner.tsx`, `tenant-profit-table.tsx`, `scope-picker.tsx`
- Test: `src/components/finance/dashboard/kpi-cards.test.tsx`, `cost-breakdown.test.tsx`, `pending-banner.test.tsx`

**Interfaces:**
- Consumes: `FinanceDashboard`, `DashboardScope` (Task 3); `GroupPeriodBar`, `GroupPeriod`, `defaultGroupPeriod` (`src/components/group/group-period-bar.tsx`); `GroupScoreboard` (`src/components/group/group-scoreboard.tsx`).
- Produces:
  ```ts
  export function FinanceDashboardView(props: {
    initialScope: DashboardScope;
    canPickScope: boolean;                       // super admin
    onOpenTenant?: (tenantId: string) => void;   // group/all: row click
    onLaunchPending?: (firstDate: string) => void; // tenant scope: "Lançar agora"
  }): JSX.Element;
  ```
  It owns the period state (`defaultGroupPeriod`) and the scope state, and queries `getFinanceDashboard` with key `["finance-dashboard", scope, period]`.
- Layout (mockup, spec §5–§6), top to bottom:
  - `ScopePicker` (only with `canPickScope`): label "Ver:", options "Todas as casas", then groups, then houses, from `listDashboardScopes`.
  - `GroupPeriodBar`, with a new optional prop `monthPicker?: boolean` (true here). It adds an `<Input type="month">` after the chips; picking a month sets `{ preset: "custom", range: whole month (to clamped by the server), compare: "previous" }`. Since that is a whole calendar month, the compare window is the previous month and other costs and fee enter (spec §5.1: a month selector, defaulting to the current month).
  - `PendingBanner`: tenant scope shows "Faltam N dias de lançamento (12, 18, 19). O lucro está incompleto." + button "Lançar agora" → `onLaunchPending(first date)`. Group/all show "Casas com dias faltando: A (3), B (1)". A second amber line appears when `duplicateBetleadsCosts > 0`: "Pode haver custo Betleads contado duas vezes. Revise em Outros custos."
  - `KpiCards`: highlighted Lucro líquido, Retorno (ROI), Investido em anúncios; then Net, FTDs, Custo por FTD. Money and count cards show `formatPct(pctChange)`. ROI shows `formatPp(ppChange)`. Costs (anúncios, custo por FTD) invert the color, the same rule as `group-totals.tsx`.
  - `ProfitTrendChart` (recharts `BarChart`): tenant scope → one bar per month, negative bars red, the in-progress month lighter, incomplete months with a dashed outline and "incompleto" in the tooltip; group/all → stacked by tenant (`byTenant`). The tooltip shows lucro, anúncios and ROI. When `betleadsMissing` is set on any visible month, add the note "Sem dado de custo Betleads antes de {mês de betleadsSince}".
  - `CostBreakdown`: one row per `CostLine`, with a proportional bar, `formatBRL`, variation, and an "automático" badge when `auto`.
  - `TenantProfitTable` (group/all only): Casa, Lucro, ROI, Anúncios, Δ lucro; sortable by header; row click → `onOpenTenant`.
  - `GroupScoreboard` below (group/all only), fed from `dashboard.tenants` (`ScoreboardRow` shape: `id, nome, current, previous, goals`).
  - Mobile: cards one column under `sm`, tables in `overflow-x-auto`.
- [ ] **Step 1: Write failing tests** (testing-library, like `group-scoreboard.test.tsx`): `KpiCards shows ▲ green when profit rises and red ▲ when ad spend rises`; `KpiCards shows n.a. for null ROI`; `CostBreakdown renders rows in given order with the automático badge only on Betleads`; `PendingBanner lists dates and calls onLaunchPending with the first one`; `PendingBanner shows the duplicate warning when duplicateBetleadsCosts > 0`.
- [ ] **Step 2: Run** `npx vitest run src/components/finance/dashboard`. Expected: FAIL.
- [ ] **Step 3: Implement** the components.
- [ ] **Step 4: Run** the same command plus `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(finance): dashboard components`.

### Task 6: House page — Painel tab, Lançamentos and categorized other costs

**Files:**
- Modify: `src/routes/financeiro.tsx`, `src/routes/grupo_.casa.tsx`
- Modify: `src/components/finance/finance-month-grid.tsx`, `src/components/finance/finance-other-costs.tsx`
- Test: `src/components/finance/finance-other-costs.test.tsx` (new)

**Interfaces:**
- Consumes: `FinanceDashboardView` (Task 5); month view fields `categories`, `otherCosts[].categoria/suspectedBetleads`, `summary.betleadsUsage/betleadsFee` (Task 4).
- `/financeiro` `validateSearch`: `{ tab?: "painel" | "lancamentos" | "outros-custos" | "configuracoes"; month?: "YYYY-MM"; dia?: "YYYY-MM-DD" }`. The default tab is `painel`. Tabs are controlled by `tab`.
- `FinanceMonthView` gains `initialMonth?: string` and `focusDate?: string` (scrolls that row into view and gives it a ring).
- `/grupo/casa` gets the same tabs, read-only: Painel (`initialScope = { kind: "tenant", tenantId }`) and Lançamentos (`readOnly`).

- [ ] **Step 1: Write failing tests** for `FinanceOtherCosts`, mocking the server fns: `category select lists fixed then house categories and accepts a new name`; `a suspected Betleads cost shows "parece duplicado com o custo Betleads automático" and a remove button`; `typing "SMS" in the description shows "o custo Betleads já entra sozinho"`.
- [ ] **Step 2: Run** `npx vitest run src/components/finance/finance-other-costs.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Tabs `Painel | Lançamentos | Outros custos | Configurações`. The Painel's `onLaunchPending(date)` navigates to `?tab=lancamentos&month=<date YYYY-MM>&dia=<date>`. `canPickScope` = `active.role === "super_admin"`.
  - Grid: the Anúncios and GGR cells get `bg-primary/5`. The summary strip gains a "Betleads" cell (`betleadsUsage + (betleadsFee ?? 0)`) before "Resultado do mês".
  - Other costs: a Categoria combobox (existing `Command`/`Popover` from `src/components/ui`) with the option to type a new one; a Categoria column in the table; the duplicate badge and the typing hint.
- [ ] **Step 4: Run** the test, `npm run typecheck`, then `npm run dev` and check `/financeiro` on the demo house (see the demo-tenant memory for the login): the Painel shows the cards, the chart and the costs; "Lançar agora" opens the right day; the layout holds at 375 px width.
- [ ] **Step 5: Commit** `feat(finance): house Painel tab, Lançamentos focus and other-cost categories`.

### Task 7: Group page and super-admin scope

**Files:**
- Modify: `src/routes/grupo.tsx`, `src/lib/navigation.ts` (label "Painel do grupo" → "Financeiro do grupo")
- Delete: `src/components/group/group-totals.tsx` (superseded by `KpiCards`); delete its test if one exists
- Test: `src/lib/navigation.test.ts` (label assertion, if present)

**Interfaces:**
- Consumes: `FinanceDashboardView` (Task 5).
- `/grupo` renders `FinanceDashboardView` with `initialScope = { kind: "group", groupId: active.id }`, `canPickScope` for super admins, and `onOpenTenant` → `/grupo/casa?tenant=…`. When the active group changes in the header switcher, the scope resets to it (key the component by `active.id`).
- In `all` scope, `onOpenTenant` for the super admin switches the picker to that house (tenant scope) instead of navigating.

- [ ] **Step 1: Update** `navigation.test.ts` for the new label and run `npx vitest run src/lib/navigation.test.ts`. Expected: FAIL.
- [ ] **Step 2: Implement** the route and the nav label. Remove the dead `getGroupOverview` imports.
- [ ] **Step 3: Run** `npm test` and `npm run typecheck`. Expected: PASS. Then in `npm run dev` as super admin: `/grupo` shows the "Ver:" picker; "Todas as casas" lists every active non-demo house; clicking a row opens that house's dashboard.
- [ ] **Step 4: Commit** `feat(finance): group page uses the dashboard; super admin picks all/group/house`.

### Task 8: Demo seed

**Files:**
- Modify: `scripts/demo/seed-demo-finance.mjs`
- Test: `scripts/demo/seed-demo-finance.db.test.ts`

**Interfaces:**
- Other costs: replace `CRM`/`SMS` with categorized rows for each seeded month, for example `{ descricao: "Influenciador X", categoria: "Afiliados e influenciadores" }` and `{ descricao: "Equipe de atendimento", categoria: "Equipe" }`. No seeded cost matches `looksLikeBetleadsCost`.
- Betleads cost: for each seeded day, insert one `usage_reservation` ledger row for the demo house with `created_at` at 12:00 São Paulo that day and a deterministic amount (`uniform(80, 200, key)`). Precede them with a `purchase` row covering the total, so `balance_after` stays ≥ 0, and update `tenant_wallets` to match. One `paid` invoice per seeded month (`amount_cents` 400000, `period_start` = the 1st). Idempotency keys and ids come from `seededUuid`, so a reset does not duplicate rows.
- History: default `days` becomes 365. The seed still only covers days that have `tenant_daily_metrics` rows, so the chart shows as many months as the demo has metrics.

- [ ] **Step 1: Extend the db test**: after seeding, `finance_betleads_usage` returns one row per seeded day; `billing_wallet_integrity()` (if it is part of the loaded schema) reports nothing; no other cost has a Betleads-like description; seeding twice gives the same row counts.
- [ ] **Step 2: Run** `npx vitest run scripts/demo/seed-demo-finance.db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(demo): seed Betleads cost, categories and a year of finance history`.

### Task 9: Whole-branch verification

- [ ] **Step 1:** `npm test`. Expected: every test passes (count ≥ today's suite).
- [ ] **Step 2:** `npm run typecheck` and `npm run lint`. Expected: no errors.
- [ ] **Step 3:** `npm run build`. Expected: success, with no `*.server` module in the client bundle.
- [ ] **Step 4:** Update the spec status line to "implementado (branch feat/financeiro-painel)" and commit `docs: finance dashboard implemented`.
- [ ] **Step 5:** Report the prod rollout order to the user. Do not run it. Apply migration `20261103100000_finance_dashboard.sql` (needs explicit ok), then deploy the app, then run the demo reset.
