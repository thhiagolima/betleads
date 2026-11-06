// Super-admin "Saúde" tab (Task 4, spec §5.2; Task 5/F3: state + actions):
// the technical-alerts strip on top of the house table. One row per
// `PlatformAlert`, severity tag first, the clickable area (`onOpen`) leading
// straight to the screen that fixes it — unless the alert has no such screen
// (`href` null), then that area is plain text. Each row also carries two
// small actions, "Reconhecer" and "Silenciar 24 h", as siblings of the
// clickable area (never nested inside it, so there is no button-inside-button).
// With no alerts the strip collapses to a single green line.
//
// `alert.stored` (joined by `platform-health.server.ts`) drives the
// acknowledged/silenced display: acknowledged alerts stay listed, muted, with
// a "reconhecido" tag; silenced alerts are hidden from the main list behind a
// one-line "N silenciados até HH:MM — mostrar" summary that expands them.
import { useState } from "react";

import { isSilenced, SILENCE_HOURS } from "@/lib/platform-health/alert-lifecycle";
import type { PlatformAlert } from "@/lib/platform-health/alert-rules";
import type { StoredAlertInfo } from "@/lib/platform-health/platform-health.server";
import { cn } from "@/lib/utils";

const TIME_ZONE = "America/Sao_Paulo";

export type AlertWithStored = PlatformAlert & { stored: StoredAlertInfo | null };

const EMPTY_PENDING_KEYS: ReadonlySet<string> = new Set();

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

