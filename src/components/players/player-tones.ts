import type { LevelSlug } from "@/lib/player-level";
import type { PlayerSituation } from "@/lib/player-situation";
import { LEVEL_IDENTITY } from "@/components/identity/identity";

/**
 * The one level palette (C-32), now from the identity colours: Jogadores, the
 * ficha, Níveis and Públicos all read it. `text` colours the label, `border`
 * outlines the badge and `dot` fills a marker.
 */
export const LEVEL_TONE: Record<LevelSlug, { text: string; border: string; dot: string }> =
  LEVEL_IDENTITY;

export const SITUATION_TONE: Record<PlayerSituation, string> = {
  active: "text-success",
  cooling: "text-warning",
  sleeping: "text-danger",
  no_deposit: "text-muted-foreground",
};
