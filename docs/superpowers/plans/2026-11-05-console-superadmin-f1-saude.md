# Console do superadmin — F1 Saúde: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nova aba **Saúde** (primeira e padrão) em `/admin`: faixa de alertas técnicos (6 tipos) + tabela de todas as casas com cadastros, FTDs, conversão e recuperação CRM dos últimos 7 dias contra a própria base.

**Architecture:** Regras puras (situação da casa e alertas) em `src/lib/platform-health/`, testadas com tabelas de casos. Um loader server-side lê as fontes existentes em paralelo (cada uma com timeout, falha vira alerta "não foi possível verificar"), aplica as regras e guarda o resultado 60 s em memória. Uma server function GET superadmin expõe o resultado; a aba React mostra faixa + tabela e recarrega a cada 60 s.

**Tech Stack:** TypeScript, TanStack Start (`createServerFn`), React Query, Supabase (`supabaseAdmin`), Vitest, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-05-console-superadmin-design.md` (§5 é esta fase). Leia antes de começar.

Worktree: `C:\Users\Carol\Desktop\betleads-synchealth`, branch `feat/console-superadmin`.

## Global Constraints

- Sem migração nesta fase. Se alguma leitura exigir função SQL nova, **pare e reporte** (migração em produção precisa de ok do usuário).
- Toda leitura cross-house só depois de `assertSuperAdmin(ctx.userId)` (`src/lib/billing/billing-health.server.ts:412`).
- Casas demo (`tenants.is_demo = true`) fora de tudo. Casas `status = 'canceled'` fora.
- Fuso de dia: America/Sao_Paulo. "Últimos 7 dias" = D−7..D−1 (até ontem); base = D−35..D−8, dividida por 4 (média semanal).
- Recuperação = `crm_influenced_revenue` de `finance_activity_days` (nunca somar com `crm_direct_revenue`). Valor na moeda da casa (`tenants.moeda`, padrão BRL), formatado com `formatMoney` de `src/lib/currency.ts`.
- Cadastros/FTDs = `registrations`/`ftds` de `finance_days` via `fetchFinanceDays` (`src/lib/finance/finance-data.server.ts:305`).
- Textos da UI em pt-BR; números com `toLocaleString("pt-BR")`; variação com sinal "−" (U+2212) e "+".
- Tema escuro; tokens semânticos (`text-muted-foreground`, `bg-card`); tabela rola na horizontal dentro do card em telas estreitas.
- Todos os limites ficam em constantes exportadas (`HEALTH_THRESHOLDS`, `ALERT_THRESHOLDS`, `JOB_EXPECTED_PERIOD_S`) para ajuste fácil.
- `npm run build` verde antes de concluir (vazamento de `*.server` no bundle).

## Review Focus

1. Casa pequena (base < volume mínimo) com queda grande em % → deve ficar **verde** (a regra não vale), nunca vermelha. Teste na Task 1.
2. Casa com base zero e movimento atual (casa nova) → "sem histórico", sem divisão por zero nem "Infinity%". Teste na Task 1.
3. Casa em ARS → recuperação formatada em ARS e limite mínimo de recuperação aplicado na moeda dela, sem converter. Teste na Task 1 (motivo) e Task 4 (célula).
4. Uma fonte quebrada (RPC com erro ou timeout) → a tela abre com as outras fontes e um alerta ATENÇÃO "Não foi possível verificar …". Teste na Task 3.
5. Job que só grava execução quando tem trabalho (`sms_campaign_dispatch`) parado à noite → nenhum alerta de "sem execução". Teste na Task 2.

---

### Task 1: Situação da casa (regras puras)

**Files:**
- Create: `src/lib/platform-health/house-health.ts`
- Test: `src/lib/platform-health/house-health.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type HouseDay = { date: string; registrations: number; ftds: number; recovered: number };
  export type HouseHealthInput = { tenantId: string; name: string; moeda: string; days: HouseDay[] };
  export type HealthLevel = "red" | "yellow" | "green" | "no_history";
  export type HouseWindowTotals = { registrations: number; ftds: number; recovered: number; conversion: number | null };
  export type HouseHealthRow = {
    tenantId: string; name: string; moeda: string; level: HealthLevel; reason: string | null;
    current: HouseWindowTotals; base: HouseWindowTotals; // base = média semanal
    deltas: { registrationsPct: number | null; ftdsPct: number | null; conversionPts: number | null; recoveredPct: number | null };
  };
  export type HealthWindows = { current: { from: string; to: string }; base: { from: string; to: string } };
  export const HEALTH_THRESHOLDS: {
    redPct: -50; yellowPct: -25; redConvPts: -10; yellowConvPts: -5;
    minBaseRegistrations: 20; minBaseFtds: 10; minBaseRecovered: 500; minHistoryWeeks: 3;
  };
  export function healthWindows(todaySaoPaulo: string): HealthWindows;
  export function summarizeHouse(input: HouseHealthInput, windows: HealthWindows): HouseHealthRow | null; // null = casa sem movimento
  export function sortHouses(rows: HouseHealthRow[]): HouseHealthRow[];
  ```

- [ ] **Step 1: Write the failing tests** (`house-health.test.ts`), using a helper that builds 35 days of `HouseDay` from a per-week total (spread evenly) for the base weeks and the current week:
  - `healthWindows("2026-11-05")` → `{ current: { from: "2026-10-29", to: "2026-11-04" }, base: { from: "2026-10-01", to: "2026-10-28" } }`.
  - ForrandoBet-like: base 636 cadastros/semana e 218 FTDs/semana, atual 107 e 57 → `level "red"`, `deltas.registrationsPct ≈ -83.2`, `reason` = `"Cadastros −83% (107 vs ~636/semana)"`.
  - Conversão: base 430 cad/278 FTD (64,7%), atual 1614/846 (52,4%) → `conversionPts ≈ -12.3`, `level "red"`, reason começa com `"Conversão −12 pts"`.
  - Amarelo: cadastros −30% com base 100/semana → `"yellow"`.
  - Volume mínimo: base 10 cadastros/semana, atual 1 → `"green"` e `reason null` (Review Focus 1).
  - Casa nova: base com cadastros em só 1 das 4 semanas, atual 196 → `"no_history"`, `deltas.registrationsPct null` (Review Focus 2).
  - Sem movimento: tudo zero → `summarizeHouse` retorna `null`.
  - Recuperação: base 10.000/semana, atual 4.000, `moeda "ARS"` → `"red"`, reason contém `"Recuperação −60%"` e o valor formatado em ARS (Review Focus 3).
  - Pior regra vence: cadastros −30% (amarelo) e FTDs −60% (vermelho) → reason fala de FTDs.
  - `sortHouses`: ordem red, yellow, green, no_history; dentro do grupo, a maior queda (menor delta entre as métricas que valem) primeiro.

- [ ] **Step 2: Run** `npx vitest run src/lib/platform-health/house-health.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `house-health.ts`. Use `addDays` (or the date helpers in `src/lib/finance/`) for the windows, with plain `YYYY-MM-DD` strings. Base totals are the 28-day sum ÷ 4. A history week counts when its 7-day cadastro sum is > 0. Percent delta = `(current − base) / base × 100`, `null` when base is 0. Conversion = ftds ÷ registrations × 100, `null` when registrations is 0. Reason formats:
  - `Cadastros −83% (107 vs ~636/semana)`, `FTDs −74% (57 vs ~218/semana)`
  - `Conversão −12 pts (52,4% vs 64,7%)`
  - `Recuperação −60% (ARS 4.000 vs ~ARS 10.000/semana)` (use `formatMoney(value, moeda)`).

