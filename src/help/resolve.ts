import { patternMatches } from "@/lib/navigation";
import { HELP_SCREEN_LOADERS } from "./registry";
import type { HelpScreen } from "./types";

/**
 * Which help article (if any) covers `pathname`, and which tab within it
 * (the hash, without "#", or null when there is none). Matches against
 * `HELP_SCREEN_LOADERS`' keys the same way `resolveRouteMeta` matches
 * `ROUTE_META` (same `patternMatches`), so a screen route and its help
 * article key are always the same pattern.
 *
 * `VIRTUAL_SCREENS` ids (onboarding, shell) never match here — they don't
 * start with "/" so `patternMatches` can't match them against a pathname.
 * The panel loads those articles directly instead.
 */
export function resolveHelpScreen(
  pathname: string,
  hash: string,
): { route: string; tab: string | null } | null {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const route = Object.keys(HELP_SCREEN_LOADERS).find((pattern) => patternMatches(pattern, clean));
  if (!route) return null;
  const tab = hash.replace(/^#/, "") || null;
  return { route, tab };
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
