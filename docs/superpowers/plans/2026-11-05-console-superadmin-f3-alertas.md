# Console do superadmin — F3 Alertas com ciclo de vida e resumo diário: plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Os alertas técnicos da aba Saúde passam a ter memória: abrem, são vistos de novo, fecham sozinhos quando o problema some, podem ser **reconhecidos** ou **silenciados por 24 h**, e ficam num **histórico de 30 dias**. Críticos novos geram **e-mail imediato** aos superadmins (no máximo 1 por alerta a cada 6 h) e todo dia às **8h (BRT)** sai um **resumo** por e-mail.

**Architecture:** Uma tabela `platform_alerts` guarda o estado de cada alerta pela chave (`PlatformAlert.key`, já estável desde F1). Um cron de 5 min chama uma rota que recalcula os alertas com o mesmo loader da aba Saúde (sem o cache e sem o check de superadmin), reconcilia com a tabela (regras puras), manda e-mail dos críticos novos e apaga resolvidos com mais de 30 dias. Outro cron às 11:00 UTC monta o resumo (alertas abertos, casas vermelhas/amarelas, devedores) e envia uma vez por dia (tabela `platform_digest_log`). A aba Saúde mostra o estado guardado (desde quando, reconhecido, silenciado) e os botões; o histórico abre num painel.

**Tech Stack:** TypeScript, TanStack Start, Supabase (pg_cron + pg_net + vault, como `20261022110100_billing_reconcile_cron.sql`), Infobip e-mail via `sendPlatformEmail` (`src/lib/billing/billing-emails.server.ts:53`), Vitest + PGlite.

**Spec:** `docs/superpowers/specs/2026-11-05-console-superadmin-design.md` §7.

Worktree `C:\Users\Carol\Desktop\betleads-synchealth`, branch `feat/alertas-plataforma` (de origin/main 3f428c6).

## Global Constraints

- Duas migrações, **criadas mas nunca aplicadas** pelos implementadores: `20261212100000_platform_alerts.sql` (tabelas) e `20261212100100_platform_alerts_cron.sql` (crons). O controller aplica com ok do usuário; a de cron só depois do deploy.
- Tabelas sem acesso de `anon`/`authenticated` (RLS ligada, sem policies, `revoke all`); toda leitura/escrita é server-side com `supabaseAdmin`, depois de `assertSuperAdmin` nas server functions de UI e de `requireSharedSecret(request, "CRON_SECRET")` nas rotas de cron.
- **E-mail desligado por padrão:** só envia quando `PLATFORM_ALERTS_EMAIL_ENABLED === "true"`. Com a flag desligada o ciclo de vida funciona igual (abre/fecha/reconhece) e nada sai por e-mail. Destinatários: e-mails dos usuários com `user_roles.role = 'super_admin'` (via `supabaseAdmin.auth.admin.getUserById`, como `getPayerEmails` em `billing-emails.server.ts:221`). Remetente e envio: `sendPlatformEmail` com `idempotencyKey`.
- Limites como constantes exportadas: `CRITICAL_RENOTIFY_MS = 6 h`, `SILENCE_HOURS = 24`, `HISTORY_DAYS = 30`, digest às `11:00 UTC` (= 08:00 BRT).
- Textos pt-BR; e-mails HTML no mesmo padrão inline dos e-mails de cobrança (`escapeHtml`, card simples), com link para `https://betleads.io/admin#saude` (usar o helper de URL pública que os e-mails de cobrança usam, se houver).
- Casas demo nunca aparecem (o loader de F1 já filtra).
- `morning-check` e `system_alerts` não mudam (rota não agendada e sem leitor; os robôs já são cobertos pelas regras de F1). *(Ruling do controller.)*
- `npm run build` verde na verificação final.

## Review Focus

1. Cron roda duas vezes ao mesmo tempo (atraso do pg_cron) → nunca dois alertas abertos com a mesma chave (índice único parcial + upsert), nunca dois e-mails do mesmo crítico na janela. Testes nas Tasks 1 e 3.
2. Alerta silenciado que volta a ser visto → continua silenciado até `silenced_until`; depois disso volta a notificar (se crítico). Teste na Task 2.
3. Problema some e volta depois → o alerta antigo está resolvido; um novo é aberto (novo `opened_at`), e o crítico notifica de novo. Teste na Task 2.
4. Uma fonte do loader falha (alerta `source:*`) → é tratada como qualquer alerta (abre/fecha), e não resolve em massa os outros alertas. Teste na Task 3 (a reconciliação só resolve chaves ausentes quando o loader rodou; alertas de fonte que falhou não resolvem as chaves daquele tipo — ver Task 2).
5. Resumo diário disparado duas vezes no mesmo dia → só um e-mail (claim em `platform_digest_log`). Teste na Task 4.

---

