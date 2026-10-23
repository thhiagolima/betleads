import type { LevelSlug } from "@/lib/player-level";
import type { PlayerSituation } from "@/lib/player-situation";

/**
 * The one level palette (C-32). Every screen that shows a player's level uses
 * these tones: Jogadores, the ficha and, later, Níveis and Públicos.
 * `text` colors the label, `border` outlines the badge and `dot` fills a marker.
 */
export const LEVEL_TONE: Record<LevelSlug, { text: string; border: string; dot: string }> = {
  novice: { text: "text-muted-foreground", border: "border-border", dot: "bg-muted-foreground" },
  bronze: { text: "text-orange-300", border: "border-orange-400/35", dot: "bg-orange-400" },
  silver: { text: "text-slate-200", border: "border-slate-300/35", dot: "bg-slate-300" },
  gold: { text: "text-amber-300", border: "border-amber-400/40", dot: "bg-amber-400" },
  diamond: { text: "text-cyan-300", border: "border-cyan-400/40", dot: "bg-cyan-400" },
  black: { text: "text-violet-300", border: "border-violet-400/40", dot: "bg-violet-400" },
};

export const SITUATION_TONE: Record<PlayerSituation, string> = {
  active: "text-success",
  cooling: "text-warning",
  sleeping: "text-danger",
  no_deposit: "text-muted-foreground",
};
