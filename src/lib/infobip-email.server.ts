// Infobip Email HTTP API v3 adapter.
// Adaptador único de e-mail do CRM.

export type InfobipEmailInput = {
  to: string;
  from: string;
  fromName?: string | null;
  replyTo?: string | null;
  subject: string;
  html: string;
  idempotencyKey?: string;
};

export type InfobipEmailResult = {
  ok: boolean;
  status: number;
  body: unknown;
  idempotencyKey: string;
  temporary?: boolean;
};

function endpoint(): string | null {
  const baseUrl = process.env.INFOBIP_BASE_URL?.trim().replace(/\/$/, "");
  return baseUrl ? `${baseUrl}/email/3/send` : null;
}

function notifyUrl(correlationId: string): string | null {
  const appUrl = process.env.PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  const token = process.env.INFOBIP_EMAIL_CALLBACK_TOKEN?.trim()
    ?? process.env.INFOBIP_VOICE_CALLBACK_TOKEN?.trim();
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

/** Sends one email through Infobip's documented multipart HTTP endpoint. */
export async function callInfobipEmail(input: InfobipEmailInput): Promise<InfobipEmailResult> {
  const url = endpoint();
  const apiKey = process.env.INFOBIP_API_KEY?.trim();
  const idempotencyKey = input.idempotencyKey || crypto.randomUUID();
  if (!url || !apiKey) {
    return {
      ok: false,
      status: 0,
      body: { error: "INFOBIP_BASE_URL ou INFOBIP_API_KEY não configurado" },
      idempotencyKey,
      temporary: false,
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
  const deliveryUrl = notifyUrl(idempotencyKey);
  if (deliveryUrl) {
    form.set("notifyUrl", deliveryUrl);
    form.set("notifyContentType", "application/json");
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `App ${apiKey}`,
      },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    const body = parseBody(await response.text(), response.headers.get("content-type"));
    return {
      ok: response.ok,
      status: response.status,
      body,
      idempotencyKey,
      temporary: response.status === 429 || response.status >= 500,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { error: error instanceof Error ? error.message : String(error) },
      idempotencyKey,
      temporary: true,
    };
  }
}
