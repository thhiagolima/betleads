import { supabaseAdmin } from "@/integrations/supabase/client.server";
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

export type SendEmailResult = Awaited<ReturnType<typeof callInfobipEmail>>;

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
  const result = await callInfobipEmail({
    ...input,
    html: shieldDarkEmailHtml(
      absolutizeEmailUrls(sanitizeEmailHtml(prepared?.content ?? augmentedHtml), getEmailBaseUrl()),
    ),
    idempotencyKey,
  });
  await (result.ok
    ? markTrackedDispatchesSent(trackedDispatchIds)
    : markTrackedDispatchesFailed(trackedDispatchIds));
  return result;
}

export async function resolveSender(
  smtpId?: string | null,
  tenantId?: string | null,
): Promise<{ fromEmail: string; fromName: string | null; replyTo: string | null } | null> {
  if (smtpId) {
    const { data, error } = await supabaseAdmin
      .from("email_smtp_configs")
      .select("from_email, from_name, config")
      .eq("id", smtpId)
      .maybeSingle();
    if (!error && data)
      return {
        fromEmail: data.from_email,
        fromName: data.from_name ?? null,
        replyTo: ((data.config ?? {}) as { replyTo?: string }).replyTo || null,
      };
  }
  const senderQuery = supabaseAdmin
    .from("email_senders")
    .select("from_email, from_name, reply_to")
    .eq("is_default", true)
    .limit(1);
  if (tenantId) senderQuery.eq("tenant_id", tenantId);
  const { data: sender } = await senderQuery.maybeSingle();
  if (sender)
    return {
      fromEmail: sender.from_email,
      fromName: sender.from_name ?? null,
      replyTo: sender.reply_to ?? null,
    };
  const smtpQuery = supabaseAdmin
    .from("email_smtp_configs")
    .select("from_email, from_name, config")
    .eq("is_default", true)
    .limit(1);
  if (tenantId) smtpQuery.eq("tenant_id", tenantId);
  const { data: smtp } = await smtpQuery.maybeSingle();
  return smtp
    ? {
        fromEmail: smtp.from_email,
        fromName: smtp.from_name ?? null,
        replyTo: ((smtp.config ?? {}) as { replyTo?: string }).replyTo || null,
      }
    : null;
}
