// Super-admin "Saúde" tab (Task 4, spec §5.2): the technical-alerts strip on
// top of the house table. One row per `PlatformAlert`, severity tag first,
// the whole row clickable (`onOpen`) so it leads straight to the screen that
// fixes it — unless the alert has no such screen (`href` null), then the row
// is plain text. With no alerts the strip collapses to a single green line.
import type { PlatformAlert } from "@/lib/platform-health/alert-rules";
import { cn } from "@/lib/utils";

const TIME_ZONE = "America/Sao_Paulo";

/** "HH:MM" of an ISO instant, in São Paulo. */
export function formatCheckedAt(checkedAt: string): string {
  return new Date(checkedAt).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  });
}

/**
 * "há X min" under one hour, "há N h" (whole hours elapsed, floored) under
 * 24 h, else "desde DD/MM" in São Paulo.
 */
export function formatSince(since: string | null, now: Date): string {
  if (!since) return "";
  const date = new Date(since);
  const diffMs = now.getTime() - date.getTime();
  const diffHours = diffMs / 3_600_000;
  if (diffHours < 1) {
    const minutes = Math.max(1, Math.floor(diffMs / 60_000));
    return `há ${minutes} min`;
  }
  if (diffHours < 24) {
    return `há ${Math.floor(diffHours)} h`;
  }
  const ddmm = date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: TIME_ZONE,
  });
  return `desde ${ddmm}`;
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

const ROW_CLASS =
  "flex w-full items-center gap-3 rounded-lg bg-muted/60 px-3 py-2 text-left text-sm";

export function HealthAlertsStrip({
  alerts,
  checkedAt,
  onOpen,
}: {
  alerts: PlatformAlert[];
  checkedAt: string;
  onOpen: (alert: PlatformAlert & { href: string }) => void;
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
      {alerts.map((alert) => {
        const content = (
          <>
            <SeverityTag severity={alert.severity} />
            <span className="min-w-0 flex-1 truncate">{alert.message}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatSince(alert.since, now)}
            </span>
          </>
        );
        const href = alert.href;
        if (href === null) {
          return (
            <div key={alert.key} className={ROW_CLASS}>
              {content}
            </div>
          );
        }
        return (
          <button
            key={alert.key}
            type="button"
            onClick={() => onOpen({ ...alert, href })}
            className={cn(ROW_CLASS, "transition-colors hover:bg-muted")}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
