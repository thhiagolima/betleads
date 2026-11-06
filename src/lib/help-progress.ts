// Pure helpers for the in-app tutorial's help progress (guided tours + help
// panel). No server imports: this module is used both client-side and
// server-side.

export type HelpProgressStatus = "done" | "skipped" | "off";

export type HelpProgressMap = Record<string, HelpProgressStatus>;

/** Preference key for "Não mostrar tours automaticamente", stored as a row in
 * `help_progress` just like any tour's key. */
export const AUTO_TOURS_OFF_KEY = "prefs:auto-tours";

const VALID_STATUSES: readonly HelpProgressStatus[] = ["done", "skipped", "off"];

function isHelpProgressStatus(value: string): value is HelpProgressStatus {
  return (VALID_STATUSES as readonly string[]).includes(value);
}

/** `help_progress` key for a screen/tab's guided tour: `tour:<route>` or,
 * when a tab is given, `tour:<route>#<tab>`. */
export function tourKey(route: string, tab?: string | null): string {
  return tab ? `tour:${route}#${tab}` : `tour:${route}`;
}

/** Builds a `{ key: status }` map from raw rows, silently dropping any row
 * whose status isn't one of the known `HelpProgressStatus` values. */
export function rowsToProgressMap(rows: { key: string; status: string }[]): HelpProgressMap {
  const map: HelpProgressMap = {};
  for (const row of rows) {
    if (isHelpProgressStatus(row.status)) {
      map[row.key] = row.status;
    }
  }
  return map;
}