### Task 1: Migração das tabelas

**Files:**
- Create: `supabase/migrations/20261212100000_platform_alerts.sql`
- Test: `src/lib/platform-health/platform-alerts.db.test.ts` (PGlite, padrão de `src/lib/billing/billing-month-usage.db.test.ts` / `billing-db-test-support.ts`)

**Interfaces:**
- Produces (SQL):
  ```sql
  public.platform_alerts (
    id uuid primary key default gen_random_uuid(),
    alert_key text not null,
    kind text not null,
    severity text not null check (severity in ('critical','warning')),
    message text not null,
    tenant_id uuid null references public.tenants(id) on delete cascade,
    href text null,
    opened_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    seen_count integer not null default 1,
    resolved_at timestamptz null,
    acknowledged_at timestamptz null,
    acknowledged_by uuid null,
    silenced_until timestamptz null,
    last_notified_at timestamptz null
  );
  create unique index platform_alerts_one_open_per_key on public.platform_alerts (alert_key) where resolved_at is null;
  create index platform_alerts_resolved_idx on public.platform_alerts (resolved_at) where resolved_at is not null;
  public.platform_digest_log (digest_day date primary key, sent_at timestamptz not null default now(), recipients integer not null default 0);
  ```
  Both: `alter table … enable row level security;` no policies; `revoke all … from anon, authenticated;` `grant all … to service_role;`. Header comment: purpose, "só cria tabelas; pode ser aplicada antes do deploy".
