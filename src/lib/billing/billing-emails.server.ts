// Billing e-mails (mensalidade, Task 5): the four platform-sender e-mails
// (`issued`, `due_today`, `locked`, `paid`), sent once per invoice/kind
// (`billing_email_log`) and only inside the 08:00-20:00 Brasília window.
//
// These never go through `sendInfobipEmail` (src/lib/email-send.server.ts):
// that path refuses a billing-locked house via `assertTenantNotDemoForSend`,
// which would make the 'locked' e-mail itself undeliverable. `sendPlatformEmail`
// calls `callInfobipEmail` directly with the platform sender
// (`PLATFORM_EMAIL_FROM`, default `no-reply@betleads.io`) and never takes a
// tenantId — no demo/consent/suppression/link-tracking plumbing applies here.
//
// Concurrency: `billing_email_log` has PK (invoice_id, kind). The row is
// inserted (`on conflict do nothing`) BEFORE sending; only the caller that
// actually inserted it sends. `force` (superadmin resend) upserts instead,
// always winning. If every recipient send fails, the log row is deleted so
// the next hourly sweep retries — bounded naturally by the invoice leaving
// the relevant window (no longer open/due/locked/within 48h of being paid).

import { brl } from "../format";
import { brtDayKey } from "@/lib/tz";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isBillingEnforcementEnabled } from "@/lib/tenant-access.server";

import { callInfobipEmail } from "../infobip-email.server";
import { isBillingInvoicesEnabled } from "./invoices.server";
import { PAYER_ROLES } from "./billing-state.server";

export type BillingEmailKind = "issued" | "due_today" | "locked" | "paid";

const PLATFORM_FROM_NAME = "BetLeads";
const DEFAULT_PLATFORM_FROM = "no-reply@betleads.io";
const PLAN_CREDITS_URL = "https://betleads.io/plano-e-creditos";
const BRT_OFFSET_MIN = -180; // BRT = UTC-3
const WINDOW_START_MIN = 8 * 60;
const WINDOW_END_MIN = 20 * 60;
const PAID_LOOKBACK_MS = 48 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Platform sender
// ---------------------------------------------------------------------------

/** `PLATFORM_EMAIL_FROM`, defaulting to `no-reply@betleads.io`. */
export function platformEmailFrom(): string {
  return process.env.PLATFORM_EMAIL_FROM?.trim() || DEFAULT_PLATFORM_FROM;
}

/**
 * Sends one e-mail from the platform sender, bypassing every tenant-scoped
 * guard (demo, billing lock, consent, suppression list, link tracking).
 * Never takes a tenantId — it is not a tenant send.
 */
export async function sendPlatformEmail(input: {
  to: string;
  subject: string;
  html: string;
  idempotencyKey?: string;
}) {
  return callInfobipEmail({
    to: input.to,
    from: platformEmailFrom(),
    fromName: PLATFORM_FROM_NAME,
    subject: input.subject,
    html: input.html,
    idempotencyKey: input.idempotencyKey,
  });
}

// ---------------------------------------------------------------------------
// Window (08:00-20:00 Brasília)
// ---------------------------------------------------------------------------

