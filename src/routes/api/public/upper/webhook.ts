import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { maskDocumentsDeep } from "@/lib/billing/payer";
import { confirmChargeFromUpper } from "@/lib/billing/payment-charges.server";
import { verifyUpperSignature } from "@/lib/billing/upper-webhook";

// Signed webhook from the Upper Pix gateway.
//
// - The raw body is read with request.text() and checked byte-for-byte
//   against the X-Upper-Signature header before any JSON parsing — see
//   verifyUpperSignature. A bad signature answers 400 and writes nothing.
// - Every event with a valid signature is deduplicated by event_id (the
//   body's `id`, falling back to X-Upper-Delivery) and recorded in
//   payment_webhook_events BEFORE any processing. If that recording itself
//   fails (DB error), we answer 503 so Upper redelivers.
// - If processing fails AFTER the event row exists (Upper or DB down while
//   confirming the charge), the error is stored on the row, processed_at
//   stays null and we answer 503 too, so Upper redelivers and the next
//   delivery processes it (the reconcile cron is the second safety net).
// - A repeated event_id that already has `processed_at` is answered with 200
//   without touching confirmChargeFromUpper again.
// - `charge.*` events trigger confirmChargeFromUpper, which always re-checks
//   the charge with Upper directly (the webhook is only ever a hint).
//   `ping` and `payment.*` are recorded and otherwise ignored. The outcome
//   ('credited', 'not_paid', 'needs_review', 'already_credited',
//   'unknown_charge', 'ping', 'ignored', ...) is stored in `.outcome`.
// - raw_body and headers are stored for diagnostics, but never the full
//   payer document (LGPD) or the signature header (a secret).

type UpperWebhookBody = {
  id?: unknown;
  event?: unknown;
  data?: { externalId?: unknown } | null;
  externalId?: unknown;
};

function eventIdFrom(body: UpperWebhookBody, deliveryHeader: string | null): string | null {
  if (typeof body.id === "string" && body.id.length > 0) return body.id;
  return deliveryHeader;
}

function externalIdFrom(body: UpperWebhookBody): string | null {
  const fromData = body.data && typeof body.data === "object" ? body.data.externalId : undefined;
  if (typeof fromData === "string" && fromData.length > 0) return fromData;
  if (typeof body.externalId === "string" && body.externalId.length > 0) return body.externalId;
  return null;
}

/**
 * LGPD: payment_webhook_events.raw_body must never carry a full payer
 * document. Every object key named `document` (any case, at any depth,
 * inside objects or arrays) is masked — see maskDocumentsDeep. The signature
 * was already verified against the exact original bytes before this runs;
 * only the stored copy is sanitized. When nothing needed masking, the
 * original bytes are stored unchanged.
 */
function sanitizedRawBodyFor(rawBody: string, parsed: unknown): string {
  const { value, masked } = maskDocumentsDeep(parsed);
  if (masked === 0) return rawBody;
  return JSON.stringify(value);
}

/** Only these headers are kept for diagnostics — never X-Upper-Signature (a secret). */
function headersToStore(request: Request): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of ["x-upper-event", "x-upper-delivery", "user-agent", "content-type"]) {
    const value = request.headers.get(name);
    if (value) kept[name] = value;
  }
  return kept;
}

