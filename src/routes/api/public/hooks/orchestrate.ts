import { createFileRoute } from "@tanstack/react-router";
import { orchestrate } from "@/lib/orchestrator.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/hooks/orchestrate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try { requireSharedSecret(request, "CRON_SECRET"); } catch (r) { return r as Response; }
        try {
          const url = new URL(request.url);
          const tenantId = url.searchParams.get("tenant");
          if (!tenantId) {
            return Response.json({ ok: false, error: "missing tenant query param" }, { status: 400 });
          }
          const limitParam = url.searchParams.get("limit");
          const limit = limitParam ? Math.max(1, Math.min(5000, parseInt(limitParam, 10))) : undefined;
          const r = await orchestrate({ mode: "execute", tenantId, limit });
          return Response.json({ ok: true, ...r });
        } catch (e) {
          return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
      },
    },
  },
});