import { requireBrazilianPhone } from "./phone-normalization";

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
};

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

/** Starts a CML call. Infobip fetches the callback only after the call is answered. */
export async function callInfobipVoice(to: string, audioUrl: string): Promise<InfobipVoiceResult> {
  const baseUrl = process.env.INFOBIP_BASE_URL?.trim().replace(/\/$/, "");
  const apiKey = process.env.INFOBIP_API_KEY?.trim();
  const from = process.env.INFOBIP_VOICE_FROM?.replace(/\D/g, "");
  const idempotencyKey = crypto.randomUUID();
  const callback = callbackUrl("/api/public/infobip/voice/cml", { audio: audioUrl });
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
    };
  }
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
    };
  }
}