- [ ] **Step 4: Run** the same command — Expected: PASS.

- [ ] **Step 5: Commit** `feat(admin): house health rules for the super admin console`

### Task 2: Regras de alerta técnico (puras)

**Files:**
- Create: `src/lib/platform-health/alert-rules.ts`
- Test: `src/lib/platform-health/alert-rules.test.ts`

**Interfaces:**
- Consumes: `BillingHealthReport` type from `src/lib/billing/billing-health.server.ts` (import the type only: `import type`).
- Produces:
  ```ts
  export type AlertSeverity = "critical" | "warning";
  export type AlertKind = "job" | "webhook" | "queue" | "provider" | "runway" | "billing" | "source";
  export type PlatformAlert = {
    key: string; kind: AlertKind; severity: AlertSeverity; message: string;
    tenantId: string | null; since: string | null; href: string;
  };
  export type JobHealthRow = { job: string; last_started_at: string | null; last_status: string | null;
    seconds_since_last_start: number | null; stale_running: number; oldest_running_heartbeat_at: string | null;
    runs_last_hour: number; failed_last_hour: number; partial_last_hour: number };
  export type WebhookStats = { tenantId: string; name: string; lastEventAt: string | null;
    /** Estimated from the last ≤200 events of the past 7 days (see Task 3). */
    eventsPerDay: number; errors24h: number };
  export type QueueMetricRow = { tenant_id: string; channel: string; ready: number; paused: number;
    oldest_ready_age_seconds: number | null; sent_15m: number; errors_15m: number };
  export type BreakerRow = { channel: string; state: string; reason: string | null; first_opened_at: string | null };
  export type RateStateRow = { channel: string; last_provider_error: string | null; backoff_until: string | null };
  export type ShortioRunRow = { started_at: string; claimed: number; rate_limited: number };
  export type RunwayRow = { tenant_id: string; tenant_name: string; runway_hours: number | string };
  export const JOB_EXPECTED_PERIOD_S: Record<string, number>;
  export const ALERT_THRESHOLDS: { /* values below */ };
  export function jobAlerts(rows: JobHealthRow[], now: Date): PlatformAlert[];
  export function webhookAlerts(stats: WebhookStats[], now: Date): PlatformAlert[];
  export function queueAlerts(rows: QueueMetricRow[], names: Map<string, string>): PlatformAlert[];
  export function providerAlerts(input: { breakers: BreakerRow[]; rateStates: RateStateRow[]; shortioRuns: ShortioRunRow[] }, now: Date): PlatformAlert[];
  export function runwayAlerts(rows: RunwayRow[]): PlatformAlert[];
  export function billingAlerts(report: BillingHealthReport): PlatformAlert[];
  export function sourceFailureAlert(source: string): PlatformAlert; // warning, kind "source"
  export function sortAlerts(alerts: PlatformAlert[]): PlatformAlert[]; // critical first, then oldest `since` first (null last)
  ```
