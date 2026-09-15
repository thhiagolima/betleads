import { createFileRoute } from "@tanstack/react-router";
import { requireSharedSecret } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/hooks/cashback-catchup")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try { requireSharedSecret(request, "CRON_SECRET"); } catch (r) { return r as Response; }
        try {
          const url = new URL(request.url);
          const sinceParam = url.searchParams.get("since");
          const limitParam = Number(url.searchParams.get("limit") ?? "500");
          const { runCashbackCatchup } = await import("@/lib/cashback-catchup.server");
          const result = await runCashbackCatchup({
            limit: Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 2000) : 500,
            ...(sinceParam ? { since: sinceParam } : {}),
          });
          return Response.json({ ok: true, result });
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      },
    },
  },
});