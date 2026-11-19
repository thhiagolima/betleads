import { Eye, Pencil } from "lucide-react";

import { cn } from "@/lib/utils";

export type EditorPane = "editar" | "previa";

/** Full-screen on phones, large centered dialog from sm up (same as the campaign composer). */
export const EMAIL_EDITOR_DIALOG_CLASS =
  "flex h-dvh max-h-dvh w-full max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[92dvh] sm:max-h-[92dvh] sm:w-[95vw] sm:max-w-[1200px] sm:rounded-lg";

/**
 * "Editar | Prévia" switch shown below lg, where the form and the preview no
 * longer fit side by side. From lg up both panes are always visible.
 */
export function EditorPaneTabs({
  pane,
  onChange,
}: {
  pane: EditorPane;
  onChange: (pane: EditorPane) => void;
}) {
  const tabs: { value: EditorPane; label: string; icon: typeof Pencil }[] = [
    { value: "editar", label: "Editar", icon: Pencil },
    { value: "previa", label: "Prévia", icon: Eye },
  ];
  return (
    <div className="shrink-0 border-b border-border/50 px-4 py-2 lg:hidden">
      <div role="tablist" aria-label="Editar ou ver a prévia" className="grid grid-cols-2 rounded-md border border-border p-0.5">
        {tabs.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={pane === value}
            onClick={() => onChange(value)}
            className={cn(
              "flex min-h-10 items-center justify-center gap-1.5 rounded-sm text-sm font-medium transition-colors",
              pane === value ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
