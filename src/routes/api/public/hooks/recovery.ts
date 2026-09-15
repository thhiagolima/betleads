// Recupera SMS/Email travados (locked_at > 5min) e campanhas travadas (>15min).
// Chamado por pg_cron a cada 2 minutos.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recordRun } from "@/lib/dispatch-rate.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/hooks/recovery")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try { requireSharedSecret(request, "CRON_SECRET"); } catch (r) { return r as Response; }
        const started = Date.now();
        const out: Record<string, number> = { sms: 0, email: 0, campaigns: 0 };
        try {
          const [s, e, c] = await Promise.all([
            supabaseAdmin.rpc("recover_stuck_sms_leads"),
            supabaseAdmin.rpc("recover_stuck_email_leads"),
            supabaseAdmin.rpc("recover_stuck_email_campaigns"),
          ]);
          out.sms = Number(s.data ?? 0);
          out.email = Number(e.data ?? 0);
          out.campaigns = Number(c.data ?? 0);
        } catch (err) {
          console.error("[recovery] erro", err);
        }
        await Promise.all([
          recordRun(started, {
            channel: "sms",
            kind: "recovery",
            lock_recovered: out.sms,
            stop_reason: "ok",
          }),
          recordRun(started, {
            channel: "email",
            kind: "recovery",
            lock_recovered: out.email + out.campaigns,
            stop_reason: "ok",
          }),
        ]);
        return Response.json({ ok: true, recovered: out });
      },
    },
  },
});