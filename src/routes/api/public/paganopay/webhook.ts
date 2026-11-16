import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recordBillingSignal } from "@/lib/billing/billing-signals.server";
import { verifyPaganoPaySignatureAny } from "@/lib/billing/paganopay-webhook";
import { maskDocumentsDeep } from "@/lib/billing/payer";
import { confirmCharge } from "@/lib/billing/payment-charges.server";
import { paganoPayWebhookSecrets } from "@/lib/billing/payment-gateway-config.server";

// Webhook from PaganoPay (registered once in their panel, Integrações →
// Webhook, with "Atualização de transações"). One URL for the whole account.
//
// - Signed: `X-Webhook-Signature: v1=<hex>` over "<X-Webhook-Timestamp>.<raw
//   body>" with the panel secret (paganopay-webhook.ts). Accepted under any of
//   paganoPayWebhookSecrets(). No secret configured → 500. Bad/stale
//   signature → 401, a `paganopay_webhook_invalid_signature` signal (reason
//   only) and nothing written.
// - The body is only a hint: confirmCharge re-reads the charge with
//   GET /payments/transactions/{id} before crediting anything.
// - The PaganoPay account is shared with what SpacePay created on it, so the
//   panel webhook also delivers charges that are not ours (or not PaganoPay
//   rows of ours): recorded as `unknown_charge` and answered 200. Non-`pix.*`
//   events (cash-outs, etc.) are answered 200 without being stored.
// - Response policy: PaganoPay PAUSES the webhook after 10 failed deliveries in
//   a row, and events of a pause are never redelivered. So once an event row
//   is saved we ALWAYS answer 200, even if processing fails (the error stays
//   on the row and the reconcile cron catches the charge up in ≤5 min). Only
//   a failure to save the event answers 503, so PaganoPay retries it (every
//   60 s, 5 attempts).
// - Processing is raced against PROCESS_DEADLINE_MS; past it we answer 200
//   and let it finish (it records its own outcome/error).
// - Dedupe: event_id = `paganopay:<event>:<id>:<status>` (their docs: duplicates
//   happen, order is not guaranteed). An already-processed one answers 200.
// - raw_body keeps the body with document-like keys masked (maskDocumentsDeep).
//   Never the signature header.

type PaganoPayWebhookBody = {
  event?: unknown;
  id?: unknown;
  transactionId?: unknown;
  status?: unknown;
  external_ref?: unknown;
  externalRef?: unknown;
};

const PROCESS_DEADLINE_MS = 3000;

const OK = (extra: Record<string, unknown> = {}) =>
  Response.json({ ok: true, ...extra }, { status: 200 });

function asText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function sanitizedRawBodyFor(rawBody: string, parsed: unknown): string {
  const { value, masked } = maskDocumentsDeep(parsed);
  if (masked === 0) return rawBody;
  return JSON.stringify(value);
}

/** Only these headers are kept for diagnostics — never X-Webhook-Signature. */
function headersToStore(request: Request): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of [
    "x-webhook-event",
    "x-webhook-id",
    "x-webhook-timestamp",
    "user-agent",
    "content-type",
  ]) {
    const value = request.headers.get(name);
    if (value) kept[name] = value;
  }
  return kept;
}

/** Our charge for this delivery: PaganoPay id first, else our sellerExternalRef. */
async function findOurExternalId(
  transactionId: string | null,
  externalRef: string | null,
): Promise<string | null> {
  if (transactionId) {
    const { data, error } = await supabaseAdmin
      .from("payment_charges")
      .select("external_id")
      .eq("provider", "paganopay")
      .eq("provider_charge_id", transactionId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.external_id) return data.external_id;
  }
  if (externalRef) {
    const { data, error } = await supabaseAdmin
      .from("payment_charges")
      .select("external_id")
      .eq("provider", "paganopay")
      .eq("external_id", externalRef)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.external_id) return data.external_id;
  }
  return null;
}

async function markEvent(
  eventId: string,
  patch: { outcome: string | null; error: string | null; processed: boolean },
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("payment_webhook_events")
    .update({
      outcome: patch.outcome,
      error: patch.error,
      processed_at: patch.processed ? new Date().toISOString() : null,
    })
    .eq("event_id", eventId);
  if (error) {
    console.error("[paganopay-webhook] failed to update event row", {
      eventId,
      error: error.message,
    });
  }
}

