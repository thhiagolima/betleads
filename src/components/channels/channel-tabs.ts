/**
 * Tabs of the three channel pages (SMS, Email, Voz) and how an URL hash maps
 * to them. Old hashes keep working: they open the tab that replaced them, or
 * send the user to the page that now owns that content.
 */

export type ChannelId = "sms" | "email" | "voz";

export type ChannelTabItem = { value: string; label: string };

export const CHANNEL_TABS = {
  sms: [
    { value: "visao-geral", label: "Visão geral" },
    { value: "templates", label: "Templates" },
    { value: "historico", label: "Histórico" },
  ],
  email: [
    { value: "visao-geral", label: "Visão geral" },
    { value: "templates", label: "Templates" },
    { value: "historico", label: "Histórico" },
  ],
  voz: [
    { value: "visao-geral", label: "Visão geral" },
    { value: "massa", label: "Envio em massa" },
    { value: "audios", label: "Áudios e roteiros" },
    { value: "historico", label: "Histórico" },
  ],
} as const satisfies Record<ChannelId, readonly ChannelTabItem[]>;

export type ChannelTab<C extends ChannelId> = (typeof CHANNEL_TABS)[C][number]["value"];

/** Where an old hash now lives outside the channel page. */
export type ChannelRedirect = {
  to: "/campanhas" | "/automacoes";
  search?: Record<string, string>;
};

const TAB_ALIASES: Record<ChannelId, Record<string, string>> = {
  sms: {
    saude: "visao-geral",
    dashboard: "visao-geral",
    massa: "visao-geral",
    enviar: "visao-geral",
    configuracoes: "visao-geral",
  },
  email: {
    dashboard: "visao-geral",
    remetentes: "visao-geral",
    smtp: "visao-geral",
    configuracoes: "visao-geral",
  },
  voz: {
    dashboard: "visao-geral",
    scripts: "audios",
    roteiros: "audios",
    fila: "historico",
  },
};

const REDIRECTS: Record<ChannelId, Record<string, ChannelRedirect>> = {
  sms: {
    campanhas: { to: "/campanhas" },
    fila: { to: "/campanhas" },
  },
  email: {
    campanhas: { to: "/campanhas", search: { newChannel: "email" } },
    automacoes: { to: "/automacoes" },
  },
  voz: {
    // Fluxos de voz agora ficam em Automações.
    fluxos: { to: "/automacoes" },
  },
};

export type ChannelHashResolution =
  | {
      kind: "tab";
      tab: string;
      /** False when the hash is an old alias that should be rewritten to `tab`. */
      canonical: boolean;
    }
  | { kind: "redirect"; redirect: ChannelRedirect };

export function resolveChannelHash(channel: ChannelId, rawHash: string): ChannelHashResolution {
  const hash = rawHash.replace(/^#/, "").trim().toLowerCase();
  const redirect = REDIRECTS[channel][hash];
  if (redirect) return { kind: "redirect", redirect };
  const tabs = CHANNEL_TABS[channel] as readonly ChannelTabItem[];
  if (tabs.some((tab) => tab.value === hash)) return { kind: "tab", tab: hash, canonical: true };
  const alias = TAB_ALIASES[channel][hash];
  if (alias) return { kind: "tab", tab: alias, canonical: false };
  // Empty or unknown hash: the overview, without touching the URL.
  return { kind: "tab", tab: tabs[0].value, canonical: true };
}
