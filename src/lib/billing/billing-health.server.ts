// PG6-03: billing health monitor (panel and alerts).
//
// One check, `checkBillingHealth`, reads `billing_health_snapshot`
// (service_role RPC, migration 20261024100400) and turns it into findings,
// each with a stable code, a severity and a pt-BR message:
//
//   code                         severity  source
//   ---------------------------  --------  ------------------------------------------
//   webhook_invalid_signature    critical  billing_monitor_signals (webhook route)
//   charge_paid_not_credited     critical  payment_charges PAID, credited_at null > 10 min
//   charge_needs_review          warning   payment_charges needs_review, not credited
//   wallet_ledger_mismatch       critical  billing_wallet_integrity()
//   upper_feature_disabled       critical  billing_monitor_signals (upper-pix client)
//   upper_unauthorized           critical  billing_monitor_signals (upper-pix client)
//   upper_unavailable            critical  billing_monitor_signals (upper-pix client): 3+
//                                          timeouts, network errors or 5xx in the window
//   reconcile_cron_stale         critical  dispatcher_runs job billing-reconcile (5 min)
//   billing_cycle_cron_stale     critical  dispatcher_runs job billing-cycle (1 h)
//   billing_health_check_failed  critical  the snapshot itself could not be read
//   billing_alert_test           critical  synthetic, from the superadmin button
//
// Findings never carry secrets, payloads, balances or supplier cost: only
// counts, times and fixed reasons.
//
// Alerting (`runBillingHealthStage`, run by the 5-minute reconcile job):
// critical findings go to Sentry (one issue per code, via fingerprint) when
// the server Sentry client is active, otherwise to console.error with the
// fixed `[billing-alert]` prefix for Better Stack log alerts. The
// `billing-health` Better Stack heartbeat
// (BETTERSTACK_HEARTBEAT_BILLING_HEALTH) is pinged only when no job/DB-state
// finding is critical, so a missing ping means the job stopped or billing
// state is wrong. Signal findings (invalid webhook signature, Upper 401 /
// FEATURE_DISABLED) alert only on new events and never gate the heartbeat.
// Without Sentry, each code is logged at most once per hour per process.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { pingHeartbeat } from "@/lib/observability/job-monitor.server";
import { captureServerMessage, isServerSentryActive } from "@/lib/observability/sentry.server";

export type BillingHealthCode =
  | "webhook_invalid_signature"
  | "charge_paid_not_credited"
  | "charge_needs_review"
  | "wallet_ledger_mismatch"
  | "upper_feature_disabled"
  | "upper_unauthorized"
  | "upper_unavailable"
  | "reconcile_cron_stale"
  | "billing_cycle_cron_stale"
  | "billing_health_check_failed"
  | "billing_alert_test";

export type BillingHealthSeverity = "critical" | "warning";

export type BillingHealthFinding = {
  code: BillingHealthCode;
  severity: BillingHealthSeverity;
  message: string;
  /** Signal findings only: time of the most recent event (no secret). */
  lastAt?: string | null;
};

/**
 * Findings built from event counters (billing_monitor_signals). They alert
 * only on events newer than the previous stage run and never gate the
 * heartbeat: the heartbeat reflects job/DB state only.
 */
export const SIGNAL_FINDING_CODES: ReadonlySet<BillingHealthCode> = new Set<BillingHealthCode>([
  "webhook_invalid_signature",
  "upper_feature_disabled",
  "upper_unauthorized",
  "upper_unavailable",
]);

/** Upper timeouts/network errors/5xx alert from this many events in the window. */
export const UPPER_UNAVAILABLE_THRESHOLD = 3;

export type BillingHealthReport = {
  ok: boolean;
  checkedAt: string;
  windowHours: number;
  findings: BillingHealthFinding[];
};

type SignalRow = { count: number; last_at: string | null; last_detail: string | null };

/** Shape of `billing_health_snapshot()`. */
export type BillingHealthSnapshot = {
  signals: Record<string, SignalRow | undefined>;
  paid_uncredited: { count: number; oldest_paid_at: string | null };
  needs_review: { count: number; oldest_at: string | null };
  wallet_mismatch: { count: number; tenant_ids: string[] };
  jobs_last_ok: Record<string, string | null | undefined>;
};

