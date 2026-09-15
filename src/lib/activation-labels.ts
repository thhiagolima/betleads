// Mapas de tradução do orquestrador para linguagem de produto (pt-BR).

export function modeLabel(mode?: string | null): string {
  if (mode === "execute") return "Reprocessamento";
  if (mode === "simulate") return "Simulação";
  return mode ?? "—";
}

export function statusLabel(status?: string | null): string {
  if (status === "running") return "Em andamento";
  if (status === "done") return "Concluído";
  if (status === "ok") return "Concluído";
  if (status === "error") return "Falhou";
  return status ?? "—";
}

/** Classifica um erro do orquestrador.
 * - "operational": esperado, não compromete envios (ex.: ciclo demorou demais).
 * - "failure": falha real que precisa de atenção. */
export function classifyError(error?: string | null): "operational" | "failure" | null {
  if (!error) return null;
  const e = error.toLowerCase();
  if (e.includes("timed_out") || e.includes("timeout")) return "operational";
  return "failure";
}

export function friendlyError(error?: string | null): string {
  const kind = classifyError(error);
  if (kind === "operational") {
    return "O varredor de leads excedeu o tempo limite e foi reiniciado automaticamente. Os envios de SMS, e-mail e ligações continuam normalmente.";
  }
  return error ?? "";
}

export function formatDateShort(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
}

export function formatDuration(startedAt?: string | null, finishedAt?: string | null): string | null {
  if (!startedAt || !finishedAt) return null;
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}