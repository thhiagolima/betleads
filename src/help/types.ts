// Content model for the in-app tutorial (guided tour + help panel). Plain
// typed TypeScript objects, not MDX, so the coverage test (-coverage.test.ts)
// can walk the data directly. See docs/superpowers/specs/2026-11-05-tutorial-crm-design.md §4.1.

export type HelpRole = "admin" | "gestor" | "member" | "expert";

export type HelpItem = {
  /** The element's `data-tour` value, set via `tourAnchor(...)` (anchor.ts).
   * Absent for items that describe something with no single element to
   * highlight (e.g. a group of read-only numbers). */
  anchor?: string;
  /** The exact label/text as it appears on the screen. */
  label: string;
  /** What it does. */
  what: string;
  /** When to use it. */
  when?: string;
  /** Care points, common mistakes, what happens next. */
  notes?: string;
  /** Only present/relevant for these roles. Omitted means everyone who sees
   * the screen sees the item. */
  roles?: HelpRole[];
};

export type HelpSection = {
  id: string;
  title: string;
  /** The tab (PageTabs hash, without "#") this section belongs to, when the
   * screen has tabs. Omitted for screens without tabs. */
  tab?: string;
  intro?: string;
  items: HelpItem[];
};

export type HelpState = {
  id: string;
  title: string;
  /** What the state means. */
  what: string;
  /** What to do about it. */
  action?: string;
};

export type TourStep = {
  anchor: string;
  title: string;
  body: string;
  /** The `HelpSection.id` this step relates to, so the panel's "Nesta tela"
   * can scroll to it. */
  articleSection?: string;
};

export type HelpScreen = {
  id: string;
  /** The route pattern, exactly as declared in `ROUTE_META`
   * (src/lib/navigation.ts), or a `VIRTUAL_SCREENS` id for a screen with no
   * route (onboarding, shell). */
  route: string;
  title: string;
  purpose: string;
  /** Who sees the screen. */
  roles: HelpRole[];
  sections: HelpSection[];
  states: HelpState[];
  /** Keyed by "default", or by the tab (hash, without "#") for screens with
   * tabs — one tour per tab. */
  tours: Record<string, TourStep[]>;
  /** The tab the screen opens on when the URL has no hash (the route's own
   * fallback, e.g. "casa" for /configuracoes/casa). Required when every tour
   * is tab-keyed (no "default"), or the landing URL would find no tour —
   * enforced by -coverage.test.ts. Resolved by `effectiveTab` (resolve.ts). */
  defaultTab?: string;
  /** The route whose tour progress this screen shares, when one article is
   * registered under two routes (the journey editor: /jornadas/$journeyId
   * shares "/jornadas/nova"'s, so saving a new journey — which navigates to
   * its id — doesn't auto-start the same tour again). Omitted: `route`.
   * Resolved by `screenTourKey` (tour-logic.ts). */
  tourRoute?: string;
  /** Glossary term ids (glossary.ts) used by this screen, beyond any
   * `<Term id>` already found in its own component source. */
  terms?: string[];
};

export type GlossaryTerm = {
  id: string;
  term: string;
  short: string;
  long?: string;
};
