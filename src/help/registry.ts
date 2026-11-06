import type { HelpScreen } from "./types";

/**
 * One lazy loader per help article, keyed by route (the exact `ROUTE_META`
 * pattern it documents) or by a `VIRTUAL_SCREENS` id for a screen with no
 * route of its own (onboarding, shell — coverage-config.ts). Loaded on
 * demand (`import()`) so the help content never enters the initial bundle
 * (spec §8 "Bundle").
 *
 * Starts empty: Tasks 9-15 register one entry per phase-1 screen here and
 * remove the matching route from `PENDING_ROUTES` (coverage-config.ts) as
 * each article ships.
 */
export const HELP_SCREEN_LOADERS: Record<string, () => Promise<{ default: HelpScreen }>> = {
  "/configuracoes/casa": () => import("./screens/configuracoes-casa"),
  "/email": () => import("./screens/email"),
  "/campanhas": () => import("./screens/campanhas"),
  "/campanhas/$campaignId/relatorio": () => import("./screens/campanha-relatorio"),
  "/automacoes": () => import("./screens/automacoes"),
  "/jornadas/nova": () => import("./screens/jornada-editor"),
  "/jornadas/$journeyId": () =>
    import("./screens/jornada-editor").then((mod) => ({ default: mod.editScreen })),
  "/jornadas/$journeyId/relatorio": () => import("./screens/jornada-relatorio"),
  "/webhooks": () => import("./screens/webhooks"),
  onboarding: () => import("./screens/onboarding"),
  shell: () => import("./screens/shell"),
};

let allScreens: Promise<HelpScreen[]> | null = null;

/** Loads every registered article once (cached), for the panel's search
 * across all screens (spec §4.4). An article that fails to load is left
 * out; a later call retries nothing (the cache keeps what loaded). */
export function loadAllHelpScreens(): Promise<HelpScreen[]> {
  allScreens ??= Promise.all(
    Object.values(HELP_SCREEN_LOADERS).map((load) =>
      load().then(
        (mod) => mod.default,
        () => null,
      ),
    ),
  ).then((screens) => screens.filter((s): s is HelpScreen => s !== null));
  return allScreens;
}
