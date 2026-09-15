// Checagem automática diária às 06:05 BRT (09:05 UTC).
// Valida se SMS e Email realmente acordaram às 06:00 e estão processando.
// Grava o resultado em system_alerts (severidade ok/warning/critical).

import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";

type ChannelSummary = {
  runs: number;
  sent: number;
  errors: number;
  rate_limited: number;
  pending: number;
  in_retry: number;
  locked_stuck: number;
  last_stop_reason: string | null;
  last_provider_error: string | null;
  last_run_at: string | null;
  woke_up: boolean;
  sent_logs: number;
  backoff_until: string | null;
  backoff_active: boolean;
};

async function summarizeChannel(channel: "sms" | "email", since: string): Promise<ChannelSummary> {
  const queueTable = channel === "sms" ? "sms_flow_leads" : "email_flow_leads";
  const sendLogTable = channel === "sms" ? "sms_send_logs" : "email_send_logs";

  // runs do dispatcher após as 06:00
  const { data: runs } = await supabaseAdmin
    .from("dispatcher_runs")
    .select("sent,errors,rate_limited,stop_reason,last_provider_error,started_at")
    .eq("channel", channel)
    .eq("kind", "tick")
    .gte("started_at", since)
    .order("started_at", { ascending: false });

  const totalRuns = runs?.length ?? 0;
  const sent = (runs ?? []).reduce((a, r) => a + (r.sent ?? 0), 0);
  const errors = (runs ?? []).reduce((a, r) => a + (r.errors ?? 0), 0);
  const rateLimited = (runs ?? []).reduce((a, r) => a + (r.rate_limited ?? 0), 0);
  const lastRun = runs?.[0];

  // estado da fila agora
  const nowIso = new Date().toISOString();
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();

  const [{ count: pending }, { count: inRetry }, { count: stuck }, { count: sentLogs }, rateStateRes] = await Promise.all([
    supabaseAdmin.from(queueTable).select("id", { count: "exact", head: true })
      .in("status", ["pending", "running"]).lte("next_run_at", nowIso),
    supabaseAdmin.from(queueTable).select("id", { count: "exact", head: true })
      .gt("attempts", 0).in("status", ["pending", "running"]),
    supabaseAdmin.from(queueTable).select("id", { count: "exact", head: true })
      .not("locked_at", "is", null).lt("locked_at", fiveMinAgo),
    // Envio real confirmado nos *_send_logs desde 06:00 — fonte de verdade.
    supabaseAdmin.from(sendLogTable).select("id", { count: "exact", head: true })
      .eq("status", "sent").gte("created_at", since),
    supabaseAdmin.from("dispatch_rate_state").select("backoff_until")
      .eq("channel", channel).maybeSingle(),
  ]);

  const backoffUntil = (rateStateRes.data?.backoff_until as string | null) ?? null;
  const backoffActive = !!(backoffUntil && new Date(backoffUntil).getTime() > Date.now());

  return {
    runs: totalRuns,
    sent,
    errors,
    rate_limited: rateLimited,
    pending: pending ?? 0,
    in_retry: inRetry ?? 0,
    locked_stuck: stuck ?? 0,
    last_stop_reason: lastRun?.stop_reason ?? null,
    last_provider_error: lastRun?.last_provider_error ?? null,
    last_run_at: lastRun?.started_at ?? null,
    woke_up: totalRuns > 0,
    sent_logs: sentLogs ?? 0,
    backoff_until: backoffUntil,
    backoff_active: backoffActive,
  };
}

function classify(s: ChannelSummary): "ok" | "warning" | "critical" {
  // Fonte de verdade: se houve envio real (sms_send_logs/email_send_logs) desde 06:00,
  // o motor acordou e está funcionando — mesmo que dispatcher_runs mostre 0 na janela
  // amostrada (pool paralelo com throttled_by_minute_cap é comportamento normal).
  if (s.sent_logs > 0) {
    if (s.locked_stuck > 0) return "warning";
    return "ok";
  }
  // Sem envio confirmado ainda. Se o provedor pediu backoff que ainda está ativo,
  // não é falha — é espera autorresolvível.
  if (s.backoff_active) return "warning";
  // Backoff que já expirou + nada enviado = aviso (vai retomar no próximo tick).
  if (s.backoff_until && !s.backoff_active && s.pending > 0) return "warning";
  if (!s.woke_up) return "critical";
  if (s.pending > 0) return "critical";
  if (s.errors > 0 && s.sent === 0) return "critical";
  if (s.rate_limited > 0 || s.locked_stuck > 0) return "warning";
  return "ok";
}

export const Route = createFileRoute("/api/public/hooks/morning-check")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try { requireSharedSecret(request, "CRON_SECRET"); } catch (r) { return r as Response; }
        // janela: das 06:00 BRT (09:00 UTC) de hoje até agora
        const now = new Date();
        const sinceUtc = new Date(Date.UTC(
          now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0, 0,
        ));
        const since = sinceUtc.toISOString();

        const [sms, email] = await Promise.all([
          summarizeChannel("sms", since),
          summarizeChannel("email", since),
        ]);

        const smsSev = classify(sms);
        const emailSev = classify(email);
        const worst: "ok" | "warning" | "critical" =
          smsSev === "critical" || emailSev === "critical" ? "critical"
            : smsSev === "warning" || emailSev === "warning" ? "warning"
              : "ok";

        const title = worst === "ok"
          ? "SMS e Email retomaram normalmente às 06:00."
          : worst === "warning"
            ? "Retomada das 06:00 com alertas."
            : "Falha na retomada automática das 06:00.";

        const message =
          `SMS — enviados: ${sms.sent} · pendentes: ${sms.pending} · erros: ${sms.errors}` +
          ` · motivo última parada: ${sms.last_stop_reason ?? "—"}\n` +
          `Email — enviados: ${email.sent} · pendentes: ${email.pending} · erros: ${email.errors}` +
          ` · motivo última parada: ${email.last_stop_reason ?? "—"}`;

        const { error } = await supabaseAdmin.from("system_alerts").insert({
          alert_type: "morning_check",
          severity: worst,
          title,
          message,
          details: { since, sms, email },
        });
        if (error) console.error("[morning-check] insert alert falhou", error.message);

        return Response.json({ ok: true, severity: worst, sms, email });
      },
    },
  },
});