// Wallet alerts (PG3 Task 8): the low-balance e-mail and the shared throttle.
//
// - `claimWalletAlert` wraps `billing_claim_wallet_alert` (service_role only):
//   an atomic upsert on `wallet_alerts (tenant_id, kind)` that returns true
//   only to the caller that moved `last_sent_at`, at most once per
//   `interval`. Claim BEFORE sending; a false claim means "someone already
//   sent it inside the interval, do nothing". Task 7 uses it for the
//   no-balance alert ('no_balance', '1 hour').
// - `sendLowBalanceAlerts` is the hourly sweep `runBillingCycle` runs (wired
//   by the billing-cycle cron route): every active, non-demo, non-exempt
//   house whose balance is above zero and below its own threshold (zero is
//   Task 7's 'no_balance' alert)
//   (`billing_low_balance_candidates`) gets at most one e-mail per 24 h, to
//   its admins/owners/gestores, only inside the 08:00-20:00 Brasília window.
// - `notifyNoBalance` (Task 7) is called by the senders (journeys, SMS/e-mail
//   flows, call flows) when the house wallet refused a send: at most one
//   "Saldo esgotado" e-mail per hour per house ('no_balance', '1 hour').
//   Outside the window it does not claim, so the next refusal inside the
//   window claims instead. Never throws into the caller.
//
// These are platform e-mails (`sendPlatformEmail`): never charged to the
// house, and never shown the supplier cost.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { brl } from "../format";
import { brtDayKey } from "../tz";
import {
  getPayerEmails,
  getTenantForEmail,
  isWithinBillingEmailWindow,
  sendPlatformEmail,
} from "./billing-emails.server";

export type WalletAlertKind = "low_balance" | "no_balance";

/** Postgres interval text, e.g. '24 hours' or '1 hour'. */
export type WalletAlertInterval = string;

export const LOW_BALANCE_ALERT_KIND: WalletAlertKind = "low_balance";
export const LOW_BALANCE_ALERT_INTERVAL: WalletAlertInterval = "24 hours";
export const NO_BALANCE_ALERT_KIND: WalletAlertKind = "no_balance";
export const NO_BALANCE_ALERT_INTERVAL: WalletAlertInterval = "1 hour";

/** Rows per `billing_low_balance_candidates` page (the RPC accepts 1-1000). */
export const CANDIDATES_PAGE_SIZE = 500;

const PLAN_CREDITS_URL = "https://betleads.io/plano-e-creditos";

type DbResult<T> = { data: T | null; error: { message: string } | null };
type RpcClient = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => PromiseLike<DbResult<T>>;
};

