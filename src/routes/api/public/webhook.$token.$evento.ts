import { createFileRoute } from "@tanstack/react-router";
import { getServiceClient, processWebhookEvent } from "@/lib/webhook-process.server";
import { invalidateServerResultCache } from "@/lib/server-result-cache";

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
  const expected = Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const received = provided.replace(/^sha256=/i, "").trim().toLowerCase();
  if (received.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ received.charCodeAt(index);
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

        const { data: tenantRow } = await sb
          .from("tenants")
          .select("id,webhook_secret")
          .eq("webhook_token", token)
          .maybeSingle();
        const tenantId = tenantRow?.id as string | undefined;
        if (!tenantId) {
          return Response.json({ ok: false, error: "token inválido" }, { status: 404 });
        }
        if (
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
