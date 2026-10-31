import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ChevronDown, Loader2 } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { getMetaSyncRunJobs, getMetaSyncRuns } from "@/lib/meta.functions";
import { cn } from "@/lib/utils";
import { ToneBadge, type Tone } from "./meta-badges";
import { formatDateTime, plural } from "./meta-format";

// Histórico de sincronizações da Meta (MB4-01): os últimos 10 runs da casa e, ao
// abrir um, o resultado de cada conta. Visível para todo membro da casa.

export type MetaSyncRunRow = {
  id: string;
  trigger_type: "manual" | "scheduled" | "backfill" | string;
  days: number | null;
  status: "queued" | "running" | "completed" | "partial" | "failed" | "canceled" | string;
  total_accounts: number;
  processed_accounts: number;
  successful_accounts: number;
  failed_accounts: number;
  rows_imported: number;
  started_at: string | null;
  finished_at: string | null;
  error_summary: string | null;
  created_at: string;
};

export type MetaSyncJobRow = {
  accountId: string;
  accountName: string | null;
  metaAdAccountId: string;
  status: string;
  attemptCount: number;
  rateLimitedCount: number;
  rowsImported: number;
  lastError: string | null;
  finishedAt: string | null;
};

const ACTIVE = new Set(["queued", "running", "retry"]);

/** "manual", "automática", "automática (28 dias)" ou "importação inicial". */
export function triggerLabel(run: Pick<MetaSyncRunRow, "trigger_type" | "days">) {
  if (run.trigger_type === "manual") return "manual";
  if (run.trigger_type === "backfill") return "importação inicial";
  return (run.days ?? 0) >= 28 ? `automática (${run.days} dias)` : "automática";
}

const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "na fila", tone: "none" },
  running: { label: "em andamento", tone: "none" },
  completed: { label: "concluída", tone: "ok" },
  partial: { label: "concluída com atenção", tone: "attention" },
  failed: { label: "falhou", tone: "error" },
  canceled: { label: "cancelada", tone: "none" },
};

const JOB_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "na fila", tone: "none" },
  running: { label: "lendo", tone: "none" },
  retry: { label: "nova tentativa", tone: "attention" },
  completed: { label: "concluída", tone: "ok" },
  failed: { label: "falhou", tone: "error" },
  canceled: { label: "cancelada", tone: "none" },
};

function StatusBadge({
  status,
  map,
}: {
  status: string;
  map: Record<string, { label: string; tone: Tone }>;
}) {
  const entry = map[status] ?? { label: status, tone: "none" as Tone };
  if (status === "running") {
    return (
      <Badge
        variant="outline"
        className="gap-1 whitespace-nowrap border-info/30 bg-info/10 text-meta font-medium text-info"
      >
        <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
        {entry.label}
      </Badge>
    );
  }
  return <ToneBadge tone={entry.tone}>{entry.label}</ToneBadge>;
}

/** Status de um run (`meta_sync_runs.status`) com texto e ícone. */
export function RunStatusBadge({ status }: { status: string }) {
  return <StatusBadge status={status} map={RUN_STATUS} />;
}

/** Duração do run ("3 min", "1 h 05 min", "menos de 1 min") ou "em andamento". */
export function durationText(run: Pick<MetaSyncRunRow, "status" | "started_at" | "finished_at">) {
  if (ACTIVE.has(run.status) || !run.finished_at) {
    return run.status === "queued" ? "na fila" : "em andamento";
  }
  if (!run.started_at) return "—";
  const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

const NUMBER = new Intl.NumberFormat("pt-BR");

function rowsText(count: number) {
  return `${NUMBER.format(count)} ${count === 1 ? "linha importada" : "linhas importadas"}`;
}

/** Seção "Histórico de sincronizações" da aba Meta Ads (lê `["meta-sync-runs"]`). */
export function SyncHistory() {
  const fetchRuns = useServerFn(getMetaSyncRuns);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["meta-sync-runs"],
    queryFn: async () => (await fetchRuns()) as unknown as MetaSyncRunRow[],
    refetchInterval: (query) => {
      const runs = (query.state.data ?? []) as MetaSyncRunRow[];
      return runs.some((run) => ACTIVE.has(run.status)) ? 3000 : 30000;
    },
  });
  return <SyncHistoryList runs={data ?? []} loading={isLoading} failed={isError} />;
}