/** "DD/MM HH:MM" of an ISO instant, in São Paulo — history panel rows. */
export function formatHistoryDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** How long an alert stayed open: "N min" under 1 h, "N h" under 48 h, else "N d". */
export function formatAlertDuration(openedAt: string, resolvedAt: string): string {
  const ms = Math.max(0, new Date(resolvedAt).getTime() - new Date(openedAt).getTime());
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/** True when `alert.stored` is silenced and still in the future at `now`. */
function alertIsSilenced(alert: AlertWithStored, now: Date): boolean {
  return alert.stored != null && isSilenced(alert.stored, now);
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

function AcknowledgedTag() {
  return (
    <span className="shrink-0 rounded-md border border-muted-foreground/30 px-1.5 py-0.5 text-[11px] text-muted-foreground">
      reconhecido
    </span>
  );
}

/** Fix round 1 (controller ruling): a silenced row shown via "mostrar" carries its own
 * "silenciado até HH:MM" tag instead of the "Silenciar 24 h" button. */
function SilencedTag({ until }: { until: string }) {
  return (
    <span className="shrink-0 rounded-md border border-muted-foreground/30 px-1.5 py-0.5 text-[11px] text-muted-foreground">
      silenciado até {formatCheckedAt(until)}
    </span>
  );
}

const ROW_CLASS = "flex w-full items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm";
const ACTION_BUTTON_CLASS =
  "shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50";

/** Exported for direct testing (fix round 1): a silenced/acknowledged row's tag+button state is
 * only reachable through "mostrar" via a click renderToStaticMarkup can't simulate here, so the
 * tests render this row directly instead of through `HealthAlertsStrip`'s toggle. */
export function AlertRow({
  alert,
  now,
  onOpen,
  onAcknowledge,
  onSilence,
  pending,
}: {
  alert: AlertWithStored;
  now: Date;
  onOpen: (alert: AlertWithStored & { href: string }) => void;
  onAcknowledge: (key: string) => void;
  onSilence: (key: string) => void;
  /** Fix round 1: computed per row by the caller (a Set of in-flight keys), not a single
   * shared "pendingKey" shared between the ack and silence mutations. */
  pending: boolean;
}) {
  const acknowledged = alert.stored?.acknowledgedAt != null;
  const silencedUntil = alert.stored?.silencedUntil ?? null;
  const silenced = alertIsSilenced(alert, now);
  const content = (
    <>
      <SeverityTag severity={alert.severity} />
      {acknowledged && <AcknowledgedTag />}
      {silenced && silencedUntil && <SilencedTag until={silencedUntil} />}
      <span className="min-w-0 flex-1 truncate">{alert.message}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatSince(alert.since, now)}
      </span>
    </>
  );
  const href = alert.href;

  return (
    <div className={cn(ROW_CLASS, acknowledged && "opacity-70")}>
      {href === null ? (
        <div className="flex min-w-0 flex-1 items-center gap-3 text-left">{content}</div>
      ) : (
        <button
          type="button"
          onClick={() => onOpen({ ...alert, href })}
          className="flex min-w-0 flex-1 items-center gap-3 text-left transition-colors hover:text-foreground"
        >
          {content}
        </button>
      )}
      <div className="flex shrink-0 items-center gap-1">
        {!acknowledged && (
          <button
            type="button"
            disabled={pending}
            onClick={(event) => {
              event.stopPropagation();
              onAcknowledge(alert.key);
            }}
            className={ACTION_BUTTON_CLASS}
          >
            Reconhecer
          </button>
        )}
        {!silenced && (
          <button
            type="button"
            disabled={pending}
            onClick={(event) => {
              event.stopPropagation();
              onSilence(alert.key);
            }}
            className={ACTION_BUTTON_CLASS}
          >
            Silenciar {SILENCE_HOURS} h
          </button>
        )}
      </div>
    </div>
  );
}

export function HealthAlertsStrip({
  alerts,
  checkedAt,
  onOpen,
  onAcknowledge,
  onSilence,
  pendingKeys = EMPTY_PENDING_KEYS,
}: {
  alerts: AlertWithStored[];
  checkedAt: string;
  onOpen: (alert: AlertWithStored & { href: string }) => void;
  onAcknowledge: (key: string) => void;
  onSilence: (key: string) => void;
  /** Fix round 1: keys currently being acknowledged/silenced, one Set per row instead of a
   * single shared "pendingKey" (acting on two rows in quick succession must not re-enable
   * the wrong one). */
  pendingKeys?: ReadonlySet<string>;
}) {
  const [expanded, setExpanded] = useState(false);

  if (alerts.length === 0) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
        Tudo funcionando — verificado às {formatCheckedAt(checkedAt)}
      </p>
    );
  }

  const now = new Date();
  const visible = alerts.filter((alert) => !alertIsSilenced(alert, now));
  const silenced = alerts.filter((alert) => alertIsSilenced(alert, now));
  // "até HH:MM": the soonest of the silenced alerts to reappear.
  const soonestUntil = silenced
    .map((alert) => alert.stored?.silencedUntil)
    .filter((value): value is string => value != null)
    .sort()[0];

  return (
    <div className="space-y-1.5">
      {visible.map((alert) => (
        <AlertRow
          key={alert.key}
          alert={alert}
          now={now}
          onOpen={onOpen}
          onAcknowledge={onAcknowledge}
          onSilence={onSilence}
          pending={pendingKeys.has(alert.key)}
        />
      ))}
      {silenced.length > 0 && (
        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="text-left text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {silenced.length} silenciado{silenced.length > 1 ? "s" : ""}
            {soonestUntil ? ` até ${formatCheckedAt(soonestUntil)}` : ""} —{" "}
            {expanded ? "ocultar" : "mostrar"}
          </button>
          {expanded &&
            silenced.map((alert) => (
              <AlertRow
                key={alert.key}
                alert={alert}
                now={now}
                onOpen={onOpen}
                onAcknowledge={onAcknowledge}
                onSilence={onSilence}
                pending={pendingKeys.has(alert.key)}
              />
            ))}
        </div>
      )}
    </div>
  );
}

export type AlertHistoryItem = {
  id: string;
  message: string;
  openedAt: string;
  resolvedAt: string;
};

/** The "Histórico (30 dias)" panel's content: resolved alerts, newest first. */
export function AlertHistoryList({ history }: { history: AlertHistoryItem[] }) {
  if (history.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Nenhum alerta resolvido nos últimos 30 dias.</p>
    );
  }
  return (
    <ul className="space-y-2">
      {history.map((item) => (
        <li key={item.id} className="rounded-md border border-border px-3 py-2 text-sm">
          <p>{item.message}</p>
          <p className="text-xs text-muted-foreground">
            aberto em {formatHistoryDateTime(item.openedAt)} · resolvido em{" "}
            {formatHistoryDateTime(item.resolvedAt)} ·{" "}
            {formatAlertDuration(item.openedAt, item.resolvedAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}
