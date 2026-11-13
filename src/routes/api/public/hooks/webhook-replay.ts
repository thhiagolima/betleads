import { createFileRoute } from "@tanstack/react-router";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSharedSecret } from "@/lib/cron-auth.server";
import { getServiceClient, processWebhookEvent } from "@/lib/webhook-process.server";
import { pingHeartbeat, startJobRun } from "@/lib/observability/job-monitor.server";

const JOB = "webhook_replay";
const CLAIM_RPC = "claim_webhook_logs_for_replay";
const DEFAULT_TIME_BUDGET_MS = 40_000;

type ReplayRow = {
  id: string;
  tenant_id: string;
  evento: string;
  payload?: Record<string, unknown> | null;
  replay_attempts?: number | null;
  /** 'replay' | 'dead_lettered' (claim) or 'candidate' | 'would_dead_letter' (dry run). */
  action?: string | null;
};

type SelectResult = {
  rows: ReplayRow[];
  /** `claim`: rows leased by the RPC (attempts/backoff/DLQ). `legacy`: plain select. */
  mode: "claim" | "legacy";
  error?: string;
};

// PGRST202: function not in PostgREST's schema cache; 42883: undefined function.
function isMissingRpc(error: { code?: string }) {
  return error.code === "PGRST202" || error.code === "42883";
}

/**
 * Selects the batch through the atomic claim RPC (CON-03). Falls back to the
 * pre-migration plain select only when the RPC does not exist yet, so a
 * deploy that precedes the migration keeps draining the backlog.
 */
