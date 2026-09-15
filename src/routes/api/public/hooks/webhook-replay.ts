import { createFileRoute } from "@tanstack/react-router";
import { requireSharedSecret } from "@/lib/cron-auth.server";
import { getServiceClient, processWebhookEvent } from "@/lib/webhook-process.server";

export const Route = createFileRoute("/api/public/hooks/webhook-replay")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (r) {
          return r as Response;
        }

        const sb = getServiceClient();
        if (!sb) {
          return Response.json({ ok: false, error: "Server misconfigured" }, { status: 500 });
        }

        const body = await request.json().catch(() => ({} as Record<string, unknown>));
        const tenantId = typeof body.tenant_id === "string" ? body.tenant_id : undefined;
        const limitRaw = Number(body.limit ?? 100);
        const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 500);

        let query = sb
          .from("webhook_logs")
          .select("id, tenant_id, evento, payload")
          .eq("status", "recebido")
          .order("created_at", { ascending: true })
          .limit(limit);

        if (tenantId) query = query.eq("tenant_id", tenantId);

        const { data: rows, error } = await query;
        if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

        let processed = 0;
        let failed = 0;
        for (const row of rows ?? []) {
          const response = await processWebhookEvent(
            sb,
            row.tenant_id as string,
            row.evento as string,
            (row.payload ?? {}) as Record<string, unknown>,
            { mirror: true, existingLogId: row.id as string },
          );
          const result = await response.json().catch(() => ({ ok: false }));
          if ((result as { ok?: boolean }).ok) processed += 1;
          else failed += 1;
        }

        return Response.json({ ok: true, scanned: rows?.length ?? 0, processed, failed });
      },
    },
  },
});