function rpcDb(): RpcClient {
  // The wallet-alert RPCs are not in the generated Supabase types yet.
  return supabaseAdmin as unknown as RpcClient;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Claims the right to send alert `kind` for `tenantId`: true only for the
 * one caller that moved `wallet_alerts.last_sent_at` (first time, or the
 * previous send is at least `interval` old). Throws on a DB error.
 */
export async function claimWalletAlert(
  tenantId: string,
  kind: WalletAlertKind,
  interval: WalletAlertInterval,
): Promise<boolean> {
  const { data, error } = await rpcDb().rpc<boolean>("billing_claim_wallet_alert", {
    _tenant: tenantId,
    _kind: kind,
    _interval: interval,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

// `brl()` puts a NBSP between "R$" and the number; plain space for e-mail.
function moneyText(value: number): string {
  return brl(value).replace(new RegExp(String.fromCharCode(160), "g"), " ");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function lowBalanceEmail(houseName: string, balance: number, threshold: number) {
  const subject = `Saldo baixo na BetLeads: ${moneyText(balance)}`;
  const body =
    `O saldo de créditos da casa ${escapeHtml(houseName)} está em ${moneyText(balance)}, ` +
    `abaixo do limite de alerta de ${moneyText(threshold)}. Quando o saldo acabar, ` +
    "SMS e voz ficam bloqueados; e-mail segue só dentro da franquia mensal. " +
    "Adicione créditos para manter tudo funcionando.";
  const html = `<!doctype html>
<html>
  <body style="margin:0; padding:24px; background:#f5f5f5; font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:8px; padding:24px; color:#1f2937;">
      <p style="font-size:16px; line-height:1.5; margin:0 0 20px;">${body}</p>
      <p style="text-align:center; margin:0;">
        <a href="${PLAN_CREDITS_URL}" style="background:#2563eb; color:#ffffff; padding:12px 24px; border-radius:6px; text-decoration:none; font-weight:bold; display:inline-block;">Abrir Plano e créditos</a>
      </p>
      <p style="font-size:12px; line-height:1.5; color:#6b7280; margin:20px 0 0;">Você pode mudar o limite de alerta em Plano e créditos.</p>
    </div>
  </body>
</html>`;
  return { subject, html };
}

type LowBalanceCandidate = {
  tenant_id: string;
  tenant_name: string | null;
  balance: number | string;
  low_balance_threshold: number | string;
};

/** Sends the alert for one house; true when at least one recipient was accepted. */
async function alertOneHouse(candidate: LowBalanceCandidate, now: Date): Promise<boolean> {
  const tenantId = candidate.tenant_id;
  if (!(await claimWalletAlert(tenantId, LOW_BALANCE_ALERT_KIND, LOW_BALANCE_ALERT_INTERVAL))) {
    return false;
  }
  const recipients = await getPayerEmails(tenantId);
  if (recipients.length === 0) return false;

  const { subject, html } = lowBalanceEmail(
    candidate.tenant_name?.trim() || "sua casa",
    Number(candidate.balance),
    Number(candidate.low_balance_threshold),
  );
  const day = brtDayKey(now);
  let accepted = 0;
  for (const [index, to] of recipients.entries()) {
    const idempotencyKey = `wallet-alert:${LOW_BALANCE_ALERT_KIND}:${tenantId}:${day}:${index}`;
    try {
      const result = await sendPlatformEmail({ to, subject, html, idempotencyKey });
      if (result.ok) accepted += 1;
      else {
        console.error("[wallet-alerts] provider refused the send", {
          tenantId,
          recipientIndex: index,
          status: result.status,
        });
      }
    } catch (err) {
      console.error("[wallet-alerts] send failed", {
        tenantId,
        recipientIndex: index,
        error: errorMessage(err),
      });
    }
  }
  return accepted > 0;
}

/**
 * Hourly low-balance sweep (run by `runBillingCycle`). Returns how many
 * houses got the e-mail. A no-op outside 08:00-20:00 Brasília. Throws only
 * when the candidate list itself cannot be read; a failure on one house is
 * logged and the sweep moves on.
 *
 * The claim happens before sending, so a provider outage costs that house
 * its alert for the next 24 h (no duplicate e-mails is the stronger rule).
 */
export async function sendLowBalanceAlerts(opts: { now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  if (!isWithinBillingEmailWindow(now)) return 0;

  let sent = 0;
  let after: string | null = null;
  // Keyset paging (`_after` = last tenant_id seen) so the list is never
  // silently capped at PostgREST's 1000 rows. The guard only stops an
  // endless loop if a stub ever ignores `_after`.
  for (let guard = 0; guard < 10_000; guard += 1) {
    const result: DbResult<LowBalanceCandidate[]> = await rpcDb().rpc<LowBalanceCandidate[]>(
      "billing_low_balance_candidates",
      { _after: after, _limit: CANDIDATES_PAGE_SIZE },
    );
    if (result.error) throw new Error(result.error.message);
    const page: LowBalanceCandidate[] = result.data ?? [];

    for (const candidate of page) {
      try {
        if (await alertOneHouse(candidate, now)) sent += 1;
      } catch (err) {
        console.error("[wallet-alerts] low balance alert failed", {
          tenantId: candidate.tenant_id,
          error: errorMessage(err),
        });
      }
    }

    if (page.length < CANDIDATES_PAGE_SIZE) break;
    after = page[page.length - 1].tenant_id;
  }
  return sent;
}

// ---------------------------------------------------------------------------
// No-balance alert (Task 7)
// ---------------------------------------------------------------------------

/**
 * A broke house can refuse hundreds of sends per dispatcher run; each one
 * would cost a tenant read, an exempt check and a claim. This process asks
 * the database at most once per minute per house; the claim itself (1 hour,
 * atomic, shared by every process) stays the real throttle.
 */
const NO_BALANCE_RECHECK_MS = 60_000;
const noBalanceCheckedAt = new Map<string, number>();

/** Test hook: forgets the per-process recheck memo. */
export function resetNoBalanceAlertMemo(): void {
  noBalanceCheckedAt.clear();
}

async function isTenantExempt(tenantId: string): Promise<boolean> {
  const { data, error } = await rpcDb().rpc<boolean>("billing_tenant_exempt", {
    _tenant: tenantId,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

function noBalanceEmail(houseName: string) {
  const subject = "Saldo esgotado — envios pausados";
  const body =
    `O saldo de créditos da casa ${escapeHtml(houseName)} acabou. ` +
    "SMS e voz estão pausados: jornadas e automações pulam esses envios até você adicionar créditos. " +
    "O e-mail segue só dentro da franquia mensal gratuita.";
  const html = `<!doctype html>
<html>
  <body style="margin:0; padding:24px; background:#f5f5f5; font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:8px; padding:24px; color:#1f2937;">
      <p style="font-size:16px; line-height:1.5; margin:0 0 20px;">${body}</p>
      <p style="text-align:center; margin:0;">
        <a href="${PLAN_CREDITS_URL}" style="background:#2563eb; color:#ffffff; padding:12px 24px; border-radius:6px; text-decoration:none; font-weight:bold; display:inline-block;">Adicionar créditos</a>
      </p>
    </div>
  </body>
</html>`;
  return { subject, html };
}

async function sendNoBalanceAlert(tenantId: string, now: Date): Promise<boolean> {
  if (!isWithinBillingEmailWindow(now)) return false;

  const last = noBalanceCheckedAt.get(tenantId);
  const nowMs = now.getTime();
  if (last !== undefined && nowMs - last < NO_BALANCE_RECHECK_MS) return false;
  noBalanceCheckedAt.set(tenantId, nowMs);

  const tenant = await getTenantForEmail(tenantId);
  if (!tenant || tenant.is_demo) return false;
  if (await isTenantExempt(tenantId)) return false;
  if (!(await claimWalletAlert(tenantId, NO_BALANCE_ALERT_KIND, NO_BALANCE_ALERT_INTERVAL))) {
    return false;
  }

  const recipients = await getPayerEmails(tenantId);
  if (recipients.length === 0) return false;
  const { subject, html } = noBalanceEmail(tenant.nome?.trim() || "sua casa");
  // One key per BRT hour: a provider retry of the same send is deduplicated.
  const hour = `${brtDayKey(now)}T${String((now.getUTCHours() + 21) % 24).padStart(2, "0")}`;
  let accepted = 0;
  for (const [index, to] of recipients.entries()) {
    const idempotencyKey = `wallet-alert:${NO_BALANCE_ALERT_KIND}:${tenantId}:${hour}:${index}`;
    try {
      const result = await sendPlatformEmail({ to, subject, html, idempotencyKey });
      if (result.ok) accepted += 1;
      else {
        console.error("[wallet-alerts] provider refused the no-balance send", {
          tenantId,
          recipientIndex: index,
          status: result.status,
        });
      }
    } catch (err) {
      console.error("[wallet-alerts] no-balance send failed", {
        tenantId,
        recipientIndex: index,
        error: errorMessage(err),
      });
    }
  }
  return accepted > 0;
}

/**
 * Called by a sender after the HOUSE's wallet refused a send
 * (`errorKind: "insufficient_balance"`). E-mails the house's
 * admins/owners/gestores at most once per hour, only inside 08:00-20:00
 * Brasília; demo and exempt houses never get it. Returns true when the
 * e-mail went out. Never throws: an alert failure must not disturb the
 * dispatcher that called it.
 */
export async function notifyNoBalance(
  tenantId: string,
  opts: { now?: Date } = {},
): Promise<boolean> {
  try {
    return await sendNoBalanceAlert(tenantId, opts.now ?? new Date());
  } catch (err) {
    console.error("[wallet-alerts] no balance alert failed", {
      tenantId,
      error: errorMessage(err),
    });
    return false;
  }
}
