import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type RealtimeStatus = "idle" | "connecting" | "active" | "offline";

/**
 * Subscribes to postgres_changes on the given tables and invalidates the
 * given React Query key(s) on any change, with a small debounce so a burst
 * of UPDATEs doesn't trigger a refetch storm.
 *
 * Returns the channel status so callers (e.g. the header indicator) can
 * reflect connection health honestly.
 */
export function useRealtimeInvalidate(
  channelName: string,
  tables: string[],
  queryKeys: ReadonlyArray<ReadonlyArray<unknown>>,
  debounceMs = 300,
): RealtimeStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>("connecting");

  useReportRealtimeStatus(status);

  useEffect(() => {
    if (tables.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        for (const key of queryKeys) {
          qc.invalidateQueries({ queryKey: key as unknown[] });
        }
      }, debounceMs);
    };

    let channel = supabase.channel(channelName);
    for (const table of tables) {
      channel = (channel as any).on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        trigger,
      );
    }

    const sub = channel.subscribe((s) => {
      if (s === "SUBSCRIBED") setStatus("active");
      else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") setStatus("offline");
      else setStatus("connecting");
    });

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(sub);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelName, tables.join(","), JSON.stringify(queryKeys), debounceMs]);

  return status;
}

// ---- Shared status bus, so the global header can reflect *any* active
// realtime subscription on the current page without being coupled to it.

const listeners = new Set<(s: RealtimeStatus) => void>();
let currentGlobal: RealtimeStatus = "idle";
const counts: Record<RealtimeStatus, number> = {
  idle: 0,
  connecting: 0,
  active: 0,
  offline: 0,
};

function recomputeGlobal() {
  let next: RealtimeStatus = "idle";
  if (counts.active > 0) next = "active";
  else if (counts.connecting > 0) next = "connecting";
  else if (counts.offline > 0) next = "offline";
  if (next !== currentGlobal) {
    currentGlobal = next;
    for (const l of listeners) l(next);
  }
}

export function publishRealtimeStatus(status: RealtimeStatus) {
  // Track the latest status per caller via the effect lifecycle below.
  // We expose a tiny hook (useGlobalRealtimeStatus) to consume the bus.
  // Implementation note: callers use useReportRealtimeStatus(status) which
  // handles increment/decrement on unmount automatically.
  void status;
}

export function useReportRealtimeStatus(status: RealtimeStatus) {
  useEffect(() => {
    counts[status] += 1;
    recomputeGlobal();
    return () => {
      counts[status] = Math.max(0, counts[status] - 1);
      recomputeGlobal();
    };
  }, [status]);
}

export function useGlobalRealtimeStatus(): RealtimeStatus {
  const [s, setS] = useState<RealtimeStatus>(currentGlobal);
  useEffect(() => {
    listeners.add(setS);
    setS(currentGlobal);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}