import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { AlertTriangle, Check, Minus } from "lucide-react";

import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  META_TEXTS,
  type AccountRow,
  type BusinessGroup,
} from "@/components/integrations/meta-connection-model";
import { cn } from "@/lib/utils";
import { SyncStatusBadge } from "./meta-badges";
import { groupToggleVisibleLabel } from "./meta-copy";
import { formatDateTime } from "./meta-format";

/** Checkbox da BM com o estado "misto" (`aria-checked="mixed"`, MB3-10). */
function GroupCheckbox({
  checked,
  disabled,
  label,
  onToggle,
}: {
  checked: boolean | "indeterminate";
  disabled: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <CheckboxPrimitive.Root
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onCheckedChange={onToggle}
      className="grid h-4 w-4 shrink-0 cursor-pointer place-content-center rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=indeterminate]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:text-primary-foreground"
    >
      <CheckboxPrimitive.Indicator className="grid place-content-center text-current">
        {checked === "indeterminate" ? (
          <Minus aria-hidden className="h-3.5 w-3.5" />
        ) : (
          <Check aria-hidden className="h-4 w-4" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

function AccountRowItem({
  row,
  checked,
  readOnly,
  isDemo,
  onToggle,
}: {
  row: AccountRow;
  checked: boolean;
  readOnly: boolean;
  isDemo: boolean;
  onToggle: () => void;
}) {
  const { account } = row;
  const locked = readOnly || isDemo;
  // Sem chave conectada só dá para desmarcar (o RPC recusa marcar).
  const disabled = locked || (!row.selectable && !checked);
  const name = account.name ?? account.account_id ?? account.meta_ad_account_id;
  const dataUntil = account.last_success_at ? formatDateTime(account.last_success_at) : null;
  const checkboxId = `meta-account-${account.id}`;
  return (
    <li
      className={cn(
        "flex gap-3 rounded-lg border border-border/50 px-3 py-3",
        row.isNew && "border-primary/40 bg-primary/5",
        disabled && !locked && "opacity-80",
      )}
    >
      <DemoDisabledTooltip active={isDemo}>
        <Checkbox
          id={checkboxId}
          className="mt-0.5"
          checked={checked}
          disabled={disabled}
          onCheckedChange={onToggle}
        />
      </DemoDisabledTooltip>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <label
            htmlFor={checkboxId}
            className={cn(
              "min-w-0 break-words text-sm font-semibold",
              disabled ? "cursor-not-allowed" : "cursor-pointer",
            )}
          >
            {name}
            {row.isNew && (
              <Badge
                variant="outline"
                className="ml-2 border-primary/40 bg-primary/10 align-middle text-meta text-primary"
              >
                nova
              </Badge>
            )}
          </label>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {row.anyAccessConnectionIds.length > 1 && (
              <Badge variant="outline" className="text-meta text-muted-foreground">
                via {row.anyAccessConnectionIds.length} chaves
              </Badge>
            )}
            <SyncStatusBadge status={account.sync_status} />
          </div>
        </div>
        <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-meta text-muted-foreground">
          <span className="break-all font-mono">{account.meta_ad_account_id}</span>
          {account.currency && <span>{account.currency}</span>}
          {account.timezone_name && <span>{account.timezone_name}</span>}
          {dataUntil && <span>dados até {dataUntil}</span>}
        </p>
        {row.usdWarning && (
          <p className="flex items-center gap-1 text-meta text-warning">
            <AlertTriangle aria-hidden className="h-3 w-3 shrink-0" />
            {META_TEXTS.usdOutsideRoas}
          </p>
        )}
        {row.reason && <p className="text-meta text-warning">{row.reason}</p>}
        {account.sync_status === "error" && account.last_error && (
          <p className="break-words text-meta text-danger">{account.last_error}</p>
        )}
      </div>
    </li>
  );
}

/** Uma BM: marcar todas pelo checkbox do grupo e as contas dela (MB3-02). */
export function AccountGroup({
  group,
  selected,
  readOnly,
  isDemo,
  filtered,
  onToggleGroup,
  onToggleAccount,
}: {
  group: BusinessGroup;
  selected: ReadonlySet<string>;
  readOnly: boolean;
  isDemo: boolean;
  /** Busca ou filtro ativo: o grupo mostra (e o checkbox marca) só as contas visíveis. */
  filtered: boolean;
  onToggleGroup: (group: BusinessGroup) => void;
  onToggleAccount: (row: AccountRow) => void;
}) {
  const headingId = `meta-bm-${group.key}`;
  const locked = readOnly || isDemo;
  return (
    <section role="group" aria-label={`BM ${group.name}`} className="space-y-2">
      <div className="flex items-center gap-3 px-1">
        <DemoDisabledTooltip active={isDemo}>
          <GroupCheckbox
            checked={group.checkState}
            disabled={locked || (group.selectableCount === 0 && group.selectedCount === 0)}
            label={groupToggleVisibleLabel(group.name, filtered)}
            onToggle={() => onToggleGroup(group)}
          />
        </DemoDisabledTooltip>
        <h3 id={headingId} className="min-w-0 text-sm font-semibold">
          <span className="break-words">BM {group.name}</span>{" "}
          <span className="font-normal text-muted-foreground">
            ({group.selectedCount} de {group.rows.length}{" "}
            {filtered ? "visíveis marcadas" : "marcadas"})
          </span>
        </h3>
      </div>
      <ul aria-labelledby={headingId} className="space-y-2">
        {group.rows.map((row) => (
          <AccountRowItem
            key={row.account.id}
            row={row}
            checked={selected.has(row.account.id)}
            readOnly={readOnly}
            isDemo={isDemo}
            onToggle={() => onToggleAccount(row)}
          />
        ))}
      </ul>
    </section>
  );
}
