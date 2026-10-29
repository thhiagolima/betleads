// "Outros custos" (spec §5, §7.3, §8; dated in docs/ESCOPO_AUDITORIA_FINANCEIRO
// _2026-10-29.md §3.5): rows of date, description, category and value; each
// enters every period that contains its date. "Repetir todo mês" copies a
// cost into each new month on the same day (finance_materialize_recurring_costs).
// The category is a fixed set plus the ones the house typed before; a cost that
// looks like a Betleads charge gets a typing hint, and an already-launched one
// in a month with automatic Betleads cost is flagged as a probable duplicate.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, ChevronsUpDown, Info, Pencil, Plus, Repeat, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { formatBRL } from "@/components/finance/format";
import { currentMonth } from "@/components/finance/day-entry";
import { financeMonthQueryKey, invalidateFinanceAfterSave } from "@/components/finance/query-keys";
import { deleteOtherCost, getTenantFinanceMonth, saveOtherCost } from "@/lib/finance.functions";
import { presetRange } from "@/lib/finance/calc";
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
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
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

/** "YYYY-MM-DD" of today in São Paulo, the same day boundary as the server. */
const todaySaoPaulo = () => presetRange("today", new Date()).from;

function lastDayOf(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The days a cost of `month` ("YYYY-MM") may be dated: inside the month, up to today; null for a future month. */
export function costDateBounds(month: string, today: string): { min: string; max: string } | null {
  const min = `${month}-01`;
  if (min > today) return null;
  const last = lastDayOf(month);
  return { min, max: last < today ? last : today };
}

/** Today when it is in `month`, else the month's last day; null for a future month. */
export function defaultCostDate(month: string, today: string): string | null {
  return costDateBounds(month, today)?.max ?? null;
}

export function isCostDateAllowed(date: string, month: string, today: string): boolean {
  const bounds = costDateBounds(month, today);
  return !!bounds && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= bounds.min && date <= bounds.max;
}

const ddmm = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/** The Data cell: "dd/mm", and "todo mês" when the cost repeats. */
export function CostDateLabel({
  costDate,
  repeatMonthly,
}: {
  costDate: string;
  repeatMonthly: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {ddmm(costDate)}
      {repeatMonthly && (
        <span className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
          <Repeat className="h-3 w-3" />
          todo mês
        </span>
      )}
    </span>
  );
}

export type DeleteMode = "delete" | "skip_month" | "end_series";

/** Deleting a repeating row asks whether to skip only this month or end the repetition. */
export const asksRepeatChoice = (cost: { repeatMonthly: boolean }) => cost.repeatMonthly;

/** A month skipped with "Excluir só este mês": the repeating row kept with valor 0. */
export const isSkippedCost = (cost: { repeatMonthly: boolean; valor: number }) =>
  cost.repeatMonthly && cost.valor === 0;

export function deleteToast(mode: DeleteMode): string {
  if (mode === "end_series") return "Repetição encerrada";
  if (mode === "skip_month") return "Mês pulado";
  return "Custo removido";
}

/** The Valor cell: the amount, or "pulado neste mês" for a skipped month. */
export function CostValueLabel({ valor, skipped }: { valor: number; skipped: boolean }) {
  if (skipped) {
    return <span className="text-xs italic text-muted-foreground">pulado neste mês</span>;
  }
  return <>{formatBRL(valor)}</>;
}

/** The two answers when a repeating row is deleted. */
export function RepeatDeleteChoices({
  disabled,
  onSkipMonth,
  onEndSeries,
}: {
  disabled: boolean;
  onSkipMonth: () => void;
  onEndSeries: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button type="button" variant="outline" disabled={disabled} onClick={onSkipMonth}>
        Excluir só este mês (continua nos próximos)
      </Button>
      <Button type="button" variant="destructive" disabled={disabled} onClick={onEndSeries}>
        Encerrar a repetição
      </Button>
    </div>
  );
}

/** Data (inside the viewed month, not after today) and "Repetir todo mês". */
export function CostDateRepeatFields({
  month,
  today,
  costDate,
  repeatMonthly,
  disabled,
  onCostDateChange,
  onRepeatChange,
}: {
  month: string;
  today: string;
  costDate: string;
  repeatMonthly: boolean;
  disabled: boolean;
  onCostDateChange: (value: string) => void;
  onRepeatChange: (value: boolean) => void;
}) {
  const bounds = costDateBounds(month, today);
  return (
    <>
      <div className="w-40">
        <Input
          type="date"
          aria-label="Data"
          min={bounds?.min}
          max={bounds?.max}
          value={costDate}
          onChange={(e) => onCostDateChange(e.target.value)}
          disabled={disabled || !bounds}
        />
      </div>
      <label className="flex h-9 items-center gap-2 text-sm">
        <Switch
          checked={repeatMonthly}
          onCheckedChange={onRepeatChange}
          disabled={disabled}
          aria-label="Repetir todo mês"
        />
        Repetir todo mês
      </label>
    </>
  );
}

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

export function CategoryCombobox({
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

export function FinanceOtherCosts({
  tenantId,
  initialMonth,
}: {
  tenantId: string;
  /** "YYYY-MM" to open on (the day modal's "Editar em Outros custos"); default: this month. */
  initialMonth?: string;
}) {
  const isDemo = useIsDemoTenant();
  const qc = useQueryClient();
  const getMonth = useServerFn(getTenantFinanceMonth);
  const saveFn = useServerFn(saveOtherCost);
  const removeFn = useServerFn(deleteOtherCost);

  const [month, setMonth] = useState(() => initialMonth ?? currentMonth());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [descricao, setDescricao] = useState("");
  const [categoria, setCategoria] = useState(DEFAULT_CATEGORY);
  const [valor, setValor] = useState("");
  const [costDate, setCostDate] = useState(() => defaultCostDate(month, todaySaoPaulo()) ?? "");
  const [repeatMonthly, setRepeatMonthly] = useState(false);

  const resetForm = () => {
    setEditingId(null);
    setDescricao("");
    setCategoria(DEFAULT_CATEGORY);
    setValor("");
    setCostDate(defaultCostDate(month, todaySaoPaulo()) ?? "");
    setRepeatMonthly(false);
  };

  const startEdit = (cost: {
    id: string;
    descricao: string;
    categoria: string;
    valor: number;
    costDate: string;
    repeatMonthly: boolean;
  }) => {
    setEditingId(cost.id);
    setDescricao(cost.descricao);
    setCategoria(cost.categoria);
    setValor(String(cost.valor));
    setCostDate(cost.costDate);
    setRepeatMonthly(cost.repeatMonthly);
  };

  const query = useQuery({
    queryKey: financeMonthQueryKey(tenantId, month),
    queryFn: () => getMonth({ data: { tenantId, month } }),
  });

  useEffect(() => resetForm(), [tenantId, month]);

  const refresh = () => invalidateFinanceAfterSave(qc, tenantId, month);

  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          tenantId,
          costDate,
          repeatMonthly,
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

  const [askingDeleteId, setAskingDeleteId] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: DeleteMode }) =>
      removeFn({ data: { tenantId, id, mode } }),
    onSuccess: (_result, { id, mode }) => {
      toast.success(deleteToast(mode));
      setAskingDeleteId(null);
      if (editingId === id) resetForm();
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const requestDelete = (cost: { id: string; repeatMonthly: boolean }) => {
    if (asksRepeatChoice(cost)) setAskingDeleteId(cost.id);
    else remove.mutate({ id: cost.id, mode: "delete" });
  };

  if (query.isLoading || !query.data) {
    return <div className="h-24 animate-pulse rounded-lg border border-border/40" />;
  }

  const canEdit = query.data.permissions.canEditValues;
  const { otherCosts, categories } = query.data;
  const total = otherCosts.reduce((sum, cost) => sum + cost.valor, 0);
  const hint = descricao.trim() ? betleadsHint(descricao, categoria) : null;
  const today = todaySaoPaulo();
  const dateAllowed = isCostDateAllowed(costDate, month, today);

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
              <TableHead>Data</TableHead>
              <TableHead>Descrição</TableHead>
              <TableHead>Categoria</TableHead>
              <TableHead>Valor</TableHead>
              {canEdit && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {otherCosts.map((cost) => (
              <TableRow key={cost.id}>
                <TableCell className="whitespace-nowrap">
                  <CostDateLabel costDate={cost.costDate} repeatMonthly={cost.repeatMonthly} />
                </TableCell>
                <TableCell className="min-w-[180px]">
                  {cost.descricao}
                  {cost.suspectedBetleads && (
                    <DuplicateBetleadsNote
                      canRemove={canEdit}
                      disabled={remove.isPending}
                      isDemo={isDemo}
                      onRemove={() => requestDelete(cost)}
                    />
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">{cost.categoria}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <CostValueLabel valor={cost.valor} skipped={isSkippedCost(cost)} />
                </TableCell>
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
                          onClick={() => requestDelete(cost)}
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
                  colSpan={canEdit ? 5 : 4}
                  className="py-6 text-center text-sm text-muted-foreground"
                >
                  Nenhum custo lançado neste mês.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <AlertDialog
        open={askingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setAskingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir custo recorrente</AlertDialogTitle>
            <AlertDialogDescription>
              Este custo se repete todo mês. Excluir só este mês ou encerrar a repetição?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <RepeatDeleteChoices
            disabled={remove.isPending}
            onSkipMonth={() =>
              askingDeleteId && remove.mutate({ id: askingDeleteId, mode: "skip_month" })
            }
            onEndSeries={() =>
              askingDeleteId && remove.mutate({ id: askingDeleteId, mode: "end_series" })
            }
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancelar</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {otherCosts.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Total do mês: <span className="font-medium text-foreground">{formatBRL(total)}</span>
        </p>
      )}

      {canEdit && (
        <div className="space-y-2 rounded-lg border border-border/40 bg-background/30 p-3">
          <div className="flex flex-wrap items-end gap-2">
            <CostDateRepeatFields
              month={month}
              today={today}
              costDate={costDate}
              repeatMonthly={repeatMonthly}
              disabled={isDemo}
              onCostDateChange={setCostDate}
              onRepeatChange={setRepeatMonthly}
            />
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
                disabled={isDemo || !descricao.trim() || !valor || !dateAllowed || save.isPending}
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
