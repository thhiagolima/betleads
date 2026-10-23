import { SITUATION_LABEL, type PlayerSituation } from "@/lib/player-situation";
import { cn } from "@/lib/utils";

import { SITUATION_TONE } from "./player-tones";

/** Situation of a player in its tone ("Ativo", "Esfriando"…). Same label on every screen. */
export function SituationText({
  situation,
  className,
}: {
  situation: PlayerSituation;
  className?: string;
}) {
  return (
    <span className={cn("font-medium", SITUATION_TONE[situation], className)}>
      {SITUATION_LABEL[situation]}
    </span>
  );
}
