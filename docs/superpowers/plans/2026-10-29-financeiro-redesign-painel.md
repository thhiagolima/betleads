# Financeiro — redesign do painel (F1–F5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the finance panel readable. Split send cost by channel with quantities and separate the mensalidade. Show sends per day. Add the missing KPIs (movimentação, aquisição, GGR, envios/CRM). Replace the 13-column grid with a day list plus a day modal. Give "outros custos" a date and an optional monthly repeat.

**Architecture:** Two new SQL migrations add read functions (sends by channel; daily activity from metrics, CRM and Meta) plus the dated/recurring other costs with a daily materialization cron. Pure TS modules compute the KPIs and the net-to-profit waterfall. Both server functions (month view, dashboard) expose the new data through the existing chunked fetchers. The UI rebuilds the dashboard body and the Lançamentos tab on top of these.

**Tech Stack:** TanStack Start (`createServerFn`), Supabase/Postgres (pg_cron), zod, React, TanStack Query, recharts 2.15, vitest + PGlite (no jsdom: component tests use `renderToStaticMarkup`; click logic goes in exported pure helpers).

**Spec:** `docs/ESCOPO_AUDITORIA_FINANCEIRO_2026-10-29.md` (decisions in §4), on top of `docs/superpowers/specs/2026-10-27-financeiro-painel-design.md`.

## Global Constraints

- All UI copy is pt-BR. Money: `formatBRL`. Ratios and percentages: `formatPct`/`formatRatio`. Counts: `formatInt` (`src/components/finance/format.ts`). A missing value renders `n.a.`.
- One name per number in every screen (spec §3.6): **Lucro líquido**, **Net (depósitos − saques)**, **GGR (Perdas na casa)**, **Taxa de GGR**, **Taxa de movimentação**, **Envios**, **Mensalidade**, **Outros custos**.
- Channels and labels: `sms` → "SMS" (unit "envios"), `voice_30s` → "Voz" (unit "blocos de 30 s"), `email` → "E-mail" (unit "e-mails").
- Provider costs (spec §4.1): SMS R$ 0,059; voz R$ 0,034 por 30 s; e-mail R$ 0,0004. These are registered in prod `billing_price_book` by the user, **not by this plan**. Ledger rows with a null `provider_unit_cost` for an exempt house mean "custo do provedor não cadastrado". Never show them as R$ 0.
- The mensalidade enters only a closed month or the "Mês" preset (spec §4.3). Outros custos enter any window that contains their date (spec §3.5).
- CRM return (spec §4.2): show both receita direta and receita influenciada, each with its own retorno = receita ÷ custo de Envios (null when the cost is 0).
- ROI reference (spec §4.5): the previous calendar month of `range.to`. While that month is in progress, cut at the same day (use `compareRange(monthRange, "previous", "month")`).
- Anti-goal stays: for the same month and scope, the dashboard's Lucro líquido equals the Lançamentos total. Extend the existing "tenant scope month total equals the month view total" test whenever the math changes.
- Writes refuse the demo house (`assertTenantNotDemo`). Read = `finance_can_view`. Write = `finance_can_edit_values`.
- New SQL functions are `stable security definer`, `set search_path = public`, and executable by `service_role` only (`revoke all … from public, anon, authenticated; grant execute … to service_role`).
- Every new RPC goes through `planRpcChunks`/`RPC_ROW_BUDGET` (`src/lib/finance/finance-data.server.ts`) so no response reaches the PostgREST 1000-row cap. Pass the per-house-per-day row count honestly. For example, sends by channel is ≤ 3 rows per house per day.
- Migrations: `supabase/migrations/20261113100000_finance_sends_activity.sql` and `supabase/migrations/20261113100100_finance_other_costs_dated.sql`. Both must be applied in prod **before** the deploy. Applying them is not part of this plan.
- Verification before handing off: `npm test`, `npm run typecheck`, `npm run lint` (0 errors), `npm run build`.

## Review Focus

