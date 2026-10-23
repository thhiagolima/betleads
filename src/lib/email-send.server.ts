import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { refundForDelivery, reserveForDelivery } from "./billing/wallet.server";
import { augmentEmailHtml, isSuppressed } from "./email-deliverability.server";
import { callInfobipEmail } from "./infobip-email.server";
import { getChannelConsentStatus } from "./consent.server";
import { assertTenantNotDemoForSend } from "./tenant-access.server";
import {
  markTrackedDispatchesFailed,
  markTrackedDispatchesSent,
  prepareTrackedEmailHtml,
  type LinkTrackingContext,
} from "./shortio.server";

export type SendEmailInput = {
  to: string;
  from: string;
  fromName?: string | null;
  replyTo?: string | null;
  subject: string;
  html: string;
  idempotencyKey?: string;
  tenantId?: string | null;
  linkTracking?: Omit<LinkTrackingContext, "channel">;
};

export type SendEmailResult = Awaited<ReturnType<typeof callInfobipEmail>> & {
  /**
   * PG3 — the wallet reservation of this e-mail (`email:<key>[:gen]`).
   * Present whenever one was made, also on a failure (then already refunded,
   * `amount` 0). `amount` is what the house paid for this e-mail in R$
   * (0 inside the monthly free allowance or for an exempt house). Callers
   * persist both in email_send_logs.billing_reference_id / billed_amount.
   */
  billing?: { referenceId: string; amount: number };
};

/** wallet_ledger.reference_type of an e-mail reservation. */
export const EMAIL_RESERVATION_REFERENCE_TYPE = "email_send";

/** body.error of a send refused by the house's own wallet. */
export const EMAIL_INSUFFICIENT_BALANCE_MESSAGE = "Saldo insuficiente";

