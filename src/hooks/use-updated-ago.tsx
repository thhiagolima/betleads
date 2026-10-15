import { useEffect, useState } from "react";

/**
 * Polling intervals used by screens that stopped listening to Realtime
 * `postgres_changes` on high-write tables (REP-05 / NOVO-B). Screens still
 * refresh on their own, just on a fixed cadence instead of on every row change.
 */
export const POLL_INTERVALS = {
  /** Aggregated stats / history screens (heavy queries). */
  stats: 60_000,
  /** Live operational lists (feeds, dispatch dashboards). */
  liveList: 15_000,
  /** Operational dashboards that aggregate a period. */
  dashboard: 30_000,
} as const;

/** "agora", "há 12s", "há 3min" — re-renders every 5 s. */
export function useUpdatedAgo(ts: number | undefined): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 5_000);
    return () => clearInterval(id);
  }, []);
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return "agora";
  if (s < 60) return `há ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m}min`;
  return `há ${Math.floor(m / 60)}h`;
}

/** Discreet "Atualizado há X" label for polled screens. */
export function UpdatedAgo({
  ts,
  className = "",
}: {
  ts: number | undefined;
  className?: string;
}) {
  const ago = useUpdatedAgo(ts);
  return (
    <span className={`text-xs text-muted-foreground tabular-nums ${className}`}>
      Atualizado {ago}
    </span>
  );
}
