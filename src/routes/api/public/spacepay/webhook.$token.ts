import { createHash } from "node:crypto";

import { createFileRoute } from "@tanstack/react-router";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recordBillingSignal } from "@/lib/billing/billing-signals.server";
import { maskDocumentsDeep } from "@/lib/billing/payer";
import { confirmCharge } from "@/lib/billing/payment-charges.server";
import { spacePayCallbackSecrets } from "@/lib/billing/payment-gateway-config.server";
import { verifySpacePayCallbackToken } from "@/lib/billing/spacepay-callback-token";

// Callback from the SpacePay Pix gateway (cash-in `callbackUrl`).
//
// - The payload format is UNDOCUMENTED and the callback is UNSIGNED. The only
//   proof of authenticity is the per-charge token in the URL
//   (`/api/public/spacepay/webhook/<base64url(externalId)>.<hmac>`, HMAC with
//   the callback secret — see verifySpacePayCallbackToken). A token is
//   accepted under ANY of spacePayCallbackSecrets() (gateway config: DB and
//   env fallback), so URLs signed before a secret rotation keep working. The
//   token also carries OUR externalId, so the body is never needed to find the
//   charge. No secret at all → 500. Bad token → 401, a
//   `spacepay_webhook_invalid_token` billing signal (reason only) and nothing
//   written.
// - The body is only a hint: confirmCharge always re-reads the charge from
//   SpacePay (`GET /transactions/{id}`) and never trusts any amount/status in
//   the payload.
// - SpacePay ROLLS BACK the "paid" on its side when our callback does not
//   answer 2xx. So once the token is valid we ALWAYS answer 200 { ok: true }
//   — even if recording the event or processing it fails. Failures are
//   logged and, when the event row exists, stored in its `error` column
//   (processed_at stays null); the reconcile cron (5 min, ACTIVE rows older
//   than 2 min) is the catch-up path.
// - Latency matters for the same reason: a SLOW answer can also make the
//   proxy treat the callback as failed and roll the payment back. Processing
//   (confirmCharge = a GET to SpacePay + DB writes + the credit RPC) is raced
//   against CALLBACK_DEADLINE_MS: past it we answer 200 at once and let the
//   processing promise finish on its own. It never rejects (it stores its
//   outcome/error on the event row itself, and a stray rejection is caught
//   and logged). If the runtime drops that work after the response, the
//   event row stays unprocessed and the reconcile cron catches the charge up.
// - Race: during the callback itself, `GET /transactions/{id}` may still say
//   `created` (ACTIVE). The outcome is then 'not_paid', which is fine — the
//   cron re-checks the charge and credits it once SpacePay reports `paid`.
// - Each delivery is recorded in payment_webhook_events (provider 'spacepay')
//   BEFORE processing, keyed by `spacepay:<externalId>:<sha256(rawBody)[:16]>`
//   — an identical redelivery already processed answers 200 without calling
//   confirmCharge again; a different body (e.g. a later status) is a new
//   event. `event` is the body's `status` (or `event`) when it is a string.
// - raw_body and an allow-list of headers are kept for diagnostics; the URL
//   token is never stored. LGPD caveat: raw_body is the body as received with
//   only document-like keys masked (maskDocumentsDeep). The format is
//   undocumented, so a payer name or a document under an unknown key may
//   still be stored here (unlike payment_charges.last_provider_payload, which
//   is an allow-list).

type SpacePayWebhookBody = {
  status?: unknown;
  event?: unknown;
};

function sha256Prefix(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex").slice(0, 16);
}

function eventNameFrom(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const body = parsed as SpacePayWebhookBody;
  if (typeof body.status === "string" && body.status.length > 0) return body.status;
  if (typeof body.event === "string" && body.event.length > 0) return body.event;
  return null;
}

/**
 * LGPD: payment_webhook_events.raw_body must never carry a full payer
 * document — see maskDocumentsDeep. A body that is not JSON (the format is
 * undocumented) is stored as-is: nothing to walk.
 */
function sanitizedRawBodyFor(rawBody: string, parsed: unknown): string {
  if (parsed === undefined) return rawBody;
  const { value, masked } = maskDocumentsDeep(parsed);
  if (masked === 0) return rawBody;
  return JSON.stringify(value);
}

function headersToStore(request: Request): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of ["user-agent", "content-type"]) {
    const value = request.headers.get(name);
    if (value) kept[name] = value;
  }
  return kept;
}

const OK = () => Response.json({ ok: true }, { status: 200 });

/** Longest we make SpacePay wait for the callback answer (see header comment). */
const CALLBACK_DEADLINE_MS = 3000;

