import { useSyncExternalStore } from "react";

import { useActiveTenant } from "@/hooks/use-active-tenant";

export type GroupOption = { id: string; nome: string; is_demo: boolean };

const STORAGE_KEY = "betleads:active-group";

// Module-level store (fix round 1, item 4): the previous per-instance
// `useState` meant two components calling `useActiveGroup()` (the header
// switcher and the /grupo* page) could disagree — switching the group in the
// switcher left the panel showing the old one until a hard navigation. This
// store is shared by every subscriber via `useSyncExternalStore`, so a write
// from one instance re-renders all of them in the same tick.
let overrideId: string | null = null;
const listeners = new Set<() => void>();

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(id: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Storage unavailable (private mode, SSR): the session just keeps the
    // in-memory override below instead of persisting it.
  }
}

/** Current stored/overridden group id, with no validation against the
 * user's actual groups (the hook below does that). Exported for the store
 * unit test and for `useSyncExternalStore`'s `getSnapshot`. */
export function getActiveGroupId(): string | null {
  return overrideId ?? readStored();
}

/** Sets the id and notifies every subscriber (same tab). */
export function setActiveGroupId(id: string) {
  overrideId = id;
  writeStored(id);
  for (const listener of listeners) listener();
}

export function subscribeActiveGroup(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: clears the in-memory override and subscriber set. */
export function __resetActiveGroupStoreForTests() {
  overrideId = null;
  listeners.clear();
}

const getServerSnapshot = () => null;

/**
 * The group the group-area pages (`/grupo*`) are scoped to. Validated
 * against `useActiveTenant().data.groups` (the groups the user manages) on
 * every read, falling back to the first one when the stored id is stale or
 * missing (Task 7, brief step 1). Backed by the module-level store above, so
 * every component calling this hook sees the same active group.
 */
export function useActiveGroup() {
  const { data } = useActiveTenant();
  const groups = (data?.groups ?? []) as GroupOption[];
  const storedId = useSyncExternalStore(subscribeActiveGroup, getActiveGroupId, getServerSnapshot);

  const active = groups.find((group) => group.id === storedId) ?? groups[0] ?? null;

  const setActive = (id: string) => {
    if (!groups.some((group) => group.id === id)) return;
    setActiveGroupId(id);
  };

  return { groups, active, setActive };
}
