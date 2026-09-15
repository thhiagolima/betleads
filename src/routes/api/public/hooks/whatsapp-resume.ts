import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runDispatcher } from "@/lib/automation.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";

// Auto-recovery endpoint. Pode ser chamado via cron OU pelo botão da UI.
// Idempotente: destrava leads em cooldown atrasado, reagenda failed antigos
// e dispara o próximo lote.
export const Route = createFileRoute("/api/public/hooks/whatsapp-resume")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try { requireSharedSecret(request, "CRON_SECRET"); } catch (r) { return r as Response; }
        try {
          const url = new URL(request.url);
          const bypassWindow = url.searchParams.get("bypassWindow") === "1";
          const nowIso = new Date().toISOString();

          const { data: resumed } = await supabaseAdmin
            .from("flow_leads")
            .update({ status: "pending", next_run_at: nowIso })
            .eq("status", "cooldown")
            .lte("next_run_at", nowIso)
            .select("id");

          const fifteenMinAgo = new Date(Date.now() - 15 * 60_000).toISOString();
          const { data: retried } = await supabaseAdmin
            .from("flow_leads")
            .update({ status: "pending", next_run_at: nowIso, last_error: null })
            .eq("status", "failed")
            .lt("next_run_at", fifteenMinAgo)
            .select("id");

          const result = await runDispatcher({ limit: 100, bypassWindow });
          return Response.json({
            ok: true,
            resumed: resumed?.length ?? 0,
            retried: retried?.length ?? 0,
            dispatched: result,
          });
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