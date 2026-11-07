import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { refundForDelivery, reserveForDelivery } from "./billing/wallet.server";
import { requireBrazilianPhone } from "./phone-normalization";
import { transportErrorKind, type ProviderErrorKind } from "./rate-limit/transport-errors";
import { assertTenantNotDemoForSend } from "./tenant-access.server";
import { isChannelEnabled } from "./tenant-channels.server";
import { CHANNEL_DISABLED_MESSAGE } from "./tenant-channels.shared";
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

/** CML create timeout of platform accounts; a house-owned account uses OWNED_ACCOUNT_REQUEST_TIMEOUT_MS. */
const REQUEST_TIMEOUT_MS = 20_000;

// Infobip Calls Markup Language (CML) adapter for outbound recorded calls.
// Voz do CRM é atendida exclusivamente pela Infobip.

export function normalizeE164BR(raw: string): string {
  return requireBrazilianPhone(raw);
}

export type InfobipVoiceResult = {
  ok: boolean;
  status: number;
  body: unknown;
  idempotencyKey: string;
  providerCallId: string | null;
  /** True when a call for this idempotency key already exists locally; no new call was placed. */
  alreadySent?: boolean;
  /** Set when there is no provider response (B1): whether the call may exist. */
  errorKind?: ProviderErrorKind | null;
  /**
   * PG3 — the wallet reservation made for this call (`voice:<key>[:gen]`).
   * Present whenever blocks were reserved, also on a failure (then already
   * refunded). Callers persist `referenceId` in call_history.billing_reference_id.
   */
  billing?: { referenceId: string; units: number };
  /** Conta de provedor que fez a ligação; ausente quando nenhuma foi usada. */
  providerAccountId?: string | null;
};

/** Default cap (seconds) of a call without a known audio/flow limit. */
const DEFAULT_VOICE_MAX_CALL_SECONDS = 120;

function positiveSeconds(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Voice blocks reserved before dialing (PG3 spec, decision 2):
 * `ceil((maxSeconds + 10) / 30)`. A missing or invalid cap falls back to
 * `VOICE_MAX_CALL_SECONDS`, then to 120 s.
 */
export function voiceReservationUnits(maxSeconds?: number | null): number {
  const seconds =
    positiveSeconds(maxSeconds) ??
    positiveSeconds(process.env.VOICE_MAX_CALL_SECONDS) ??
    DEFAULT_VOICE_MAX_CALL_SECONDS;
  return Math.ceil((seconds + 10) / 30);
}

export type InfobipVoiceOptions = {
  /**
   * Stable identity of one logical call (e.g. the journey delivery key). It is
   * forwarded as `customData` and callback correlation, and a call already
   * recorded in call_history with this correlation is never placed again.
   */
  idempotencyKey?: string | null;
  tenantId: string;
  /**
   * Longest expected call, in seconds: the audio duration (journeys) or the
   * block's `max_call_seconds` (call flows). Sizes the wallet reservation;
   * defaults to `VOICE_MAX_CALL_SECONDS` (120).
   */
  maxSeconds?: number | null;
  /** Área do Expert: owner of the call; the reservation checks his monthly cap. */
  expertId?: string | null;
  /**
   * Wallet delivery key when it must differ from `idempotencyKey` (e.g. the
   * call_queue item id: one reservation `voice:<queue id>[:gen]` per item,
   * while each dial keeps its own correlation). Defaults to the idempotency
   * key, else the fresh uuid.
   */
  billingKey?: string | null;
};

export type InfobipVoiceContent =
  | { type: "audio"; audioUrl: string }
  | { type: "tts"; text: string; language?: string };

function jsonBody(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { non_json: true, snippet: text.slice(0, 500) };
  }
}

/**
 * CML / event URL. `accountToken` is the house-owned account's callback token
 * (provider-callback-tokens.server.ts); null means a platform account, which
 * keeps the global INFOBIP_VOICE_CALLBACK_TOKEN.
 */