1. **Exempt house with sends whose provider cost is null** (voz and e-mail before the user registers the prices) → the channel shows quantity plus "custo do provedor não cadastrado", and its cost is excluded, not R$ 0 presented as real. Test in Task 1 (SQL returns `missing_cost_units`) and Task 2 (`sendLines`).
2. **A recurring cost created on the 31st** → in a 30-day month or in February it materializes on the month's last day. Running the cron twice the same day creates nothing new. Test in Task 4.
3. **Zero divisors**: no deposits → ticket médio `n.a.`; no Pix gerado → conversão `n.a.`; no envio cost → retorno `n.a.`; no impressions → CPM/CTR hidden. Never `Infinity`/`NaN`. Test in Task 2.
4. **An other cost dated inside a 7-day window** now enters that window's Lucro líquido, while the mensalidade still does not. Test in Task 3.
5. **Day modal "próximo dia" on the last day of the month or on today** → the button is disabled, with no navigation into the future or another month. Test in Task 6 (pure helper).

---

### Task 1: SQL — sends by channel and daily activity

**Files:**
- Create: `supabase/migrations/20261113100000_finance_sends_activity.sql`
- Test: `src/lib/finance-sends-activity.db.test.ts` (follow `src/lib/finance-exempt-provider-cost.db.test.ts`)

**Interfaces:**
- Produces (service_role only):
  - `public.finance_send_usage(_tenants uuid[], _from date, _to date) returns table (tenant_id uuid, metric_date date, item text, units bigint, amount numeric, missing_cost_units bigint)`
    - One row per house × São Paulo day × `item`, over `usage_reservation`/`usage_refund` ledger rows. The window filter and `select distinct unnest(_tenants)` are as in `finance_betleads_usage` (`20261112100000`).
    - `units` = Σ reservation units − Σ refund units.
    - `amount`: paying house = −Σ amount; exempt house (`billing_tenant_exempt`) = Σ ± units × provider_unit_cost over rows **with** a cost.
    - `missing_cost_units` = for an exempt house, net units of rows whose `provider_unit_cost` is null; 0 for paying houses.
  - `public.finance_activity_days(_tenants uuid[], _from date, _to date) returns table (tenant_id uuid, metric_date date, deposit_count int, depositor_count int, withdrawal_count int, generated_pix_count int, crm_sent int, crm_clicks int, crm_direct_conversions int, crm_direct_revenue numeric, crm_influenced_revenue numeric, ad_impressions bigint, ad_clicks bigint)`
    - Exactly one row per house × day (`generate_series`, like `finance_days`). Columns are left-joined and coalesced to 0.
    - Counts come from `tenant_daily_metrics`.
    - CRM: Σ over `crm_results_daily` (`sent`, `human_clicks`, `direct_conversions`, `direct_revenue`, `influenced_revenue`) per house and day.
    - Meta: Σ `marketing_ad_metrics_daily.impressions` and `coalesce(link_clicks, clicks)` where `provider = 'meta'`.
  - `finance_betleads_usage` is left untouched; the server stops calling it in Task 3.

- [ ] **Step 1: Write failing tests**
  - `send usage splits by channel with units and amount`: a paying house with sms (−0,08 × 10, refund +0,08 × 2) and email rows on the same SP day → rows `(sms, units 8, amount 0.64)` and `(email, …)`.
  - `exempt house uses provider cost and reports missing-cost units`: voice reservation units 4 with null cost and sms units 10 at 0.059 → `(voice_30s, units 4, amount 0, missing_cost_units 4)` and `(sms, units 10, amount 0.59, missing 0)`.
  - `activity days returns one row per day with zeros`: 3-day window, metrics only on day 2 → 3 rows, day 2 carries counts.
  - `activity days sums crm_results_daily rows and meta metrics per day`.
  - `duplicate tenant ids do not double rows`; `authenticated and anon cannot execute`.