export function SyncHistoryList({
  runs,
  loading = false,
  failed = false,
}: {
  runs: MetaSyncRunRow[];
  loading?: boolean;
  failed?: boolean;
}) {
  return (
    <section aria-labelledby="meta-sync-history-title" className="space-y-3">
      <div className="min-w-0">
        <h3 id="meta-sync-history-title" className="font-semibold">
          Histórico de sincronizações
        </h3>
        <p className="text-meta text-muted-foreground">
          As últimas 10 leituras da Meta nesta casa. Abra uma para ver cada conta.
        </p>
      </div>
      {loading ? (
        <p className="py-4 text-center text-sm text-muted-foreground">Carregando histórico…</p>
      ) : failed ? (
        <p role="alert" className="flex items-center gap-2 text-sm text-danger">
          <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" />
          Não foi possível carregar o histórico.
        </p>
      ) : runs.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          Nenhuma sincronização ainda.
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
          {runs.slice(0, 10).map((run) => (
            <SyncRunItem key={run.id} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SyncRunItem({ run }: { run: MetaSyncRunRow }) {
  const [open, setOpen] = useState(false);
  const panelId = `meta-sync-run-${run.id}`;
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-start gap-3 px-3 py-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} />
            <span className="text-sm font-medium">{triggerLabel(run)}</span>
            <span className="text-meta text-muted-foreground">
              {formatDateTime(run.created_at) ?? "—"}
            </span>
          </div>
          <p className="text-meta text-muted-foreground">
            {run.processed_accounts} de {plural(run.total_accounts, "conta", "contas")}
            {run.failed_accounts > 0 && (
              <span className="text-danger">
                {" "}
                · {plural(run.failed_accounts, "falhou", "falharam")}
              </span>
            )}{" "}
            · {rowsText(run.rows_imported)} · {durationText(run)}
          </p>
          {run.error_summary && (
            <p className="flex items-start gap-1 break-words text-meta text-danger">
              <AlertTriangle aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="min-w-0">{run.error_summary}</span>
            </p>
          )}
        </div>
        <ChevronDown
          aria-hidden
          className={cn(
            "mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
        <span className="sr-only">{open ? "Fechar detalhes" : "Ver contas"}</span>
      </button>
      {open && (
        <div id={panelId} className="border-t border-border/60 bg-muted/20 px-3 py-3 sm:px-4">
          <SyncRunJobs runId={run.id} active={ACTIVE.has(run.status)} />
        </div>
      )}
    </li>
  );
}

/** Intervalo do refetch das contas de um run aberto: 3 s enquanto ele roda. */
export function runJobsRefetchInterval(active: boolean): number | false {
  return active ? 3000 : false;
}

function SyncRunJobs({ runId, active }: { runId: string; active: boolean }) {
  const fetchJobs = useServerFn(getMetaSyncRunJobs);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["meta-sync-run-jobs", runId],
    queryFn: async () => (await fetchJobs({ data: { runId } })).jobs as MetaSyncJobRow[],
    // O status do run vem da lista (que já repete a cada 3 s com run ativo); quando
    // ele termina, o polling das contas para.
    refetchInterval: runJobsRefetchInterval(active),
  });
  return <SyncRunJobsList jobs={data ?? []} loading={isLoading} failed={isError} />;
}

export function SyncRunJobsList({
  jobs,
  loading = false,
  failed = false,
}: {
  jobs: MetaSyncJobRow[];
  loading?: boolean;
  failed?: boolean;
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-meta text-muted-foreground">
        <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
        Carregando contas…
      </p>
    );
  }
  if (failed) {
    return (
      <p role="alert" className="text-meta text-danger">
        Não foi possível carregar as contas desta sincronização.
      </p>
    );
  }
  if (jobs.length === 0) {
    return <p className="text-meta text-muted-foreground">Nenhuma conta nesta sincronização.</p>;
  }
  return (
    <ul aria-label="Contas da sincronização" className="space-y-2">
      {jobs.map((job) => (
        <li
          key={job.accountId}
          className="min-w-0 rounded-lg border border-border/60 bg-background/60 px-3 py-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {job.accountName ?? job.metaAdAccountId}
              </p>
              <p className="font-mono text-meta text-muted-foreground">{job.metaAdAccountId}</p>
            </div>
            <StatusBadge status={job.status} map={JOB_STATUS} />
          </div>
          <p className="mt-1 text-meta text-muted-foreground">
            {rowsText(job.rowsImported)} · {plural(job.attemptCount, "tentativa", "tentativas")}
            {job.rateLimitedCount > 0 &&
              ` · ${plural(job.rateLimitedCount, "limite da Meta", "limites da Meta")}`}
            {job.finishedAt && ` · terminou ${formatDateTime(job.finishedAt) ?? ""}`}
          </p>
          {job.lastError && (
            <p className="mt-1 break-words text-meta text-danger">{job.lastError}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
