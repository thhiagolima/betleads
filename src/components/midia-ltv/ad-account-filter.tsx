import { Check, ChevronsUpDown, Filter } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { MetaAccount } from "@/components/integrations/meta-summary";
import { cn } from "@/lib/utils";

// Filtro "BM / conta" de Aquisição e LTV (MB4-04): escolhe as contas de anúncio
// marcadas da casa que entram no overview. Vazio = todas as contas.

export const AD_ACCOUNT_FILTER_NOTE =
  "Com filtro, entram só os jogadores atribuídos a essas contas; tráfego sem atribuição fica de fora.";

const NO_BM = "Sem BM";

export type AdAccountOption = { id: string; name: string; business: string };

/** Contas marcadas da casa, agrupadas pela BM (nome), em ordem alfabética. */
export function adAccountGroups(accounts: MetaAccount[]) {
  const groups = new Map<string, AdAccountOption[]>();
  for (const account of accounts) {
    if (account.selected === false) continue;
    const business = account.business_name?.trim() || NO_BM;
    const list = groups.get(business) ?? [];
    list.push({
      id: account.meta_ad_account_id,
      name: account.name?.trim() || account.meta_ad_account_id,
      business,
    });
    groups.set(business, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === NO_BM ? 1 : b === NO_BM ? -1 : a.localeCompare(b, "pt-BR")))
    .map(([business, options]) => ({
      business,
      options: options.sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    }));
}

/** Texto do botão: "Todas as contas", o nome da conta ou "N contas". */
export function adAccountFilterLabel(value: string[], options: AdAccountOption[]) {
  if (value.length === 0) return "Todas as contas";
  if (value.length === 1) return options.find((option) => option.id === value[0])?.name ?? value[0];
  return `${value.length} contas`;
}

/**
 * Marca/desmarca `ids` (uma conta ou a BM inteira). Mesmo com todas marcadas uma a
 * uma, a lista explícita continua sendo filtro (só tráfego atribuído); "Todas as
 * contas" é a única ação que limpa.
 */
export function toggleAdAccounts(value: string[], ids: string[]) {
  const next = new Set(value);
  const allIn = ids.every((id) => next.has(id));
  for (const id of ids) {
    if (allIn) next.delete(id);
    else next.add(id);
  }
  return [...next];
}

export function AdAccountFilter({
  accounts,
  value,
  onChange,
}: {
  accounts: MetaAccount[];
  /** `meta_ad_account_id`s escolhidos; vazio = todas. */
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => adAccountGroups(accounts), [accounts]);
  const options = useMemo(() => groups.flatMap((group) => group.options), [groups]);
  const chosen = new Set(value);
  const active = value.length > 0;

  if (options.length === 0) return null;

  function toggle(ids: string[]) {
    onChange(toggleAdAccounts(value, ids));
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Filtrar por BM / conta"
          className={cn(
            "h-9 w-full justify-between gap-2 sm:w-auto sm:max-w-xs",
            active && "border-primary/60 bg-primary/5",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Filter aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">BM / conta:</span>
            <span className="truncate font-medium">{adAccountFilterLabel(value, options)}</span>
          </span>
          <ChevronsUpDown aria-hidden className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] p-0" align="start">
        <Command>
          <CommandInput placeholder="Buscar BM, conta ou act_" />
          <CommandList>
            <CommandEmpty>Nenhuma conta encontrada.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__all__ todas as contas" onSelect={() => onChange([])}>
                <Check
                  aria-hidden
                  className={cn("h-4 w-4", active ? "opacity-0" : "opacity-100")}
                />
                Todas as contas
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            {groups.map((group) => {
              const ids = group.options.map((option) => option.id);
              const allIn = ids.every((id) => chosen.has(id));
              return (
                <CommandGroup key={group.business} heading={group.business}>
                  {group.options.length > 1 && (
                    <CommandItem
                      value={`__bm__ ${group.business}`}
                      onSelect={() => toggle(ids)}
                      className="text-meta font-medium"
                    >
                      <Check
                        aria-hidden
                        className={cn("h-4 w-4", allIn ? "opacity-100" : "opacity-0")}
                      />
                      Toda a BM
                    </CommandItem>
                  )}
                  {group.options.map((option) => (
                    <CommandItem
                      key={option.id}
                      value={`${option.name} ${option.id} ${group.business}`}
                      onSelect={() => toggle([option.id])}
                    >
                      <Check
                        aria-hidden
                        className={cn(
                          "h-4 w-4 shrink-0",
                          chosen.has(option.id) ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{option.name}</span>
                      <span className="shrink-0 font-mono text-meta text-muted-foreground">
                        {option.id}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Aviso mostrado quando o filtro está ativo. */
export function AdAccountFilterNote({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <p
      role="note"
      className="rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-meta text-info"
    >
      {AD_ACCOUNT_FILTER_NOTE}
    </p>
  );
}
