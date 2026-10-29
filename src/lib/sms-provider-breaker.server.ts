// SMS provider circuit breaker (incident 15/10/2026), one per provider account.
//
// An account-level refusal (101 auth / 505 no balance / HTTP 401/402/403,
// errorKind `provider_account`) means NO lead of the houses on that account
// can be sent. Instead of burning each lead's attempts:
//
//   closed    : sends go out normally.
//   open      : no worker sends SMS; journey items stay waiting (no attempt
//               consumed), campaign/flow ticks stop with
//               stop_reason='provider_unavailable' without moving cursors.
//               Backoff 2 min, doubling on each reopen up to 30 min.
//   half_open : after the backoff ONE worker (the probe holder) sends ONE real
//               queued item. Accepted -> closed. Refused (account) -> open
//               with a doubled backoff.
//
// State lives in public.provider_circuit_breakers (migration
// 20261015123000_sms_provider_breaker.sql), one row per breaker key: 'sms' for
// the platform account, 'sms:<provider_account_id>' for a house's own account
// (smsBreakerKey). Every transition is one RPC that locks that row, so
// concurrent workers/processes cannot double-open, double-probe or
// double-alert. Reporting happens in sendSmsInternal and in the bulk sender,
// so every SMS path (journeys, flows, campaigns, manual/test sends) feeds the
// breaker of the account that sent; the dispatchers ask SmsAccountGates.
//
// Fail-open: if the RPCs are missing (migration not applied) or the DB call
// fails, the breaker reads as closed; account errors are still deferred
// without consuming attempts by the workers' classification.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { pingHeartbeat } from "@/lib/observability/job-monitor.server";
import { captureServerMessage } from "@/lib/observability/sentry.server";
import type { ProviderAccountReason } from "@/lib/rate-limit/transport-errors";
import { DEFAULT_SHORT_BRASIL_ACCOUNT_ID } from "@/lib/provider-accounts.server";

export const SMS_PROVIDER_JOB = "sms_provider";
/** Breaker key of the platform SMS account (the original single row). */
export const PLATFORM_SMS_BREAKER_KEY = "sms";

/** Breaker key of the account that sends a house's SMS. */
export function smsBreakerKey(accountId: string | null | undefined): string {
  return !accountId || accountId === DEFAULT_SHORT_BRASIL_ACCOUNT_ID
    ? PLATFORM_SMS_BREAKER_KEY
    : `sms:${accountId}`;
}

const isPlatformKey = (key: string) => key === PLATFORM_SMS_BREAKER_KEY;
/** Cached state is trusted for this long before a success re-checks the DB. */
export const BREAKER_CACHE_MS = 5_000;
/** A probe holder that vanished is replaced after this long. */
export const BREAKER_PROBE_TTL_SECONDS = 300;

export type BreakerState = "closed" | "open" | "half_open";

export type BreakerSnapshot = {
  state: BreakerState;
  reason: string | null;
  lastError: string | null;
  since: string | null;
  retryAt: string | null;
};

export type SmsSendGate =
  | { mode: "closed" }
  | { mode: "probe"; holder: string; snapshot: BreakerSnapshot }
  | { mode: "open"; snapshot: BreakerSnapshot };

const CLOSED: BreakerSnapshot = {
  state: "closed",
  reason: null,
  lastError: null,
  since: null,
  retryAt: null,
};

type RpcResult = { data: unknown; error: { message: string } | null };
type BreakerDb = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
};

const db = () => supabaseAdmin as unknown as BreakerDb;

const cache = new Map<string, { snapshot: BreakerSnapshot; at: number }>();
let warnedUnavailable = false;

/** Test hook. */
export function __resetSmsBreakerCacheForTests() {
  cache.clear();
  warnedUnavailable = false;
}

function remember(key: string, snapshot: BreakerSnapshot) {
  cache.set(key, { snapshot, at: Date.now() });
}

function unavailable(where: string, message: string) {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn("[sms-breaker] breaker unavailable; treating as closed", { where, error: message });
}

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? (row as Record<string, unknown>) : null;
}

const str = (value: unknown) => (typeof value === "string" && value ? value : null);

function asState(value: unknown): BreakerState {
  return value === "open" || value === "half_open" ? value : "closed";
}

/** Last known state without touching the DB (may be up to BREAKER_CACHE_MS old, or never loaded). */
export function cachedSmsBreaker(key: string = PLATFORM_SMS_BREAKER_KEY): BreakerSnapshot {
  return cache.get(key)?.snapshot ?? CLOSED;
}