export const BILLING_ALERT_LOG_PREFIX = "[billing-alert]";
export const BILLING_HEALTH_HEARTBEAT_JOB = "billing-health";
/** Window the 5-minute job alerts on. The panel looks further back. */
export const JOB_WINDOW_HOURS = 1;
export const PANEL_WINDOW_HOURS = 24;

const MINUTE_MS = 60_000;
/** Each billing job is stale once its last OK run is older than 3x its interval. */
const BILLING_JOBS: { job: string; code: BillingHealthCode; label: string; intervalMs: number }[] =
  [
    {
      job: "billing-reconcile",
      code: "reconcile_cron_stale",
      label: "A conciliação do Pix (a cada 5 min)",
      intervalMs: 5 * MINUTE_MS,
    },
    {
      job: "billing-cycle",
      code: "billing_cycle_cron_stale",
      label: "O ciclo de cobrança (a cada 1 h)",
      intervalMs: 60 * MINUTE_MS,
    },
  ];
const STALE_FACTOR = 3;

const SIGNATURE_REASON_LABEL: Record<string, string> = {
  missing: "assinatura ausente",
  malformed: "assinatura malformada",
  stale: "assinatura vencida",
  mismatch: "assinatura não confere",
};

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

const BRT_FORMAT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatBrt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "data desconhecida";
  return BRT_FORMAT.format(date);
}

function signalCount(snapshot: BillingHealthSnapshot, code: string): SignalRow | null {
  const row = snapshot.signals?.[code];
  if (!row) return null;
  const count = Number(row.count ?? 0);
  return count > 0 ? { ...row, count } : null;
}

