import { createFileRoute } from "@tanstack/react-router";
import {
  runSmsDispatcher,
  runScheduledSmsCampaigns,
} from "@/lib/sms-dispatcher.server";
import { runEmailFlowDispatcher } from "@/lib/email-automations.server";
import { tickFlows } from "@/lib/call-flows.server";
import { runDispatcher as runWhatsappDispatcher } from "@/lib/automation.server";
import { requireSharedSecret } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/hooks/dispatch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try { requireSharedSecret(request, "CRON_SECRET"); } catch (r) { return r as Response; }
        const url = new URL(request.url);
        const channel = url.searchParams.get("channel");
        try {
          let result: unknown;
          // SMS/Email/Ligação: sem antiban — vão a velocidade máxima.
          // WhatsApp: mantém 50 por ciclo (antiban real contra ban).
          // Lotes pequenos por requisição (cabe no tempo de execução do worker).
          // O cron dispara várias chamadas em paralelo por minuto pra atingir
          // throughput alto sem estourar timeout.
          if (channel === "sms") {
            // Primeiro despacha campanhas agendadas (envio em massa programado),
            // depois roda o dispatcher normal dos fluxos.
            const campaigns = await runScheduledSmsCampaigns({ limit: 20 });
            const flows = await runSmsDispatcher({ limit: 2000 });
            result = { campaigns, flows };
          }
          else if (channel === "email") result = await runEmailFlowDispatcher({ limit: 2000 });
          else if (channel === "call") result = await tickFlows(200);
          else if (channel === "whatsapp") result = await runWhatsappDispatcher({ limit: 50 });
          else return Response.json({ ok: false, error: "channel inválido" }, { status: 400 });
          return Response.json({ ok: true, channel, result });
        } catch (e) {
          return Response.json(
            { ok: false, channel, error: e instanceof Error ? e.message : String(e) },
            { status: 500 },
          );
        }
      },
    },
  },
});