async function selectBatch(
  sb: SupabaseClient,
  args: {
    limit: number;
    status: string;
    tenantId?: string;
    evento?: string;
    perTenant?: number;
    dryRun: boolean;
  },
): Promise<SelectResult> {
  const params: Record<string, unknown> = { p_limit: args.limit, p_dry_run: args.dryRun };
  if (args.status !== "pendente") params.p_statuses = [args.status];
  if (args.tenantId) params.p_tenant_id = args.tenantId;
  if (args.evento) params.p_evento = args.evento;
  if (args.perTenant) params.p_per_tenant = args.perTenant;

  const { data, error } = await sb.rpc(CLAIM_RPC, params);
  if (!error) return { rows: (data ?? []) as ReplayRow[], mode: "claim" };
  if (!isMissingRpc(error)) return { rows: [], mode: "claim", error: error.message };

  let query = sb
    .from("webhook_logs")
    .select("id, tenant_id, evento, payload")
    .order("created_at", { ascending: true })
    .limit(args.limit);
  query =
    args.status === "pendente"
      ? query.in("status", ["recebido", "erro"])
      : query.eq("status", args.status);
  if (args.tenantId) query = query.eq("tenant_id", args.tenantId);
  if (args.evento) query = query.eq("evento", args.evento);
  const legacy = await query;
  if (legacy.error) return { rows: [], mode: "legacy", error: legacy.error.message };
  return { rows: (legacy.data ?? []) as ReplayRow[], mode: "legacy" };
}

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
        const perTenantRaw = Number(body.per_tenant);
        const perTenant =
          Number.isFinite(perTenantRaw) && perTenantRaw >= 1
            ? Math.min(Math.floor(perTenantRaw), limit)
            : undefined;
        // One batch of 20 per minute drained ~1,200 events/hour: the 13k
        // backlog left by the 2026-11-13 webhook storm would have taken 11 h.
        // A tick now claims batch after batch until this budget runs out
        // (below nginx's 60 s), and the next tick picks up the rest.
        const budgetRaw = Number(body.time_budget_ms ?? DEFAULT_TIME_BUDGET_MS);
        const timeBudgetMs = Math.min(
          Math.max(Number.isFinite(budgetRaw) ? budgetRaw : DEFAULT_TIME_BUDGET_MS, 0),
          DEFAULT_TIME_BUDGET_MS,
        );
        const startedAt = Date.now();

        // The claim RPC leases rows (replay_attempts + next_replay_at backoff),
        // interleaves tenants and dead-letters rows after 8 attempts (~4 h of backoff), so a set
        // of permanently failing events can no longer pin the head of the
        // queue and overlapping cron ticks never process the same row.
        const claimBatch = () =>
          selectBatch(sb, { limit, status, tenantId, evento, perTenant, dryRun });
        const selection = await claimBatch();
        if (selection.error) {
          if (!dryRun) {
            const failedRun = await startJobRun(JOB, {
              channel: "webhook",
              kind: "replay",
              tenantId: tenantId ?? null,
            });
            await failedRun.fail(new Error(`webhook_logs claim: ${selection.error}`));
          }
          return Response.json({ ok: false, error: selection.error }, { status: 500 });
        }

        const selected = selection.rows;
        if (dryRun) {
          const byEvent = selected.reduce<Record<string, number>>((summary, row) => {
            summary[row.evento] = (summary[row.evento] ?? 0) + 1;
            return summary;
          }, {});
          return Response.json({
            ok: true,
            dry_run: true,
            limit,
            has_more: perTenant ? selected.length > 0 : selected.length === limit,
            scanned: selected.length,
            would_dead_letter: selected.filter((row) => row.action === "would_dead_letter").length,
            by_event: byEvent,
            sample: selected.slice(0, 10).map((row) => ({
              id: row.id,
              tenant_id: row.tenant_id,
              evento: row.evento,
              replay_attempts: row.replay_attempts ?? null,
            })),
          });
        }

        // Empty ticks (the normal state) only prove liveness; rows are written
        // only when there is a backlog to replay.
        if (selected.length === 0) {
          void pingHeartbeat(JOB, true);
          return Response.json({
            ok: true,
            dry_run: false,
            limit,
            has_more: false,
            scanned: 0,
            processed: 0,
            failed: 0,
            dead_lettered: 0,
            deferred: 0,
          });
        }

        const run = await startJobRun(JOB, {
          channel: "webhook",
          kind: "replay",
          tenantId: tenantId ?? null,
        });
        let scanned = 0;
        let claimed = 0;
        let deadLetteredCount = 0;
        let processed = 0;
        let failed = 0;
        let deferred = 0;
        let lastError: string | null = null;
        let hasMore = false;
        // Keep replay bounded. Five concurrent events are enough to drain a
        // backlog without causing the same database contention that made the
        // report endpoints time out.
        const concurrency = 5;
        let current: SelectResult = selection;
        try {
          for (;;) {
            const rows = current.rows;
            const deadLettered = rows.filter((row) => row.action === "dead_lettered");
            const toReplay = rows.filter((row) => row.action !== "dead_lettered");
            if (deadLettered.length > 0) {
              console.warn("[webhook-replay] events moved to dead letter queue", {
                count: deadLettered.length,
                ids: deadLettered.map((row) => row.id),
              });
            }
            scanned += rows.length;
            claimed += toReplay.length;
            deadLetteredCount += deadLettered.length;
            run.progress({ queue_before: scanned, claimed });
            const mode = current.mode;
            let roundProgress = 0;
            for (let offset = 0; offset < toReplay.length; offset += concurrency) {
              const batch = toReplay.slice(offset, offset + concurrency);
              const results = await Promise.all(
                batch.map(async (row) => {
                  const response = await processWebhookEvent(
                    sb,
                    row.tenant_id,
                    row.evento,
                    (row.payload ?? {}) as Record<string, unknown>,
                    { existingLogId: row.id },
                  );
                  const result = (await response.json().catch(() => ({ ok: false }))) as {
                    ok?: boolean;
                    in_progress?: boolean;
                    error?: unknown;
                  };
                  // in_progress comes with ok:true (HTTP 202), so check it first.
                  if (result.in_progress) {
                    // Another delivery holds the receipt. processWebhookEvent kept
                    // the row `recebido` and moved next_replay_at past the lease;
                    // waiting on a live lease must not consume a replay attempt.
                    if (mode === "claim" && typeof row.replay_attempts === "number") {
                      await sb
                        .from("webhook_logs")
                        .update({ replay_attempts: Math.max(0, row.replay_attempts - 1) })
                        .eq("id", row.id);
                    }
                    return "deferred" as const;
                  }
                  if (result.ok) return "processed" as const;
                  const message = String(result.error ?? `HTTP ${response.status}`).slice(
                    0,
                    1000,
                  );
                  lastError = message;
                  if (mode === "claim") {
                    await sb
                      .from("webhook_logs")
                      .update({ last_replay_error: message })
                      .eq("id", row.id);
                  }
                  return "failed" as const;
                }),
              );
              for (const outcome of results) {
                if (outcome === "processed") processed += 1;
                else if (outcome === "deferred") deferred += 1;
                else failed += 1;
                if (outcome !== "deferred") roundProgress += 1;
              }
              run.progress({ sent: processed, errors: failed, rescheduled: deferred });
            }
            // With a per-tenant cap a single tenant backlog returns fewer than `limit`
            // rows even when more remain, so any claimed row means "call again".
            hasMore = perTenant ? rows.length > 0 : rows.length === limit;
            // Only the claim RPC leases rows: the legacy select would hand back
            // the same rows. A round of only deferred rows would spin on live leases.
            const keepGoing =
              hasMore &&
              mode === "claim" &&
              (roundProgress > 0 || deadLettered.length > 0) &&
              Date.now() - startedAt < timeBudgetMs;
            if (!keepGoing) break;
            const next = await claimBatch();
            if (next.error) {
              // Earlier rounds are done; the next tick claims again.
              console.warn("[webhook-replay] claim failed mid-tick", { error: next.error });
              lastError = `webhook_logs claim: ${next.error}`;
              break;
            }
            if (next.rows.length === 0) {
              hasMore = false;
              break;
            }
            current = next;
          }
        } catch (replayError) {
          await run.fail(replayError, {
            queue_before: scanned,
            claimed,
            sent: processed,
            errors: failed + deadLetteredCount,
            rescheduled: deferred,
          });
          throw replayError;
        }
        await run.finish({
          queue_before: scanned,
          claimed,
          sent: processed,
          // Dead-lettered rows are permanent failures: count them so the run
          // is reported as partial and shows up in alerting.
          errors: failed + deadLetteredCount,
          rescheduled: deferred,
          last_provider_error: lastError,
          stop_reason: hasMore ? "has_more" : "drained",
        });

        return Response.json({
          ok: true,
          dry_run: false,
          limit,
          has_more: hasMore,
          scanned,
          processed,
          failed,
          dead_lettered: deadLetteredCount,
          deferred,
        });
      },
    },
  },
});
