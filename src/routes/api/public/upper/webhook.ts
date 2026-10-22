import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { confirmChargeFromUpper } from "@/lib/billing/payment-charges.server";
import { verifyUpperSignature } from "@/lib/billing/upper-webhook";

// Signed webhook from the Upper Pix gateway.
//
// - The raw body is read with request.text() and checked byte-for-byte
//   against the X-Upper-Signature header before any JSON parsing — see
//   verifyUpperSignature. A bad signature answers 400 and writes nothing.
// - Every event with a valid signature is deduplicated by event_id (the
//   body's `id`, falling back to X-Upper-Delivery) and recorded in
//   payment_webhook_events before any processing, so a crash mid-processing
//   still leaves a row the Task 5 reconciliation cron can catch up on.
// - A repeated event_id that already has `processed_at` is answered with 200
//   without touching confirmChargeFromUpper again.
// - `charge.*` events trigger confirmChargeFromUpper, which always re-checks
//   the charge with Upper directly (the webhook is only ever a hint).
//   `ping` and `payment.*` are recorded and otherwise ignored.
// - Processing errors never surface as a non-200: the message (no secrets)
//   goes to payment_webhook_events.error and the cron retries later.

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

  let body: UpperWebhookBody;
  try {
    body = rawBody ? (JSON.parse(rawBody) as UpperWebhookBody) : {};
  } catch {
    return Response.json({ ok: false, error: "malformed_body" }, { status: 400 });
  }

  const deliveryId = request.headers.get("x-upper-delivery");
  const eventId = eventIdFrom(body, deliveryId);
  if (!eventId) {
    return Response.json({ ok: false, error: "missing_event_id" }, { status: 400 });
  }

  const eventName = typeof body.event === "string" ? body.event : null;

  try {
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from("payment_webhook_events")
      .upsert(
        {
          event_id: eventId,
          event: eventName,
          delivery_id: deliveryId,
          signature_valid: true,
          raw_body: rawBody,
        },
        { onConflict: "event_id", ignoreDuplicates: true },
      )
      .select("event_id");
    if (insertError) throw new Error(insertError.message);

    const isNewEvent = Array.isArray(inserted) && inserted.length > 0;
    if (!isNewEvent) {
      const { data: existingRow } = await supabaseAdmin
        .from("payment_webhook_events")
        .select("processed_at")
        .eq("event_id", eventId)
        .maybeSingle();
      if (existingRow?.processed_at) {
        return Response.json({ ok: true }, { status: 200 });
      }
    }

    try {
      if (eventName && eventName.startsWith("charge.")) {
        const externalId = externalIdFrom(body);
        if (externalId) {
          await confirmChargeFromUpper(externalId);
        }
      }
      // `ping` and `payment.*` (and a `charge.*` with no externalId) are
      // recorded above and otherwise need no further action.
      await supabaseAdmin
        .from("payment_webhook_events")
        .update({ processed_at: new Date().toISOString() })
        .eq("event_id", eventId);
    } catch (processingError) {
      const message =
        processingError instanceof Error ? processingError.message : "unknown processing error";
      await supabaseAdmin
        .from("payment_webhook_events")
        .update({ error: message })
        .eq("event_id", eventId);
    }

    return Response.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("[upper-webhook] error recording event:", err);
    return Response.json({ ok: true }, { status: 200 });
  }
}

export const Route = createFileRoute("/api/public/upper/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => handlePost(request),
    },
  },
});
