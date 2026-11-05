// Route classification for -coverage.test.ts rule 1 (spec §6): every key of
// `ROUTE_META` (src/lib/navigation.ts) must have an article
// (HELP_SCREEN_LOADERS), be excluded, or be pending. Re-inventoried against
// ROUTE_META on 2026-11-05 (fece91b); when a new route is added, classify it
// here or the coverage test fails.

/**
 * Screens that never get a help article: super admin, redirect-only
 * routes (confirmed by reading each route file's `beforeLoad`/component —
 * an unconditional `redirect`/`<Navigate>`), non-UI endpoints (the MCP
 * OAuth `.well-known` metadata), and the explicit list from the spec
 * (`/whatsapp`, `/alertas`, `/mcp/autorizar`).
 *
 * Every entry here must be an actual `ROUTE_META` key (enforced by
 * -coverage.test.ts) — `/u/$token`, the public unsubscribe page the spec
 * also names (§5), isn't one yet (no `ROUTE_META` entry exists for it, even
 * though the route file does), so it's deliberately left out until that
 * entry is added; see the task 2 report for the open finding.
 */
export const EXCLUDED_ROUTES: string[] = [
  // Super admin.
  "/admin",
  "/grupos",
  // Explicit exclusions (spec §6 / constraints.md).
  "/whatsapp",
  "/alertas",
  "/mcp/autorizar",
  // Redirect-only (unconditional `redirect`/`<Navigate>` in the route file,
  // nothing else rendered).
  "/relatorios/conversao", // -> /resultados
  "/sms/templates", // -> /sms#templates
  "/creditos-sms", // -> /plano-e-creditos
  "/automacoes/sms", // -> /automacoes
  "/automacoes/email", // -> /automacoes
  "/automacoes/ligacoes", // -> /automacoes
  "/automacoes/whatsapp", // -> /automacoes
  "/jornadas", // -> /automacoes (its children, /jornadas/nova etc., are real screens)
  "/links", // -> /webhooks#links
  "/links/configuracoes", // -> /webhooks#links
  "/experts/$expertId", // -> /rendimento/equipe/$expertId
  // Non-UI: MCP OAuth metadata endpoints, not screens.
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/api/mcp",
];

/**
 * Screens that need an article but don't have one yet, grouped by the phase
 * that will add it (spec §5 "Telas por fase"). An entry can also be
 * `"/rota#aba"`: the route already has an article (a loader exists for it),
 * but that one tab's section/tour is still missing.
 *
 * Right now (Task 2) `HELP_SCREEN_LOADERS` is empty, so this also holds
 * every phase-1 route — Tasks 9-15 remove each one as its article ships.
 */
export const PENDING_ROUTES: string[] = [
  // --- Fase 1 (shell/onboarding infra ships in Task 2; these 9 screens'
  // articles ship in Tasks 9-15) ---
  "/campanhas",
  "/campanhas/$campaignId/relatorio",
  "/automacoes",
  "/jornadas/nova",
  "/jornadas/$journeyId",
  "/jornadas/$journeyId/relatorio",
  "/webhooks",

  // --- Fase 2 ---
  "/",
  "/eventos",
  "/players",
  "/players/$playerId",
  "/publicos",
  "/gamificacao",
  "/regras",
  "/sms",
  "/plano-e-creditos",
  "/ligacoes",
  "/consentimentos",
  "/configuracoes",
  "/tenants",

  // --- Fase 3 ---
  "/resultados",
  "/resultados/comparar",
  "/rendimento",
  "/rendimento/equipe",
  "/rendimento/equipe/$expertId",
  "/midia-ltv",
  "/financeiro",
  "/inteligencia",
  "/treino-ia",
  "/experts",
  "/mcp",

  // --- Fase 4 ---
  "/expert",
  "/expert/",
  "/expert/leads",
  "/expert/leads/$playerId",
  "/expert/rendimento",
  "/expert/modelos",
  "/grupo",
  "/grupo/casa",
  "/grupo/metas",
  "/grupo/pessoas",
];

/**
 * Articles with no route of their own in `ROUTE_META` — the panel loads
 * them directly instead of through `resolveHelpScreen` (spec §4.6, §5).
 */
export const VIRTUAL_SCREENS = ["onboarding", "shell"] as const;

/**
 * Anchors (ids passed to the `tourAnchor` helper) that exist in the code but aren't cited
 * by any article yet — Task 7 populates articles for the touched screens
 * and shrinks this list. Starts empty.
 */
export const ANCHORS_PENDING_ARTICLE: string[] = [
  // The header "?" (HelpButton, Task 4); the shell article ships later.
  "shell.header.help",
];