- Thresholds (spec §5.2): job stale = `stale_running > 0`; job late = `seconds_since_last_start > 3 × JOB_EXPECTED_PERIOD_S[job]`; webhook silence = `max(2 h, 6 × 86400/eventsPerDay)`, critical at ≥ 100 events/day, warning at ≥ 20/day, error rate `errors24h / eventsPerDay` > 5% with `eventsPerDay ≥ 50`; queue critical `oldest_ready_age_seconds > 1800` with `ready > 0` and `paused = 0`, warning > 600 or error share > 20% with ≥ 20 attempts; runway critical < 6 h, warning < 24 h (reuse `RUNWAY_URGENT_HOURS` / `RUNWAY_ALERT_HOURS` from `src/lib/billing/wallet-alerts.server.ts` only if importing them keeps this file free of server-only imports; otherwise copy the values with a comment pointing there); Short.io warning when the last 6 runs have `Σ rate_limited / Σ claimed > 0.2`.
- Hrefs: job/queue/provider → `/admin#canais`; webhook → `/webhooks`; runway → `/admin#saldo`; billing → `/admin#faturamento`. `tenantId` set when the alert is about one house (the UI switches house before following a house-scoped href).
- Keys: `job:<job>`, `webhook:<tenantId>:silence|errors`, `queue:<tenantId>:<channel>`, `provider:breaker:<channel>`, `provider:rate:<channel>`, `provider:shortio`, `runway:<tenantId>`, `billing:<code>`, `source:<name>`.

