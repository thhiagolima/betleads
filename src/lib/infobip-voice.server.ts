import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { refundForDelivery, reserveForDelivery } from "./billing/wallet.server";
import { requireBrazilianPhone } from "./phone-normalization";
import { transportErrorKind, type ProviderErrorKind } from "./rate-limit/transport-errors";
import { assertTenantNotDemoForSend } from "./tenant-access.server";

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

function callbackUrl(path: string, params: Record<string, string>): string | null {
  const appUrl = process.env.PUBLIC_APP_URL?.replace(/\/$/, "");
  const token = process.env.INFOBIP_VOICE_CALLBACK_TOKEN;
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
  const baseUrl = process.env.INFOBIP_BASE_URL?.trim().replace(/\/$/, "");
  const apiKey = process.env.INFOBIP_API_KEY?.trim();
  const from = process.env.INFOBIP_VOICE_FROM?.replace(/\D/g, "");
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
  const callback = callbackUrl(
    "/api/public/infobip/voice/cml",
    content.type === "audio"
      ? { audio: content.audioUrl, correlation: idempotencyKey }
      : { mode: "say", correlation: idempotencyKey },
  );
  // The event webhook is unique per request as well. `customData` is kept as
  // a second correlation mechanism because providers may omit URL parameters
  // from a forwarded event payload.
  const notifyUrl = callbackUrl("/api/public/infobip/voice/events", {
    correlation: idempotencyKey,
  });
  if (!baseUrl || !apiKey || !from || !callback || !notifyUrl) {
    return {
      ok: false,
      status: 0,
      body: { error: "Configuração Infobip Voice incompleta" },
      idempotencyKey,
      providerCallId: null,
      errorKind: "misconfigured",
    };
  }
  // Fail-closed guard immediately before the provider request: a demo,
  // unknown or missing tenant never reaches Infobip. Checked here rather than
  // only in the top-level dispatcher so this also covers every call site.
  await assertTenantNotDemoForSend(options.tenantId);
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
    deliveryKey: idempotencyKey,
    units,
    referenceType: "voice_call",
  });
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
  const result = await placeCall(baseUrl, apiKey, from, to, callback, notifyUrl, idempotencyKey);
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
  return { ...result, billing };
}

async function placeCall(
  baseUrl: string,
  apiKey: string,
  from: string,
  to: string,
  callback: string,
  notifyUrl: string,
  idempotencyKey: string,
): Promise<InfobipVoiceResult> {
  try {
    const response = await fetch(`${baseUrl}/markuplanguage/1/create`, {
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
      signal: AbortSignal.timeout(20_000),
    });
    const body = jsonBody(await response.text());
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
      // A 20 s timeout or reset may still have placed the call (no
      // idempotency header on the CML create endpoint).
      errorKind: transportErrorKind(error),
    };
  }
}