/** Reads the breaker row (cached for BREAKER_CACHE_MS unless `force`). Never throws. */
export async function readSmsBreaker(
  opts: { force?: boolean; key?: string } = {},
): Promise<BreakerSnapshot> {
  const key = opts.key ?? PLATFORM_SMS_BREAKER_KEY;
  const cached = cache.get(key);
  if (!opts.force && cached && Date.now() - cached.at < BREAKER_CACHE_MS) return cached.snapshot;
  try {
    const { data, error } = await db()
      .from("provider_circuit_breakers")
      .select("state,reason,last_error,first_opened_at,backoff_until,probe_started_at")
      .eq("channel", key)
      .maybeSingle();
    if (error) {
      unavailable("read", error.message);
      remember(key, CLOSED);
      return CLOSED;
    }
    const row = (data ?? null) as Record<string, unknown> | null;
    const state = asState(row?.state);
    const snapshot: BreakerSnapshot =
      state === "closed"
        ? CLOSED
        : {
            state,
            reason: str(row?.reason),
            lastError: str(row?.last_error),
            since: str(row?.first_opened_at),
            retryAt:
              state === "half_open" && str(row?.probe_started_at)
                ? new Date(
                    Date.parse(String(row?.probe_started_at)) + BREAKER_PROBE_TTL_SECONDS * 1000,
                  ).toISOString()
                : str(row?.backoff_until),
          };
    remember(key, snapshot);
    if (state === "closed" && isPlatformKey(key)) void pingHeartbeat(SMS_PROVIDER_JOB, true);
    return snapshot;
  } catch (error) {
    unavailable("read", error instanceof Error ? error.message : String(error));
    return CLOSED;
  }
}

export function describeBreakerReason(reason: string | null): string {
  if (reason === "no_balance") return "sem saldo";
  if (reason === "auth") return "autenticação/sem saldo";
  return "conta recusada";
}

const UNKNOWN_REFUSAL_ALERT_MS = 10 * 60_000;
let lastUnknownRefusalAlertAt = 0;

/**
 * The provider refused a message with a code we do not classify. The send is
 * already treated as failed (refunded); this only makes the new code visible,
 * at most once per instance every 10 minutes. Never throws.
 */
export function reportUnknownSmsProviderRefusal(body: unknown, now = Date.now()) {
  if (now - lastUnknownRefusalAlertAt < UNKNOWN_REFUSAL_ALERT_MS) return;
  lastUnknownRefusalAlertAt = now;
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  try {
    captureServerMessage("Short Brasil recusou SMS com código desconhecido", "warning", {
      job: SMS_PROVIDER_JOB,
      tags: { provider_status: String(b.status ?? "") },
      extra: { status_detalhe: String(b.statusDetalhe ?? "").slice(0, 300) },
    });
  } catch {
    // observability must never break a send
  }
}

function alertOpen(key: string, snapshot: BreakerSnapshot, firstTime: boolean) {
  // A house's own account names itself; the platform account keeps the
  // original text (and alone drives the sms_provider heartbeat).
  const account = isPlatformKey(key) ? "" : ` (conta ${key.slice("sms:".length)})`;
  captureServerMessage(
    firstTime
      ? `Envio de SMS suspenso${account}: provedor recusou a conta (${describeBreakerReason(snapshot.reason)})`
      : `Envio de SMS continua suspenso${account}: provedor recusa a conta (${describeBreakerReason(snapshot.reason)})`,
    "error",
    {
      job: SMS_PROVIDER_JOB,
      tags: {
        breaker_state: snapshot.state,
        reason: snapshot.reason ?? "unknown",
        breaker_key: key,
      },
      extra: {
        since: snapshot.since,
        retry_at: snapshot.retryAt,
        last_error: snapshot.lastError?.slice(0, 300) ?? null,
      },
    },
  );
  if (isPlatformKey(key)) void pingHeartbeat(SMS_PROVIDER_JOB, false);
}

/**
 * An SMS send got an account-level refusal. Opens (or, for a failed probe,
 * reopens with a doubled backoff) the breaker of that account and alerts.
 * Never throws.
 */
export async function reportSmsProviderAccountFailure(args: {
  reason: ProviderAccountReason;
  error: string;
  sendStartedAt: Date;
  /** smsBreakerKey of the account that sent; default: the platform account. */
  key?: string;
}): Promise<BreakerSnapshot> {
  const key = args.key ?? PLATFORM_SMS_BREAKER_KEY;
  try {
    const { data, error } = await db().rpc("provider_breaker_report_failure", {
      p_channel: key,
      p_reason: args.reason,
      p_error: args.error.slice(0, 800),
      p_send_started_at: args.sendStartedAt.toISOString(),
    });
    if (error) {
      unavailable("report_failure", error.message);
      return CLOSED;
    }
    const row = firstRow(data);
    const snapshot: BreakerSnapshot = {
      state: asState(row?.state),
      reason: args.reason,
      lastError: args.error.slice(0, 800),
      since: str(row?.first_opened_at),
      retryAt: str(row?.backoff_until),
    };
    remember(key, snapshot);
    if (row?.opened === true) {
      console.error("[sms-breaker] opened", {
        key,
        reason: args.reason,
        openCount: row?.open_count ?? null,
        retryAt: snapshot.retryAt,
      });
    }
    if (row?.alert_due === true)
      alertOpen(key, snapshot, Number(row?.open_count ?? 0) === 1 && row?.opened === true);
    return snapshot;
  } catch (error) {
    unavailable("report_failure", error instanceof Error ? error.message : String(error));
    return CLOSED;
  }
}

