import { Loader2, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  META_TEXTS,
  filterRows,
  groupByBusiness,
  toggleGroup,
  type AccountFilter,
  type AccountRow,
} from "@/components/integrations/meta-connection-model";
import { AccountGroup } from "./account-group";
import { emptyAccountsHelp } from "./meta-copy";
import { plural } from "./meta-format";

const FILTERS: { value: AccountFilter; label: string }[] = [
  { value: "all", label: "Todas" },
  { value: "selected", label: "Marcadas" },
  { value: "errors", label: "Com erro" },
  { value: "new", label: "Novas" },
];

export type SelectionDraft = {
  draft: ReadonlySet<string>;
  persisted: ReadonlySet<string>;
  diff: { added: string[]; removed: string[]; dirty: boolean };
  setDraft: (next: ReadonlySet<string>) => void;
  discard: () => void;
};

/** Contas por BM, com busca, filtro e o rascunho da seleção (MB3-02, MB3-03). */
export function AccountSelection({
  rows,
  selection,
  readOnly,
  isDemo,
  savePending,
  onSave,
  onDiscard,
  staleNotice,
  initialFilter = "all",
}: {
  rows: AccountRow[];
  selection: SelectionDraft;
  readOnly: boolean;
  isDemo: boolean;
  savePending: boolean;
  onSave: (accountIds: string[]) => void;
  /** Depois de descartar o rascunho (a tela some com o aviso de lista alterada). */
  onDiscard?: () => void;
  staleNotice: boolean;
  initialFilter?: AccountFilter;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AccountFilter>(initialFilter);
  const { draft, diff, persisted } = selection;
  // "Marcadas" filtra pelo que está salvo: desmarcar uma conta não a tira da lista.
  const groups = useMemo(
    () => groupByBusiness(filterRows(rows, filter, query, persisted), draft),
    [rows, filter, query, persisted, draft],
  );
  const filtered = filter !== "all" || query.trim() !== "";
  const locked = readOnly || isDemo;
  const changes = diff.added.length + diff.removed.length;
  const showFooter = diff.dirty && !readOnly;

  const toggleAccount = (row: AccountRow) => {
    if (locked) return;
    const next = new Set(draft);
    if (next.has(row.account.id)) next.delete(row.account.id);
    else if (row.selectable) next.add(row.account.id);
    selection.setDraft(next);
  };

  return (
    <section aria-labelledby="meta-accounts-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h3 id="meta-accounts-title" className="font-semibold">
            Contas de anúncio
          </h3>
          <p className="text-meta text-muted-foreground">
            Só as contas marcadas entram nos relatórios. {draft.size} de{" "}
            {plural(rows.length, "conta marcada", "contas marcadas")}.
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <div className="relative w-full sm:w-56">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label="Buscar conta, act_ ou BM"
              placeholder="Buscar conta, act_ ou BM"
              className="h-8 pl-8"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            aria-label="Mostrar contas"
            className="flex-wrap justify-start"
            value={filter}
            onValueChange={(value) => value && setFilter(value as AccountFilter)}
          >
            {FILTERS.map((item) => (
              <ToggleGroupItem key={item.value} value={item.value} className="h-8 text-meta">
                {item.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      {staleNotice && (
        <p role="alert" className="rounded-md bg-warning/10 px-3 py-2 text-meta text-warning">
          {META_TEXTS.listChanged}
        </p>
      )}

      <div className="space-y-5">
        {groups.map((group) => (
          <AccountGroup
            key={group.key}
            group={group}
            selected={draft}
            readOnly={readOnly}
            isDemo={isDemo}
            filtered={filtered}
            onToggleGroup={(target) => {
              if (!locked) selection.setDraft(toggleGroup(target, draft));
            }}
            onToggleAccount={toggleAccount}
          />
        ))}
        {groups.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {rows.length === 0
              ? emptyAccountsHelp
              : "Nenhuma conta corresponde à busca ou ao filtro."}
          </p>
        )}
      </div>

      {showFooter && (
        <div
          role="region"
          aria-label="Alterações não salvas"
          className="sticky bottom-[calc(60px+env(safe-area-inset-bottom))] z-30 md:bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-card/95 px-4 py-3 backdrop-blur sm:-mx-5 sm:px-5"
        >
          <span className="mr-auto text-sm font-medium">
            {plural(changes, "alteração não salva", "alterações não salvas")}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={savePending}
            onClick={() => {
              selection.discard();
              onDiscard?.();
            }}
          >
            Descartar
          </Button>
          <DemoDisabledTooltip active={isDemo}>
            <Button size="sm" disabled={isDemo || savePending} onClick={() => onSave([...draft])}>
              {savePending && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
              Salvar contas
            </Button>
          </DemoDisabledTooltip>
        </div>
      )}
    </section>
  );
}
