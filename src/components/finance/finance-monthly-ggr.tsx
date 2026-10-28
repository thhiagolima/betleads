// "GGR do mês" at the top of Lançamentos: one accumulated value per month
// ("Perdas na casa" month to date, as the platform's GGR PAINEL shows it) and
// the day it is valid through. The server spreads it over the month's days
// (allocateMonthlyGgr); while it exists the daily GGR column is read-only.
// Clearing the value removes the total and the month goes back to daily GGR.
import { formatBRL } from "@/components/finance/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const MONTHLY_GGR_LABEL = "GGR do mês (Perdas na casa acumulado)";
export const MONTHLY_GGR_COLUMN_NOTE = "usando o total do mês";

export type MonthlyGgrFormValue = { ggr: string; validThrough: string };
export type MonthlyGgrCurrent = { ggr: number; validThrough: string } | null;

const addDays = (date: string, delta: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);

function monthBounds(month: string) {
  const [y, m] = month.split("-").map(Number);
  return {
    first: `${month}-01`,
    last: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10),
  };
}

const ddmm = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/** Yesterday (São Paulo `today`), clamped into `month` ("YYYY-MM"). */
export function defaultValidThrough(month: string, today: string): string {
  const { first, last } = monthBounds(month);
  const yesterday = addDays(today, -1);
  if (yesterday < first) return first;
  if (yesterday > last) return last;
  return yesterday;
}

/** pt-BR with a decimal comma: "-340,24", "1.497,15" (dots only as thousands groups). */
const PT_BR_DECIMAL = /^-?(\d+|\d{1,3}(\.\d{3})+),\d{1,2}$/;
/** Thousands groups without decimals: "1.000", "12.345.678". */
const DOT_THOUSANDS = /^-?\d{1,3}(\.\d{3})+$/;
/** Plain number, optional decimal dot with 1–2 digits: "1497.15", "-12.5". */
const DOT_DECIMAL = /^-?\d+(\.\d{1,2})?$/;

/**
 * The typed value as a number: "" → null (clears the total). Accepts
 * "-340,24", "1.497,15", "1.000" (= 1000), "12.345.678" and "1497.15";
 * anything ambiguous ("1,497.15", two commas, a dot after the comma,
 * "1497.151") is NaN, shown as "Valor inválido".
 */
export function parseGgrInput(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (PT_BR_DECIMAL.test(trimmed)) return Number(trimmed.replace(/\./g, "").replace(",", "."));
  if (DOT_THOUSANDS.test(trimmed)) return Number(trimmed.replace(/\./g, ""));
  if (DOT_DECIMAL.test(trimmed)) return Number(trimmed);
  return Number.NaN;
}

/** Same rules as the server (setMonthlyGgr); null when the form can be saved. */
export function monthlyGgrFormError(
  form: MonthlyGgrFormValue & { month: string },
  today: string,
): string | null {
  const ggr = parseGgrInput(form.ggr);
  if (ggr === null) return null;
  if (Number.isNaN(ggr)) return "Valor inválido";
  if (!form.validThrough) return "Informe a data de atualização";
  const { first, last } = monthBounds(form.month);
  if (form.validThrough < first || form.validThrough > last) {
    return "A data deve estar dentro do mês";
  }
  if (form.validThrough > today) return "Data futura não permitida";
  return null;
}

export function monthlyGgrStatus(current: MonthlyGgrCurrent): string {
  return current
    ? `Total do mês ${formatBRL(current.ggr)}, atualizado até ${ddmm(current.validThrough)}.`
    : "Sem total do mês: o GGR vem dos dias.";
}

export function MonthlyGgrFields({
  value,
  month,
  today,
  current,
  canEdit,
  disabled,
  saving,
  onChange,
  onSave,
}: {
  value: MonthlyGgrFormValue;
  /** "YYYY-MM". */
  month: string;
  /** "YYYY-MM-DD" in São Paulo. */
  today: string;
  current: MonthlyGgrCurrent;
  canEdit: boolean;
  /** Demo house: shown but not editable. */
  disabled: boolean;
  saving: boolean;
  onChange: (value: MonthlyGgrFormValue) => void;
  onSave: () => void;
}) {
  const { first, last } = monthBounds(month);
  const max = last < today ? last : today;
  const error = monthlyGgrFormError({ ...value, month }, today);
  const unchanged =
    current === null
      ? parseGgrInput(value.ggr) === null
      : parseGgrInput(value.ggr) === current.ggr && value.validThrough === current.validThrough;

  return (
    <div className="space-y-2 rounded-lg border border-border/40 bg-primary/5 p-3 text-sm">
      {canEdit ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">{MONTHLY_GGR_LABEL}</span>
            <Input
              type="text"
              inputMode="decimal"
              value={value.ggr}
              placeholder="vazio = GGR por dia"
              onChange={(e) => onChange({ ...value, ggr: e.target.value })}
              disabled={disabled}
              className="h-9 w-44"
            />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">atualizado até</span>
            <Input
              type="date"
              value={value.validThrough}
              min={first}
              max={max}
              onChange={(e) => onChange({ ...value, validThrough: e.target.value })}
              disabled={disabled}
              className="h-9 w-40"
            />
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || saving || error !== null || unchanged}
            onClick={onSave}
          >
            {saving ? "Salvando…" : "Salvar GGR do mês"}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{MONTHLY_GGR_LABEL}</p>
      )}
      <p className="text-xs text-muted-foreground">{monthlyGgrStatus(current)}</p>
      {canEdit && error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
