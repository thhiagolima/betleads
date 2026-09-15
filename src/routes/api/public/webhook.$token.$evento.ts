import { createFileRoute } from "@tanstack/react-router";
import { getServiceClient, processWebhookEvent } from "@/lib/webhook-process.server";

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
        let payload: Record<string, unknown> = {};
        try {
          payload = await request.json();
        } catch {
          payload = {};
        }

        const sb = getServiceClient();
        if (!sb) {
          return Response.json({ ok: false, error: "Server misconfigured" }, { status: 500 });
        }

        const { data: tenantRow } = await sb
          .from("tenants")
          .select("id")
          .eq("webhook_token", token)
          .maybeSingle();
        const tenantId = tenantRow?.id as string | undefined;
        if (!tenantId) {
          return Response.json({ ok: false, error: "token inválido" }, { status: 404 });
        }

        return processWebhookEvent(sb, tenantId, evento, payload);
      },
    },
  },
});