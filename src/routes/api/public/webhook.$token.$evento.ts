import { createFileRoute } from "@tanstack/react-router";
import { getServiceClient, processWebhookEvent } from "@/lib/webhook-process.server";
import { invalidateServerResultCache } from "@/lib/server-result-cache";
import { isDemoTenant } from "@/lib/tenant-access.server";

async function validSignature(secret: string, payload: string, provided: string | null) {
  if (!provided) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const received = provided
    .replace(/^sha256=/i, "")
    .trim()
    .toLowerCase();
  if (received.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++)
    difference |= expected.charCodeAt(index) ^ received.charCodeAt(index);
  return difference === 0;
}

export const Route = createFileRoute("/api/public/webhook/$token/$evento")({
  server: {
    handlers: {
      POST: async ({
        request,
        params,
      }: {
        request: Request;
        params: { token: string; evento: string };
      }) => {
        const { token, evento } = params;
        const rawPayload = await request.text();
        let payload: Record<string, unknown> = {};
        try {
          payload = rawPayload ? JSON.parse(rawPayload) : {};
        } catch {
          payload = {};
        }

        const sb = getServiceClient();
        if (!sb) {
          return Response.json({ ok: false, error: "Server misconfigured" }, { status: 500 });
        }

        const { data: tenantRow, error: tenantLookupError } = await sb
          .from("tenants")
          .select("id,webhook_secret,webhook_hmac_enforced")
          .eq("webhook_token", token)
          .maybeSingle();
        // Do not report an infrastructure/credential failure as an invalid token.
        // Providers won't retry a 404, while a 503 correctly marks the delivery as
        // temporary and makes the deployment configuration problem observable.
        if (tenantLookupError) {
          console.error("Webhook tenant lookup failed", {
            code: tenantLookupError.code,
            message: tenantLookupError.message,
          });
          return Response.json(
            { ok: false, error: "webhook service temporarily unavailable" },
            { status: 503 },
          );
        }
        const tenantId = tenantRow?.id as string | undefined;
        if (!tenantRow || !tenantId) {
          return Response.json({ ok: false, error: "token inválido" }, { status: 404 });
        }
        // Demo tenant: reject before any webhook_logs/webhook_event_receipts
        // insert and before HMAC processing side effects. A lookup error is
        // treated as demo-unsafe by isDemoTenant, so it is rejected too.
        if (await isDemoTenant(tenantId)) {
          return Response.json(
            { ok: false, error: "ambiente de demonstração" },
            { status: 403 },
          );
        }
        if (
          tenantRow.webhook_hmac_enforced &&
          tenantRow.webhook_secret &&
          !(await validSignature(
            tenantRow.webhook_secret as string,
            rawPayload,
            request.headers.get("x-webhook-signature"),
          ))
        ) {
          return Response.json({ ok: false, error: "assinatura invÃ¡lida" }, { status: 401 });
        }

        const response = await processWebhookEvent(sb, tenantId, evento, payload);
        if (response.ok) {
          invalidateServerResultCache(`dashboard:${tenantId}:`);
          invalidateServerResultCache(`gamification:${tenantId}:`);
          invalidateServerResultCache(`audience:${tenantId}:`);
        }
        return response;
      },
    },
  },
});
