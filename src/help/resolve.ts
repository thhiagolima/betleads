import { patternMatches } from "@/lib/navigation";
import { HELP_SCREEN_LOADERS } from "./registry";

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