function brtMinuteOfDay(at: Date): number {
  const shifted = new Date(at.getTime() + BRT_OFFSET_MIN * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** Whether `at` falls inside the 08:00-20:00 Brasília sending window. */
export function isWithinBillingEmailWindow(at: Date): boolean {
  const minute = brtMinuteOfDay(at);
  return minute >= WINDOW_START_MIN && minute < WINDOW_END_MIN;
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

function formatDDMM(yyyyMmDd: string): string {
  const [, m, d] = yyyyMmDd.split("-");
  return `${d}/${m}`;
}

// `brl()` inserts a NBSP between "R$" and the number; normalized to a plain
// space for e-mail HTML (same approach as billing-view.ts's `money()`).
function moneyBRL(amountCents: number): string {
  return brl(amountCents / 100).replace(new RegExp(String.fromCharCode(160), "g"), " ");
}

function emailSubject(kind: BillingEmailKind, dueDateDDMM: string): string {
  switch (kind) {
    case "issued":
      return `Sua mensalidade BetLeads vence em ${dueDateDDMM}`;
    case "due_today":
      return "Sua mensalidade BetLeads vence hoje";
    case "locked":
      return "Acesso ao CRM suspenso por falta de pagamento";
    case "paid":
      return "Pagamento confirmado — obrigado!";
  }
}

function emailBodyText(kind: BillingEmailKind, amount: string, dueDateDDMM: string): string {
  switch (kind) {
    case "issued":
      return `Sua mensalidade de ${amount} vence em ${dueDateDDMM}. Pague por Pix para manter tudo funcionando.`;
    case "due_today":
      return `Sua mensalidade de ${amount} vence hoje. Pague por Pix para manter tudo funcionando.`;
    case "locked":
      return `A mensalidade de ${amount} venceu em ${dueDateDDMM}. O acesso ao CRM foi suspenso por falta de pagamento. Pague por Pix e o acesso volta na hora.`;
    case "paid":
      return `Recebemos o pagamento da sua mensalidade de ${amount}. Obrigado!`;
  }
}

function emailHtml(kind: BillingEmailKind, invoice: InvoiceEmailRow): string {
  const dueDateDDMM = formatDDMM(invoice.due_date);
  const amount = moneyBRL(invoice.amount_cents);
  const bodyText = emailBodyText(kind, amount, dueDateDDMM);
  return `<!doctype html>
<html>
  <body style="margin:0; padding:24px; background:#f5f5f5; font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:8px; padding:24px; color:#1f2937;">
      <p style="font-size:16px; line-height:1.5; margin:0 0 20px;">${bodyText}</p>
      <p style="text-align:center; margin:0;">
        <a href="${PLAN_CREDITS_URL}" style="background:#2563eb; color:#ffffff; padding:12px 24px; border-radius:6px; text-decoration:none; font-weight:bold; display:inline-block;">Abrir Plano e créditos</a>
      </p>
    </div>
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

type InvoiceEmailRow = {
  id: string;
  tenant_id: string;
  due_date: string;
  amount_cents: number;
  status: string;
  paid_at: string | null;
};

async function getInvoiceForEmail(invoiceId: string): Promise<InvoiceEmailRow | null> {
  const { data, error } = await supabaseAdmin
    .from("billing_invoices")
    .select("id, tenant_id, due_date, amount_cents, status, paid_at")
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as InvoiceEmailRow | null) ?? null;
}

type TenantEmailRow = { id: string; nome: string | null; is_demo: boolean | null };

async function getTenantForEmail(tenantId: string): Promise<TenantEmailRow | null> {
  // `is_demo` is not yet in the generated Supabase types; same cast used
  // throughout tenant-access.server.ts for this column.
  const { data, error } = await (supabaseAdmin as any)
    .from("tenants")
    .select("id, nome, is_demo")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as TenantEmailRow | null) ?? null;
}

/** Distinct e-mails of the house's `admin`/`owner`/`gestor` users; never `member`/`user`. */
async function getPayerEmails(tenantId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("user_id, role")
    .eq("tenant_id", tenantId)
    .in("role", [...PAYER_ROLES]);
  if (error) throw new Error(error.message);

  const userIds = Array.from(
    new Set(((data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id)),
  );

  const emails: string[] = [];
  for (const userId of userIds) {
    try {
      const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(
        userId,
      );
      if (userError) throw new Error(userError.message);
      const email = userData?.user?.email;
      if (email && !emails.includes(email)) emails.push(email);
    } catch (err) {
      console.error("[billing-emails] could not resolve recipient e-mail", {
        tenantId,
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return emails;
}

// ---------------------------------------------------------------------------
// sendBillingEmail
// ---------------------------------------------------------------------------

export type SendBillingEmailResult = { sent: boolean; recipients: number };

/**
 * Sends `kind` for one invoice, once. Writes `billing_email_log` with
 * `insert ... on conflict do nothing` BEFORE sending (only the inserter
 * sends); `force` (superadmin resend) upserts instead and always sends.
 *
 * Outside the 08:00-20:00 Brasília window or with `BILLING_INVOICES_ENABLED`
 * off, a non-forced call does nothing (not even a DB read) — the hourly sweep
 * (`sendPendingBillingEmails`) retries later. The 'locked' kind additionally
 * requires `BILLING_ENFORCEMENT_ENABLED`, even when forced: it must never be
 * sent while enforcement is off, whatever triggered the call.
 *
 * A demo house is never e-mailed (explicit check, belt-and-suspenders on top
 * of exempt houses never having an invoice at all): recipients come back
 * empty, but the log row is still written with `recipients = 0` so the job
 * never loops on it.
 */
export async function sendBillingEmail(
  invoiceId: string,
  kind: BillingEmailKind,
  opts: { force?: boolean; now?: Date } = {},
): Promise<SendBillingEmailResult> {
  const force = opts.force ?? false;
  const now = opts.now ?? new Date();

  if (!force) {
    if (!isBillingInvoicesEnabled()) return { sent: false, recipients: 0 };
    if (!isWithinBillingEmailWindow(now)) return { sent: false, recipients: 0 };
  }

  const invoice = await getInvoiceForEmail(invoiceId);
  if (!invoice) return { sent: false, recipients: 0 };

  if (kind === "locked" && !isBillingEnforcementEnabled()) {
    return { sent: false, recipients: 0 };
  }

  const tenant = await getTenantForEmail(invoice.tenant_id);
  const recipients = tenant?.is_demo ? [] : await getPayerEmails(invoice.tenant_id);

  // The exact `sent_at` this call writes — used below to scope the rollback
  // delete to the row THIS call inserted (never a concurrent force-resend's
  // row, which would carry a different `sent_at`).
  const mySentAt = now.toISOString();

  let shouldSend: boolean;
  if (force) {
    const { error } = await supabaseAdmin
      .from("billing_email_log")
      .upsert(
        { invoice_id: invoiceId, kind, sent_at: mySentAt, recipients: recipients.length },
        { onConflict: "invoice_id,kind" },
      );
    if (error) throw new Error(error.message);
    shouldSend = true;
  } else {
    const { data, error } = await supabaseAdmin
      .from("billing_email_log")
      .upsert(
        { invoice_id: invoiceId, kind, sent_at: mySentAt, recipients: recipients.length },
        { onConflict: "invoice_id,kind", ignoreDuplicates: true },
      )
      .select("invoice_id");
    if (error) throw new Error(error.message);
    shouldSend = ((data as unknown[] | null) ?? []).length > 0;
  }

  if (!shouldSend) return { sent: false, recipients: recipients.length };
  if (recipients.length === 0) return { sent: true, recipients: 0 };

  const subject = emailSubject(kind, formatDDMM(invoice.due_date));
  const html = emailHtml(kind, invoice);

  let sentCount = 0;
  for (const [index, to] of recipients.entries()) {
    // Per-recipient idempotency key so an Infobip delivery callback can be
    // attributed to exactly one recipient of this invoice/kind.
    const idempotencyKey = `billing:${invoiceId}:${kind}:${index}`;
    try {
      const result = await sendPlatformEmail({ to, subject, html, idempotencyKey });
      if (result.ok) sentCount += 1;
      else {
        console.error("[billing-emails] provider refused the send", {
          invoiceId,
          kind,
          // Never log the address itself; its position in the recipient list
          // (also in the idempotency key) is enough to trace it.
          recipientIndex: index,
          status: result.status,
        });
      }
    } catch (err) {
      console.error("[billing-emails] send failed", {
        invoiceId,
        kind,
        recipientIndex: index,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (sentCount === 0) {
    // Every recipient failed: undo the log so the next hourly sweep retries
    // instead of silently giving up forever. Scoped to THIS call's exact
    // `sent_at`: a concurrent force-resend that won in between (and wrote
    // its own, later `sent_at`) must never be deleted by this rollback.
    const { error: deleteError } = await supabaseAdmin
      .from("billing_email_log")
      .delete()
      .eq("invoice_id", invoiceId)
      .eq("kind", kind)
      .eq("sent_at", mySentAt);
    if (deleteError) {
      console.error("[billing-emails] could not roll back the log row", {
        invoiceId,
        kind,
        error: deleteError.message,
      });
    }
    return { sent: false, recipients: recipients.length };
  }

  return { sent: true, recipients: recipients.length };
}

// ---------------------------------------------------------------------------
// sendPendingBillingEmails (the hourly sweep)
// ---------------------------------------------------------------------------

async function sentInvoiceIds(kind: BillingEmailKind): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from("billing_email_log")
    .select("invoice_id")
    .eq("kind", kind);
  if (error) throw new Error(error.message);
  return new Set(((data ?? []) as Array<{ invoice_id: string }>).map((row) => row.invoice_id));
}

function withoutSent(rows: Array<{ id: string }>, sent: Set<string>): string[] {
  return rows.filter((row) => !sent.has(row.id)).map((row) => row.id);
}

/** Open invoices with no `issued` log yet. */
async function findIssuedCandidates(): Promise<string[]> {
  const [{ data, error }, sent] = await Promise.all([
    supabaseAdmin.from("billing_invoices").select("id").eq("status", "open"),
    sentInvoiceIds("issued"),
  ]);
  if (error) throw new Error(error.message);
  return withoutSent((data ?? []) as Array<{ id: string }>, sent);
}

/** Open invoices due today (Brasília) with no `due_today` log yet. */
async function findDueTodayCandidates(now: Date): Promise<string[]> {
  const today = brtDayKey(now);
  const [{ data, error }, sent] = await Promise.all([
    supabaseAdmin.from("billing_invoices").select("id").eq("status", "open").eq("due_date", today),
    sentInvoiceIds("due_today"),
  ]);
  if (error) throw new Error(error.message);
  return withoutSent((data ?? []) as Array<{ id: string }>, sent);
}

/** Open invoices of houses in `locked_unpaid` with no `locked` log yet. */
async function findLockedCandidates(): Promise<string[]> {
  const { data: lockedTenants, error: tbError } = await supabaseAdmin
    .from("tenant_billing")
    .select("tenant_id")
    .eq("access_state", "locked_unpaid");
  if (tbError) throw new Error(tbError.message);
  const tenantIds = ((lockedTenants ?? []) as Array<{ tenant_id: string }>).map(
    (row) => row.tenant_id,
  );
  if (tenantIds.length === 0) return [];

  const [{ data, error }, sent] = await Promise.all([
    supabaseAdmin
      .from("billing_invoices")
      .select("id")
      .eq("status", "open")
      .in("tenant_id", tenantIds),
    sentInvoiceIds("locked"),
  ]);
  if (error) throw new Error(error.message);
  return withoutSent((data ?? []) as Array<{ id: string }>, sent);
}

/** Invoices paid in the last 48h with no `paid` log yet. */
async function findPaidCandidates(now: Date): Promise<string[]> {
  const cutoff = new Date(now.getTime() - PAID_LOOKBACK_MS).toISOString();
  const [{ data, error }, sent] = await Promise.all([
    // A 100% discount settles the invoice as 'full_discount': nothing was
    // paid, so no "pagamento confirmado" e-mail. Every paid invoice has a
    // paid_via (the settle always sets it), so neq never drops a real payment.
    supabaseAdmin
      .from("billing_invoices")
      .select("id")
      .eq("status", "paid")
      .neq("paid_via", "full_discount")
      .gte("paid_at", cutoff),
    sentInvoiceIds("paid"),
  ]);
  if (error) throw new Error(error.message);
  return withoutSent((data ?? []) as Array<{ id: string }>, sent);
}

async function sendForKind(
  invoiceIds: string[],
  kind: BillingEmailKind,
  now: Date,
): Promise<number> {
  let count = 0;
  for (const invoiceId of invoiceIds) {
    const result = await sendBillingEmail(invoiceId, kind, { now });
    if (result.sent) count += 1;
  }
  return count;
}

/**
 * The hourly job (Task 3's `runBillingCycle` wires this): sends every
 * pending `issued`/`due_today`/`locked`/`paid` e-mail, each once per invoice
 * (`billing_email_log`). Returns the real count of e-mails actually sent
 * (not merely "handed to the pipeline"). A no-op outside
 * `BILLING_INVOICES_ENABLED` or the 08:00-20:00 Brasília window.
 */
export async function sendPendingBillingEmails(opts: { now?: Date } = {}): Promise<number> {
  if (!isBillingInvoicesEnabled()) return 0;
  const now = opts.now ?? new Date();
  if (!isWithinBillingEmailWindow(now)) return 0;

  let sent = 0;
  sent += await sendForKind(await findIssuedCandidates(), "issued", now);
  sent += await sendForKind(await findDueTodayCandidates(now), "due_today", now);
  if (isBillingEnforcementEnabled()) {
    sent += await sendForKind(await findLockedCandidates(), "locked", now);
  }
  sent += await sendForKind(await findPaidCandidates(now), "paid", now);
  return sent;
}