/**
 * Stage 2: confirms the charge and stores the outcome (or the error, with
 * processed_at null) on the event row when it exists. Handles its own errors;
 * the caller still guards against a rejection.
 */
async function processEvent(
  externalId: string,
  eventId: string,
  eventRecorded: boolean,
): Promise<void> {
  let outcome: string | null = null;
  try {
    const result = await confirmCharge(externalId);
    outcome = result.outcome;
    if (eventRecorded) {
      const { error: updateError } = await supabaseAdmin
        .from("payment_webhook_events")
        .update({ processed_at: new Date().toISOString(), outcome, error: null })
        .eq("event_id", eventId);
      if (updateError) {
        console.error("[spacepay-webhook] failed to mark event processed", {
          externalId,
          error: updateError.message,
        });
        await supabaseAdmin
          .from("payment_webhook_events")
          .update({ error: `processed_at update failed: ${updateError.message}` })
          .eq("event_id", eventId);
      }
    }
  } catch (processingError) {
    const message =
      processingError instanceof Error ? processingError.message : "unknown processing error";
    console.error("[spacepay-webhook] processing error", { externalId, error: message });
    if (eventRecorded) {
      try {
        const { error: recordError } = await supabaseAdmin
          .from("payment_webhook_events")
          .update({ error: message, outcome, processed_at: null })
          .eq("event_id", eventId);
        if (recordError) throw new Error(recordError.message);
      } catch (recordErr) {
        console.error("[spacepay-webhook] failed to record processing error", {
          externalId,
          error: recordErr instanceof Error ? recordErr.message : String(recordErr),
        });
      }
    }
  }
}

async function handlePost(request: Request, token: string): Promise<Response> {
  const secrets = await spacePayCallbackSecrets();
  if (secrets.length === 0) {
    return Response.json(
      { ok: false, error: "SPACEPAY_CALLBACK_SECRET not configured" },
      { status: 500 },
    );
  }

  let verification = verifySpacePayCallbackToken(token, secrets[0]);
  for (const secret of secrets.slice(1)) {
    // "malformed" doesn't depend on the secret; only a bad signature is retried.
    if (verification.ok || verification.reason !== "bad_signature") break;
    verification = verifySpacePayCallbackToken(token, secret);
  }
  if (!verification.ok) {
    // Nothing written to payment_webhook_events; the billing health monitor
    // counts it. Reason only, never the token or the body.
    void recordBillingSignal("spacepay_webhook_invalid_token", verification.reason);
    return Response.json({ ok: false, error: verification.reason }, { status: 401 });
  }
  const externalId = verification.externalId;

  // From here on every path answers 200 (see header comment).
  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch (err) {
    console.error("[spacepay-webhook] error reading body", {
      externalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let parsedBody: unknown = undefined;
  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = undefined;
    }
  }

  const eventId = `spacepay:${externalId}:${sha256Prefix(rawBody)}`;
  const eventName = eventNameFrom(parsedBody);

  // Stage 1: record the event. A failure here is logged and processing
  // still runs — SpacePay must get its 2xx, and confirmCharge is idempotent.
  let eventRecorded = false;
  try {
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from("payment_webhook_events")
      .upsert(
        {
          event_id: eventId,
          provider: "spacepay",
          event: eventName,
          delivery_id: null,
          signature_valid: true,
          raw_body: sanitizedRawBodyFor(rawBody, parsedBody),
          headers: headersToStore(request),
        },
        { onConflict: "event_id", ignoreDuplicates: true },
      )
      .select("event_id");
    if (insertError) throw new Error(insertError.message);
    eventRecorded = true;

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
    console.error("[spacepay-webhook] error recording event", {
      externalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Stage 2: process, but never make SpacePay wait more than
  // CALLBACK_DEADLINE_MS for its 200 (see header comment).
  const processing = processEvent(externalId, eventId, eventRecorded).catch((err: unknown) => {
    console.error("[spacepay-webhook] unexpected processing rejection", {
      externalId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), CALLBACK_DEADLINE_MS);
  });
  const winner = await Promise.race([processing.then(() => "done" as const), deadline]);
  clearTimeout(timer);
  if (winner === "timeout") {
    console.warn("[spacepay-webhook] processing past the callback deadline; answered 200 early", {
      externalId,
      deadlineMs: CALLBACK_DEADLINE_MS,
    });
  }

  return OK();
}

export const Route = createFileRoute("/api/public/spacepay/webhook/$token")({
  server: {
    handlers: {
      POST: async ({ request, params }) => handlePost(request, params.token),
    },
  },
});