function callbackUrl(
  path: string,
  params: Record<string, string>,
  accountToken: string | null,
): string | null {
  const appUrl = process.env.PUBLIC_APP_URL?.replace(/\/$/, "");
  const token = accountToken ?? process.env.INFOBIP_VOICE_CALLBACK_TOKEN;
  if (!appUrl || !token) return null;
  const url = new URL(`${appUrl}${path}`);
  url.searchParams.set("token", token);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

async function findExistingCall(
  idempotencyKey: string,
  tenantId: string | null | undefined,
): Promise<{ id: string; provider_call_id: string | null } | null> {
  let query = supabaseAdmin
    .from("call_history")
    .select("id, provider_call_id")
    .eq("provider_response->>correlation_id", idempotencyKey);
  if (tenantId) query = query.eq("tenant_id", tenantId);
  const { data, error } = await query.limit(1);
  if (error) throw new Error(error.message);
  return data?.[0] ?? null;
}

/** Starts a CML call. Infobip fetches the callback only after the call is answered. */
export async function callInfobipVoice(
  to: string,
  content: InfobipVoiceContent,
  options: InfobipVoiceOptions,
): Promise<InfobipVoiceResult> {
  const idempotencyKey = options.idempotencyKey || crypto.randomUUID();
  // The CML create endpoint has no request-idempotency contract, so a retried
  // delivery is deduplicated against local state before dialing anyone.
  if (options.idempotencyKey) {
    try {
      const existing = await findExistingCall(idempotencyKey, options.tenantId);
      if (existing) {
        return {
          ok: true,
          status: 200,
          body: { already_sent: true, call_history_id: existing.id },
          idempotencyKey,
          providerCallId: existing.provider_call_id,
          alreadySent: true,
        };
      }
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: {
          error: `Falha ao verificar ligação existente: ${error instanceof Error ? error.message : String(error)}`,
        },
        idempotencyKey,
        providerCallId: null,
        // The local duplicate check failed: the provider was never called.
        errorKind: "not_sent",
      };
    }
  }
  // Voice channel turned off for the house (tenant_channels): before the
  // account is resolved (no misconfigured error) and before any reservation.
  if (!(await isChannelEnabled(options.tenantId ?? null, "voice"))) {
    return {
      ok: false,
      status: 0,
      body: { error: CHANNEL_DISABLED_MESSAGE("voice") },
      idempotencyKey,
      providerCallId: null,
      errorKind: "channel_disabled",
    };
  }
  let account: InfobipAccount;
  try {
    account = await resolveInfobipAccount(options.tenantId, "voice");
  } catch (error) {
    if (!(error instanceof ProviderAccountUnavailableError)) throw error;
    return {
      ok: false,
      status: 0,
      body: { error: error.message },
      idempotencyKey,
      providerCallId: null,
      errorKind: "misconfigured",
    };
  }
  const { baseUrl, apiKey, voiceFrom: from } = account;
  let accountToken: string | null;
  try {
    accountToken = await callbackTokenFor(account);
  } catch (error) {
    // Owned account without a readable callback token: never dialed, and
    // never with the global token.
    return {
      ok: false,
      status: 0,
      body: {
        error: `Token de callback da conta indisponível: ${error instanceof Error ? error.message : String(error)}`,
      },
      idempotencyKey,
      providerCallId: null,
      errorKind: "misconfigured",
      providerAccountId: account.id,
    };
  }
  const callback = callbackUrl(
    "/api/public/infobip/voice/cml",
    content.type === "audio"
      ? { audio: content.audioUrl, correlation: idempotencyKey }
      : { mode: "say", correlation: idempotencyKey },
    accountToken,
  );
  // The event webhook is unique per request as well. `customData` is kept as
  // a second correlation mechanism because providers may omit URL parameters
  // from a forwarded event payload.
  const notifyUrl = callbackUrl(
    "/api/public/infobip/voice/events",
    { correlation: idempotencyKey },
    accountToken,
  );
  if (!baseUrl || !apiKey || !from || !callback || !notifyUrl) {
    return {
      ok: false,
      status: 0,
      body: { error: "Configuração Infobip Voice incompleta" },
      idempotencyKey,
      providerCallId: null,
      errorKind: "misconfigured",
      providerAccountId: account.id,
    };
  }
  // Fail-closed guard immediately before the provider request: a demo,
  // unknown or missing tenant never reaches Infobip. Checked here rather than
  // only in the top-level dispatcher so this also covers every call site.
  await assertTenantNotDemoForSend(options.tenantId);
  // Conta própria (Task 9): at most OWNED_ACCOUNT_MAX_INFLIGHT requests in
  // flight per house-owned account. Over the limit: never dialed nor
  // reserved; the 429 item backoff hands it back to the queue.
  const slot = tryAcquireAccountSlot(account);
  if (!slot) {
    return {
      ok: false,
      status: OWNED_ACCOUNT_BUSY_STATUS,
      body: { error: OWNED_ACCOUNT_BUSY_MESSAGE, owned_account_busy: true },
      idempotencyKey,
      providerCallId: null,
      errorKind: null,
      providerAccountId: account.id,
    };
  }
  try {
    return await reserveAndDial(account, to, options, idempotencyKey, {
      callback,
      notifyUrl,
    });
  } finally {
    slot.release();
  }
}

