import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, ChevronDown, Copy, Info } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Section title inside a report card, with an optional line under it and actions. */
export function ReportSectionHeader({
  title,
  description,
  actions,
  id,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-2", className)}>
      <div className="min-w-0">
        <h2 id={id} className="text-section">
          {title}
        </h2>
        {description ? (
          <p className="mt-0.5 text-meta text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Group caption that names the time window of the numbers below it. */
export function WindowCaption({ children }: { children: ReactNode }) {
  return <p className="text-label font-medium text-muted-foreground">{children}</p>;
}

/** Plain label + value, no box. Used inside cards (stages, steps). */
export function StatCell({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "success";
}) {
  return (
    <div className="min-w-0">
      {hint ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <p
              tabIndex={0}
              className="w-fit cursor-help text-meta text-muted-foreground underline decoration-dotted underline-offset-2"
            >
              {label}
            </p>
          </TooltipTrigger>
          <TooltipContent className="max-w-60">{hint}</TooltipContent>
        </Tooltip>
      ) : (
        <p className="text-meta text-muted-foreground">{label}</p>
      )}
      <p
        className={cn(
          "mt-0.5 min-w-0 break-words text-kpi-sm tabular-nums",
          tone === "success" && "text-success",
        )}
      >
        {value}
      </p>
    </div>
  );
}

/** One-line notice. Warning for something the operator should act on; info otherwise. */
export function ReportNotice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning";
  children: ReactNode;
}) {
  const Icon = tone === "warning" ? AlertTriangle : Info;
  return (
    <div
      className={cn(
        "flex gap-2 rounded-xl border p-3 text-body",
        tone === "warning"
          ? "border-warning/30 bg-warning/5 text-foreground"
          : "border-border bg-card/60 text-muted-foreground",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "warning" ? "text-warning" : "text-muted-foreground",
        )}
        aria-hidden="true"
      />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Player name linking to the player's page when the player is known. */
export function PlayerName({
  playerId,
  name,
  className,
}: {
  playerId?: string | null;
  name: string;
  className?: string;
}) {
  if (!playerId) return <span className={cn("font-medium", className)}>{name}</span>;
  return (
    <Link
      to="/players/$playerId"
      params={{ playerId }}
      search={{ id: undefined, focus: undefined }}
      className={cn(
        "font-medium text-foreground underline-offset-2 hover:underline focus-visible:underline",
        className,
      )}
    >
      {name}
    </Link>
  );
}

/** Collapsed block for provider data the operator rarely needs. */
export function TechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <details className="group">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-label text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronDown
          className="size-4 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
        Detalhes técnicos
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

/** Copies the sent message so it can be pasted into a new campaign. */
export function CopyMessageButton({ text }: { text: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!text}
      onClick={async () => {
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          toast.success("Mensagem copiada");
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error("Não foi possível copiar. Selecione o texto e copie manualmente.");
        }
      }}
    >
      {copied ? (
        <Check className="mr-1.5 size-4" aria-hidden="true" />
      ) : (
        <Copy className="mr-1.5 size-4" aria-hidden="true" />
      )}
      Copiar mensagem
    </Button>
  );
}

/**
 * Long text clamped to two lines inside a table cell. Tapping it shows the
 * whole text (a `title` alone never shows on touch screens).
 */
export function ExpandableText({
  text,
  className,
  maxWidthClassName = "max-w-[320px]",
}: {
  text: string;
  className?: string;
  /** Width cap on the wrapper: `max-w` on a `<td>` itself is ignored by tables. */
  maxWidthClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      aria-expanded={open}
      title={open ? undefined : text}
      onClick={(event) => {
        // Rows can be clickable: opening the text must not open the row.
        event.stopPropagation();
        setOpen((value) => !value);
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className={cn(
        "block w-full min-w-0 break-words text-left outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
        maxWidthClassName,
        !open && "line-clamp-2",
        className,
      )}
    >
      {text}
    </button>
  );
}

/** Reason a disabled action is unavailable, as visible text (a `title` never shows on touch). */
export function DisabledReason({ children }: { children: ReactNode }) {
  return <span className="text-meta text-muted-foreground">{children}</span>;
}
