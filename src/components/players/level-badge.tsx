import { IdentityBadge } from "@/components/identity/identity-badge";
import { LEVEL_IDENTITY } from "@/components/identity/identity";
import { LEVEL_LABEL, type LevelSlug } from "@/lib/player-level";

/** Level of a player: icon + name in the level's colour, thin border ("Ouro", "Black VIP"…). */
export function LevelBadge({ level, className }: { level: LevelSlug; className?: string }) {
  return (
    <IdentityBadge tone={LEVEL_IDENTITY[level]} label={LEVEL_LABEL[level]} className={className} />
  );
}