- [ ] **Step 1: Write the failing db test:** a second open row with the same `alert_key` fails (unique violation); a resolved row + a new open row with the same key is allowed; `authenticated` and `anon` cannot select/insert either table; `service_role` can; `platform_digest_log` primary key rejects a second row for the same day.
- [ ] **Step 2: Run** `npx vitest run src/lib/platform-health/platform-alerts.db.test.ts` — Expected: FAIL.
- [ ] **Step 3: Write the migration.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin): platform_alerts and platform_digest_log tables`

### Task 2: Regras puras de reconciliação e notificação

**Files:**
- Create: `src/lib/platform-health/alert-lifecycle.ts`
- Test: `src/lib/platform-health/alert-lifecycle.test.ts`

**Interfaces:**
- Consumes: `PlatformAlert` (`src/lib/platform-health/alert-rules.ts`).
- Produces:
  ```ts
  export type StoredAlert = {
    id: string; alertKey: string; kind: string; severity: "critical" | "warning"; message: string;
    tenantId: string | null; href: string | null; openedAt: string; lastSeenAt: string; seenCount: number;
    acknowledgedAt: string | null; silencedUntil: string | null; lastNotifiedAt: string | null;
  };
  export type AlertSyncPlan = {
    open: PlatformAlert[];                                   // keys not stored yet → insert
    seen: Array<{ id: string; alert: PlatformAlert }>;       // stored and present → update message/severity/href, last_seen_at, seen_count+1
    resolve: string[];                                       // stored ids absent now → resolved_at = now
  };
  export const CRITICAL_RENOTIFY_MS: number; // 6 h
  export const SILENCE_HOURS: number;        // 24
  export const HISTORY_DAYS: number;         // 30
  export function planAlertSync(stored: StoredAlert[], current: PlatformAlert[], failedKinds: Set<string>): AlertSyncPlan;
  export function isSilenced(a: Pick<StoredAlert, "silencedUntil">, now: Date): boolean;
  export function shouldNotify(a: Pick<StoredAlert, "severity" | "acknowledgedAt" | "silencedUntil" | "lastNotifiedAt">, now: Date): boolean;
  ```
- `failedKinds`: kinds whose data source failed this round (derived by the caller from `source:*` alerts: map source name → alert kind; unknown → none). A stored alert of a failed kind that is absent now is **not** resolved (Review Focus 4).
- `shouldNotify`: severity critical AND not acknowledged AND not silenced AND (`lastNotifiedAt` null OR older than `CRITICAL_RENOTIFY_MS`).
- [ ] **Step 1: Write the failing tests:** new key → `open`; same key stored → `seen`; stored key absent → `resolve`; absent but kind in `failedKinds` → not resolved; `shouldNotify` table: warning → false; critical new → true; notified 2 h ago → false; 7 h ago → true; acknowledged → false; silenced until tomorrow → false; silence expired → true (Review Focus 2); resolved-then-reopened is just a new `open` (Review Focus 3, the resolved row is not in `stored`).
- [ ] **Step 2: Run** `npx vitest run src/lib/platform-health/alert-lifecycle.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin): alert lifecycle rules`

### Task 3: Sincronização no servidor, e-mail de crítico e rota de cron

**Files:**
- Create: `src/lib/platform-health/alert-store.server.ts`
- Create: `src/lib/platform-health/alert-email.server.ts`
- Create: `src/routes/api/public/hooks/platform-alerts.ts`
- Modify: `src/lib/platform-health/platform-health.server.ts` (export `computePlatformHealth(now: Date): Promise<PlatformHealth>` = today's private `loadPlatformHealth`, no auth, no cache; `adminPlatformHealthFor` keeps using it)
- Test: `src/lib/platform-health/alert-store.server.test.ts`, `src/lib/platform-health/alert-email.server.test.ts`

**Interfaces:**
- Consumes: Task 2; `computePlatformHealth`; `sendPlatformEmail` (`src/lib/billing/billing-emails.server.ts:53`); `requireSharedSecret` (`src/lib/cron-auth.server.ts`); `startJobRun` (`src/lib/observability/job-monitor.server.ts`) for a `platform_alerts` job row.
- Produces:
  ```ts
  // alert-store.server.ts
  export async function loadOpenAlerts(): Promise<StoredAlert[]>;
  export async function syncPlatformAlerts(now: Date): Promise<{ opened: number; seen: number; resolved: number; notified: number; purged: number }>;
  export async function acknowledgeAlert(alertKey: string, userId: string, current: PlatformAlert | null, now: Date): Promise<void>;
  export async function silenceAlert(alertKey: string, current: PlatformAlert | null, now: Date): Promise<void>; // silenced_until = now + SILENCE_HOURS
  export async function listAlertHistory(now: Date): Promise<StoredAlert[] & { resolvedAt?: string }[]>; // last HISTORY_DAYS, newest first, max 200
  // alert-email.server.ts
  export async function listSuperAdminEmails(): Promise<string[]>;
  export function criticalAlertEmail(alerts: StoredAlert[]): { subject: string; html: string };
  export async function notifyCriticalAlerts(alerts: StoredAlert[], now: Date): Promise<number>; // returns e-mails sent; no-op unless PLATFORM_ALERTS_EMAIL_ENABLED === "true"
  ```
- `syncPlatformAlerts`: `computePlatformHealth(now)` → `loadOpenAlerts()` → `planAlertSync` → apply (insert with `on conflict` on the partial unique index doing nothing, so two concurrent runs never duplicate; updates by id; resolves by id) → reload the open rows that `shouldNotify` → `notifyCriticalAlerts` (one e-mail listing all of them) → set `last_notified_at = now` on those rows **before** sending (claim, like `claimWalletAlert`) using an update guarded by the same `last_notified_at` value read (so a concurrent run's claim wins once) → delete resolved rows older than `HISTORY_DAYS` (batch of 500).
- `acknowledgeAlert` / `silenceAlert`: if no open row for the key exists yet (cron hasn't run), insert it from `current` first; then update. Unknown key with `current` null → throw "Alerta não encontrado."
- Route `POST /api/public/hooks/platform-alerts`: `requireSharedSecret(request, "CRON_SECRET")`, `startJobRun("platform_alerts")`, run `syncPlatformAlerts(new Date())`, finish with counters, return JSON; on error `run.fail(error)` and 500. Same shape as `src/routes/api/public/hooks/billing-reconcile.ts`.
- [ ] **Step 1: Write the failing tests** (fake db `createFakeDb`, `computePlatformHealth` and `sendPlatformEmail` mocked): first sync inserts 2 alerts; second sync with one gone resolves it and bumps `seen_count` of the other; two concurrent `syncPlatformAlerts` calls produce one open row per key and one e-mail (Review Focus 1); flag off → no e-mail, `last_notified_at` untouched; flag on → one e-mail to every super-admin address with all notifiable criticals; acknowledge/silence before the first sync creates the row; route rejects a wrong secret with 401.
- [ ] **Step 2: Run** `npx vitest run src/lib/platform-health/alert-store.server.test.ts src/lib/platform-health/alert-email.server.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those tests + `src/lib/platform-health/platform-health.server.test.ts` + `npx tsc --noEmit -p .` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin): platform alert sync, critical e-mail and cron route`

### Task 4: Resumo diário

**Files:**
- Create: `src/lib/platform-health/daily-digest.ts` (pure builder)
- Create: `src/lib/platform-health/daily-digest.server.ts`
- Create: `src/routes/api/public/hooks/platform-digest.ts`
- Test: `src/lib/platform-health/daily-digest.test.ts`, `src/lib/platform-health/daily-digest.server.test.ts`

**Interfaces:**
- Consumes: `computePlatformHealth`, `loadOpenAlerts`, `listSuperAdminEmails`, `sendPlatformEmail`; for debtors, the Financeiro geral pieces: `summarizeBillingStates` inputs are expensive to rebuild — instead read `tenant_billing` (`tenant_id, access_state`) + open `billing_invoices` (`tenant_id, amount_cents, due_date`) for the health houses and call `summarizeBillingStates` (`src/lib/billing/billing-state-summary.ts`) with the current month.
- Produces:
  ```ts
  // daily-digest.ts
  export type DigestInput = { day: string; openAlerts: StoredAlert[]; houses: HouseHealthRow[]; debtors: Debtor[]; owedCents: number };
  export function buildDailyDigest(input: DigestInput): { subject: string; html: string };
  // daily-digest.server.ts
  export async function runDailyDigest(now: Date): Promise<{ sent: boolean; reason?: "already_sent" | "disabled" | "no_recipients"; recipients: number }>;
  ```
- Subject: `BetLeads — resumo de DD/MM: N alertas, M casas em vermelho` (counts in pt-BR). Sections: Alertas abertos (críticos primeiro; silenciados listados à parte como "silenciados"), Casas em vermelho/amarelo (nome + motivo), Quem está devendo (nome, valor, dias), link "Abrir a aba Saúde". Empty sections say "Nada aqui hoje."
- `runDailyDigest`: flag off → `{sent:false, reason:"disabled"}` without claiming; else claim today's BRT day in `platform_digest_log` (insert, conflict → `already_sent`), then send one e-mail per recipient (`idempotencyKey` `platform-digest:<day>:<index>`), update `recipients`.
- Route `POST /api/public/hooks/platform-digest`: same pattern as Task 3's route, job name `platform_digest`.
- [ ] **Step 1: Write the failing tests:** builder renders the three sections and the empty text; subject counts; HTML escapes a house name with `<script>`; runner: flag off → disabled; second run same day → `already_sent` and no e-mail (Review Focus 5); no super admins → `no_recipients`.
- [ ] **Step 2: Run** `npx vitest run src/lib/platform-health/daily-digest` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; `npx tsc --noEmit -p .` clean.
- [ ] **Step 5: Commit** `feat(admin): daily platform digest e-mail`

### Task 5: Aba Saúde com estado, ações e histórico

**Files:**
- Modify: `src/lib/platform-health/platform-health.server.ts` (`PlatformHealth.alerts` entries gain `stored: { openedAt: string; acknowledgedAt: string | null; silencedUntil: string | null } | null`, joined from `loadOpenAlerts()` by key; `since` prefers `stored.openedAt` when the rule gave none)
- Create: `src/lib/platform-health/platform-alerts.functions.ts` — `adminAcknowledgeAlert({ key })`, `adminSilenceAlert({ key })`, `adminAlertHistory()`; each `assertSuperAdmin` first; ack/silence look up the current computed alert (from `computePlatformHealth` via the same 60 s cache as the tab — reuse `adminPlatformHealthFor`) to pass as `current`.
- Modify: `src/components/admin/platform-health/health-alerts-strip.tsx`, `platform-health-tab.tsx`
- Test: extend `src/components/admin/platform-health/platform-health-tab.test.tsx`; `src/lib/platform-health/platform-alerts.functions.test.ts`

UI rules:
- Each alert row gets two small buttons: **Reconhecer** and **Silenciar 24 h** (stop propagation so the row link still works).
- Acknowledged alerts: muted row with "reconhecido"; still listed.
- Silenced alerts: hidden from the main list; a line `N silenciados até HH:MM — mostrar` expands them.
- "Histórico (30 dias)" button opens a panel/dialog listing resolved alerts: message, aberto em, resolvido em, duração.
- After an action, invalidate `["admin-platform-health"]`.
- [ ] **Step 1: Write the failing tests:** buttons render; acknowledged row shows "reconhecido"; silenced alert hidden and counted in the "silenciados" line; history panel lists resolved alerts with duration; server functions reject non-super-admin; ack on a computed-but-unstored alert creates it.
- [ ] **Step 2: Run** `npx vitest run src/components/admin/platform-health src/lib/platform-health/platform-alerts.functions.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those + `src/lib/platform-health` + `npx tsc --noEmit -p .` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(admin): acknowledge, silence and history for platform alerts`

### Task 6: Migração dos crons + verificação (controller)

- [ ] Create `supabase/migrations/20261212100100_platform_alerts_cron.sql`: unschedule-if-exists then `cron.schedule('betleads-platform-alerts', '*/5 * * * *', …/api/public/hooks/platform-alerts…)` and `cron.schedule('betleads-platform-digest', '0 11 * * *', …/api/public/hooks/platform-digest…)`, same body as `20261022110100_billing_reconcile_cron.sql` (vault `betleads_cron_secret`, `Authorization: Bearer`). Header: "aplicar depois do deploy".
- [ ] `npx vitest run --maxWorkers=2` — only the month-dependent `seed-demo-finance` may fail.
- [ ] `npm run build` — exit 0.
- [ ] Read-only production check of `computePlatformHealth` + `planAlertSync` against an empty store (what would open on the first run).
