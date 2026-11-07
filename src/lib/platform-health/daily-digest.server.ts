// Daily digest cron job for the super-admin "Saúde" console (F3, Task 4):
// once a day, at 08:00 BRT, e-mails every super admin a summary of open
// alerts, red/yellow houses and who owes money.
//
// Idempotency: `platform_digest_log` has a primary key on `digest_day`
// (Brasília calendar day). `runDailyDigest` claims the day with a plain
// insert before doing any work; a concurrent/duplicate run collides (23505)
// and is told `already_sent` without e-mailing anyone. When the run then
// cannot deliver (no recipients, a throw, or no send accepted) it deletes
// its claim, so the 11:30 UTC retry cron (or a manual re-run) the same day
// still sends; after a delivered digest the retry is a no-op.
//
// The alerts listed are the ones computed this run (`health.alerts`, joined
// with their stored silence), not the `platform_alerts` table, so a stalled
// alerts cron can never produce an "all clear" digest.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  summarizeBillingStates,
  type BillingStateInput,
  type Debtor,
} from "@/lib/billing/billing-state-summary";
import { sendPlatformEmail } from "@/lib/billing/billing-emails.server";
import { brtDayKey } from "@/lib/tz";

import { isPlatformAlertsEmailEnabled, listSuperAdminEmails } from "./alert-email.server";
import { buildDailyDigest } from "./daily-digest";
import type { HouseHealthRow } from "./house-health";
import { computePlatformHealth } from "./platform-health.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- platform_digest_log is not in the generated Supabase types yet.
type LooseDb = any;

const db = () => supabaseAdmin as LooseDb;

const DIGEST_TABLE = "platform_digest_log";
const UNIQUE_VIOLATION = "23505";

type DbError = { message: string; code?: string } | null;

function fail(error: DbError): never {
  throw new Error(error?.message ?? "Falha ao acessar platform_digest_log.");
}

/** Inserts today's claim row; false (not thrown) when another run already claimed it. */
async function claimDigestDay(day: string): Promise<boolean> {
  const { error } = await db().from(DIGEST_TABLE).insert({ digest_day: day, recipients: 0 });
  if (!error) return true;
  if ((error as DbError)?.code === UNIQUE_VIOLATION) return false;
  fail(error);
}

/** Deletes today's claim so a later run the same day can send. */
async function releaseDigestDay(day: string): Promise<void> {
  const { error } = await db().from(DIGEST_TABLE).delete().eq("digest_day", day);
  if (error) fail(error);
}

async function recordRecipients(day: string, recipients: number): Promise<void> {
  const { error } = await db().from(DIGEST_TABLE).update({ recipients }).eq("digest_day", day);
  if (error) fail(error);
}

type TenantBillingRow = { tenant_id: string; access_state: string };
type OpenInvoiceRow = { tenant_id: string; amount_cents: number | string; due_date: string };

/**
 * Debtors + total owed among `houses` (the health panel's houses, not every
 * tenant): reads `tenant_billing.access_state` and open `billing_invoices`
 * for just those tenant ids and runs them through `summarizeBillingStates`.
 * A house missing from `tenant_billing` defaults to "ok" (never flagged as a
 * debtor) — rebuilding the exempt/plan nuance Financeiro geral has is out of
 * scope for a digest e-mail.
 */
