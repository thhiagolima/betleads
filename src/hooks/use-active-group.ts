import { useState } from "react";

import { useActiveTenant } from "@/hooks/use-active-tenant";

export type GroupOption = { id: string; nome: string; is_demo: boolean };

const STORAGE_KEY = "betleads:active-group";

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

/**
 * The group the group-area pages (`/grupo*`) are scoped to. Validated
 * against `useActiveTenant().data.groups` (the groups the user manages) on
 * every read, falling back to the first one when the stored id is stale or
 * missing (Task 7, brief step 1).
 */
export function useActiveGroup() {
  const { data } = useActiveTenant();
  const groups = (data?.groups ?? []) as GroupOption[];
  const [overrideId, setOverrideId] = useState<string | null>(null);

  const storedId = overrideId ?? readStored();
  const active = groups.find((group) => group.id === storedId) ?? (groups[0] ?? null);

  const setActive = (id: string) => {
    if (!groups.some((group) => group.id === id)) return;
    setOverrideId(id);
    writeStored(id);
  };

  return { groups, active, setActive };
}