- [ ] **Step 0 (done by the controller, 05/11 — use these values):** measured over 48 h, every job below wrote rows in every hour; use `billing-cycle` 3600, `billing-reconcile` 300, `dashboard_metrics_refresh` 300, `email_tick` 60, `journey_dispatch` 60, `journey_level_outbox` 60, `journey_scan` 60, `recovery` 60, `shortio_sync` 300, `sms_tick` 60, `tenant_domains_verify` 600, `webhook_replay` 300. `sms_campaign_dispatch` wrote rows in only 10 of 48 hours and stays out. Original instruction, for reference: confirm job cadences in production (read-only). Connect as in the `db-access-pooler` notes (session pooler, `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`) and run:
  `select job, date_trunc('hour', started_at at time zone 'America/Sao_Paulo') h, count(*) from dispatcher_runs where started_at > now() - interval '48 hours' group by 1,2 order by 1,2;`
  Fill `JOB_EXPECTED_PERIOD_S` only with jobs that write a row on every tick **at every hour** (from the 05/11 snapshot: `email_tick`, `sms_tick`, `journey_dispatch`, `journey_scan`, `journey_level_outbox`, `recovery` ≈ 60 s; `billing-reconcile`, `shortio_sync` ≈ 300 s; `webhook_replay` ≈ 180 s; `tenant_domains_verify` ≈ 600 s; `billing-cycle` ≈ 3600 s; `dashboard_metrics_refresh` ≈ 300 s). Leave out any job with hours without rows, and always leave out `sms_campaign_dispatch` (writes only when it claims a campaign).

- [ ] **Step 1: Write the failing tests** — one `describe` per rule, cases:
  - jobs: stale row → critical `job:sms_tick`; `shortio_sync` last start 20 min ago → critical (late); `failed_last_hour 2` → warning; `sms_campaign_dispatch` last start 15 h ago → **no alert** (Review Focus 5); unknown job late → no alert.
  - webhook: `eventsPerDay 1000`, last event 3 h ago → critical; same house, last event 30 min ago → none; Sorte-da-Bet-like `eventsPerDay 10`, last event 14 h ago → **none**; `eventsPerDay 200` with `errors24h 20` → warning `…:errors`.
  - queue: age 2000 s, ready 5, paused 0 → critical; paused 3 → none; 15 min 30 sent + 10 errors → warning.
  - provider: breaker `open`/`no_balance` on `sms` → critical with message mentioning Short Brasil; `backoff_until` in the future with error text → warning; 6 Short.io runs with 600 claimed / 150 rate_limited → warning `provider:shortio`; 6 runs with 600/30 → none.
  - runway: 4 h → critical; 12 h → warning; 30 h → none.
  - billing: each finding becomes an alert with the same severity and message, href `/admin#faturamento`.
  - `sortAlerts`: critical before warning; older `since` first; `since null` last.

- [ ] **Step 2: Run** `npx vitest run src/lib/platform-health/alert-rules.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** `alert-rules.ts`. Messages are short pt-BR sentences naming the house, e.g. `ForrandoBet sem webhook há 3 h (normal: a cada ~2 min)`, `Robô shortio_sync sem rodar há 20 min (esperado a cada 5 min)`, `Short.io: 25% dos links adiados por limite de chamadas — todas as casas`, `Short Brasil sem saldo: envio de SMS suspenso`. Map job names to readable labels where obvious (`sms_tick` → "Disparo de SMS"); unknown names show as is.

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit** `feat(admin): technical alert rules for the super admin console`

### Task 3: Loader server-side

**Files:**
- Create: `src/lib/platform-health/platform-health.server.ts`
- Create: `src/lib/platform-health/platform-health.functions.ts`
- Test: `src/lib/platform-health/platform-health.server.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2 exports; `assertSuperAdmin`, `checkBillingHealth` (`billing-health.server.ts`); `fetchFinanceDays`, `fetchActivityDays`, `todaySaoPaulo` (`finance-data.server.ts`); `supabaseAdmin`.
- Produces:
  ```ts
  export type PlatformHealth = {
    checkedAt: string; window: HealthWindows["current"];
    alerts: PlatformAlert[]; houses: HouseHealthRow[];
    quietHouses: Array<{ tenantId: string; name: string }>;
  };
  export async function adminPlatformHealthFor(ctx: { userId: string }, opts?: { now?: Date; fresh?: boolean }): Promise<PlatformHealth>;
  export function __resetPlatformHealthCacheForTests(): void;
  // platform-health.functions.ts
  export const adminPlatformHealth: /* createServerFn GET + requireSupabaseAuth → adminPlatformHealthFor(context) */;
  ```
