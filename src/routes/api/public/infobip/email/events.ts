import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  ownedAccountIdsFor,
  resolveCallbackScope,
  scopeAllowsRow,
  touchCallbackReceived,
  type CallbackScope,
} from "@/lib/provider-callback-tokens.server";

// E-mail delivery events. ?token= is the global token for platform accounts
// or the account's own token for a house-owned account
// (provider-callback-tokens.server.ts); an event only touches the
// email_send_logs rows the token's scope allows.

type JsonRecord = Record<string, unknown>;

type EventFilter = { scope: CallbackScope; ownedAccountIds: ReadonlySet<string> };

function globalToken(): string | undefined {
  return (
    process.env.INFOBIP_EMAIL_CALLBACK_TOKEN?.trim() ??
    process.env.INFOBIP_VOICE_CALLBACK_TOKEN?.trim()
  );
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function callbackData(event: JsonRecord): string | null {
  const direct = event.callbackData ?? event.callback_data;
  if (typeof direct === "string" && direct) return direct;
  const nested = asRecord(event.message) ?? asRecord(event.result);
  const value = nested?.callbackData ?? nested?.callback_data;
  return typeof value === "string" && value ? value : null;
}

function delivered(event: JsonRecord): boolean | null {
  const status = asRecord(event.status);
  const raw = String(
    status?.groupName ?? status?.name ?? event.status ?? event.state ?? "",
  ).toUpperCase();
  if (/(DELIVERED|DELIVERY|SENT)/.test(raw)) return true;
  if (/(REJECT|UNDELIVER|FAIL|EXPIRE|BOUNCE|ERROR)/.test(raw)) return false;
  return null;
}

async function applyEvent(correlation: string, event: JsonRecord, filter: EventFilter) {
  const { data, error } = await supabaseAdmin
    .from("email_send_logs")
    .select("id, provider_response, provider_account_id")
    .contains("provider_response", { idempotency_key: correlation })
    .limit(20);
  if (error) throw error;
  const rows = ((data ?? []) as Array<{
    id: string;
    provider_response: unknown;
    provider_account_id?: string | null;
  }>).filter((row) =>
    scopeAllowsRow(filter.scope, row.provider_account_id ?? null, filter.ownedAccountIds),
  );
  const isDelivered = delivered(event);
  await Promise.all(
    rows.map((row) => {
      const previous = asRecord(row.provider_response) ?? {};
      return supabaseAdmin
        .from("email_send_logs")
        .update({
          provider_response: { ...previous, delivery_event: event } as never,
          ...(isDelivered === true ? { status: "delivered" } : {}),
          ...(isDelivered === false ? { status: "error", error: "Entrega recusada pelo provedor" } : {}),
        })
        .eq("id", row.id);
    }),
  );
  return rows.length;
}

export const Route = createFileRoute("/api/public/infobip/email/events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const scope = await resolveCallbackScope(
          new URL(request.url).searchParams.get("token"),
          globalToken(),
        );
        if (!scope) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (scope.kind === "account") await touchCallbackReceived(scope.accountId);
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid json" }, { status: 400 });
        }
        const events = Array.isArray(body)
          ? body
          : Array.isArray(asRecord(body)?.results)
            ? (asRecord(body)?.results as unknown[])
            : [body];
        const filter = { scope, ownedAccountIds: await ownedAccountIdsFor(scope) };
        let matched = 0;
        const requestedCorrelation = new URL(request.url).searchParams.get("correlation");
        for (const item of events) {
          const event = asRecord(item);
          if (!event) continue;
          const correlation = callbackData(event) ?? requestedCorrelation;
          if (correlation) matched += await applyEvent(correlation, event, filter);
        }
        return Response.json({ ok: true, matched });
      },
    },
  },
});
