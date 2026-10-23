import {
  BarChart3,
  Building2,
  FileText,
  Home,
  Mail,
  Megaphone,
  Menu,
  MessageSquare,
  Phone,
  PieChart,
  Plug,
  Settings,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  Target,
  Trophy,
  UserCog,
  Users,
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
  requires?: "tenant_admin" | "super_admin" | "not_super_admin";
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
      link("Aquisição e LTV", "/midia-ltv", BarChart3),
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
    ],
  },
];

/** The whole shell for an expert: no house sections, just their two pages. */
export const EXPERT_SECTIONS: NavSection[] = [
  {
    label: "Expert",
    items: [link("Início", "/expert", Home), link("Leads", "/expert/leads", Users)],
  },
];

/** Lives in the account menu (header avatar). */
export const ACCOUNT_LINKS: NavLink[] = [
  link("Conta e equipe", "/tenants", Building2, { requires: "not_super_admin" }),
];

export type MobileTab = { title: string; to?: string; icon: LucideIcon; alsoActiveOn?: string[] };

export const EXPERT_MOBILE_TABS: MobileTab[] = [
  { title: "Início", to: "/expert", icon: Home },
  { title: "Leads", to: "/expert/leads", icon: Users },
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
  "/midia-ltv": { section: "Resultados", title: "Aquisição e LTV" },
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
  "/expert": { section: "Expert", title: "Início" },
  "/expert/leads": { section: "Expert", title: "Leads" },
  "/webhooks": { section: "Configurações", title: "Integrações" },
  "/consentimentos": { section: "Canais", title: "Consentimentos" },
  "/configuracoes/casa": { section: "Configurações", title: "Configuração da casa" },
  "/configuracoes": { section: "Configurações", title: "Configurações" },
  "/tenants": { section: "Conta", title: "Conta e equipe" },
  "/admin": { section: "Administração", title: "Visão da plataforma" },
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

export function canSee(access: NavAccess, role: ShellRole | null, isSuperAdmin: boolean) {
  if (!access.requires) return true;
  if (access.requires === "super_admin") return isSuperAdmin;
  // The expert never gets house-admin links either, including the ones
  // (like "Conta e equipe") only gated on "not being the super admin".
  if (access.requires === "not_super_admin") return !isSuperAdmin && role !== "expert";
  return isSuperAdmin || role === "admin";
}

export function visibleSections(role: ShellRole | null, isSuperAdmin: boolean): NavSection[] {
  if (role === "expert") return EXPERT_SECTIONS;
  return SIDEBAR_SECTIONS.filter((section) => canSee(section, role, isSuperAdmin))
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => canSee(item, role, isSuperAdmin)),
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

export function navLinkKey(item: Pick<NavLink, "to" | "hash">) {
  return item.hash ? `${item.to}#${item.hash}` : item.to;
}

function allLinks(): NavLink[] {
  return SIDEBAR_SECTIONS.flatMap((section) =>
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
