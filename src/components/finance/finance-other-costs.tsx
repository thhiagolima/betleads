// "Outros custos do mês" (spec §5, §7.3, §8): rows of description, category
// and value that enter the month's result but not any single day's. The
// category is a fixed set plus the ones the house typed before; a cost that
// looks like a Betleads charge gets a typing hint, and an already-launched one
// in a month with automatic Betleads cost is flagged as a probable duplicate.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, ChevronsUpDown, Info, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { formatBRL } from "@/components/finance/format";
import { currentMonth, financeMonthQueryKey } from "@/components/finance/finance-month-grid";
import { deleteOtherCost, getTenantFinanceMonth, saveOtherCost } from "@/lib/finance.functions";
import {
  MAX_CATEGORY_LENGTH,
  betleadsHint,
  categoryChoices,
  categoryKey,
} from "@/lib/finance/categories";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const DEFAULT_CATEGORY = "Outros";

/** The list inside the Categoria combobox. Filtering is ours (cmdk's is off). */
export function CategoryCommand({
  categories,
  search,
  selected,
  onSearchChange,
  onSelect,
}: {
  categories: string[];
  search: string;
  selected?: string;
  onSearchChange: (value: string) => void;
  onSelect: (label: string) => void;
}) {
  const { options, newName } = categoryChoices(categories, search);
  return (
    <Command shouldFilter={false}>
      <CommandInput
        placeholder="Buscar ou criar categoria"
        maxLength={MAX_CATEGORY_LENGTH}
        value={search}
        onValueChange={onSearchChange}
      />
      <CommandList>
        <CommandEmpty>Nenhuma categoria.</CommandEmpty>
        <CommandGroup>
          {options.map((label) => (
            <CommandItem key={label} value={label} onSelect={() => onSelect(label)}>
              <Check
                className={cn(
                  "h-4 w-4",
                  selected !== undefined && categoryKey(selected) === categoryKey(label)
                    ? "opacity-100"
                    : "opacity-0",
                )}
              />
              <span>{label}</span>
            </CommandItem>
          ))}
          {newName && (
            <CommandItem value={`__new__${newName}`} onSelect={() => onSelect(newName)}>
              <Plus className="h-4 w-4" />
              <span>Criar categoria “{newName}”</span>
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function CategoryCombobox({
  categories,
  value,
  onChange,
  disabled,
}: {
  categories: string[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Categoria"
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{value}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <CategoryCommand
          categories={categories}
          search={search}
          selected={value}
          onSearchChange={setSearch}
          onSelect={(label) => {
            onChange(label);
            setOpen(false);
            setSearch("");
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The probable-duplicate flag of a launched cost (spec §7.3), with its remove button. */
export function DuplicateBetleadsNote({
  canRemove,
  disabled,
  isDemo = false,
  onRemove,
}: {
  canRemove: boolean;
  disabled: boolean;
  isDemo?: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">
        <Info className="h-3 w-3 shrink-0" />
        parece duplicado com o custo Betleads automático
      </span>
      {canRemove && (
        <DemoDisabledTooltip active={isDemo}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-destructive hover:text-destructive"
            disabled={isDemo || disabled}
            onClick={onRemove}
          >
            Remover
          </Button>
        </DemoDisabledTooltip>
      )}
    </div>
  );
}

export function FinanceOtherCosts({ tenantId }: { tenantId: string }) {
  const isDemo = useIsDemoTenant();
  const qc = useQueryClient();
  const getMonth = useServerFn(getTenantFinanceMonth);
  const saveFn = useServerFn(saveOtherCost);
  const removeFn = useServerFn(deleteOtherCost);

  const [month, setMonth] = useState(currentMonth);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [descricao, setDescricao] = useState("");
  const [categoria, setCategoria] = useState(DEFAULT_CATEGORY);
  const [valor, setValor] = useState("");

  const resetForm = () => {
    setEditingId(null);
    setDescricao("");
    setCategoria(DEFAULT_CATEGORY);
    setValor("");
  };

  const startEdit = (cost: { id: string; descricao: string; categoria: string; valor: number }) => {
    setEditingId(cost.id);
    setDescricao(cost.descricao);
    setCategoria(cost.categoria);
    setValor(String(cost.valor));
  };

  const query = useQuery({
    queryKey: financeMonthQueryKey(tenantId, month),
    queryFn: () => getMonth({ data: { tenantId, month } }),
  });

  useEffect(() => resetForm(), [tenantId, month]);

  const refresh = () => qc.invalidateQueries({ queryKey: financeMonthQueryKey(tenantId, month) });

  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          tenantId,
          month,
          descricao,
          categoria,
          valor: Number(valor),
          id: editingId ?? undefined,
        },
      }),
    onSuccess: () => {
      toast.success("Custo salvo");
      resetForm();
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeFn({ data: { tenantId, id } }),
    onSuccess: (_result, id) => {
      toast.success("Custo removido");
      if (editingId === id) resetForm();
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (query.isLoading || !query.data) {
    return <div className="h-24 animate-pulse rounded-lg border border-border/40" />;
  }

  const canEdit = query.data.permissions.canEditValues;
  const { otherCosts, categories } = query.data;
  const total = otherCosts.reduce((sum, cost) => sum + cost.valor, 0);
  const hint = descricao.trim() ? betleadsHint(descricao, categoria) : null;

  return (
    <div className="space-y-4">
      <Input
        type="month"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        className="w-44"
      />
      <div className="overflow-x-auto rounded-lg border border-border/40">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Descrição</TableHead>
              <TableHead>Categoria</TableHead>
              <TableHead>Valor</TableHead>
              {canEdit && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {otherCosts.map((cost) => (
              <TableRow key={cost.id}>
                <TableCell className="min-w-[180px]">
                  {cost.descricao}
                  {cost.suspectedBetleads && (
                    <DuplicateBetleadsNote
                      canRemove={canEdit}
                      disabled={remove.isPending}
                      isDemo={isDemo}
                      onRemove={() => remove.mutate(cost.id)}
                    />
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">{cost.categoria}</TableCell>
                <TableCell className="whitespace-nowrap">{formatBRL(cost.valor)}</TableCell>
                {canEdit && (
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <DemoDisabledTooltip active={isDemo}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={isDemo}
                          onClick={() => startEdit(cost)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </DemoDisabledTooltip>
                      <DemoDisabledTooltip active={isDemo}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          disabled={isDemo || remove.isPending}
                          onClick={() => remove.mutate(cost.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </DemoDisabledTooltip>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {otherCosts.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={canEdit ? 4 : 3}
                  className="py-6 text-center text-sm text-muted-foreground"
                >
                  Nenhum custo lançado neste mês.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {otherCosts.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Total do mês: <span className="font-medium text-foreground">{formatBRL(total)}</span>
        </p>
      )}

      {canEdit && (
        <div className="space-y-2 rounded-lg border border-border/40 bg-background/30 p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[160px] flex-1">
              <Input
                placeholder="Descrição (ex.: Designer, Afiliado X)"
                value={descricao}
                onChange={(e) => setDescricao(e.target.value)}
                disabled={isDemo}
              />
            </div>
            <div className="w-full sm:w-52">
              <CategoryCombobox
                categories={categories}
                value={categoria}
                onChange={setCategoria}
                disabled={isDemo}
              />
            </div>
            <div className="w-32">
              <Input
                type="number"
                step="0.01"
                min={0}
                placeholder="Valor"
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                disabled={isDemo}
              />
            </div>
            <DemoDisabledTooltip active={isDemo}>
              <Button
                type="button"
                disabled={isDemo || !descricao.trim() || !valor || save.isPending}
                onClick={() => save.mutate()}
                className="gap-2"
              >
                <Plus className="h-4 w-4" />
                {editingId ? "Salvar custo" : "Adicionar"}
              </Button>
            </DemoDisabledTooltip>
            {editingId && (
              <Button type="button" variant="ghost" onClick={resetForm} className="gap-2">
                <X className="h-4 w-4" />
                Cancelar
              </Button>
            )}
          </div>
          {hint && (
            <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <Info className="h-3.5 w-3.5 shrink-0" />
              {hint}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