async function reserveAndDial(
  account: InfobipAccount,
  to: string,
  options: InfobipVoiceOptions,
  idempotencyKey: string,
  urls: { callback: string; notifyUrl: string },
): Promise<InfobipVoiceResult> {
  const { baseUrl, apiKey, voiceFrom: from } = account;
  const { callback, notifyUrl } = urls;
  // PG3: reserve the call's blocks from the house's wallet only after the
  // guard (a demo or locked house never reserves) and before dialing. The
  // delivery key is the caller's idempotency key, else the fresh uuid above,
  // so a retry of a refunded attempt moves to the next generation. Any error
  // other than "no balance" propagates (the call is not placed).
  const units = voiceReservationUnits(options.maxSeconds);
  const reservation = await reserveForDelivery(supabaseAdmin, {
    tenantId: options.tenantId,
    item: "voice_30s",
    prefix: "voice",
    deliveryKey: options.billingKey || idempotencyKey,
    units,
    referenceType: "voice_call",
    ...(options.expertId ? { expertId: options.expertId } : {}),
    // The account resolved above is the one that dials (conta própria: SQL
    // reserves 0 when the house owns it).
    providerAccountId: account.id,
  });
  if (!reservation.ok && reservation.refusal) {
    // Área do Expert: the expert's cap (or deactivation); never dialed.
    return {
      ok: false,
      status: 0,
      body: { error: reservation.reason },
      idempotencyKey,
      providerCallId: null,
      errorKind: reservation.refusal,
    };
  }
  if (!reservation.ok) {
    return {
      ok: false,
      status: 0,
      body: { error: reservation.reason },
      idempotencyKey,
      providerCallId: null,
      // The HOUSE's wallet refused: never dialed, never a global pause.
      errorKind: "insufficient_balance",
    };
  }
  const billing = { referenceId: reservation.referenceId, units };
  const result = await placeCall(
    baseUrl,
    apiKey,
    from,
    to,
    callback,
    notifyUrl,
    idempotencyKey,
    requestTimeoutMsFor(account, REQUEST_TIMEOUT_MS),
  );
  // Refund on ANY failure, including a timeout that may have placed the call
  // (PG3 spec, decision 5 — same as SMS).
  if (!result.ok) {
    await refundForDelivery(supabaseAdmin, {
      tenantId: options.tenantId,
      referenceId: reservation.referenceId,
      prefix: "voice",
      reason: `infobip_voice_${result.status || result.errorKind || "error"}`,
    });
  }
  return { ...result, billing, providerAccountId: account.id };
}

async function placeCall(
  baseUrl: string,
  apiKey: string,
  from: string,
  to: string,
  callback: string,
  notifyUrl: string,
  idempotencyKey: string,
  timeoutMs: number,
): Promise<InfobipVoiceResult> {
  try {
    const { response, text } = await fetchTextWithTimeout(
      `${baseUrl}/markuplanguage/1/create`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `App ${apiKey}`,
        },
        body: JSON.stringify({
          callback: { url: callback, errorUrl: callback, method: "POST" },
          endpoint: { type: "PHONE", phoneNumber: to.replace(/^\+/, "") },
          notifyUrl,
          from,
          customData: idempotencyKey,
        }),
      },
      timeoutMs,
      `Infobip não respondeu em ${timeoutMs / 1000}s`,
    );
    const body = jsonBody(text);
    const data = body as { callId?: string; id?: string } | null;
    return {
      ok: response.ok,
      status: response.status,
      body,
      idempotencyKey,
      providerCallId: data?.callId ?? data?.id ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { error: error instanceof Error ? error.message : String(error) },
      idempotencyKey,
      providerCallId: null,
      // A timeout (20 s; 8 s on a house-owned account) or reset may still have placed the call (no
      // idempotency header on the CML create endpoint).
      errorKind: transportErrorKind(error),
    };
  }
}
