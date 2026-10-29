// Infobip SMS adapter (POST /sms/2/text/advanced), for houses whose SMS
// account is an Infobip account (docs/ESCOPO_PROVEDORES_POR_CASA_2026-10-28.md,
// Fase 4). One message per request, like the Short Brasil single path.
//
// Our idempotency key goes out as the message id and as callbackData, so the
// delivery report (/api/public/infobip/sms/events) finds the sms_send_logs
// row by provider_message_id and the tracked links by delivery key.

import type { InfobipAccount } from "./provider-accounts.server";
import {
  transportErrorKind,
  type ProviderAccountReason,
  type ProviderErrorKind,
} from "./rate-limit/transport-errors";

export type InfobipSmsResult = {
  ok: boolean;
  status: number;
  body: unknown;
  idempotencyKey: string;
  errorKind: ProviderErrorKind | null;
  providerAccountId: string | null;
  providerMessageId: string | null;
  /** The provider refused the ACCOUNT (auth / no credits): not the lead's fault. */
  accountReason: ProviderAccountReason | null;
  /** Operator-facing reason of a refusal. */
  errorSummary: string | null;
};

const REQUEST_TIMEOUT_MS = 15_000;
const NOT_SENT_MAX_ATTEMPTS = 3;

type InfobipStatus = {
  groupId?: number;
  groupName?: string;
  id?: number;
  name?: string;
  description?: string;
};

function notifyUrl(): string | null {
  const appUrl = process.env.PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  const token = infobipSmsCallbackToken();
  if (!appUrl || !token) return null;
  const url = new URL(`${appUrl}/api/public/infobip/sms/events`);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Token of the SMS delivery-report webhook (falls back to the voice token, like e-mail). */
export function infobipSmsCallbackToken(): string | null {
  return (
    process.env.INFOBIP_SMS_CALLBACK_TOKEN?.trim() ||
    process.env.INFOBIP_VOICE_CALLBACK_TOKEN?.trim() ||
    null
  );
}

function parseBody(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { non_json: true, snippet: text.slice(0, 400) };
  }
}

function firstMessageStatus(body: unknown): {
  status: InfobipStatus | null;
  messageId: string | null;
} {
  const messages = (body as { messages?: unknown } | null)?.messages;
  const first = Array.isArray(messages)
    ? (messages[0] as Record<string, unknown> | undefined)
    : undefined;
  const status =
    first?.status && typeof first.status === "object" ? (first.status as InfobipStatus) : null;
  const messageId = typeof first?.messageId === "string" ? first.messageId : null;
  return { status, messageId };
}

function requestErrorText(body: unknown): string | null {
  const text = (body as { requestError?: { serviceException?: { text?: unknown } } } | null)
    ?.requestError?.serviceException?.text;
  return typeof text === "string" && text ? text : null;
}

/** Infobip rejection names that refuse the account itself, not the number. */
function accountReasonOf(
  httpStatus: number,
  status: InfobipStatus | null,
): ProviderAccountReason | null {
  if (httpStatus === 401 || httpStatus === 403) return "auth";
  if (httpStatus === 402) return "no_balance";
  const name = String(status?.name ?? "").toUpperCase();
  if (/NOT_ENOUGH_CREDITS|NO_CREDIT|INSUFFICIENT/.test(name)) return "no_balance";
  return null;
}

/** One SMS through one Infobip account (no house guard, billing or log: callers own those). */
export async function postInfobipSms(
  account: InfobipAccount,
  to: string,
  message: string,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<InfobipSmsResult> {
  const base = {
    idempotencyKey,
    providerAccountId: account.id,
    providerMessageId: null,
    accountReason: null,
  };
  if (!account.baseUrl || !account.apiKey) {
    return {
      ...base,
      ok: false,
      status: 0,
      body: { error: "URL base ou API key da conta Infobip não configurada" },
      idempotencyKey: "",
      errorKind: "misconfigured",
      errorSummary: "Conta Infobip sem URL base ou API key",
    };
  }
  const reportUrl = notifyUrl();
  const payload = {
    messages: [
      {
        destinations: [{ to: to.replace(/\D/g, ""), messageId: idempotencyKey }],
        ...(account.smsFrom ? { from: account.smsFrom } : {}),
        text: message,
        callbackData: idempotencyKey,
        ...(reportUrl ? { notifyUrl: reportUrl, notifyContentType: "application/json" } : {}),
      },
    ],
  };

  let response: Response;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      response = await fetch(`${account.baseUrl}/sms/2/text/advanced`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `App ${account.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      break;
    } catch (error) {
      // B1: only a request that provably never left is retried; a timeout or
      // reset may have been accepted (no request idempotency at Infobip).
      const errorKind = transportErrorKind(error);
      if (errorKind === "not_sent" && attempt < NOT_SENT_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ...base,
        ok: false,
        status: 0,
        body: { error: reason, attempts: attempt },
        errorKind,
        errorSummary: `Sem resposta da Infobip: ${reason}`,
      };
    }
  }

  const body = parseBody(await response.text());
  const { status, messageId } = firstMessageStatus(body);
  // PENDING (group 1) is "accepted, waiting for the operator"; anything else
  // in the immediate answer (REJECTED, group 5) did not go out.
  const accepted =
    response.ok &&
    (status?.groupId === 1 || String(status?.groupName ?? "").toUpperCase() === "PENDING");
  if (accepted) {
    return {
      ...base,
      ok: true,
      status: response.status,
      body,
      errorKind: null,
      providerMessageId: messageId ?? idempotencyKey,
      errorSummary: null,
    };
  }
  const accountReason = accountReasonOf(response.status, status);
  const detail =
    status?.description || status?.name || requestErrorText(body) || `HTTP ${response.status}`;
  return {
    ...base,
    ok: false,
    status: response.status,
    body,
    errorKind: null,
    accountReason,
    errorSummary:
      accountReason === "auth"
        ? `A Infobip recusou as credenciais da conta (${detail})`
        : accountReason === "no_balance"
          ? `Conta Infobip sem crédito (${detail})`
          : `Infobip recusou o SMS: ${detail}`,
  };
}
