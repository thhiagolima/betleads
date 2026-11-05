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
export const HELP_SCREEN_LOADERS: Record<string, () => Promise<{ default: HelpScreen }>> = {};