/** Never rejects: stores its outcome (or error, unprocessed) on the event row. */
async function processEvent(
  eventId: string,
  eventName: string,
  transactionId: string | null,
  externalRef: string | null,
): Promise<void> {
  try {
    const externalId = await findOurExternalId(transactionId, externalRef);
    if (!externalId) {
      await markEvent(eventId, { outcome: "unknown_charge", error: null, processed: true });
      return;
    }
    if (eventName === "pix.received") {
      // Charge generated, not a payment.
      await markEvent(eventId, { outcome: "ignored_received", error: null, processed: true });
      return;
    }
    const { outcome } = await confirmCharge(externalId);
    await markEvent(eventId, { outcome, error: null, processed: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown processing error";
    console.error("[paganopay-webhook] processing error", { eventId, error: message });
    await markEvent(eventId, { outcome: null, error: message, processed: false });
  }
}

async function handlePaganoPayWebhook(request: Request): Promise<Response> {
  const secrets = await paganoPayWebhookSecrets();
  const rawBody = await request.text();
  if (secrets.length === 0) {
    return Response.json(
      { ok: false, error: "PAGANOPAY_WEBHOOK_SECRET not configured" },
      { status: 500 },
    );
  }

  const verification = verifyPaganoPaySignatureAny(
    rawBody,
    request.headers.get("x-webhook-signature"),
    request.headers.get("x-webhook-timestamp"),
    secrets,
    Math.floor(Date.now() / 1000),
  );
  if (!verification.ok) {
    void recordBillingSignal("paganopay_webhook_invalid_signature", verification.reason);
    return Response.json({ ok: false, error: verification.reason }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Signed but unreadable: nothing to act on; a 4xx would only push the
    // webhook towards PaganoPay's automatic pause.
    console.error("[paganopay-webhook] signed body is not a JSON object");
    return OK({ ignored: "malformed_body" });
  }
  const body = parsed as PaganoPayWebhookBody;
  const eventName = asText(body.event) ?? asText(request.headers.get("x-webhook-event"));
  if (!eventName || !eventName.startsWith("pix.")) {
    // Cash-outs and anything else on the account: not ours to handle.
    return OK({ ignored: eventName ?? "no_event" });
  }

  const transactionId = asText(body.id) ?? asText(body.transactionId);
  const status = asText(body.status)?.toUpperCase() ?? "UNKNOWN";
  const externalRef = asText(body.external_ref) ?? asText(body.externalRef);
  const eventId = `paganopay:${eventName}:${transactionId ?? externalRef ?? "?"}:${status}`;

  // Stage 1: record. Failing here is the only non-2xx after a valid signature.
  try {
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from("payment_webhook_events")
      .upsert(
        {
          event_id: eventId,
          provider: "paganopay",
          event: eventName,
          delivery_id: request.headers.get("x-webhook-id"),
          signature_valid: true,
          raw_body: sanitizedRawBodyFor(rawBody, parsed),
          headers: headersToStore(request),
        },
        { onConflict: "event_id", ignoreDuplicates: true },
      )
      .select("event_id");
    if (insertError) throw new Error(insertError.message);
    const isNewEvent = Array.isArray(inserted) && inserted.length > 0;
    if (!isNewEvent) {
      const { data: existingRow, error: existingError } = await supabaseAdmin
        .from("payment_webhook_events")
        .select("processed_at")
        .eq("event_id", eventId)
        .maybeSingle();
      if (existingError) throw new Error(existingError.message);
      if (existingRow?.processed_at) return OK();
    }
  } catch (err) {
    console.error("[paganopay-webhook] error recording event", {
      eventId,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ ok: false, error: "event_not_recorded" }, { status: 503 });
  }

  // Stage 2: process, answering 200 no later than PROCESS_DEADLINE_MS.
  const processing = processEvent(eventId, eventName, transactionId, externalRef).catch(
    (err: unknown) => {
      console.error("[paganopay-webhook] unexpected processing rejection", {
        eventId,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), PROCESS_DEADLINE_MS);
  });
  const winner = await Promise.race([processing.then(() => "done" as const), deadline]);
  clearTimeout(timer);
  if (winner === "timeout") {
    console.warn("[paganopay-webhook] processing past the deadline; answered 200 early", {
      eventId,
    });
  }
  return OK();
}

export const Route = createFileRoute("/api/public/paganopay/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => handlePaganoPayWebhook(request),
    },
  },
});