- [ ] **Step 2:** `npx vitest run src/lib/finance-sends-activity.db.test.ts --hookTimeout=60000` → FAIL (file missing).
- [ ] **Step 3:** Write the migration.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(finance): SQL for sends by channel and daily activity`.

### Task 2: Pure KPIs, send lines and waterfall

**Files:**
- Create: `src/lib/finance/kpis.ts`, `src/lib/finance/kpis.test.ts`
- Modify: `src/lib/finance/types.ts`, `src/lib/finance/calc.ts` (`costBreakdown`)

**Interfaces:**
- Produces in `types.ts`:
  ```ts
  export type SendItem = "sms" | "voice_30s" | "email";
  export type SendUsage = { item: SendItem; units: number; amount: number; missingCostUnits: number };
  export type DayActivity = { depositCount: number; depositorCount: number; withdrawalCount: number; generatedPixCount: number;
    crmSent: number; crmClicks: number; crmDirectConversions: number; crmDirectRevenue: number; crmInfluencedRevenue: number;
    adImpressions: number; adClicks: number };
  export type SendLine = { item: SendItem; label: string; unitLabel: string; units: number; amount: number;
    unitCost: number | null; previousAmount: number | null; missingCost: boolean };
  export type FinanceKpis = {
    margin: number | null;                 // cashResult / net
    ticketMedio: number | null;            // depositAmount / depositCount
    saqueMedio: number | null;             // withdrawalAmount / withdrawalCount
    depositorsPerDay: number | null;       // Σ depositorCount / days
    withdrawalShare: number | null;        // withdrawalAmount / depositAmount
    pixConversion: number | null;          // depositCount / generatedPixCount
    registrationToFtd: number | null;      // ftds / registrations
    ftdMedio: number | null;               // ftdDepositAmount / ftds
    ggrShareOfDeposits: number | null;     // ggr / depositAmount
    cpm: number | null; ctr: number | null; costPerClick: number | null; // only when adImpressions > 0, else null
    sendCost: number;                      // Σ SendUsage.amount
    crmDirectRevenue: number; crmInfluencedRevenue: number;
    crmDirectReturn: number | null;        // crmDirectRevenue / sendCost
    crmInfluencedReturn: number | null;    // crmInfluencedRevenue / sendCost
  };
  export type WaterfallStep = { key: string; label: string; kind: "start" | "down" | "up" | "subtotal" | "total"; start: number; end: number };
  ```
  `CostLineKey` gains `"sends" | "fee"` and loses `"betleads"`.
- Produces in `kpis.ts`:
  - `sumActivity(days: DayActivity[]): DayActivity`
  - `sendLines(current: SendUsage[], previous: SendUsage[] | null): SendLine[]` (one line per channel present, in the order SMS, Voz, E-mail; `unitCost = amount / units` when units > 0 and not `missingCost`)
  - `computeKpis(summary: PeriodSummary, activity: DayActivity, sends: SendUsage[], days: number): FinanceKpis`
  - `waterfallSteps(summary: PeriodSummary, sendCost: number, categories: Record<string, number>): WaterfallStep[]`. Steps in order:
    1. Depósitos (start)
    2. Saques (down)
    3. Net (subtotal)
    4. Taxa de GGR (down)
    5. Taxa de movimentação (down)
    6. Anúncios (down)
    7. Envios (down)
    8. Mensalidade (down; omitted when `betleadsFee` is null)
    9. one step per other-cost category (down)
    10. Lucro líquido (total)

    Zero-amount down steps are omitted. The total's `end` must equal `summary.cashResult` (assert in a test).
- `costBreakdown` (calc.ts): replace the `betleads` line with **"Envios"** (`key "sends"`, `auto: true`, amount = `betleadsUsage`) and **"Mensalidade"** (`key "fee"`, `auto: true`, amount = `betleadsFee ?? 0`, dropped when null and previous null). Drop the `exemptHouse` option and `betleadsCostLabel`. The exempt explanation moves to the Envios block (Task 7).

- [ ] **Step 1: Write failing tests** in `kpis.test.ts`:
  - `computeKpis divides correctly`: depositAmount 1000, depositCount 4 → ticketMedio 250; ftds 5, registrations 20 → registrationToFtd 0.25; cashResult 30, net 300 → margin 0.1.
  - `zero divisors give null, never Infinity or NaN` (each ratio above with a 0 denominator, cpm/ctr with 0 impressions).
  - `crm returns use send cost and are null with zero cost`.
  - `sendLines orders channels, computes unit cost and flags missing provider cost`.
  - `waterfall ends at cashResult and omits Mensalidade when fee is null`.
  - Update `calc.test.ts` for the Envios/Mensalidade lines.
- [ ] **Step 2:** `npx vitest run src/lib/finance` → FAIL.
- [ ] **Step 3:** Implement. Fix every compile error (`npm run typecheck`) caused by the removed `betleads` key and label helper.
- [ ] **Step 4:** Same command plus typecheck → PASS.
- [ ] **Step 5:** Commit `feat(finance): KPIs, send lines and net-to-profit waterfall`.

### Task 3: Server — sends, activity and KPIs in the dashboard and the month view

**Files:**
- Modify: `src/lib/finance/finance-data.server.ts`, `src/lib/finance-dashboard.functions.ts`, `src/lib/finance.functions.ts`
- Test: `src/lib/finance-dashboard.functions.test.ts`, `src/lib/finance.functions.test.ts`

**Interfaces:**
- Consumes: Task 1 RPCs; Task 2 `sumActivity`, `sendLines`, `computeKpis`, `waterfallSteps`.
- Produces:
  - `fetchSendUsage(tenantIds, range)` (≤ 3 rows per house-day) and `fetchActivityDays(tenantIds, range)` (1 row per house-day), both chunked.
  - Usage passed to `summarize` = Σ `fetchSendUsage` amount. It replaces `fetchBetleadsUsage` in both server functions.
  - `FinanceDashboard` gains:
    - `sends: SendLine[]`;
    - `kpis: { current: FinanceKpis; previous: FinanceKpis }`;
    - `waterfall: WaterfallStep[]`;
    - `roiReference: { roi: number | null; range: DateRange }`;
    - `exemptHouse: boolean` (tenant scope only; false otherwise).
  - `MonthPoint` gains `net` and `depositAmount`.
  - `DashboardTenantRow` gains `margin: number | null` and `sendCost: number`.
  - Month view (`getTenantFinanceMonthFor`) gains:
    - `sendsByDay: Record<string, SendUsage[]>`;
    - `activityByDay: Record<string, DayActivity>`;
    - `monthSends: SendLine[]`.
- Other costs keep their month-based selection in this task. Task 4 switches to dates.

- [ ] **Step 1: Write failing tests**:
  - `dashboard returns send lines per channel and envios equals summary.betleadsUsage`.
  - `kpis come from activity of the window`.
  - `roiReference is the previous month cut at the same day while in progress`.
  - `waterfall total equals totals.current.cashResult`.
  - `month view exposes sends and activity by day`.
  - Keep "tenant scope month total equals the month view total" passing.
  - Fake RPCs cap at 1000 rows like the existing ones.
- [ ] **Step 2:** `npx vitest run src/lib/finance-dashboard.functions.test.ts src/lib/finance.functions.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command plus typecheck → PASS.
- [ ] **Step 5:** Commit `feat(finance): sends, activity and KPIs in the finance server functions`.

