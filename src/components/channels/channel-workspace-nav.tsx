/* eslint-disable react-refresh/only-export-components */
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  BarChart3,
  History,
  Library,
  Mail,
  MessageSquare,
  Phone,
  PlusCircle,
  Settings,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ChannelWorkspaceChannel = "sms" | "email" | "voice";
export type ChannelWorkspaceSection =
  "overview" | "create" | "library" | "campaigns" | "history" | "settings";
type Destination = { to: string; hash?: string; search?: Record<string, string> };

const channels: Array<{
  id: ChannelWorkspaceChannel;
  label: string;
  icon: LucideIcon;
  to: string;
}> = [
  { id: "sms", label: "SMS", icon: MessageSquare, to: "/sms" },
  { id: "email", label: "E-mail", icon: Mail, to: "/email" },
  { id: "voice", label: "Voz", icon: Phone, to: "/ligacoes" },
];

const sectionMeta: Array<{ id: ChannelWorkspaceSection; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "Visão geral", icon: BarChart3 },
  { id: "create", label: "Criar", icon: PlusCircle },
  { id: "library", label: "Biblioteca", icon: Library },
  { id: "campaigns", label: "Campanhas / Fluxos", icon: Workflow },
  { id: "history", label: "Histórico", icon: History },
  { id: "settings", label: "Configurações", icon: Settings },
];

export const CHANNEL_WORKSPACE_DESTINATIONS: Record<
  ChannelWorkspaceChannel,
  Record<ChannelWorkspaceSection, Destination>
> = {
  sms: {
    overview: { to: "/sms", hash: "saude" },
    create: { to: "/campanhas", search: { newChannel: "sms" } },
    library: { to: "/sms/templates" },
    campaigns: { to: "/jornadas" },
    history: { to: "/sms", hash: "historico" },
    settings: { to: "/sms", hash: "configuracoes" },
  },
  email: {
    overview: { to: "/email", hash: "dashboard" },
    create: { to: "/campanhas", search: { newChannel: "email" } },
    library: { to: "/email", hash: "templates" },
    campaigns: { to: "/jornadas" },
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
    if (pathname === "/jornadas") return "campaigns";
    if (hash === "historico") return "history";
    if (hash === "configuracoes") return "settings";
    return "overview";
  }
  if (channel === "email") {
    if (pathname === "/jornadas") return "campaigns";
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

export function ChannelWorkspaceNav({ channel }: { channel: ChannelWorkspaceChannel }) {
  const navigate = useNavigate();
  const { pathname, hash } = useLocation({ select: (location) => location });
  const current = resolveChannelWorkspaceSection(channel, pathname, hash);

  function go(destination: Destination) {
    void navigate({
      to: destination.to as never,
      hash: destination.hash,
      search: destination.search as never,
    });
  }

  return (
    <div className="space-y-2" aria-label="Navegação do canal">
      <div className="flex flex-wrap gap-1 rounded-xl border border-border/70 bg-card/50 p-1.5">
        {channels.map((item) => (
          <Button
            key={item.id}
            type="button"
            size="sm"
            variant={item.id === channel ? "secondary" : "ghost"}
            className="h-8 gap-1.5"
            onClick={() => void navigate({ to: item.to as never })}
          >
            <item.icon className="size-3.5" />
            {item.label}
          </Button>
        ))}
      </div>
      <nav className="overflow-x-auto rounded-xl border border-border/70 bg-card/30 p-1.5">
        <div className="flex min-w-max gap-1">
          {sectionMeta.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={current === item.id ? "page" : undefined}
              onClick={() => go(CHANNEL_WORKSPACE_DESTINATIONS[channel][item.id])}
              className={cn(
                "flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors",
                current === item.id
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <item.icon className="size-3.5" />
              {item.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
