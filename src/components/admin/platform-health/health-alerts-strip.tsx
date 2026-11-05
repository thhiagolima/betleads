// Super-admin "Saúde" tab (Task 4, spec §5.2): the technical-alerts strip on
// top of the house table. One row per `PlatformAlert`, severity tag first,
// the whole row clickable (`onOpen`) so it leads straight to the screen that
// fixes it. With no alerts the strip collapses to a single green line.
import type { PlatformAlert } from "@/lib/platform-health/alert-rules";
import { cn } from "@/lib/utils";

function formatCheckedAt(checkedAt: string): string {
  return new Date(checkedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * "há 3 h" while under 24 h (or "há X min" under one hour), else "desde
 * DD/MM". Uses UTC fields so the result does not depend on the runtime's
 * local timezone.
 */
function formatSince(since: string | null, now: Date): string {
  if (!since) return "";
  const date = new Date(since);
  const diffMs = now.getTime() - date.getTime();
  const diffHours = diffMs / 3_600_000;
  if (diffHours < 1) {
    const minutes = Math.max(1, Math.round(diffMs / 60_000));
    return `há ${minutes} min`;
  }
  if (diffHours < 24) {
    return `há ${Math.round(diffHours)} h`;
  }
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `desde ${dd}/${mm}`;
}

function SeverityTag({ severity }: { severity: PlatformAlert["severity"] }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold",
        severity === "critical"
          ? "bg-destructive text-destructive-foreground"
          : "border border-warning/40 bg-warning/10 text-warning",
      )}
    >
      {severity === "critical" ? "CRÍTICO" : "ATENÇÃO"}
    </span>
  );
}

export function HealthAlertsStrip({
  alerts,
  checkedAt,
  onOpen,
}: {
  alerts: PlatformAlert[];
  checkedAt: string;
  onOpen: (alert: PlatformAlert) => void;
}) {
  if (alerts.length === 0) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
        Tudo funcionando — verificado às {formatCheckedAt(checkedAt)}
      </p>
    );
  }

  const now = new Date();
  return (
    <div className="space-y-1.5">
      {alerts.map((alert) => (
        <button
          key={alert.key}
          type="button"
          onClick={() => onOpen(alert)}
          className="flex w-full items-center gap-3 rounded-lg bg-muted/60 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
        >
          <SeverityTag severity={alert.severity} />
          <span className="min-w-0 flex-1 truncate">{alert.message}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatSince(alert.since, now)}
          </span>
        </button>
      ))}
    </div>
  );
}