### Task 4: Outros custos with date and optional monthly repeat

**Files:**
- Create: `supabase/migrations/20261113100100_finance_other_costs_dated.sql`
- Test: `src/lib/finance-other-costs-dated.db.test.ts`
- Modify: `src/lib/finance/finance-data.server.ts`, `src/lib/finance.functions.ts` (`saveOtherCost`, month view), `src/lib/finance-dashboard.functions.ts`, `src/lib/finance/calc.ts` (only if `otherCosts` becomes non-null), `scripts/demo/seed-demo-finance.mjs` (+ its db test)

**Interfaces:**
- SQL changes to `tenant_finance_other_costs`:
  - `cost_date date`: backfilled with `month`, then `not null`, with a check that `date_trunc('month', cost_date) = month` (`month` is kept for compatibility).
  - `repeat_monthly boolean not null default false`.
  - `series_id uuid` (null = no series; a materialized copy carries its origin's `series_id` or `id`).
  - `unique (series_id, month)` where `series_id` is not null.
- `public.finance_materialize_recurring_costs(_today date default (now() at time zone 'America/Sao_Paulo')::date) returns integer` (security definer, service_role):
  - For each series whose latest row has `repeat_monthly` and a month before `_today`'s month, it inserts one copy for `_today`'s month when `_today` ≥ the target day.
  - Target day = the original day of month, clamped to the month's last day.
  - The copy keeps `descricao`, `valor`, `categoria`, `repeat_monthly = true` and `created_by = null`.
  - Returns the count. It is idempotent through the unique index.
  - Scheduled with `cron.schedule('finance-recurring-costs', '10 3 * * *', $$select public.finance_materialize_recurring_costs()$$)`, following `20261023100100_billing_cycle_cron.sql`.
- `saveOtherCost` input:
  - drops `month`;
  - gains `costDate: "YYYY-MM-DD"` (≤ today + 0 days; required) and `repeatMonthly: boolean` (default false);
  - on create with `repeatMonthly`, sets `series_id = id`.
- Other costs enter a window when `cost_date` is inside the window. `costMonthsFor` now gates only the mensalidade. `PeriodSummary.otherCosts` becomes `number` (0 when none).
- Month view `otherCosts[]` gains `costDate` and `repeatMonthly`.
- Demo seed: costs get `cost_date` = the 5th of each month; the "Equipe" cost gets `repeat_monthly = true`.

- [ ] **Step 1: Write failing tests**:
  - SQL: `backfill sets cost_date to month`.
  - SQL: `materialize creates next month copy on the same day`.
  - SQL: `day 31 clamps to 30 and to Feb 28/29`.
  - SQL: `running twice creates nothing new`.
  - SQL: `turning repeat off on the latest stops the series`.
  - SQL: `not before the target day`.
  - Server: `a cost dated inside a 7d window enters cashResult; the fee does not`.
  - Server: `saveOtherCost requires costDate and rejects future dates`.
  - Update the anti-goal test.
- [ ] **Step 2:** Run `npx vitest run src/lib/finance-other-costs-dated.db.test.ts src/lib/finance.functions.test.ts src/lib/finance-dashboard.functions.test.ts scripts/demo --hookTimeout=60000` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(finance): dated other costs with optional monthly repeat`.

### Task 5: One name per number and "como calculamos"

**Files:**
- Create: `src/components/finance/definitions.ts` (+ test)
- Modify: `src/components/finance/finance-month-grid.tsx`, `src/components/group/group-goals-editor.tsx`, `src/components/group/group-scoreboard.tsx`, `src/components/finance/dashboard/*` (labels only)

**Interfaces:**
- `export const FINANCE_TERMS: Record<TermKey, { label: string; how: string }>`, with exactly these labels and explanations:
  - `cashResult`: "Lucro líquido". How: "Net menos taxa de GGR, taxa de movimentação, anúncios, envios, mensalidade (só no mês fechado) e outros custos."
  - `net`: "Net (depósitos − saques)". How: "Soma dos depósitos aprovados menos a soma dos saques aprovados."
  - `ggr`: "GGR (Perdas na casa)". How: "Valor lançado a partir do painel de GGR da plataforma; quando o mês usa o total acumulado, cada dia recebe uma estimativa proporcional ao net."
  - `ggrFee`: "Taxa de GGR". How: "GGR × a taxa da casa."
  - `movementFee`: "Taxa de movimentação". How: "A taxa da casa aplicada três vezes: sobre os depósitos, sobre os saques e sobre o net."
  - `sends`: "Envios". How: "Custo de SMS, voz e e-mail do período. Em casa isenta é o custo do provedor."
  - `fee`: "Mensalidade". How: "Valor do plano do mês; entra só no mês fechado."
  - `otherCosts`: "Outros custos". How: "Custos lançados com data; entram em qualquer período que contenha a data."
  - `roi`: "Retorno (ROI)". How: "Lucro líquido ÷ anúncios."
  - `margin`: "Margem". How: "Lucro líquido ÷ net."
- Rename visible labels: "Net bruto" → net label; "Resultado caixa"/"Resultado" → "Lucro líquido" in the grid, goal editor and scoreboard.

- [ ] **Step 1:** Test: `every term has a non-empty label and how; labels are unique`. Scoreboard markup test: `"Lucro líquido"` header present, `"Resultado"` absent.
- [ ] **Step 2:** `npx vitest run src/components/finance src/components/group` → FAIL.
- [ ] **Step 3:** Implement. A small `TermTooltip` that shows `how` on hover and tap, built on the existing `src/components/ui/tooltip.tsx`.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(finance): one name per number and how-we-calculate tooltips`.

### Task 6: Lançamentos — day list and day modal

**Files:**
- Create: `src/components/finance/day-list.tsx`, `src/components/finance/day-modal.tsx`, `src/components/finance/day-entry.ts` (pure helpers) + tests
- Modify: `src/components/finance/finance-month-grid.tsx` (becomes the list container; keep the GGR do mês block and the month summary), `src/routes/financeiro.tsx`, `src/routes/grupo_.casa.tsx` (read-only)

**Interfaces:**
- `day-entry.ts`:
  - `dayStatus(day: FinanceDay): "completo" | "falta anúncios" | "falta GGR" | "falta anúncios e GGR" | "estimado"`. "estimado" applies when `ggrEstimated` is set and ads are filled.
  - `neighborDays(dates: string[], current: string, today: string): { prev: string | null; next: string | null }`. Stays inside the month; next is null after the last date or after today.
  - `metaFillEntries(days: FinanceDay[]): { date: string; adSpend: number }[]` lists days with `adSpend === null` and `adSpendSuggested !== null`.
- **List row:** date, status chip, Net, Envios (Σ `sendsByDay[date]` amount), Lucro líquido. Clicking the row opens the modal. `dia` in the URL (Task 6 of the previous plan) opens the modal on that day.
- **Modal sections and copy:**
  1. **"Veio do CRM"**: cadastros, FTDs, valor de FTD, depósitos (R$ e quantidade), saques (R$ e quantidade), Net, envios por canal (quantidade e custo), gasto da Meta (if any).
  2. **"Você lança"**:
     - Anúncios, with the button "Usar valor da Meta (R$ X)" when there is a suggestion.
     - GGR (Perdas na casa). When the month has a total it is read-only, with "usando o total do mês".
     - "Outros custos deste dia": list plus an add form reusing Task 4's `saveOtherCost` with `costDate` = the day.
  3. **"Resultado do dia"**: a compact waterfall (`waterfallSteps` for the day).

  Buttons "Dia anterior" and "Próximo dia" (disabled per `neighborDays`), and "Salvar" (saves this day only via `saveFinanceDays` with one entry).
- Above the list: the button **"Usar gasto da Meta nos dias vazios"** (hidden when `metaFillEntries` is empty). It saves all of them in one `saveFinanceDays` call.
- Read-only (group manager on `/grupo/casa`, demo house): the modal shows values without inputs.
- Mobile: no horizontal scroll; the modal is a full-height sheet under `sm` (use `src/components/ui/sheet.tsx` there, `dialog.tsx` above).

- [ ] **Step 1:** Tests (pure + markup):
  - `dayStatus covers each case`.
  - `neighborDays stops at month end and at today`.
  - `metaFillEntries lists only empty days with a suggestion`.
  - Modal markup with fixture props shows the three section titles, the per-channel send lines and the disabled "Próximo dia" on today.
- [ ] **Step 2:** `npx vitest run src/components/finance` → FAIL.
- [ ] **Step 3:** Implement. The old 13-column table is removed.
- [ ] **Step 4:** Same command, `npm run typecheck`, `npm run build` → PASS.
- [ ] **Step 5:** Commit `feat(finance): Lançamentos as a day list with a day modal`.

### Task 7: Dashboard — result band, waterfall, KPI blocks, envios and CRM

**Files:**
- Create: `src/components/finance/dashboard/result-band.tsx`, `waterfall-chart.tsx`, `kpi-blocks.tsx`, `sends-block.tsx` + tests
- Modify: `src/components/finance/dashboard/finance-dashboard.tsx`, `profit-trend-chart.tsx` (metric toggle), `tenant-profit-table.tsx` (columns Margem, Envios); delete `kpi-cards.tsx` and `cost-breakdown.tsx` and their tests once replaced

**Interfaces:**
- Consumes: `FinanceDashboard` (Task 3), `FINANCE_TERMS` + `TermTooltip` (Task 5).
- Layout, top to bottom:
  1. **ResultBand:** Lucro líquido, Margem, Retorno (ROI) with "mês anterior: X" from `roiReference`, Anúncios. Each shows its variation and `TermTooltip`.
  2. **WaterfallChart** ("Do depósito ao lucro"): recharts stacked bars with a transparent base, from `waterfall`. Down steps red, subtotal/total neutral, the total green or red by sign.
  3. **KpiBlocks**: four titled blocks.
     - **Movimentação:** Depósitos (R$ e qtd), Depositantes por dia, Ticket médio, Saques (R$ e qtd), Saque médio, Net, Saques ÷ depósitos, Pix gerado → pago.
     - **Aquisição:** Anúncios, Cadastros, FTDs, Cadastro → FTD, Custo por cadastro, Custo por FTD, FTD médio; CPM, CTR and Custo por clique only when not null.
     - **GGR:** GGR, Taxa de GGR, GGR ÷ depósitos. The "GGR estimado a partir do total do mês." note sits in this block when `totals.current.ggrEstimated`.
     - **Envios e CRM:** `SendsBlock`.
  4. **SendsBlock:** one row per `SendLine` (canal, quantidade, custo, custo unitário, variação).
     - A line with `missingCost` shows "custo do provedor não cadastrado".
     - Then the total Envios, Receita direta + Retorno direto, Receita influenciada + Retorno influenciado.
     - Footnotes in the block: the "Sem dado de custo Betleads antes de …" note, and for `exemptHouse` "Casa isenta: custo do provedor (situação atual da casa)".
  5. **ProfitTrendChart:** toggle "Lucro líquido | Net | Depósitos" using the `MonthPoint` fields.
  6. Group/all: `TenantProfitTable` with Margem and Envios columns, then `GroupScoreboard`.
- Variation colors: costs and saques invert (as today).
- Mobile: blocks stack one column under `sm`.

- [ ] **Step 1:** Markup tests:
  - `ResultBand shows ROI with the previous-month reference`.
  - `SendsBlock shows each channel with quantity and the missing-cost text`.
  - `KpiBlocks hides Meta KPIs when null and shows n.a. for null ratios`.
  - `waterfall chart data keeps the step order`.
  - A pure helper `waterfallBars(steps)` for the chart's base/value arrays, unit-tested.
- [ ] **Step 2:** `npx vitest run src/components/finance` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/components/finance src/components/group`, `npm run typecheck`, `npm run lint`, `npm run build` → PASS.
- [ ] **Step 5:** Commit `feat(finance): dashboard with result band, waterfall and KPI blocks`.

### Task 8: Whole-branch verification and rollout notes

- [ ] **Step 1:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all pass. The known load-flaky `sms-campaign-dispatch.server.test.ts` timing test may be re-run alone.
- [ ] **Step 2:** Update `docs/ESCOPO_AUDITORIA_FINANCEIRO_2026-10-29.md` status to "implementado (branch …)" and commit `docs: finance redesign implemented`.
- [ ] **Step 3:** Report the rollout order to the user. Do not run it.
  1. Register the provider costs (voz 0.034, e-mail 0.0004) in `billing_price_book`.
  2. Apply `20261113100000` and `20261113100100`.
  3. Deploy.
  4. Demo reset.