- Sources (all in parallel, each wrapped in a helper `fromSource<T>(name, promise, fallback, timeoutMs = 8000)` that on error/timeout pushes `sourceFailureAlert(name)` and returns the fallback):
  - houses: `tenants` select `id,nome,moeda,status,is_demo` where `is_demo = false` and `status <> 'canceled'`.
  - `fetchFinanceDays(ids, base.from..current.to)` and `fetchActivityDays(ids, same)` → `HouseDay[]` per house.
  - `rpc("observability_job_health")`, `rpc("observability_queue_metrics")`.
  - `provider_circuit_breakers` (`channel,state,reason,first_opened_at`; missing table → `[]`), `dispatch_rate_state` (`channel,last_provider_error,backoff_until`).
  - `dispatcher_runs` where `job = 'shortio_sync'` order `started_at desc` limit 6 (`started_at,claimed,rate_limited`).
  - `rpc("billing_runway_alert_candidates", { _after: null, _limit: 500, _hours: 24 })`.
  - `checkBillingHealth({ windowHours: 24, now })` (never throws; its findings go through `billingAlerts`).
  - webhook stats per house (concurrency 4): the last 200 `webhook_logs.created_at` of the past 7 days (order desc limit 200; index-only scan, ~0.05 ms) and the 24 h `status = 'erro'` count (`count: "exact", head: true`, served by `webhook_logs_tenant_status_created_idx`). `lastEventAt` = newest; `eventsPerDay` = `n / 7` when fewer than 200 rows, else `200 / (newest − oldest in days)`. Put this estimate in an exported pure function `estimateEventsPerDay(createdAtDesc: string[], now: Date): number` in `alert-rules.ts`'s neighbour `platform-health.server.ts` and test it (fewer than 200 → n/7; 200 rows spanning 2 days → 100).
- Cache: module-level `{ at, value }`; reuse when `now − at < 60 s` and `!opts.fresh`.

- [ ] **Step 0 (done by the controller, 05/11):** a 7-day exact count took 1.06 s for Sorte Alta (57k rows; betgreen has 106k), the latest-event read 0.04 ms. Hence the 200-event sample above instead of exact counts. Nothing to run.

- [ ] **Step 1: Write the failing tests** with `createFakeDb` (`src/lib/sms-bulk.test-support.ts`) mocked as `@/integrations/supabase/client.server`, `is_super_admin` RPC handler returning true, and `checkBillingHealth` mocked:
  - non-super-admin → rejects with the forbidden message, no other read made.
  - two houses + one demo house → `houses`/`quietHouses` never contain the demo house; a house with all-zero days goes to `quietHouses`.
  - `observability_job_health` RPC returns an error → result still has `houses`, and `alerts` contains `source:observability_job_health` warning (Review Focus 4).
  - second call within 60 s returns the cached object without new RPC calls; `fresh: true` bypasses the cache.
  - alerts come out sorted (`sortAlerts`).

