import { createFileRoute } from "@tanstack/react-router";
import { requireSharedSecret } from "@/lib/cron-auth.server";
import { startJobRun } from "@/lib/observability/job-monitor.server";
import { runTenantDomainVerification } from "@/lib/tenant-domains-verify.server";

export const Route = createFileRoute("/api/public/tenant-domains/verify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireSharedSecret(request, "CRON_SECRET");
        } catch (response) {
          return response as Response;
        }
        const run = await startJobRun("tenant_domains_verify", {
          channel: "tenant_domains",
          kind: "verify",
        });
        try {
          const result = await runTenantDomainVerification();
          await run.finish({
            claimed: result.checked,
            sent: result.verified,
            errors: result.failed,
          });
          return Response.json({ ok: true, ...result });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Falha ao verificar domínios.";
          console.error("[tenant-domains verify]", message);
          await run.fail(error);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
