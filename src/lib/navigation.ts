import {
  BarChart3,
  Building2,
  FileText,
  Home,
  Mail,
  Megaphone,
  Menu,
  MessageSquare,
  Network,
  Phone,
  PieChart,
  Plug,
  Settings,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  Target,
  TrendingUp,
  Trophy,
  UserCog,
  Users,
  Users2,
  Wallet,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/**
 * Single source for the app shell: sidebar sections, mobile tabs and the
 * breadcrumb/title of every route. Routes left out of the menu on purpose
 * still get a title here: some are reached from inside pages (jornadas,
 * eventos, créditos SMS), others are parked until they are redesigned
 * (Oportunidades, WhatsApp — the last one redirects). Experts is not
 * parked: it is an admin/super-admin-only link under Jogadores. The
 * expert role itself gets a separate, dedicated set of sections/tabs
 * (EXPERT_SECTIONS / EXPERT_MOBILE_TABS) instead of a filtered view of
 * the house shell.
 */

export type ShellRole = "admin" | "gestor" | "member" | "super_admin" | "expert";

export type NavAccess = {
  /** Who sees the item. Defaults to everyone. */
  requires?: "tenant_admin" | "super_admin" | "not_super_admin" | "finance" | "team_profile";
};

export type NavLink = NavAccess & {
  kind: "link";
  title: string;
  to: string;
  hash?: string;
  icon?: LucideIcon;
  /** Other route prefixes that should light this item up. */
  alsoActiveOn?: string[];
};

export type NavGroup = NavAccess & {
  kind: "group";
  title: string;
  icon: LucideIcon;
  children: NavLink[];
};

export type NavEntry = NavLink | NavGroup;
export type NavSection = NavAccess & { label?: string; items: NavEntry[] };

const link = (
  title: string,
  to: string,
  icon?: LucideIcon,
  extra: Partial<Omit<NavLink, "kind" | "title" | "to" | "icon">> = {},
): NavLink => ({ kind: "link", title, to, icon, ...extra });

export const SIDEBAR_SECTIONS: NavSection[] = [
  { items: [link("Início", "/", Home, { alsoActiveOn: ["/eventos"] })] },
  {
    label: "Resultados",
    items: [
      link("Resultados do CRM", "/resultados", Target, { alsoActiveOn: ["/relatorios"] }),
      link("Meu rendimento", "/rendimento", TrendingUp, { requires: "team_profile" }),
      link("Rendimento da equipe", "/rendimento/equipe", Users2, { requires: "tenant_admin" }),
      link("Aquisição e LTV", "/midia-ltv", BarChart3),
      link("Financeiro", "/financeiro", Wallet, { requires: "finance" }),
    ],
  },
  {
    label: "Jogadores",
    items: [
      link("Jogadores", "/players", Users),
      link("Públicos", "/publicos", PieChart),
      link("Níveis e fidelização", "/gamificacao", Trophy, { alsoActiveOn: ["/regras"] }),
      link("Experts", "/experts", UserCog, { requires: "tenant_admin" }),
    ],
  },
  {
    label: "Ações",
    items: [
      link("Campanhas", "/campanhas", Megaphone),
      link("Automações", "/automacoes", Workflow, { alsoActiveOn: ["/jornadas"] }),
    ],
  },
  {
    label: "Canais",
    items: [
      link("SMS", "/sms", MessageSquare),
      link("Email", "/email", Mail),
      link("Voz", "/ligacoes", Phone),
      link("Consentimentos", "/consentimentos", ShieldQuestion),
      {
        kind: "group",
        title: "Templates e áudios",
        icon: FileText,
        children: [
          link("Templates de SMS", "/sms", undefined, { hash: "templates" }),
          link("Templates de email", "/email", undefined, { hash: "templates" }),
          link("Áudios e scripts", "/ligacoes", undefined, { hash: "audios" }),
        ],
      },
    ],
  },
  {
    label: "IA",
    requires: "tenant_admin",
    items: [
      link("Assistente IA", "/inteligencia", Sparkles),
      link("Configurar IA", "/treino-ia", Settings),
    ],
  },
  {
    label: "Configurações",
    items: [
      link("Plano e créditos", "/plano-e-creditos", Wallet),
      // Links curtos (Short.io) and the Meta connection live inside Integrações.
      link("Integrações", "/webhooks", Plug, { alsoActiveOn: ["/links"] }),
      link("Configuração da casa", "/configuracoes/casa", Building2),
      link("Configurações", "/configuracoes", Settings),
    ],
  },
  {
    label: "Administração",
    requires: "super_admin",
    items: [
      link("Visão da plataforma", "/admin", ShieldCheck),
      link("Contas", "/tenants", Building2),
      link("Grupos", "/grupos", Network),
    ],
  },
];

/** The whole shell for an expert: no house sections, just their two pages. */
export const EXPERT_SECTIONS: NavSection[] = [
  {
    label: "Expert",
    items: [
      link("Início", "/expert", Home),
      link("Leads", "/expert/leads", Users),
      link("Rendimento", "/expert/rendimento", TrendingUp),
      link("Modelos", "/expert/modelos", FileText),
    ],
  },
];

/** Lives in the account menu (header avatar). */
export const ACCOUNT_LINKS: NavLink[] = [
  link("Conta e equipe", "/tenants", Building2, { requires: "not_super_admin" }),
];

/** Menu shown instead of SIDEBAR_SECTIONS while on a /grupo* route (Task 7, spec §4/§6). */
export const GROUP_SECTIONS: NavSection[] = [
  { items: [link("Financeiro do grupo", "/grupo", Trophy)] },
  {
    label: "Grupo",
    items: [
      link("Metas", "/grupo/metas", Target),
      link("Pessoas", "/grupo/pessoas", Users),
    ],
  },
  { items: [link("Voltar às casas", "/", Home)] },
];

/** `/grupo` and every `/grupo/...` path (not `/grupos`). */
export function isGroupPath(pathname: string): boolean {
  return pathname === "/grupo" || pathname.startsWith("/grupo/");
}

/**
 * How the header switcher renders. Any group means a menu: the switcher is
 * the only way into /grupo, so a group manager with a single group (and no
 * or one house) must still be able to open it.
 */
export function tenantSwitcherMode(
  tenantCount: number,
  groupCount: number,
): "hidden" | "static" | "menu" {
  if (tenantCount === 0 && groupCount === 0) return "hidden";
  if (groupCount > 0 || tenantCount > 1) return "menu";
  return "static";
}

/** Where "/" sends a user who has groups but no house (the house home is empty for them). */
export function homeRedirect(tenantCount: number, groupCount: number): "/grupo" | null {
  return tenantCount === 0 && groupCount > 0 ? "/grupo" : null;
}

export type MobileTab = { title: string; to?: string; icon: LucideIcon; alsoActiveOn?: string[] };

export const EXPERT_MOBILE_TABS: MobileTab[] = [
  { title: "Início", to: "/expert", icon: Home },
  { title: "Leads", to: "/expert/leads", icon: Users },
  { title: "Rendimento", to: "/expert/rendimento", icon: TrendingUp },
  { title: "Modelos", to: "/expert/modelos", icon: FileText },
];

export const MOBILE_TABS: MobileTab[] = [
  { title: "Início", to: "/", icon: Home },
  {
    title: "Jogadores",
    to: "/players",
    icon: Users,
    alsoActiveOn: ["/publicos", "/alertas", "/gamificacao", "/regras"],
  },
  {
    // Same name as the sidebar section; opens Campanhas, lights on Automações too.
    title: "Ações",
    to: "/campanhas",
    icon: Megaphone,
    alsoActiveOn: ["/automacoes", "/jornadas"],
  },
  {
    title: "Resultados",
    to: "/resultados",
    icon: Target,
    alsoActiveOn: ["/relatorios", "/midia-ltv"],
  },
  { title: "Menu", icon: Menu },
];

export type RouteMeta = { section: string; title: string };

/** Keyed by the route's full path as the router declares it ($params included). */
export const ROUTE_META: Record<string, RouteMeta> = {
  "/": { section: "Visão geral", title: "Início" },
  "/eventos": { section: "Visão geral", title: "Eventos" },
  "/resultados": { section: "Resultados", title: "Resultados do CRM" },
  "/resultados/comparar": { section: "Resultados", title: "Comparar casas" },
  "/relatorios/conversao": { section: "Resultados", title: "Relatório de conversão" },
  "/rendimento": { section: "Resultados", title: "Meu rendimento" },
  "/rendimento/equipe": { section: "Resultados", title: "Rendimento da equipe" },
  "/rendimento/equipe/$expertId": { section: "Resultados", title: "Relatório de rendimento" },
  "/midia-ltv": { section: "Resultados", title: "Aquisição e LTV" },
  "/financeiro": { section: "Resultados", title: "Financeiro" },
  "/players": { section: "Jogadores", title: "Jogadores" },
  "/players/$playerId": { section: "Jogadores", title: "Detalhe do jogador" },
  "/publicos": { section: "Jogadores", title: "Públicos" },
  "/alertas": { section: "Jogadores", title: "Oportunidades" },
  "/gamificacao": { section: "Jogadores", title: "Níveis e fidelização" },
  "/regras": { section: "Jogadores", title: "Regras de níveis" },
  "/campanhas": { section: "Ações", title: "Campanhas" },
  "/campanhas/$campaignId/relatorio": { section: "Campanhas", title: "Relatório da campanha" },
  "/automacoes": { section: "Ações", title: "Automações" },
  "/automacoes/sms": { section: "Automações", title: "Automações de SMS" },
  "/automacoes/email": { section: "Automações", title: "Automações de email" },
  "/automacoes/ligacoes": { section: "Automações", title: "Automações de voz" },
  "/automacoes/whatsapp": { section: "Automações", title: "Automações de WhatsApp" },
  "/jornadas": { section: "Ações", title: "Jornadas" },
  "/jornadas/nova": { section: "Automações", title: "Nova jornada" },
  "/jornadas/$journeyId": { section: "Automações", title: "Editar jornada" },
  "/jornadas/$journeyId/relatorio": { section: "Automações", title: "Relatório da jornada" },
  "/sms": { section: "Canais", title: "SMS" },
  "/sms/templates": { section: "Canais", title: "Templates de SMS" },
  "/creditos-sms": { section: "Configurações", title: "Saldo e consumo" },
  "/plano-e-creditos": { section: "Configurações", title: "Plano e créditos" },
  "/email": { section: "Canais", title: "Email" },
  "/ligacoes": { section: "Canais", title: "Voz" },
  "/whatsapp": { section: "Canais", title: "WhatsApp" },
  "/links": { section: "Integrações", title: "Links curtos" },
  "/links/configuracoes": { section: "Integrações", title: "Links curtos" },
  "/inteligencia": { section: "IA", title: "Assistente IA" },
  "/treino-ia": { section: "IA", title: "Configurar IA" },
  "/experts": { section: "Jogadores", title: "Experts" },
  "/experts/$expertId": { section: "Jogadores", title: "Expert" },
  "/expert": { section: "Expert", title: "Início" },
  // The generated route tree's `FileRoutesByFullPath` keeps the trailing
  // slash for a nested index route ("/expert/" is `expert.index.tsx`'s
  // typed full path); `resolveRouteMeta` never looks this entry up at
  // runtime (it strips the trailing slash first), but the
  // "every route has a title" test walks that interface verbatim.
  "/expert/": { section: "Expert", title: "Início" },
  "/expert/leads": { section: "Expert", title: "Leads" },
  "/expert/leads/$playerId": { section: "Expert", title: "Ficha do lead" },
  "/expert/rendimento": { section: "Expert", title: "Rendimento" },
  "/expert/modelos": { section: "Expert", title: "Modelos de mensagem" },
  "/webhooks": { section: "Configurações", title: "Integrações" },
  "/consentimentos": { section: "Canais", title: "Consentimentos" },
  "/configuracoes/casa": { section: "Configurações", title: "Configuração da casa" },
  "/configuracoes": { section: "Configurações", title: "Configurações" },
  "/tenants": { section: "Conta", title: "Conta e equipe" },
  "/admin": { section: "Administração", title: "Visão da plataforma" },
  "/grupos": { section: "Administração", title: "Grupos" },
  "/mcp": { section: "Configurações", title: "Conectar ao Claude" },
  // Not sidebar entries: the OAuth consent screen and the well-known
  // metadata endpoints the MCP OAuth flow exposes (specs §5). Still declared
  // routes, so the "every route has a title" test needs an entry for each.
  "/mcp/autorizar": { section: "Configurações", title: "Autorizar conexão MCP" },
  "/.well-known/oauth-authorization-server": {
    section: "Configurações",
    title: "Metadados OAuth (servidor de autorização)",
  },
  "/.well-known/oauth-protected-resource": {
    section: "Configurações",
    title: "Metadados OAuth (recurso protegido)",
  },
  "/.well-known/oauth-protected-resource/api/mcp": {
    section: "Configurações",
    title: "Metadados OAuth (recurso protegido do MCP)",
  },
  "/grupo": { section: "Grupo", title: "Financeiro do grupo" },
  "/grupo/casa": { section: "Grupo", title: "Financeiro da casa" },
  "/grupo/metas": { section: "Grupo", title: "Metas do grupo" },
  "/grupo/pessoas": { section: "Grupo", title: "Pessoas do grupo" },
};

const FALLBACK_META: RouteMeta = { section: "BETLEADS", title: "BETLEADS" };

function splitPath(path: string) {
  return path.split("/").filter(Boolean);
}

function patternMatches(pattern: string, pathname: string) {
  const want = splitPath(pattern);
  const got = splitPath(pathname);
  if (want.length !== got.length) return false;
  return want.every((segment, i) => segment.startsWith("$") || segment === got[i]);
}

/** Exact route first; otherwise the closest parent route (e.g. an unknown child tab). */
export function resolveRouteMeta(pathname: string): RouteMeta {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const exact = Object.keys(ROUTE_META).find((pattern) => patternMatches(pattern, clean));
  if (exact) return ROUTE_META[exact];
  const segments = splitPath(clean);
  for (let n = segments.length - 1; n > 0; n -= 1) {
    const parent = `/${segments.slice(0, n).join("/")}`;
    const match = Object.keys(ROUTE_META).find((pattern) => patternMatches(pattern, parent));
    if (match) return ROUTE_META[match];
  }
  return FALLBACK_META;
}

export function isPathUnder(pathname: string, to: string) {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function canSee(
  access: NavAccess,
  role: ShellRole | null,
  isSuperAdmin: boolean,
  canViewFinance = false,
  hasTeamProfile = false,
) {
  if (!access.requires) return true;
  if (access.requires === "super_admin") return isSuperAdmin;
  // The expert never gets house-admin links either, including the ones
  // (like "Conta e equipe") only gated on "not being the super admin".
  if (access.requires === "not_super_admin") return !isSuperAdmin && role !== "expert";
  if (access.requires === "finance") return isSuperAdmin || canViewFinance;
  // "Meu rendimento": visible only when the active house's switcher says the
  // user has a team profile there (a real membership, not the forced
  // super_admin role — see tenants-team-profile-flag.test.ts).
  if (access.requires === "team_profile") return hasTeamProfile;
  return isSuperAdmin || role === "admin";
}

export function visibleSections(
  role: ShellRole | null,
  isSuperAdmin: boolean,
  canViewFinance = false,
  hasTeamProfile = false,
): NavSection[] {
  if (role === "expert") return EXPERT_SECTIONS;
  return SIDEBAR_SECTIONS.filter((section) =>
    canSee(section, role, isSuperAdmin, canViewFinance, hasTeamProfile),
  )
    .map((section) => ({
      ...section,
      items: section.items.filter((item) =>
        canSee(item, role, isSuperAdmin, canViewFinance, hasTeamProfile),
      ),
    }))
    .filter((section) => section.items.length > 0);
}

/**
 * Whether an expert may stay on `pathname` without being bounced to
 * `/expert`: the Expert area itself, plus the account/auth screens that
 * exist outside the house shell. Today those screens (login, password
 * reset, forced password change) are rendered by `AuthGate` before the
 * shell ever mounts and have no entry in `routeTree.gen.ts`, so there is
 * nothing else to allow — this stays a dedicated function so a future
 * account-only route can be added here without touching the redirect.
 */
export function isExpertAllowedPath(pathname: string): boolean {
  return isPathUnder(pathname, "/expert");
}

/**
 * What the shell's main area shows. Until the active house's role is known,
 * a house route renders nothing: otherwise a pure expert landing on it would
 * mount that page (and fire its house server functions) before the redirect
 * to /expert. Expert routes render right away; once the role is known (or
 * its lookup failed, role null), every role behaves as before.
 */
export type ShellContentState = "waiting_role" | "redirect_expert" | "render";

export function shellContentState(
  role: ShellRole | null,
  roleLoading: boolean,
  pathname: string,
): ShellContentState {
  if (isExpertAllowedPath(pathname)) return "render";
  if (roleLoading) return "waiting_role";
  if (role === "expert") return "redirect_expert";
  return "render";
}

export function navLinkKey(item: Pick<NavLink, "to" | "hash">) {
  return item.hash ? `${item.to}#${item.hash}` : item.to;
}

function allLinks(): NavLink[] {
  // The expert's own sections are included so their links light up too
  // ("/expert/leads/$playerId" keeps "Leads" active); their paths never
  // overlap a house link ("/experts" is a different segment). The group
  // menu's links (/grupo*) likewise never overlap a house link.
  return [...SIDEBAR_SECTIONS, ...EXPERT_SECTIONS, ...GROUP_SECTIONS].flatMap((section) =>
    section.items.flatMap((item) => (item.kind === "group" ? item.children : [item])),
  );
}

/**
 * The ONE nav link that is current. The most specific path wins; on the same
 * path, a link whose hash matches beats the plain one (so /email#templates
 * lights "Templates de email" and not "Email" too).
 */
export function activeNavKey(pathname: string, hash: string): string | null {
  const normalizedHash = hash.replace(/^#/, "");
  let best: { key: string; score: number } | null = null;
  for (const item of allLinks()) {
    const prefixes = [item.to, ...(item.alsoActiveOn ?? [])];
    const matched = prefixes.filter((prefix) => isPathUnder(pathname, prefix));
    if (matched.length === 0) continue;
    if (item.hash && item.hash !== normalizedHash) continue;
    const ownPath = isPathUnder(pathname, item.to);
    const length = Math.max(...matched.map((prefix) => prefix.length));
    // Own path beats an alias; then longer prefix; then a matching hash.
    const score = (ownPath ? 10_000 : 0) + length * 10 + (item.hash ? 1 : 0);
    if (!best || score > best.score) best = { key: navLinkKey(item), score };
  }
  return best?.key ?? null;
}

export function activeMobileTab(pathname: string, tabs: MobileTab[] = MOBILE_TABS): string | null {
  // Longest-prefix wins, so e.g. "/expert/leads" lights "Leads" and not
  // "Início" even though "/expert" is also a prefix of it.
  let best: { title: string; length: number } | null = null;
  for (const candidate of tabs) {
    if (!candidate.to) continue;
    const prefixes = [candidate.to, ...(candidate.alsoActiveOn ?? [])];
    const matched = prefixes.filter((prefix) => isPathUnder(pathname, prefix));
    if (matched.length === 0) continue;
    const length = Math.max(...matched.map((prefix) => prefix.length));
    if (!best || length > best.length) best = { title: candidate.title, length };
  }
  return best?.title ?? null;
}