- [ ] **Step 2: Run** `npx vitest run src/lib/platform-health/platform-health.server.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** both files. `platform-health.functions.ts` follows `src/lib/billing/billing-health.functions.ts` (only `createServerFn` exports, logic in the `.server.ts`).

- [ ] **Step 4: Run** — Expected: PASS. Also `npx tsc --noEmit -p .` — Expected: no output.

- [ ] **Step 5: Commit** `feat(admin): platform health loader for the super admin console`

### Task 4: Aba Saúde em /admin

**Files:**
- Create: `src/components/admin/platform-health/platform-health-tab.tsx`
- Create: `src/components/admin/platform-health/health-alerts-strip.tsx`
- Create: `src/components/admin/platform-health/house-health-table.tsx`
- Test: `src/components/admin/platform-health/platform-health-tab.test.tsx`
- Modify: `src/routes/admin.tsx:136-160` (`AdminView`, `ADMIN_VIEWS`, `viewFromHash` default) and `:233-242` (panel switch)

**Interfaces:**
- Consumes: `adminPlatformHealth` (Task 3), `PlatformHealth`, `PlatformAlert`, `HouseHealthRow`.
- Produces: `export function PlatformHealthTab(): JSX.Element`; `export function HealthAlertsStrip(props: { alerts: PlatformAlert[]; checkedAt: string; onOpen: (alert: PlatformAlert) => void })`; `export function HouseHealthTable(props: { houses: HouseHealthRow[]; quietHouses: PlatformHealth["quietHouses"]; window: PlatformHealth["window"]; onOpenHouse: (tenantId: string) => void })`.

- [ ] **Step 1: Write the failing tests** with `renderToStaticMarkup`, mocking `@tanstack/react-query` (`useQuery` → mutable state) and `useServerFn: fn => fn`, as in `src/components/admin/provider-accounts-panel.test.tsx`:
  - no alerts → text `Tudo funcionando — verificado às` is present.
  - one critical + one warning → `CRÍTICO` appears before `ATENÇÃO` and both messages render.
  - house rows render in the given order with the reason text; a red house shows its reason (`Cadastros −83% (107 vs ~636/semana)`).
  - ARS house shows recovery formatted in ARS (Review Focus 3).
  - `quietHouses` render as one summary line `+ 2 casas sem movimento (A, B)`.
  - footer `Últimos 7 dias até 04/11 contra a média das 4 semanas anteriores. Casas demo fora.` for `window.to = "2026-11-04"`.
  - loading state renders the pulse placeholder; error state renders `Não foi possível carregar a saúde das casas.`

- [ ] **Step 2: Run** `npx vitest run src/components/admin/platform-health` — Expected: FAIL.

- [ ] **Step 3: Implement** the three components and wire the tab:
  - `ADMIN_VIEWS` gets `{ value: "health", label: "Saúde", hash: "saude" }` **first**; `viewFromHash` falls back to `"health"`; `setView` fallback hash `"saude"`.
  - `PlatformHealthTab`: `useQuery({ queryKey: ["admin-platform-health"], queryFn: () => fn(), refetchInterval: 60_000 })`.
  - Alert row: severity tag, message, "desde" relative time (`há 3 h`, `desde 29/10`), whole row clickable → `onOpen`.
  - Table: columns Casa · Cadastros · FTDs · Conversão · Recuperação CRM; each cell = value + delta (red for negative beyond yellow threshold, green positive, muted otherwise; "novo" when delta is null and level is `no_history`); colored dot by `level`; reason under the house name in `text-xs text-muted-foreground`.
  - Opening a house or a house-scoped alert: `localStorage.setItem("betleads:active-tenant", tenantId)` then `window.location.assign(href)` (same mechanism as `src/components/active-tenant-switcher.tsx:95`); house rows go to `/resultados`.
  - Wrap the table in `overflow-x-auto` inside its card.

- [ ] **Step 4: Run** `npx vitest run src/components/admin/platform-health src/lib/platform-health` and `npx tsc --noEmit -p .` — Expected: PASS / no output.

- [ ] **Step 5: Commit** `feat(admin): Saúde tab with house health and technical alerts`

### Task 5: Verificação final

- [ ] **Step 1:** `npx vitest run` — Expected: only the `.db.test` files that already fail on clean main fail (consent-suppression, finance-exempt-provider-cost, finance-monthly-ggr, finance-other-costs-dated, tenant-groups, seed-demo-finance); nothing under `platform-health`, `admin`, `navigation` fails.
- [ ] **Step 2:** `npm run build` — Expected: `✓ built`.
- [ ] **Step 3:** Run `adminPlatformHealthFor` once against production, read-only, from a scratch script with the real env (bypass `assertSuperAdmin` only in that script) and check it against the 05/11 snapshot: ForrandoBet and Sorte da Bet red for cadastros; PixReals red for conversion; Sorte da Bet **without** a webhook silence alert; no alert for `sms_campaign_dispatch`. Paste the alert list and the first 5 house rows into the final report.
- [ ] **Step 4: Commit** any fix found in Step 3 with its own test.
