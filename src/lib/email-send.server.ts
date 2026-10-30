import sanitizeHtml from "sanitize-html";

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
import {
  DEFAULT_INFOBIP_ACCOUNT_ID,
  ProviderAccountUnavailableError,
  resolveInfobipAccount,
} from "./provider-accounts.server";

/** The house's current e-mail account id; null when its own account is unavailable. */
async function currentEmailAccountId(tenantId: string): Promise<string | null> {
  try {
    return (await resolveInfobipAccount(tenantId, "email")).id;
  } catch (error) {
    if (error instanceof ProviderAccountUnavailableError) return null;
    throw error;
  }
}

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

// Allowlist of what an e-mail body may carry: the document shell, text,
// tables, images, links and inline/head CSS. Everything else (script, iframe,
// form/inputs, object/embed, base, link, svg/math, every on* attribute, meta
// http-equiv such as refresh) is dropped. The parser keeps no comments (so no
// Outlook conditional comments either) and no doctype; a doctype is put back.
const EMAIL_TAGS = [
  "html", "head", "body", "meta", "title", "style",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "col", "colgroup",
  "div", "span", "p", "br", "hr", "center", "font", "img", "a",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "b", "i", "u", "s", "strong", "em", "small", "big", "sub", "sup", "mark", "strike", "del", "ins",
  "ul", "ol", "li", "dl", "dt", "dd", "blockquote", "pre", "code", "abbr", "address", "cite", "q",
  "section", "article", "header", "footer", "main", "nav", "aside", "figure", "figcaption", "wbr",
];

const EMAIL_COMMON_ATTRS = [
  "style", "class", "id", "dir", "lang", "title", "role", "align", "valign",
  "width", "height", "bgcolor", "background", "border", "color", "face", "size",
  "aria-*",
];

/** CSS that runs or loads code in some engine (IE expression/behavior, XBL, script URLs, imports). */
const UNSAFE_CSS = /expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behavior\s*:|@import/i;

const EMAIL_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: EMAIL_TAGS,
  // `style` blocks are what responsive e-mail CSS is made of; their content is
  // raw CSS (never parsed as HTML) and e-mail clients run no scripts.
  allowVulnerableTags: true,
  disallowedTagsMode: "discard",
  // Disallowed tags whose text content is dropped too (not just the tag).
  nonTextTags: [
    "script", "style", "textarea", "option", "noscript", "iframe", "object", "embed",
    "applet", "template", "svg", "math", "noembed", "noframes", "xmp",
  ],
  allowedAttributes: {
    "*": EMAIL_COMMON_ATTRS,
    meta: ["charset", "name", "content"],
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "width", "height", "border", "hspace", "vspace"],
    table: ["cellpadding", "cellspacing", "summary", "frame", "rules"],
    td: ["colspan", "rowspan", "nowrap", "headers", "scope"],
    th: ["colspan", "rowspan", "nowrap", "headers", "scope"],
    col: ["span"],
    colgroup: ["span"],
    ol: ["start", "type"],
    ul: ["type"],
    li: ["value"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  // Images may be inline (data:) or attachments (cid:); links never data:.
  allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
  allowedSchemesAppliedToAttributes: ["href", "src", "cite", "background", "poster"],
  allowProtocolRelative: true,
  // Keeps the inline CSS byte for byte (no postcss rewrite); a declaration
  // list that can run code is removed whole below.
  parseStyleAttributes: false,
  transformTags: {
    "*": (tagName, attribs) => {
      // A meta refresh (any http-equiv) is dropped whole, content included:
      // renamed to a tag outside the allowlist.
      if (tagName === "meta" && Object.keys(attribs).some((n) => n.toLowerCase() === "http-equiv")) {
        return { tagName: "dropped-meta", attribs: {} };
      }
      if (attribs.style && UNSAFE_CSS.test(attribs.style)) {
        const rest = { ...attribs };
        delete rest.style;
        return { tagName, attribs: rest };
      }
      return { tagName, attribs };
    },
  },
  exclusiveFilter: (frame) => frame.tag === "style" && UNSAFE_CSS.test(frame.text ?? ""),
};

/** Allowlist sanitizer of every e-mail body before it goes to the provider. */
export function sanitizeEmailHtml(html: string): string {
  const source = html || "";
  const clean = sanitizeHtml(source, EMAIL_SANITIZE_OPTIONS);
  return /^\s*<!doctype\s/i.test(source) ? `<!DOCTYPE html>${clean}` : clean;
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
      tenantId,
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

/** email_send_logs billing and provider-account columns for a sendInfobipEmail result. */
export function emailSendLogColumns(
  result: Pick<SendEmailResult, "billing" | "providerAccountId">,
) {
  return {
    billing_reference_id: result.billing?.referenceId ?? null,
    billed_amount: result.billing ? result.billing.amount : null,
    provider_account_id: result.providerAccountId ?? null,
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
    .select("id, removed_at, provider_account_id")
    .in("id", domainIds)
    .eq("tenant_id", tenantId)
    .eq("kind", "email")
    .eq("status", "verified");
  if (domainError) throw new Error(domainError.message);
  // A domain verified in another Infobip account (the house's e-mail account
  // changed and the domain is not migrated yet) cannot send through the
  // current one. An unavailable house account is not filtered here: the send
  // itself fails as misconfigured.
  const currentAccountId = await currentEmailAccountId(tenantId);
  const verified = new Set(
    (domains ?? [])
      .filter((d) => !d.removed_at)
      .filter(
        (d) =>
          currentAccountId === null ||
          (d.provider_account_id ?? DEFAULT_INFOBIP_ACCOUNT_ID) === currentAccountId,
      )
      .map((d) => d.id),
  );
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
