import { Link } from "@tanstack/react-router";
import { Megaphone, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

/** Grupo de regras: título `text-label` (com a bolinha da cor do grupo, se houver). */
export function RuleGroup({
  title,
  help,
  dot,
  children,
}: {
  title: string;
  help?: string;
  /** Classe de cor do grupo (FILTER_GROUP_DOT). */
  dot?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="flex items-center gap-1.5 text-label font-semibold">
        {dot && <span className={cn("size-2 rounded-full", dot)} aria-hidden="true" />}
        {title}
      </legend>
      {help && <p className="-mt-1 text-meta text-muted-foreground">{help}</p>}
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

/** Chip de regra com contagem: marcador na cor do tipo; o ativo fica em `primary`. */
export function RuleChip({
  active,
  onClick,
  label,
  count,
  loading,
  dot,
  marker,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  loading?: boolean;
  /** Classe de cor da bolinha (tipo do filtro). */
  dot?: string;
  /** Marcador próprio (ex.: ícone do nível), no lugar da bolinha. */
  marker?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:h-8",
        active
          ? "border-primary bg-primary/15 text-primary"
          : "border-border bg-background/40 text-foreground hover:bg-secondary",
      )}
    >
      {marker ??
        (dot && <span className={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden="true" />)}
      <span>{label}</span>
      <span
        className={cn(
          "text-meta tabular-nums",
          active ? "text-primary/80" : "text-muted-foreground",
        )}
      >
        {loading ? "…" : (count ?? 0).toLocaleString("pt-BR")}
      </span>
    </button>
  );
}

export type AudienceMenuItem = {
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  /** Link interno (Jornada). */
  to?: "/jornadas/nova";
  search?: Record<string, unknown>;
  destructive?: boolean;
};

/** Cartão de um público: nome, descrição, etiquetas e ações ("Usar na campanha" + menu ⋯). */
export function AudienceCard({
  audienceId,
  name,
  description,
  labels,
  menu,
}: {
  audienceId: string;
  name: string;
  description?: string | null;
  labels?: string[];
  menu?: AudienceMenuItem[];
}) {
  const regular = (menu ?? []).filter((item) => !item.destructive);
  const destructive = (menu ?? []).filter((item) => item.destructive);
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-border bg-background/30 p-3.5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-body font-semibold">{name}</h3>
        {description && <p className="mt-0.5 text-meta text-muted-foreground">{description}</p>}
        {labels && labels.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Regras do público">
            {labels.map((label, index) => (
              <li
                key={`${label}-${index}`}
                className="rounded-full border border-border bg-secondary/50 px-2 py-0.5 text-meta text-muted-foreground"
              >
                {label}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button asChild className="h-11 flex-1 sm:h-9 sm:flex-none">
          <Link to="/campanhas" search={{ newCampaign: 1, audience: audienceId } as never}>
            <Megaphone className="size-4" aria-hidden="true" />
            Usar na campanha
          </Link>
        </Button>
        {menu && menu.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                variant="outline"
                label={`Mais ações para ${name}`}
                icon={<MoreHorizontal className="size-4" />}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {regular.map((item) => (
                <MenuEntry key={item.label} item={item} />
              ))}
              {destructive.length > 0 && regular.length > 0 && <DropdownMenuSeparator />}
              {destructive.map((item) => (
                <MenuEntry key={item.label} item={item} />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </article>
  );
}

function MenuEntry({ item }: { item: AudienceMenuItem }) {
  const className = cn(
    "min-h-11 gap-2 sm:min-h-8",
    item.destructive && "text-destructive focus:text-destructive",
  );
  if (item.to) {
    return (
      <DropdownMenuItem asChild className={className}>
        <Link to={item.to} search={item.search as never}>
          {item.icon}
          {item.label}
        </Link>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem className={className} onSelect={item.onSelect}>
      {item.icon}
      {item.label}
    </DropdownMenuItem>
  );
}