export function sanitizeEmailHtml(html: string): string {
  return (html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

function getEmailBaseUrl(): string {
  return (
    process.env.PUBLIC_APP_URL ||
    process.env.VITE_PUBLIC_APP_URL ||
    "https://betleads.io"
  ).replace(/\/+$/, "");
}

export function absolutizeEmailUrls(html: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return html.replace(
    /(\s(?:src|href|background|poster)\s*=\s*["'])([^"']*)(["'])/gi,
    (_m, before, value, after) => {
      if (!value || /^(https?:|data:|cid:|mailto:|tel:|#)/i.test(value))
        return `${before}${value}${after}`;
      if (value.startsWith("blob:")) return `${before}${after}`;
      return `${before}${value.startsWith("/") ? base : `${base}/`}${value.replace(/^\.?\//, "")}${after}`;
    },
  );
}

export function shieldDarkEmailHtml(html: string): string {
  return html || "";
}

/**
 * Previous send of this idempotency key that the provider accepted. Every
 * sender logs the key in email_send_logs.provider_response; a row counts as
 * accepted once it was marked sent (a later bounce keeps sent_at).
 */
async function findAcceptedEmail(idempotencyKey: string, tenantId: string | null) {
  let query = supabaseAdmin
    .from("email_send_logs")
    .select("id")
    .eq("provider_response->>idempotency_key", idempotencyKey)
    .or("status.in.(sent,delivered),sent_at.not.is.null");
  if (tenantId) query = query.eq("tenant_id", tenantId);
  const { data, error } = await query.limit(1);
  if (error) throw new Error(error.message);
  return data?.[0]?.id ?? null;
}

/**
 * Único caminho de envio de e-mail: Infobip.
 *
 * Throws DemoTenantBlockedError (DEMO_SEND_BLOCKED) for a demo, unknown or
 * missing tenant before any lookup, link dispatch or provider call. It throws
 * rather than returning a failed result because every caller writes
 * email_send_logs from the returned result.
 */
export async function sendInfobipEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const idempotencyKey = input.idempotencyKey || crypto.randomUUID();
  const tenantId = input.tenantId ?? input.linkTracking?.tenantId ?? null;
  await assertTenantNotDemoForSend(tenantId);
  // A caller-supplied key identifies one logical delivery: if it was already
  // accepted (e.g. the worker failed after sending), never send it again.
  if (input.idempotencyKey) {
    let acceptedId: string | null;
    try {
      acceptedId = await findAcceptedEmail(idempotencyKey, tenantId);
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: {
          error: `Falha ao verificar envio anterior: ${error instanceof Error ? error.message : String(error)}`,
        },
        idempotencyKey,
        temporary: true,
        // Local pre-check failed: the provider was never called.
        errorKind: "not_sent",
      };
    }
    if (acceptedId) {
      return {
        ok: true,
        status: 200,
        body: { already_sent: true, email_log_id: acceptedId },
        idempotencyKey,
        temporary: false,
        alreadySent: true,
      };
    }
  }
  try {
    const centralStatus = tenantId
      ? await getChannelConsentStatus(tenantId, "email", input.to)
      : null;
    if (centralStatus === "revoked") {
      return {
        ok: false,
        status: 200,
        body: { suppressed: true, reason: "consent_revoked" },
        idempotencyKey,
        temporary: false,
      };
    }
    if (centralStatus !== "granted" && (await isSuppressed(input.to, tenantId))) {
      return {
        ok: false,
        status: 200,
        body: { suppressed: true, reason: "recipient_in_suppression_list" },
        idempotencyKey,
        temporary: false,
      };
    }
  } catch (error) {
    // Fail-closed (QA-03): without a consent answer the e-mail is NOT sent.
    // temporary + not_sent: the provider was never called, so every caller
    // re-queues the item (campaign/flow log "pending", journey retry policy).
    console.warn("[email-send] consent check failed; send deferred", {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      status: 0,
      body: {
        error: `consent_check_failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      idempotencyKey,
      temporary: true,
      errorKind: "not_sent",
    };
  }

  const { html: augmentedHtml } = await augmentEmailHtml(input.html, { email: input.to, tenantId });
  const prepared = input.linkTracking
    ? await prepareTrackedEmailHtml(augmentedHtml, {
        ...input.linkTracking,
        deliveryKey: idempotencyKey,
      })
    : null;
  const trackedDispatchIds = prepared?.links.map((link) => link.dispatchId) ?? [];
  // Second guard immediately before the provider request.
  await assertTenantNotDemoForSend(tenantId);
  // PG3: charge this e-mail to the house's wallet. Only here — after both
  // guards (a demo or locked house never reserves) and after the consent and
  // suppression checks (a refused recipient is never charged). The monthly
  // free allowance is counted inside wallet_reserve. The delivery key is the
  // caller's idempotency key, else the fresh uuid above, so a retry of a
  // refunded attempt moves to the next generation. Any error other than "no
  // balance" propagates (nothing is sent). Platform e-mails (billing, DNS)
  // call callInfobipEmail directly and are never charged.
  const billingTenantId = tenantId as string; // the guard throws without one
  let reservation: Awaited<ReturnType<typeof reserveForDelivery>>;
  try {
    reservation = await reserveForDelivery(supabaseAdmin, {
      tenantId: billingTenantId,
      item: "email",
      prefix: "email",
      deliveryKey: idempotencyKey,
      units: 1,
      referenceType: EMAIL_RESERVATION_REFERENCE_TYPE,
    });
  } catch (error) {
    await markTrackedDispatchesFailed(trackedDispatchIds);
    throw error;
  }
  if (!reservation.ok) {
    await markTrackedDispatchesFailed(trackedDispatchIds);
    return {
      ok: false,
      status: 0,
      body: { error: EMAIL_INSUFFICIENT_BALANCE_MESSAGE },
      idempotencyKey,
      temporary: false,
      // The HOUSE's wallet refused: never sent, never a global pause.
      errorKind: "insufficient_balance",
    };
  }
  const refund = (reason: string) =>
    refundForDelivery(supabaseAdmin, {
      tenantId: billingTenantId,
      referenceId: reservation.referenceId,
      prefix: "email",
      reason,
    });
  let result: Awaited<ReturnType<typeof callInfobipEmail>>;
  try {
    result = await callInfobipEmail({
      ...input,
      html: shieldDarkEmailHtml(
        absolutizeEmailUrls(sanitizeEmailHtml(prepared?.content ?? augmentedHtml), getEmailBaseUrl()),
      ),
      idempotencyKey,
    });
  } catch (error) {
    await refund("infobip_email_error");
    await markTrackedDispatchesFailed(trackedDispatchIds);
    throw error;
  }
  // Refund on ANY failure, including a timeout that may have been accepted
  // (PG3 spec, decision 5 — same as SMS).
  if (!result.ok) {
    await refund(`infobip_email_${result.status || result.errorKind || "error"}`);
  }
  await (result.ok
    ? markTrackedDispatchesSent(trackedDispatchIds)
    : markTrackedDispatchesFailed(trackedDispatchIds));
  return {
    ...result,
    billing: {
      referenceId: reservation.referenceId,
      amount: result.ok ? Math.abs(reservation.amount) : 0,
    },
  };
}

/** email_send_logs billing columns for a sendInfobipEmail result. */
export function emailBillingColumns(result: Pick<SendEmailResult, "billing">) {
  return {
    billing_reference_id: result.billing?.referenceId ?? null,
    billed_amount: result.billing ? result.billing.amount : null,
  };
}

export const EMAIL_DOMAIN_NOT_VERIFIED = "EMAIL_DOMAIN_NOT_VERIFIED";

/**
 * The house has no sender on a verified e-mail domain. Thrown before
 * sendInfobipEmail, so nothing is sent nor logged as sent.
 */
export class EmailDomainNotVerifiedError extends Error {
  readonly code = EMAIL_DOMAIN_NOT_VERIFIED;
  constructor(message = "Configure e verifique um domínio de e-mail da casa para enviar e-mails.") {
    super(message);
    this.name = "EmailDomainNotVerifiedError";
  }
}

/** Shown when a campaign/step names a sender that no longer qualifies. */
export const STALE_SENDER_MESSAGE =
  "O remetente escolhido não está mais disponível (domínio removido ou não verificado). Escolha outro remetente.";

export type ResolvedSender = {
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
  senderId: string;
};

/**
 * Sender of a house e-mail. Only `email_senders` of this tenant whose
 * `domain_id` is a verified, non-removed e-mail `tenant_domains` row of the
 * same tenant qualify (legacy senders without domain_id never do, and
 * `email_smtp_configs` is never read).
 * - An explicit `senderId` must itself qualify: if it no longer does (other
 *   house, unverified/removed domain, legacy, deleted) the send is BLOCKED
 *   (`null`) — it never silently switches to another sender.
 * - No `senderId`: the house default, then the oldest qualifying sender.
 * `null` = the house cannot send this e-mail (callers throw
 * EmailDomainNotVerifiedError).
 */
export async function resolveSender(input: {
  tenantId: string;
  senderId?: string | null;
}): Promise<ResolvedSender | null> {
  const { tenantId, senderId } = input;
  if (!tenantId) return null;
  const blockStale = () => {
    console.warn(
      `[resolveSender] sender ${senderId} no longer qualifies for tenant ${tenantId}; e-mail blocked`,
    );
    return null;
  };
  const { data: senders, error } = await supabaseAdmin
    .from("email_senders")
    .select("id, from_email, from_name, name, reply_to, domain_id, is_default, created_at")
    .eq("tenant_id", tenantId)
    .not("domain_id", "is", null);
  if (error) throw new Error(error.message);
  const candidates = senders ?? [];
  const domainIds = [...new Set(candidates.map((s) => s.domain_id).filter(Boolean))] as string[];
  if (domainIds.length === 0) return senderId ? blockStale() : null;
  const { data: domains, error: domainError } = await supabaseAdmin
    .from("tenant_domains")
    .select("id, removed_at")
    .in("id", domainIds)
    .eq("tenant_id", tenantId)
    .eq("kind", "email")
    .eq("status", "verified");
  if (domainError) throw new Error(domainError.message);
  const verified = new Set((domains ?? []).filter((d) => !d.removed_at).map((d) => d.id));
  const usable = candidates
    .filter((s) => s.domain_id && verified.has(s.domain_id))
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  let chosen: (typeof usable)[number] | undefined;
  if (senderId) {
    chosen = usable.find((s) => s.id === senderId);
    if (!chosen) return blockStale();
  } else {
    chosen = usable.find((s) => s.is_default) ?? usable[0];
  }
  if (!chosen) return null;
  return {
    fromEmail: chosen.from_email,
    fromName: chosen.from_name || chosen.name,
    replyTo: chosen.reply_to ?? null,
    senderId: chosen.id,
  };
}