async function handlePost(request: Request): Promise<Response> {
  const secret = process.env.UPPER_WEBHOOK_SECRET;
  const rawBody = await request.text();

  if (!secret) {
    return Response.json(
      { ok: false, error: "UPPER_WEBHOOK_SECRET not configured" },
      { status: 500 },
    );
  }

  const signatureHeader = request.headers.get("x-upper-signature");
  const nowSec = Math.floor(Date.now() / 1000);
  const verification = verifyUpperSignature(rawBody, signatureHeader, secret, nowSec);
  if (!verification.ok) {
    return Response.json({ ok: false, error: verification.reason }, { status: 400 });
  }

  let parsedBody: unknown;
  let body: UpperWebhookBody;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : {};
    body = parsedBody as UpperWebhookBody;
  } catch {
    return Response.json({ ok: false, error: "malformed_body" }, { status: 400 });
  }

  const deliveryId = request.headers.get("x-upper-delivery");
  const eventId = eventIdFrom(body, deliveryId);
  if (!eventId) {
    return Response.json({ ok: false, error: "missing_event_id" }, { status: 400 });
  }

  const eventName = typeof body.event === "string" ? body.event : null;

  // Stage 1: record the event. A failure here means Upper should redeliver
  // — nothing has been saved, so there is nothing for the cron to catch up
  // on later.
  let isNewEvent: boolean;
  try {
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from("payment_webhook_events")
      .upsert(
        {
          event_id: eventId,
          event: eventName,
          delivery_id: deliveryId,
          signature_valid: true,
          raw_body: sanitizedRawBodyFor(rawBody, parsedBody),
          headers: headersToStore(request),
        },
        { onConflict: "event_id", ignoreDuplicates: true },
      )
      .select("event_id");
    if (insertError) throw new Error(insertError.message);
    isNewEvent = Array.isArray(inserted) && inserted.length > 0;

    if (!isNewEvent) {
      const { data: existingRow, error: existingError } = await supabaseAdmin
        .from("payment_webhook_events")
        .select("processed_at")
        .eq("event_id", eventId)
        .maybeSingle();
      if (existingError) throw new Error(existingError.message);
      if (existingRow?.processed_at) {
        return Response.json({ ok: true }, { status: 200 });
      }
    }
  } catch (err) {
    console.error("[upper-webhook] error recording event:", err);
    return Response.json({ ok: false, error: "event_not_recorded" }, { status: 503 });
  }

  // Stage 2: process. The event row is saved at this point; an error from
  // here on is recorded on that row (processed_at stays null) and answers
  // 503 so Upper redelivers — a redelivery of an unprocessed event is
  // processed again (see the dedupe above), and confirmChargeFromUpper is
  // safe to repeat. The reconciliation cron still catches up if Upper gives
  // up redelivering.
  let outcome: string | null = null;
  try {
    if (eventName === "ping") {
      outcome = "ping";
    } else if (eventName && eventName.startsWith("payment.")) {
      outcome = "ignored";
    } else if (eventName && eventName.startsWith("charge.")) {
      const externalId = externalIdFrom(body);
      if (externalId) {
        const result = await confirmChargeFromUpper(externalId);
        outcome = result.outcome;
      } else {
        outcome = "missing_external_id";
      }
    } else {
      outcome = "ignored";
    }

    const { error: updateError } = await supabaseAdmin
      .from("payment_webhook_events")
      .update({ processed_at: new Date().toISOString(), outcome, error: null })
      .eq("event_id", eventId);
    if (updateError) {
      // The event is safely recorded, but we can't honestly claim it was
      // marked processed: log it and leave a trail on the row itself.
      console.error("[upper-webhook] failed to mark event processed:", updateError);
      await supabaseAdmin
        .from("payment_webhook_events")
        .update({ error: `processed_at update failed: ${updateError.message}` })
        .eq("event_id", eventId);
    }
  } catch (processingError) {
    const message =
      processingError instanceof Error ? processingError.message : "unknown processing error";
    console.error("[upper-webhook] processing error:", processingError);
    const { error: recordError } = await supabaseAdmin
      .from("payment_webhook_events")
      .update({ error: message, outcome, processed_at: null })
      .eq("event_id", eventId);
    if (recordError) {
      console.error("[upper-webhook] failed to record processing error:", recordError);
    }
    return Response.json({ ok: false, error: "processing_failed" }, { status: 503 });
  }

  return Response.json({ ok: true }, { status: 200 });
}

export const Route = createFileRoute("/api/public/upper/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => handlePost(request),
    },
  },
});
