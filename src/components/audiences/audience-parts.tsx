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
  /** Texto de ajuda sob o título; aceita nó (ex.: <Term>), já que fica fora dos chips. */
  help?: ReactNode;
  /** Classe de cor do grupo (FILTER_GROUP_DOT). Só no título: os chips não repetem. */
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

/** Chip de regra com contagem; o ativo fica em `primary`. */
export function RuleChip({
  active,
  onClick,
  label,
  count,
  loading,
  dot,
  marker,
  tourProps,
}: {
  active: boolean;
  onClick: () => void;
  /** Só texto: o chip é um <button>, e um <Term> (outro botão) aqui dentro seria
   * botão dentro de botão — ponha o Term no `help` do RuleGroup. */
  label: string;
  count?: number;
  loading?: boolean;
  /** Bolinha que carrega significado próprio (ex.: tons do tempo parado). */
  dot?: string;
  /** Marcador próprio (ex.: ícone do nível), no lugar da bolinha. */
  marker?: ReactNode;
  /** `tourAnchor(...)` do chamador (chip repetido num grupo: só o primeiro recebe). */
  tourProps?: Record<string, string>;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-label font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:h-8",
        active
          ? "border-primary bg-primary/15 text-primary"
          : "border-border bg-background/40 text-foreground hover:bg-secondary",
      )}
      {...tourProps}
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

/** Quantos jogadores um público tem agora (null = ainda calculando). */
export type AudienceCount = {
  total: number;
  reachable: number;
  /** Rótulo do alcançável: "com celular" (SMS). */
  reachableLabel: string;
} | null;

/** "1.234 jogadores" / "1 lead". */
export function countNoun(count: number, noun: "jogador" | "lead") {
  const plural = noun === "jogador" ? "jogadores" : "leads";
  return `${count.toLocaleString("pt-BR")} ${count === 1 ? noun : plural}`;
}

/** The count block on the right of a row: the size first, how many can receive below. */
function CountBlock({
  count,
  error,
  noun,
}: {
  count: AudienceCount;
  error?: boolean;
  noun: "jogador" | "lead";
}) {
  if (error) return <p className="text-meta text-muted-foreground">Sem contagem agora</p>;
  if (!count)
    return (
      <div className="space-y-1" aria-label="Calculando">
        <div className="ml-auto h-4 w-20 animate-pulse rounded bg-secondary" />
        <div className="ml-auto h-3 w-24 animate-pulse rounded bg-secondary/60" />
      </div>
    );
  return (
    <div className="sm:text-right">
      <p className="text-body font-semibold tabular-nums">{countNoun(count.total, noun)}</p>
      <p className="text-meta tabular-nums text-muted-foreground">
        {count.reachable.toLocaleString("pt-BR")} {count.reachableLabel}
      </p>
    </div>
  );
}

/**
 * One audience as a list row: name (never cut to "…"), its rules on one line,
 * how many players it has now, and the actions. "Usar" is an outline button —
 * the page has a single primary button ("Novo público").
 */
export function AudienceRow({
  audienceId,
  name,
  summary,
  description,
  badge,
  count,
  countError,
  noun,
  menu,
  rowAnchor,
  actionAnchor,
  menuAnchor,
}: {
  audienceId: string;
  name: string;
  /** Regras em uma linha ("Nunca depositou · Cadastrou ontem"). */
  summary?: string;
  /** Descrição escrita por quem criou (só aparece se existir). */
  description?: string | null;
  /** Etiqueta curta ao lado do nome (ex.: "Da casa · somente leitura"). */
  badge?: string;
  count: AudienceCount;
  countError?: boolean;
  noun: "jogador" | "lead";
  menu?: AudienceMenuItem[];
  rowAnchor?: Record<string, string>;
  actionAnchor?: Record<string, string>;
  menuAnchor?: Record<string, string>;
}) {
  const regular = (menu ?? []).filter((item) => !item.destructive);
  const destructive = (menu ?? []).filter((item) => item.destructive);
  return (
    <li
      className="grid gap-x-4 gap-y-2 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
      {...rowAnchor}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="line-clamp-2 break-words text-body font-semibold">{name}</h3>
          {badge && (
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-meta text-muted-foreground">
              {badge}
            </span>
          )}
        </div>
        {summary && <p className="mt-0.5 text-meta text-muted-foreground">{summary}</p>}
        {description && (
          <p className="mt-0.5 line-clamp-2 text-meta italic text-muted-foreground/80">
            {description}
          </p>
        )}
      </div>
      <CountBlock count={count} error={countError} noun={noun} />
      <div className="flex items-center gap-1.5">
        <Button asChild variant="outline" className="h-10 flex-1 sm:h-9 sm:flex-none">
          <Link
            to="/campanhas"
            search={{ newCampaign: 1, audience: audienceId } as never}
            aria-label={`Usar “${name}” numa campanha`}
            {...actionAnchor}
          >
            <Megaphone className="size-4" aria-hidden="true" />
            Usar
          </Link>
        </Button>
        {menu && menu.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                variant="ghost"
                label={`Mais ações para ${name}`}
                icon={<MoreHorizontal className="size-4" />}
                {...menuAnchor}
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
        ) : (
          // Same width as the ⋯ button, so the "Usar" buttons line up.
          <span className="hidden size-9 sm:block" aria-hidden="true" />
        )}
      </div>
    </li>
  );
}

/** A tile of the loyalty-level block: icon, name and size; the whole tile opens the campaign. */
export function LevelTile({
  audienceId,
  name,
  icon,
  count,
  noun,
  tourProps,
}: {
  audienceId: string;
  name: string;
  icon: ReactNode;
  count: number | null;
  noun: "jogador" | "lead";
  tourProps?: Record<string, string>;
}) {
  return (
    <Link
      to="/campanhas"
      search={{ newCampaign: 1, audience: audienceId } as never}
      aria-label={`Usar o nível ${name} numa campanha`}
      className="group flex min-h-[72px] flex-col justify-between gap-1 rounded-xl border border-border bg-background/40 p-3 outline-none transition-colors hover:border-primary/50 hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring"
      {...tourProps}
    >
      <span className="flex items-center gap-1.5 text-label font-medium">
        {icon}
        {name}
      </span>
      <span className="text-meta tabular-nums text-muted-foreground group-hover:text-foreground">
        {count === null ? "…" : countNoun(count, noun)}
      </span>
    </Link>
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
