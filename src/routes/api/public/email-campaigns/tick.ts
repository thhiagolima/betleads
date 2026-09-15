// Rota pública chamada por pg_cron a cada minuto para disparar campanhas
// de email cujo agendamento já chegou.
// Auth: header `apikey` com a chave anon do projeto.

import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runCampaignSend } from "@/lib/email.functions";
import { deferIfOutsideWindow } from "@/lib/send-window.server";
import { recordRun } from "@/lib/dispatch-rate.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/email-campaigns/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try { requireSharedSecret(request, "CRON_SECRET"); } catch (r) { return r as Response; }
        try {
          const startedAt = Date.now();

          // Janela de envio: se fora, empurra agendamento p/ próximo horário permitido.
          const defer = await deferIfOutsideWindow();
          if (defer) {
            const { data: pending } = await supabaseAdmin
              .from("email_campaigns")
              .select("id")
              .eq("status", "agendada")
              .lte("scheduled_at", new Date().toISOString());
            const ids = (pending ?? []).map((c) => c.id);
            if (ids.length > 0) {
              await supabaseAdmin
                .from("email_campaigns")
                .update({ scheduled_at: defer })
                .in("id", ids);
            }
            await recordRun(startedAt, {
              channel: "email",
              kind: "campaign",
              queue_before: ids.length,
              stop_reason: "outside_window",
              provider: "businesscode-email",
            });
            return new Response(
              JSON.stringify({ ok: true, deferred: ids.length, next_run_at: defer }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          // Claim atômico: marca status=enviando + locked_at, retorna campanhas reservadas.
          const { data: claimed, error: claimErr } = await supabaseAdmin.rpc(
            "claim_due_email_campaigns",
            { p_limit: 5 },
          );
          if (claimErr) throw new Error(claimErr.message);
          const due = (claimed ?? []) as Array<{ id: string }>;

          const results: Array<{ id: string; ok: boolean; error?: string }> = [];
          let errors = 0;
          let lastErr: string | null = null;
          for (const c of due) {
            try {
              await runCampaignSend(c.id);
              results.push({ id: c.id, ok: true });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error("[email-campaigns tick] erro", c.id, msg);
              errors++;
              lastErr = msg.slice(0, 800);
              // Devolve à fila se temporário (rate limit/timeout); senão deixa como erro.
              const transient = /rate|throttle|timeout|temporar|busy|5\d\d/i.test(msg);
              await supabaseAdmin
                .from("email_campaigns")
                .update(
                  transient
                    ? {
                        status: "agendada",
                        scheduled_at: new Date(Date.now() + 60_000).toISOString(),
                        locked_at: null,
                        locked_by: null,
                      }
                    : { status: "rascunho", locked_at: null, locked_by: null },
                )
                .eq("id", c.id);
              results.push({ id: c.id, ok: false, error: msg });
            }
          }

          await recordRun(startedAt, {
            channel: "email",
            kind: "campaign",
            queue_before: due.length,
            claimed: due.length,
            sent: results.filter((r) => r.ok).length,
            errors,
            stop_reason: due.length === 0 ? "queue_empty" : errors > 0 ? "errors" : "ok",
            provider: "businesscode-email",
            last_provider_error: lastErr,
          });

          return new Response(
            JSON.stringify({ ok: true, processed: results.length, results }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[email-campaigns tick] erro", msg);
          return new Response(JSON.stringify({ ok: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});