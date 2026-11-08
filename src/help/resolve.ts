import { patternMatches } from "@/lib/navigation";
import { HELP_SCREEN_LOADERS, HELP_TAB_SEARCH_PARAMS } from "./registry";
import type { HelpScreen } from "./types";

/**
 * Which help article (if any) covers `pathname`, and which tab within it
 * (null when there is none). The tab comes from the hash (without "#"), or,
 * for a screen that keeps its tabs in a query param (`HelpScreen.
 * tabSearchParam`, mirrored in `HELP_TAB_SEARCH_PARAMS`), from that param of
 * `search` (the raw query string, with or without "?") — the hash is then
 * ignored. Matches against `HELP_SCREEN_LOADERS`' keys the same way
 * `resolveRouteMeta` matches `ROUTE_META` (same `patternMatches`), so a
 * screen route and its help article key are always the same pattern.
 *
 * `VIRTUAL_SCREENS` ids (onboarding, shell) never match here — they don't
 * start with "/" so `patternMatches` can't match them against a pathname.
 * The panel loads those articles directly instead.
 */
export function resolveHelpScreen(
  pathname: string,
  hash: string,
  search = "",
): { route: string; tab: string | null } | null {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const route = Object.keys(HELP_SCREEN_LOADERS).find((pattern) => patternMatches(pattern, clean));
  if (!route) return null;
  const param = HELP_TAB_SEARCH_PARAMS[route];
  const tab = param
    ? new URLSearchParams(search.replace(/^\?/, "")).get(param) || null
    : hash.replace(/^#/, "") || null;
  return { route, tab };
}

/** Where a help target (`route` + raw `tab`) lives in the URL: the tab as
 * `?<param>=<tab>` for a screen with a `tabSearchParam`
 * (`HELP_TAB_SEARCH_PARAMS`), else as `#<tab>`. `href` is what to navigate
 * to; `search`/`hash` round-trip through `resolveHelpScreen`. */
export function helpTabLocation(
  route: string,
  tab: string | null | undefined,
): { href: string; search: string; hash: string } {
  if (!tab) return { href: route, search: "", hash: "" };
  const param = HELP_TAB_SEARCH_PARAMS[route];
  if (param) {
    const search = `?${new URLSearchParams({ [param]: tab }).toString()}`;
    return { href: `${route}${search}`, search, hash: "" };
  }
  return { href: `${route}#${tab}`, search: "", hash: `#${tab}` };
}

/** The tab actually showing: the URL's (`tab`), else the screen's
 * `defaultTab` (what the route itself shows without a hash), else null. Use
 * it wherever the current tab picks something — the tour (`tourFor`), its
 * progress key, the panel's scroll-to-tab section — so the landing URL
 * (/configuracoes/casa) and its explicit hash (#casa) behave the same. */
export function effectiveTab(screen: HelpScreen, tab: string | null): string | null {
  return tab ?? screen.defaultTab ?? null;
}

/** The first article section of the tab actually showing, for the panel to
 * scroll to when it opens the article; null for a screen without tabs (or a
 * tab with no section of its own). */
export function tabSectionId(screen: HelpScreen, tab: string | null): string | null {
  const current = effectiveTab(screen, tab);
  if (!current) return null;
  return screen.sections.find((section) => section.tab === current)?.id ?? null;
}