async function loadDebtors(
  houses: HouseHealthRow[],
  now: Date,
): Promise<{ debtors: Debtor[]; owedCents: number }> {
  if (houses.length === 0) return { debtors: [], owedCents: 0 };

  const tenantIds = houses.map((house) => house.tenantId);
  const [billingRes, invoiceRes] = await Promise.all([
    db().from("tenant_billing").select("tenant_id,access_state").in("tenant_id", tenantIds),
    db()
      .from("billing_invoices")
      .select("tenant_id,amount_cents,due_date")
      .eq("status", "open")
      .in("tenant_id", tenantIds),
  ]);
  if (billingRes.error) fail(billingRes.error);
  if (invoiceRes.error) fail(invoiceRes.error);

  const accessStateByTenant = new Map(
    ((billingRes.data ?? []) as TenantBillingRow[]).map((row) => [row.tenant_id, row.access_state]),
  );
  const openInvoiceByTenant = new Map(
    ((invoiceRes.data ?? []) as OpenInvoiceRow[]).map((row) => [
      row.tenant_id,
      { amountCents: Number(row.amount_cents), dueDate: row.due_date },
    ]),
  );

  const inputs: BillingStateInput[] = houses.map((house) => ({
    tenantId: house.tenantId,
    name: house.name,
    accessState: accessStateByTenant.get(house.tenantId) ?? "ok",
    openInvoice: openInvoiceByTenant.get(house.tenantId) ?? null,
    firstPaidAt: null,
    paidInMonth: false,
  }));

  const todayBrt = brtDayKey(now);
  const summary = summarizeBillingStates(inputs, todayBrt, todayBrt.slice(0, 7));
  return { debtors: summary.debtors, owedCents: summary.owedCents };
}

type DigestResult = {
  sent: boolean;
  reason?: "already_sent" | "disabled" | "no_recipients" | "failed";
  /** E-mails the provider accepted. */
  recipients: number;
};

/** Builds and sends the digest for `day`; returns how many sends were accepted (no recipients: null). */
async function deliverDigest(day: string, now: Date): Promise<number | null> {
  const recipients = await listSuperAdminEmails();
  if (recipients.length === 0) return null;

  const health = await computePlatformHealth(now);
  const { debtors, owedCents } = await loadDebtors(health.houses, now);

  const { subject, html } = buildDailyDigest({
    day,
    now,
    openAlerts: health.alerts.map((alert) => ({
      severity: alert.severity,
      message: alert.message,
      silencedUntil: alert.stored?.silencedUntil ?? null,
    })),
    houses: health.houses,
    debtors,
    owedCents,
  });

  let accepted = 0;
  for (const [index, to] of recipients.entries()) {
    // Per claim (this run's stamp): a retry after a released claim is not
    // deduped by the provider; the sends of one claim share their keys.
    const idempotencyKey = `platform-digest:${day}:${now.getTime()}:${index}`;
    try {
      const result = await sendPlatformEmail({ to, subject, html, idempotencyKey });
      if (result.ok) accepted += 1;
      else {
        console.error("[platform-digest] provider refused the send", {
          recipientIndex: index,
          status: result.status,
        });
      }
    } catch (err) {
      console.error("[platform-digest] send failed", {
        recipientIndex: index,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return accepted;
}

/**
 * One daily digest run. Off by default (`PLATFORM_ALERTS_EMAIL_ENABLED`);
 * when on, claims the Brasília day in `platform_digest_log` and e-mails
 * every super admin once (`idempotencyKey`
 * `platform-digest:<day>:<claim stamp ms>:<index>`). No recipients, a throw or no accepted send releases the day
 * (`no_recipients` / `failed`) so a retry the same day can send.
 */
export async function runDailyDigest(now: Date): Promise<DigestResult> {
  if (!isPlatformAlertsEmailEnabled()) {
    return { sent: false, reason: "disabled", recipients: 0 };
  }

  const day = brtDayKey(now);
  const claimed = await claimDigestDay(day);
  if (!claimed) {
    return { sent: false, reason: "already_sent", recipients: 0 };
  }

  let accepted: number | null;
  try {
    accepted = await deliverDigest(day, now);
  } catch (err) {
    console.error("[platform-digest] digest failed", {
      day,
      error: err instanceof Error ? err.message : String(err),
    });
    await releaseDigestDay(day);
    return { sent: false, reason: "failed", recipients: 0 };
  }

  if (accepted === null) {
    await releaseDigestDay(day);
    return { sent: false, reason: "no_recipients", recipients: 0 };
  }
  if (accepted === 0) {
    await releaseDigestDay(day);
    return { sent: false, reason: "failed", recipients: 0 };
  }

  await recordRecipients(day, accepted);
  return { sent: true, recipients: accepted };
}
