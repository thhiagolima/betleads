// Pure search over the help panel's content (brief, Task 4). No DOM, no
// React: the panel builds the index with `buildSearchIndex` over every
// loaded article (spec §4.4) and filters it with `searchHelp`.
import type { Guide } from "./guides";
import type { GlossaryTerm, HelpRole, HelpScreen } from "./types";

export type SearchEntry = {
  kind: "item" | "term" | "guide";
  title: string;
  text: string;
  /** The article's route (a `ROUTE_META` pattern or virtual screen id). */
  route?: string;
  /** The article's title, to tell results from other screens apart. */
  screenTitle?: string;
  sectionId?: string;
  /** The section's tab (hash without "#"), when the screen has tabs. */
  tab?: string;
  termId?: string;
  guideId?: string;
};

/** Section id the panel gives an article's states list. */
export const STATES_SECTION_ID = "situacoes";

/** Lowercase, without accents (NFD minus combining marks), single-spaced. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Entries whose title or text contains every word of `query` (accent- and
 * case-insensitive). Order: entries of `currentRoute` first, then the rest;
 * within each group, title matches before text-only matches. Empty for a
 * query shorter than 2 characters. */
export function searchHelp(
  index: SearchEntry[],
  query: string,
  currentRoute?: string | null,
): SearchEntry[] {
  const q = normalizeSearchText(query);
  if (q.length < 2) return [];
  const words = q.split(" ");
  const buckets: SearchEntry[][] = [[], [], [], []];
  for (const entry of index) {
    const title = normalizeSearchText(entry.title);
    const haystack = `${title} ${normalizeSearchText(entry.text)}`;
    if (!words.every((w) => haystack.includes(w))) continue;
    const current = !!currentRoute && entry.route === currentRoute;
    const titleHit = words.some((w) => title.includes(w));
    buckets[(current ? 0 : 2) + (titleHit ? 0 : 1)].push(entry);
  }
  return buckets.flat();
}

/** Whether a search result on another screen can take you there: a real
 * path without params ("/jornadas/$journeyId" needs an id we don't have),
 * or the "shell" virtual screen (ruling R4) — it opens in the panel without
 * any navigation, so it's always safe to offer. "onboarding" stays
 * excluded: it's tied to the wizard overlay, not a screen you can jump to
 * from search. */
export function canOpenRoute(route: string): boolean {
  if (route === "shell") return true;
  return route.startsWith("/") && !route.includes("$");
}

/** What picking a search result does in the panel, given the screen it is
 * showing (`currentRoute`):
 * - "elsewhere": an article entry of another screen — navigate there (or
 *   open the virtual "shell" article) and focus it once loaded;
 * - "section": scroll to that section of the current article;
 * - "article": a screen's own title (no section) — open its article;
 * - "term" / "guide": highlight the glossary term / expand the guide. */
export type SelectionAction =
  | { type: "elsewhere" }
  | { type: "section"; sectionId: string }
  | { type: "article" }
  | { type: "term"; termId: string }
  | { type: "guide"; guideId: string }
  | { type: "none" };

export function selectionAction(entry: SearchEntry, currentRoute: string | null): SelectionAction {
  if (entry.kind === "term") return entry.termId ? { type: "term", termId: entry.termId } : { type: "none" };
  if (entry.kind === "guide") {
    return entry.guideId ? { type: "guide", guideId: entry.guideId } : { type: "none" };
  }
  if (entry.route && entry.route !== currentRoute) return { type: "elsewhere" };
  if (entry.sectionId) return { type: "section", sectionId: entry.sectionId };
  return { type: "article" };
}

/** Whether `role` sees something restricted to `roles` (omitted = everyone). */
export function roleCanSee(roles: HelpRole[] | undefined, role: HelpRole): boolean {
  return !roles || roles.includes(role);
}

function screenEntries(screen: HelpScreen, role: HelpRole): SearchEntry[] {
  const base = { kind: "item" as const, route: screen.route, screenTitle: screen.title };
  const entries: SearchEntry[] = [{ ...base, title: screen.title, text: screen.purpose }];
  for (const section of screen.sections) {
    const items = section.items.filter((item) => roleCanSee(item.roles, role));
    if (items.length === 0 && !section.intro) continue;
    const where = { ...base, sectionId: section.id, ...(section.tab ? { tab: section.tab } : {}) };
    entries.push({ ...where, title: section.title, text: section.intro ?? "" });
    for (const item of items) {
      entries.push({
        ...where,
        title: item.label,
        text: [item.what, item.when, item.notes].filter(Boolean).join(" "),
      });
    }
  }
  for (const state of screen.states) {
    entries.push({
      ...base,
      sectionId: STATES_SECTION_ID,
      title: state.title,
      text: [state.what, state.action].filter(Boolean).join(" "),
    });
  }
  return entries;
}

/** A guide's title, step titles and substeps, as one searchable entry
 * (brief, Task 6). Selecting it expands that guide in the panel — guides
 * with a locked `requiresRole` are still indexed, same as they're still
 * listed (just marked "só admin"). */
function guideEntry(guide: Guide): SearchEntry {
  const text = guide.steps.flatMap((step) => [step.title, ...step.substeps]).join(" ");
  return { kind: "guide", title: guide.title, text, guideId: guide.id };
}

/** Every article the role sees (title/purpose, section titles/intros, the
 * items the role can see, states), every guide, plus every glossary term.
 * Each article is indexed once: duplicates by route, and by `id` (the
 * journey editor is the same article under /jornadas/nova and
 * /jornadas/$journeyId) — the first one wins, so pass the current screen
 * first. */
export function buildSearchIndex(
  screens: HelpScreen[],
  role: HelpRole,
  glossary: GlossaryTerm[],
  guides: Guide[] = [],
): SearchEntry[] {
  const entries: SearchEntry[] = [];
  const seenRoutes = new Set<string>();
  const seenIds = new Set<string>();
  for (const screen of screens) {
    if (seenRoutes.has(screen.route) || seenIds.has(screen.id)) continue;
    if (!screen.roles.includes(role)) continue;
    seenRoutes.add(screen.route);
    seenIds.add(screen.id);
    entries.push(...screenEntries(screen, role));
  }
  for (const guide of guides) {
    entries.push(guideEntry(guide));
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
