import { LEVEL_LABEL, type LevelSlug } from "@/lib/player-level";
import { cn } from "@/lib/utils";

import { LEVEL_TONE } from "./player-tones";

/** Level of a player as a small outlined badge ("Ouro", "Black VIP"…). Inline (span). */
export function LevelBadge({ level, className }: { level: LevelSlug; className?: string }) {
  const tone = LEVEL_TONE[level];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-meta font-medium",
        tone.border,
        tone.text,
        className,
      )}
    >
      {LEVEL_LABEL[level]}
    </span>
  );
}
