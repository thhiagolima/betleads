export type ChannelWorkspaceChannel = "sms" | "email" | "voice";
export type ChannelWorkspaceSection =
  "overview" | "create" | "library" | "campaigns" | "history" | "settings";
type Destination = { to: string; hash?: string; search?: Record<string, string> };

export const CHANNEL_WORKSPACE_DESTINATIONS: Record<
  ChannelWorkspaceChannel,
  Record<ChannelWorkspaceSection, Destination>
> = {
  sms: {
    overview: { to: "/sms", hash: "saude" },
    create: { to: "/campanhas", search: { newChannel: "sms" } },
    library: { to: "/sms/templates" },
    campaigns: { to: "/automacoes" },
    history: { to: "/sms", hash: "historico" },
    settings: { to: "/sms", hash: "configuracoes" },
  },
  email: {
    overview: { to: "/email", hash: "dashboard" },
    create: { to: "/campanhas", search: { newChannel: "email" } },
    library: { to: "/email", hash: "templates" },
    campaigns: { to: "/automacoes" },
    history: { to: "/email", hash: "historico" },
    settings: { to: "/email", hash: "configuracoes" },
  },
  voice: {
    overview: { to: "/ligacoes", hash: "dashboard" },
    create: { to: "/campanhas", search: { newChannel: "voice" } },
    library: { to: "/ligacoes", hash: "audios" },
    campaigns: { to: "/ligacoes", hash: "fluxos" },
    history: { to: "/ligacoes", hash: "historico" },
    settings: { to: "/ligacoes", hash: "configuracoes" },
  },
};

export function resolveChannelWorkspaceSection(
  channel: ChannelWorkspaceChannel,
  pathname: string,
  hash: string,
): ChannelWorkspaceSection {
  if (channel === "sms") {
    if (pathname === "/sms/templates") return "library";
    if (pathname === "/automacoes" || pathname.startsWith("/jornadas/")) return "campaigns";
    if (hash === "historico") return "history";
    if (hash === "configuracoes") return "settings";
    return "overview";
  }
  if (channel === "email") {
    if (pathname === "/automacoes" || pathname.startsWith("/jornadas/")) return "campaigns";
    if (hash === "templates") return "library";
    if (hash === "historico") return "history";
    if (hash === "configuracoes" || hash === "remetentes" || hash === "smtp") return "settings";
    return "overview";
  }
  if (hash === "massa") return "create";
  if (hash === "audios" || hash === "scripts") return "library";
  if (hash === "fluxos") return "campaigns";
  if (hash === "historico") return "history";
  if (hash === "configuracoes") return "settings";
  return "overview";
}
