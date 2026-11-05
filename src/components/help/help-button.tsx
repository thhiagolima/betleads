import { CircleHelp } from "lucide-react";

import { tourAnchor } from "@/help/anchor";
import { useHelp } from "./help-provider";

/** The header's "?" (brief, Task 4): opens the help panel. */
export function HelpButton() {
  const { openPanel } = useHelp();
  return (
    <button
      type="button"
      onClick={() => openPanel()}
      aria-label="Ajuda"
      title="Ajuda"
      {...tourAnchor("shell.header.help")}
      className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-foreground/80 outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CircleHelp className="size-4" strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