/**
 * An SMS send was accepted. Only talks to the DB when the breaker is (or may
 * be) not closed, so the normal path costs at most one cached read every
 * BREAKER_CACHE_MS. Never throws.
 */
export async function noteSmsProviderSuccess(
  sendStartedAt: Date,
  key: string = PLATFORM_SMS_BREAKER_KEY,
): Promise<void> {
  try {
    const snapshot = await readSmsBreaker({ key });
    if (snapshot.state === "closed") return;
    const { data, error } = await db().rpc("provider_breaker_report_success", {
      p_channel: key,
      p_send_started_at: sendStartedAt.toISOString(),
    });
    if (error) {
      unavailable("report_success", error.message);
      return;
    }
    const row = firstRow(data);
    if (row?.closed === true) {
      remember(key, CLOSED);
      const since = str(row?.first_opened_at);
      console.info("[sms-breaker] closed: provider accepted a send", { key, since });
      captureServerMessage("Envio de SMS normalizado: provedor voltou a aceitar", "info", {
        job: SMS_PROVIDER_JOB,
        tags: { breaker_key: key },
        extra: { since, reason: str(row?.reason) },
      });
      if (isPlatformKey(key)) void pingHeartbeat(SMS_PROVIDER_JOB, true);
    } else {
      // Someone else closed it, or this success predates the last reopen.
      await readSmsBreaker({ force: true, key });
    }
  } catch (error) {
    unavailable("report_success", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Asked by a dispatcher before sending SMS. `probe` lets the caller send ONE
 * item; it must call `releaseSmsProbe` if it ends without reaching the
 * provider. Never throws (fail-open).
 */
export async function acquireSmsSendGate(
  holder: string,
  key: string = PLATFORM_SMS_BREAKER_KEY,
): Promise<SmsSendGate> {
  // Common path: one cheap read; the locking RPC only runs while not closed.
  const current = await readSmsBreaker({ force: true, key });
  if (current.state === "closed") return { mode: "closed" };
  try {
    const { data, error } = await db().rpc("provider_breaker_acquire", {
      p_channel: key,
      p_holder: holder,
      p_probe_ttl_seconds: BREAKER_PROBE_TTL_SECONDS,
    });
    if (error) {
      unavailable("acquire", error.message);
      return { mode: "closed" };
    }
    const row = firstRow(data);
    const decision = row?.decision;
    if (decision !== "open" && decision !== "probe") {
      remember(key, CLOSED);
      return { mode: "closed" };
    }
    const snapshot: BreakerSnapshot = {
      state: asState(row?.state),
      reason: str(row?.reason),
      lastError: str(row?.last_error),
      since: str(row?.first_opened_at),
      retryAt: str(row?.retry_at),
    };
    remember(key, snapshot);
    if (row?.alert_due === true) alertOpen(key, snapshot, false);
    return decision === "probe" ? { mode: "probe", holder, snapshot } : { mode: "open", snapshot };
  } catch (error) {
    unavailable("acquire", error instanceof Error ? error.message : String(error));
    return { mode: "closed" };
  }
}

/** The probe holder finished without a provider verdict: let the next worker probe. */
export async function releaseSmsProbe(
  holder: string,
  key: string = PLATFORM_SMS_BREAKER_KEY,
): Promise<void> {
  try {
    const { error } = await db().rpc("provider_breaker_release_probe", {
      p_channel: key,
      p_holder: holder,
    });
    if (error) unavailable("release_probe", error.message);
    await readSmsBreaker({ force: true, key });
  } catch (error) {
    unavailable("release_probe", error instanceof Error ? error.message : String(error));
  }
}

function brtTime(iso: string | null): string {
  if (!iso) return "--:--";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "--:--";
  const brt = new Date(ms - 3 * 3_600_000);
  return `${String(brt.getUTCHours()).padStart(2, "0")}:${String(brt.getUTCMinutes()).padStart(2, "0")}`;
}

/** Operator-facing message (admin banner, campaign last_error). */
export function smsSuspendedMessage(snapshot: Pick<BreakerSnapshot, "since" | "retryAt">): string {
  return `Envio de SMS suspenso: provedor recusou (sem saldo/autenticação) desde ${brtTime(
    snapshot.since,
  )} — tentando novamente às ${brtTime(snapshot.retryAt)}`;
}

/** When a deferred item should come back: the breaker's next chance, at least 30 s from now. */
export function breakerRetryAt(snapshot: BreakerSnapshot | null, fallbackMs: number): string {
  const now = Date.now();
  const hinted = snapshot?.retryAt ? Date.parse(snapshot.retryAt) : NaN;
  const at = Number.isFinite(hinted) && hinted > now ? hinted : now + fallbackMs;
  return new Date(Math.max(at, now + 30_000)).toISOString();
}
