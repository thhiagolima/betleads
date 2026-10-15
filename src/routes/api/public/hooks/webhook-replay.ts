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

        const body = await request.json().catch(() => ({}) as Record<string, unknown>);
        const tenantId = typeof body.tenant_id === "string" ? body.tenant_id : undefined;
        // Por padrão, retoma tanto eventos que ficaram apenas persistidos quanto
        // os que falharam durante o processamento. Antes, a recuperação buscava
        // somente `recebido` e deixava falhas financeiras fora da fila padrão.
        const status = typeof body.status === "string" ? body.status : "pendente";
        const evento = typeof body.evento === "string" ? body.evento : undefined;
        const dryRun = body.dry_run === true;
        // This route runs behind the public proxy. A large HTTP replay is not
        // a queue: it times out and leaves callers without an outcome. Keep a
        // bounded batch; pg_cron invokes the endpoint every minute until the
        // backlog is empty.
        const limitRaw = Number(body.limit ?? 20);
        const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1), 20);

        let query = sb
          .from("webhook_logs")
          .select("id, tenant_id, evento, payload")
          .order("created_at", { ascending: true })
          .limit(limit);

        query =
          status === "pendente"
            ? query.in("status", ["recebido", "erro"])
            : query.eq("status", status);

        if (tenantId) query = query.eq("tenant_id", tenantId);
        if (evento) query = query.eq("evento", evento);

        const { data: rows, error } = await query;
        if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

        const selected = rows ?? [];
        if (dryRun) {
          const byEvent = selected.reduce<Record<string, number>>((summary, row) => {
            summary[row.evento as string] = (summary[row.evento as string] ?? 0) + 1;
            return summary;
          }, {});
          return Response.json({
            ok: true,
            dry_run: true,
            limit,
            has_more: selected.length === limit,
            scanned: selected.length,
            by_event: byEvent,
            sample: selected.slice(0, 10).map((row) => ({
              id: row.id,
              tenant_id: row.tenant_id,
              evento: row.evento,
            })),
          });
        }

        let processed = 0;
        let failed = 0;
        // Keep replay bounded. Five concurrent events are enough to drain a
        // backlog without causing the same database contention that made the
        // report endpoints time out.
        const concurrency = 5;
        for (let offset = 0; offset < selected.length; offset += concurrency) {
          const batch = selected.slice(offset, offset + concurrency);
          const results = await Promise.all(
            batch.map(async (row) => {
              const response = await processWebhookEvent(
                sb,
                row.tenant_id as string,
                row.evento as string,
                (row.payload ?? {}) as Record<string, unknown>,
                { mirror: true, existingLogId: row.id as string },
              );
              const result = await response.json().catch(() => ({ ok: false }));
              return Boolean((result as { ok?: boolean }).ok);
            }),
          );
          for (const ok of results) {
            if (ok) processed += 1;
            else failed += 1;
          }
        }

        return Response.json({
          ok: true,
          dry_run: false,
          limit,
          has_more: selected.length === limit,
          scanned: selected.length,
          processed,
          failed,
        });
      },
    },
  },
});
