// Pure search over the help panel's content (brief, Task 4). No DOM, no
// React: the panel builds the index with `buildSearchIndex` and filters it
// with `searchHelp` on every keystroke.
import type { GlossaryTerm, HelpRole, HelpScreen } from "./types";

export type SearchEntry = {
  kind: "item" | "term" | "guide";
  title: string;
  text: string;
  route?: string;
  sectionId?: string;
  termId?: string;
  guideId?: string;
};

/** Lowercase, without accents (NFD minus combining marks), single-spaced. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Entries whose title or text contains every word of `query` (accent- and
 * case-insensitive), title matches first. Empty for a query shorter than 2
 * characters. */
export function searchHelp(index: SearchEntry[], query: string): SearchEntry[] {
  const q = normalizeSearchText(query);
  if (q.length < 2) return [];
  const words = q.split(" ");
  const titleHits: SearchEntry[] = [];
  const textHits: SearchEntry[] = [];
  for (const entry of index) {
    const title = normalizeSearchText(entry.title);
    const haystack = `${title} ${normalizeSearchText(entry.text)}`;
    if (!words.every((w) => haystack.includes(w))) continue;
    if (words.some((w) => title.includes(w))) titleHits.push(entry);
    else textHits.push(entry);
  }
  return [...titleHits, ...textHits];
}

/** Whether `role` sees something restricted to `roles` (omitted = everyone). */
export function roleCanSee(roles: HelpRole[] | undefined, role: HelpRole): boolean {
  return !roles || roles.includes(role);
}

/** The current screen's items the role can see, plus every glossary term.
 * (Guides join the index when they exist — Task 6.) */
export function buildSearchIndex(
  screen: HelpScreen | null,
  role: HelpRole,
  glossary: GlossaryTerm[],
): SearchEntry[] {
  const entries: SearchEntry[] = [];
  if (screen) {
    for (const section of screen.sections) {
      for (const item of section.items) {
        if (!roleCanSee(item.roles, role)) continue;
        entries.push({
          kind: "item",
          title: item.label,
          text: [item.what, item.when, item.notes].filter(Boolean).join(" "),
          route: screen.route,
          sectionId: section.id,
        });
      }
    }
  }
  for (const term of glossary) {
    entries.push({
      kind: "term",
      title: term.term,
      text: [term.short, term.long].filter(Boolean).join(" "),
      termId: term.id,
    });
  }
  return entries;
}