/** Pure: snapshot -> findings. */
export function evaluateBillingHealth(
  snapshot: BillingHealthSnapshot,
  opts: { now: Date; windowHours: number },
): BillingHealthFinding[] {
  const findings: BillingHealthFinding[] = [];
  const window = `nas últimas ${opts.windowHours} h`;

  const invalid = signalCount(snapshot, "webhook_invalid_signature");
  if (invalid) {
    const reason = invalid.last_detail ? SIGNATURE_REASON_LABEL[invalid.last_detail] : undefined;
    findings.push({
      code: "webhook_invalid_signature",
      severity: "critical",
      message:
        `${invalid.count} ${plural(invalid.count, "webhook da Upper recusado", "webhooks da Upper recusados")} ` +
        `por assinatura inválida ${window}` +
        (reason ? ` (último motivo: ${reason}).` : "."),
      lastAt: invalid.last_at,
    });
  }

  const paidCount = Number(snapshot.paid_uncredited?.count ?? 0);
  if (paidCount > 0) {
    const oldest = snapshot.paid_uncredited.oldest_paid_at;
    findings.push({
      code: "charge_paid_not_credited",
      severity: "critical",
      message:
        `${paidCount} ${plural(paidCount, "cobrança paga", "cobranças pagas")} na Upper e ` +
        `${plural(paidCount, "não creditada", "não creditadas")} há mais de 10 min` +
        (oldest ? ` (a mais antiga paga em ${formatBrt(oldest)}).` : "."),
    });
  }

  const reviewCount = Number(snapshot.needs_review?.count ?? 0);
  if (reviewCount > 0) {
    findings.push({
      code: "charge_needs_review",
      severity: "warning",
      message: `${reviewCount} ${plural(reviewCount, "cobrança", "cobranças")} aguardando revisão (valor pago diferente do cobrado ou fatura já fechada).`,
    });
  }

  const walletCount = Number(snapshot.wallet_mismatch?.count ?? 0);
  if (walletCount > 0) {
    findings.push({
      code: "wallet_ledger_mismatch",
      severity: "critical",
      message: `${walletCount} ${plural(walletCount, "carteira", "carteiras")} com saldo diferente da soma do razão.`,
    });
  }

  const featureDisabled = signalCount(snapshot, "upper_feature_disabled");
  if (featureDisabled) {
    findings.push({
      code: "upper_feature_disabled",
      severity: "critical",
      message: `A Upper respondeu FEATURE_DISABLED ${featureDisabled.count} ${plural(featureDisabled.count, "vez", "vezes")} ${window}: o Pix está desabilitado na conta.`,
      lastAt: featureDisabled.last_at,
    });
  }

  const unauthorized = signalCount(snapshot, "upper_unauthorized");
  if (unauthorized) {
    findings.push({
      code: "upper_unauthorized",
      severity: "critical",
      message: `A Upper recusou a chave de API (401) ${unauthorized.count} ${plural(unauthorized.count, "vez", "vezes")} ${window}.`,
      lastAt: unauthorized.last_at,
    });
  }

  const unavailable = signalCount(snapshot, "upper_unavailable");
  if (unavailable && unavailable.count >= UPPER_UNAVAILABLE_THRESHOLD) {
    findings.push({
      code: "upper_unavailable",
      severity: "critical",
      message: `A Upper parece fora do ar: ${unavailable.count} falhas (tempo esgotado, rede ou erro 5xx) ${window}. Pix indisponível para as casas.`,
      lastAt: unavailable.last_at,
    });
  }

  for (const job of BILLING_JOBS) {
    const lastOk = snapshot.jobs_last_ok?.[job.job] ?? null;
    const lastOkMs = lastOk ? new Date(lastOk).getTime() : Number.NaN;
    if (Number.isNaN(lastOkMs)) {
      findings.push({
        code: job.code,
        severity: "critical",
        message: `${job.label} nunca concluiu uma execução.`,
      });
      continue;
    }
    if (opts.now.getTime() - lastOkMs > STALE_FACTOR * job.intervalMs) {
      findings.push({
        code: job.code,
        severity: "critical",
        message: `${job.label} não conclui desde ${formatBrt(lastOk!)}.`,
      });
    }
  }

  return findings;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseDb = any;

const CHECK_FAILED: BillingHealthFinding = {
  code: "billing_health_check_failed",
  severity: "critical",
  message: "Não foi possível verificar a saúde da cobrança agora.",
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** Runs the check. Never throws: a failed read becomes `billing_health_check_failed`. */
export async function checkBillingHealth(
  opts: { windowHours?: number; now?: Date } = {},
): Promise<BillingHealthReport> {
  const windowHours = opts.windowHours ?? JOB_WINDOW_HOURS;
  const now = opts.now ?? new Date();
  let findings: BillingHealthFinding[];
  try {
    const { data, error } = await (supabaseAdmin as LooseDb).rpc("billing_health_snapshot", {
      _window_hours: windowHours,
      _now: now.toISOString(),
    });
    if (error || !data) throw error ?? new Error("empty snapshot");
    findings = evaluateBillingHealth(data as BillingHealthSnapshot, { now, windowHours });
  } catch (error) {
    // Server log only; the finding itself carries a fixed message.
    console.error("[billing-health] snapshot failed", { error: errorText(error) });
    findings = [CHECK_FAILED];
  }
  return {
    ok: !findings.some((f) => f.severity === "critical"),
    checkedAt: now.toISOString(),
    windowHours,
    findings,
  };
}

export type BillingAlertChannel = "sentry" | "log" | "none";

/** Without Sentry, a persistent code is logged at most once per this period per process. */
export const LOG_DEDUPE_MS = 60 * MINUTE_MS;
/** Signal findings alert only on events newer than the previous run (fallback: this long ago). */
export const SIGNAL_FRESH_FALLBACK_MS = 5 * MINUTE_MS;

const lastLoggedAt = new Map<string, number>();
let lastStageAt: number | null = null;

/** Test hook: reset the in-memory dedupe map and signal cursor. */
export function __resetBillingHealthStateForTests(): void {
  lastLoggedAt.clear();
  lastStageAt = null;
}

/**
 * Reports critical findings. Sentry when active (one issue per code, grouped
 * by fingerprint), else console.error with BILLING_ALERT_LOG_PREFIX, each code
 * at most once per LOG_DEDUPE_MS per process (`dedupe: false` bypasses it,
 * for the superadmin test alert). Never throws.
 */
export function reportBillingAlerts(
  findings: BillingHealthFinding[],
  opts: { now?: Date; dedupe?: boolean } = {},
): BillingAlertChannel {
  const critical = findings.filter((f) => f.severity === "critical");
  if (critical.length === 0) return "none";
  const nowMs = (opts.now ?? new Date()).getTime();
  const dedupe = opts.dedupe !== false;
  let useSentry = false;
  try {
    useSentry = isServerSentryActive();
  } catch {
    useSentry = false;
  }
  for (const finding of critical) {
    try {
      if (useSentry) {
        captureServerMessage(
          `${BILLING_ALERT_LOG_PREFIX} ${finding.code}: ${finding.message}`,
          "error",
          {
            job: BILLING_HEALTH_HEARTBEAT_JOB,
            tags: { alert_code: finding.code },
            fingerprint: ["billing-alert", finding.code],
          },
        );
      } else {
        const last = lastLoggedAt.get(finding.code);
        if (dedupe && last !== undefined && nowMs - last < LOG_DEDUPE_MS) continue;
        lastLoggedAt.set(finding.code, nowMs);
        console.error(`${BILLING_ALERT_LOG_PREFIX} ${finding.code} ${finding.message}`);
      }
    } catch {
      // Alerting must never break the caller.
    }
  }
  return useSentry ? "sentry" : "log";
}

/** Critical findings that gate the heartbeat: job/DB state, never event counters. */
export function heartbeatBlockingFindings(
  findings: BillingHealthFinding[],
): BillingHealthFinding[] {
  return findings.filter((f) => f.severity === "critical" && !SIGNAL_FINDING_CODES.has(f.code));
}

/**
 * Isolated stage of the 5-minute reconcile job: check, alert, heartbeat.
 *
 * - State findings (cron stale, paid not credited, wallet mismatch, check
 *   failed) alert every run (log deduped) and suppress the heartbeat.
 * - Signal findings alert only when their last event is newer than the
 *   previous run of this stage in this process (or than 5 min ago after a
 *   restart), and never suppress the heartbeat.
 *
 * Never throws.
 */
export async function runBillingHealthStage(
  opts: { now?: Date } = {},
): Promise<BillingHealthReport | null> {
  try {
    const now = opts.now ?? new Date();
    const since = lastStageAt ?? now.getTime() - SIGNAL_FRESH_FALLBACK_MS;
    lastStageAt = now.getTime();
    const report = await checkBillingHealth({ windowHours: JOB_WINDOW_HOURS, now });
    const alertable = report.findings.filter((f) => {
      if (!SIGNAL_FINDING_CODES.has(f.code)) return true;
      const lastAtMs = f.lastAt ? new Date(f.lastAt).getTime() : Number.NaN;
      return Number.isFinite(lastAtMs) && lastAtMs > since;
    });
    reportBillingAlerts(alertable, { now });
    if (heartbeatBlockingFindings(report.findings).length === 0) {
      void pingHeartbeat(BILLING_HEALTH_HEARTBEAT_JOB, true);
    }
    return report;
  } catch (error) {
    console.error("[billing-health] stage failed", { error: errorText(error) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Superadmin helpers (wrapped by billing-health.functions.ts)
// ---------------------------------------------------------------------------

const FORBIDDEN_MESSAGE = "Apenas o super admin pode realizar esta ação.";

export async function assertSuperAdmin(userId: string): Promise<void> {
  const { data, error } = await (supabaseAdmin as LooseDb).rpc("is_super_admin", {
    _user_id: userId,
  });
  if (error) throw new Error(errorText(error));
  if (!data) throw new Error(FORBIDDEN_MESSAGE);
}

export async function adminBillingHealthFor(ctx: { userId: string }): Promise<BillingHealthReport> {
  await assertSuperAdmin(ctx.userId);
  return checkBillingHealth({ windowHours: PANEL_WINDOW_HOURS });
}

export async function adminTestBillingAlertFor(ctx: {
  userId: string;
}): Promise<{ channel: BillingAlertChannel }> {
  await assertSuperAdmin(ctx.userId);
  const channel = reportBillingAlerts(
    [
      {
        code: "billing_alert_test",
        severity: "critical",
        message: "Alerta de teste da cobrança disparado pelo super admin. Nada a corrigir.",
      },
    ],
    { dedupe: false },
  );
  return { channel };
}
