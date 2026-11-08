// Infobip Email HTTP API v3 adapter.
// Adaptador único de e-mail do CRM.

import { transportErrorKind, type ProviderErrorKind } from "./rate-limit/transport-errors";
import {
  ProviderAccountUnavailableError,
  resolveInfobipAccount,
  type InfobipAccount,
} from "./provider-accounts.server";
import { callbackTokenFor } from "./provider-callback-tokens.server";
import {
  fetchTextWithTimeout,
  OWNED_ACCOUNT_BUSY_MESSAGE,
  OWNED_ACCOUNT_BUSY_STATUS,
  requestTimeoutMsFor,
  tryAcquireAccountSlot,
} from "./owned-account-isolation.server";

/** Platform accounts; a house-owned account uses OWNED_ACCOUNT_REQUEST_TIMEOUT_MS. */
const REQUEST_TIMEOUT_MS = 20_000;

export type InfobipEmailInput = {
  to: string;
  from: string;
  fromName?: string | null;
  replyTo?: string | null;
  subject: string;
  html: string;
  idempotencyKey?: string;
  /** Casa remetente: escolhe a conta Infobip. Sem casa (e-mails da plataforma), a conta padrão. */
  tenantId?: string | null;
  /**
   * Account already resolved by the caller (sendInfobipEmail reserves the
   * credit with it). With it the account is not resolved again, so the
   * reservation and the send always use the same account.
   */
  account?: InfobipAccount;
  /**
   * The caller (sendInfobipEmail) already holds this account's in-flight slot
   * (owned-account-isolation.server.ts): do not take a second one.
   */
  slotHeld?: boolean;
};

export type InfobipEmailResult = {
  ok: boolean;
  status: number;
  body: unknown;
  idempotencyKey: string;
  temporary?: boolean;
  /** True when this idempotency key was already accepted earlier; the provider was not called. */
  alreadySent?: boolean;
  /** Set when there is no provider response (B1): whether the e-mail may have been accepted. */
  errorKind?: ProviderErrorKind | null;
  /** Conta de provedor usada; null quando nenhuma conta foi usada. */
  providerAccountId?: string | null;
  /** Casa dona da conta usada (conta própria); null = conta da plataforma. */
  providerAccountOwnerTenantId?: string | null;
};

function endpoint(account: InfobipAccount): string | null {
  return account.baseUrl ? `${account.baseUrl}/email/3/send` : null;
}

/**
 * Delivery-event URL. A house-owned account carries its own callback token
 * (provider-callback-tokens.server.ts), never the global one.
 */
async function notifyUrl(correlationId: string, account: InfobipAccount): Promise<string | null> {
  const appUrl = process.env.PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  const token =
    (await callbackTokenFor(account)) ??
    process.env.INFOBIP_EMAIL_CALLBACK_TOKEN?.trim() ??
    process.env.INFOBIP_VOICE_CALLBACK_TOKEN?.trim();
  if (!appUrl || !token) return null;
  const url = new URL(`${appUrl}/api/public/infobip/email/events`);
  url.searchParams.set("token", token);
  url.searchParams.set("correlation", correlationId);
  return url.toString();
}

function parseBody(text: string, contentType: string | null): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { non_json: true, content_type: contentType, snippet: text.slice(0, 500) };
  }
}

/** Result of an e-mail whose house account is unavailable: nothing was sent. */
function infobipEmailAccountUnavailable(
  error: string,
  idempotencyKey: string,
): InfobipEmailResult {
  return {
    ok: false,
    status: 0,
    body: { error },
    idempotencyKey,
    temporary: false,
    errorKind: "misconfigured",
    providerAccountId: null,
  };
}

/** Sends one email through Infobip's documented multipart HTTP endpoint. */
export async function callInfobipEmail(input: InfobipEmailInput): Promise<InfobipEmailResult> {
  const idempotencyKey = input.idempotencyKey || crypto.randomUUID();
  let account: InfobipAccount;
  if (input.account) {
    account = input.account;
  } else {
    try {
      account = await resolveInfobipAccount(input.tenantId, "email");
    } catch (error) {
      if (!(error instanceof ProviderAccountUnavailableError)) throw error;
      return infobipEmailAccountUnavailable(error.message, idempotencyKey);
    }
  }
  const providerAccountId = account.id;
  const providerAccountOwnerTenantId = account.ownerTenantId ?? null;
  const url = endpoint(account);
  const apiKey = account.apiKey;
  if (!url || !apiKey) {
    return {
      ok: false,
      status: 0,
      body: { error: "INFOBIP_BASE_URL ou INFOBIP_API_KEY não configurado" },
      idempotencyKey,
      temporary: false,
      errorKind: "misconfigured",
      providerAccountId,
      providerAccountOwnerTenantId,
    };
  }

  const form = new FormData();
  form.set("from", input.fromName ? `${input.fromName} <${input.from}>` : input.from);
  form.set("to", input.to);
  form.set("subject", input.subject);
  form.set("html", input.html);
  if (input.replyTo) form.set("replyTo", input.replyTo);
  // Both values are per-request: the URL routes the provider event and the
  // opaque key links it to exactly one local delivery without exposing PII.
  form.set("callbackData", idempotencyKey);
  let deliveryUrl: string | null;
  try {
    deliveryUrl = await notifyUrl(idempotencyKey, account);
  } catch (error) {
    // Owned account without a readable callback token: nothing is sent.
    return {
      ok: false,
      status: 0,
      body: {
        error: `Token de callback da conta indisponível: ${error instanceof Error ? error.message : String(error)}`,
      },
      idempotencyKey,
      temporary: false,
      errorKind: "misconfigured",
      providerAccountId,
      providerAccountOwnerTenantId,
    };
  }
  if (deliveryUrl) {
    form.set("notifyUrl", deliveryUrl);
    form.set("notifyContentType", "application/json");
  }

  // Conta própria (Task 9): at most OWNED_ACCOUNT_MAX_INFLIGHT requests in
  // flight per house-owned account; over the limit nothing is sent and the
  // 429 item backoff hands it back to the queue.
  const slot = input.slotHeld ? { release() {} } : tryAcquireAccountSlot(account);
  if (!slot) {
    return {
      ok: false,
      status: OWNED_ACCOUNT_BUSY_STATUS,
      body: { error: OWNED_ACCOUNT_BUSY_MESSAGE, owned_account_busy: true },
      idempotencyKey,
      temporary: true,
      errorKind: "owned_account_busy",
      providerAccountId,
      providerAccountOwnerTenantId,
    };
  }
  try {
    const timeoutMs = requestTimeoutMsFor(account, REQUEST_TIMEOUT_MS);
    const { response, text } = await fetchTextWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `App ${apiKey}`,
        },
        body: form,
      },
      timeoutMs,
      `Infobip não respondeu em ${timeoutMs / 1000}s`,
    );
    const body = parseBody(text, response.headers.get("content-type"));
    return {
      ok: response.ok,
      status: response.status,
      body,
      idempotencyKey,
      temporary: response.status === 429 || response.status >= 500,
      providerAccountId,
      providerAccountOwnerTenantId,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { error: error instanceof Error ? error.message : String(error) },
      idempotencyKey,
      temporary: true,
      errorKind: transportErrorKind(error),
      providerAccountId,
      providerAccountOwnerTenantId,
    };
  } finally {
    slot.release();
  }
}
