import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Crown,
  Dice5,
  Gem,
  Gift,
  LogIn,
  LogOut,
  Mail,
  Medal,
  MessageCircle,
  MessageSquare,
  Phone,
  Shield,
  Sprout,
  Trophy,
  UserPlus,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import type { LevelSlug } from "@/lib/player-level";

/**
 * Identity colours: one colour + one icon per KIND of thing (level, channel,
 * event, audience filter group), the same on every screen and for every house.
 * Status (ativo/esfriando, sucesso/erro) keeps the success/warning/danger tokens.
 *
 * `text` colours icon + label, `border` outlines the badge, `dot` fills a marker,
 * `soft` is a faint fill for big icon tiles. The app is dark-only.
 */
export type IdentityTone = {
  icon: LucideIcon;
  text: string;
  border: string;
  dot: string;
  soft: string;
};

export const LEVEL_IDENTITY: Record<LevelSlug, IdentityTone> = {
  novice: {
    icon: Sprout,
    text: "text-emerald-300",
    border: "border-emerald-400/40",
    dot: "bg-emerald-400",
    soft: "bg-emerald-500/15",
  },
  bronze: {
    icon: Shield,
    text: "text-orange-300",
    border: "border-orange-400/40",
    dot: "bg-orange-400",
    soft: "bg-orange-500/15",
  },
  silver: {
    icon: Medal,
    text: "text-slate-200",
    border: "border-slate-300/35",
    dot: "bg-slate-300",
    soft: "bg-slate-300/10",
  },
  gold: {
    icon: Trophy,
    text: "text-amber-300",
    border: "border-amber-400/40",
    dot: "bg-amber-400",
    soft: "bg-amber-500/15",
  },
  diamond: {
    icon: Gem,
    text: "text-cyan-300",
    border: "border-cyan-400/40",
    dot: "bg-cyan-400",
    soft: "bg-cyan-500/15",
  },
  black: {
    icon: Crown,
    text: "text-violet-300",
    border: "border-violet-400/40",
    dot: "bg-violet-400",
    soft: "bg-violet-500/15",
  },
};

export type ChannelKind = "sms" | "email" | "voice" | "whatsapp";

export const CHANNEL_LABEL: Record<ChannelKind, string> = {
  sms: "SMS",
  email: "E-mail",
  voice: "Voz",
  whatsapp: "WhatsApp",
};

// E-mail is pink because violet already means Black VIP and bonus.
export const CHANNEL_IDENTITY: Record<ChannelKind, IdentityTone> = {
  sms: {
    icon: MessageSquare,
    text: "text-sky-300",
    border: "border-sky-400/40",
    dot: "bg-sky-400",
    soft: "bg-sky-500/15",
  },
  email: {
    icon: Mail,
    text: "text-pink-300",
    border: "border-pink-400/40",
    dot: "bg-pink-400",
    soft: "bg-pink-500/15",
  },
  voice: {
    icon: Phone,
    text: "text-teal-300",
    border: "border-teal-400/40",
    dot: "bg-teal-400",
    soft: "bg-teal-500/15",
  },
  whatsapp: {
    icon: MessageCircle,
    text: "text-green-300",
    border: "border-green-400/40",
    dot: "bg-green-400",
    soft: "bg-green-500/15",
  },
};

/** Channel keys used around the app ("call"/"ligacao" are voice). */
export function channelKind(channel: string | null | undefined): ChannelKind | null {
  const value = (channel ?? "").trim().toLowerCase();
  if (value === "sms") return "sms";
  if (value === "email" || value === "e-mail") return "email";
  if (["voice", "voz", "call", "calls", "ligacao", "ligacoes", "ligação"].includes(value))
    return "voice";
  if (value === "whatsapp") return "whatsapp";
  return null;
}

export type EventKind =
  "signup" | "login" | "logout" | "deposit" | "withdrawal" | "bet" | "bonus" | "failed" | "other";

// Deposit, withdrawal, signup and bonus share the colours of the audience
// filter groups, so the same thing has the same colour in the whole CRM.
export const EVENT_IDENTITY: Record<EventKind, IdentityTone> = {
  signup: {
    icon: UserPlus,
    text: "text-sky-300",
    border: "border-sky-400/40",
    dot: "bg-sky-400",
    soft: "bg-sky-500/15",
  },
  login: {
    icon: LogIn,
    text: "text-slate-400",
    border: "border-slate-500/40",
    dot: "bg-slate-400",
    soft: "bg-slate-500/15",
  },
  logout: {
    icon: LogOut,
    text: "text-slate-400",
    border: "border-slate-500/40",
    dot: "bg-slate-400",
    soft: "bg-slate-500/15",
  },
  deposit: {
    icon: ArrowDownToLine,
    text: "text-emerald-300",
    border: "border-emerald-400/40",
    dot: "bg-emerald-400",
    soft: "bg-emerald-500/15",
  },
  withdrawal: {
    icon: ArrowUpFromLine,
    text: "text-blue-300",
    border: "border-blue-400/40",
    dot: "bg-blue-400",
    soft: "bg-blue-500/15",
  },
  bet: {
    icon: Dice5,
    text: "text-indigo-300",
    border: "border-indigo-400/40",
    dot: "bg-indigo-400",
    soft: "bg-indigo-500/15",
  },
  bonus: {
    icon: Gift,
    text: "text-violet-300",
    border: "border-violet-400/40",
    dot: "bg-violet-400",
    soft: "bg-violet-500/15",
  },
  failed: {
    icon: XCircle,
    text: "text-red-300",
    border: "border-red-400/45",
    dot: "bg-red-400",
    soft: "bg-red-500/15",
  },
  other: {
    icon: Dice5,
    text: "text-muted-foreground",
    border: "border-border",
    dot: "bg-muted-foreground",
    soft: "bg-secondary",
  },
};

/** Audience filter groups (Públicos). Inactivity is a scale: darker = longer stopped. */
export const FILTER_GROUP_DOT = {
  deposit: "bg-emerald-400",
  signup: "bg-sky-400",
  pending: "bg-amber-400",
  withdrawal: "bg-blue-400",
  bonus: "bg-violet-400",
  inactivity: "bg-rose-400",
} as const;
export type FilterGroup = keyof typeof FILTER_GROUP_DOT;

export const INACTIVITY_DOT = {
  cooling: "bg-rose-200",
  sleeping: "bg-rose-400",
  inactive30: "bg-rose-600",
  inactive90: "bg-red-800 ring-2 ring-red-500/40",
} as const;
