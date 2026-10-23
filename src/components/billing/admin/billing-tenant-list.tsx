// The "Faturamento" tab's house list (ruling 1): one row per tenant, its billing situation,
// the open invoice (when there is one) and the 11 action dialogs from `tenant-actions.tsx`.
// Reused as a single-tenant view in the "Cobrança" section of a house (tenants.tsx, ruling 3).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  adminBillingTenantList,
  type AdminBillingTenantRow,
} from "@/lib/billing/billing-admin.functions";
import {
  adminTenantSituationLabel,
  adminTenantSituationTone,
  formatCentsBRL,
  formatDateBR,
} from "./billing-admin-ui";
import {
  ApplyInvoiceDiscountAction,
  BlockTenantAction,
  CancelInvoiceAction,
  ExtendInvoiceDueAction,
  GrantFreeDaysAction,
  ManualSettleAction,
  ResendBillingEmailAction,
  SetContinuousDiscountAction,
  SetCustomPriceAction,
  SetCycleDayAction,
  SetFrozenAction,
} from "./tenant-actions";

export const BILLING_TENANT_LIST_QUERY_KEY = ["billing-admin", "tenant-list"];
export const BILLING_DASHBOARD_QUERY_KEY = ["billing-admin", "dashboard"];
export const billingHistoryQueryKey = (tenantId: string | null) => ["billing-admin", "history", tenantId];

/** Called by every row action after it settles — refetches the list, the dashboard and (when
 * a single tenant's history is open) the history, per ruling 4. */
function useRefetchAfterBillingAction() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: BILLING_TENANT_LIST_QUERY_KEY });
    qc.invalidateQueries({ queryKey: BILLING_DASHBOARD_QUERY_KEY });
    qc.invalidateQueries({ queryKey: ["billing-admin", "history"] });
  };
}

function TenantActionsRow({ row }: { row: AdminBillingTenantRow }) {
  const onDone = useRefetchAfterBillingAction();
  const invoiceId = row.openInvoice?.id ?? null;
  return (
    <div className="flex flex-wrap gap-1">
      <BlockTenantAction tenantId={row.tenantId} blocked={row.manualBlock} onDone={onDone} />
      <ExtendInvoiceDueAction invoiceId={invoiceId} onDone={onDone} />
      <GrantFreeDaysAction tenantId={row.tenantId} onDone={onDone} />
      <ApplyInvoiceDiscountAction invoiceId={invoiceId} onDone={onDone} />
      <SetContinuousDiscountAction tenantId={row.tenantId} onDone={onDone} />
      <ManualSettleAction
        invoiceId={invoiceId}
        issuedOn={row.openInvoice?.issuedOn ?? null}
        onDone={onDone}
      />
      <CancelInvoiceAction invoiceId={invoiceId} onDone={onDone} />
      <SetCycleDayAction tenantId={row.tenantId} onDone={onDone} />
      <SetFrozenAction tenantId={row.tenantId} frozen={row.frozen} onDone={onDone} />
      <SetCustomPriceAction
        tenantId={row.tenantId}
        currentPriceCents={row.customPriceCents}
        onDone={onDone}
      />
      <ResendBillingEmailAction invoiceId={invoiceId} onDone={onDone} />
    </div>
  );
}

function TenantSituationCell({ row }: { row: AdminBillingTenantRow }) {
  return (
    <div className="space-y-1">
      <Badge variant={adminTenantSituationTone(row.accessState)}>
        {adminTenantSituationLabel(row.accessState)}
      </Badge>
      {row.openInvoice && (
        <div className="text-xs text-muted-foreground">
          {formatCentsBRL(row.openInvoice.amountCents)} · vence {formatDateBR(row.openInvoice.dueDate)}
        </div>
      )}
      {row.continuousDiscount && (
        <div className="text-xs text-muted-foreground">
          Desconto contínuo: {row.continuousDiscount.kind === "percent"
            ? `${row.continuousDiscount.value}%`
            : formatCentsBRL(row.continuousDiscount.value)}
        </div>
      )}
    </div>
  );
}

function BillingTenantRowView({ row }: { row: AdminBillingTenantRow }) {
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{row.name}</div>
        <div className="text-xs text-muted-foreground">{row.slug}</div>
      </TableCell>
      <TableCell>{row.planCode}</TableCell>
      <TableCell>
        {row.customPriceCents != null ? formatCentsBRL(row.customPriceCents) : "-"}
      </TableCell>
      <TableCell>
        <TenantSituationCell row={row} />
      </TableCell>
      <TableCell>
        <TenantActionsRow row={row} />
      </TableCell>
    </TableRow>
  );
}

/** The full "Faturamento" tab list — every house. */
export function BillingTenantListCard() {
  const fn = useServerFn(adminBillingTenantList);
  const { data, isLoading, isError } = useQuery({
    queryKey: BILLING_TENANT_LIST_QUERY_KEY,
    queryFn: () => fn() as Promise<AdminBillingTenantRow[]>,
  });

  const rows = data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-primary" />
          Casas
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Casa</TableHead>
              <TableHead>Plano</TableHead>
              <TableHead>Preço próprio</TableHead>
              <TableHead>Situação</TableHead>
              <TableHead>Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5} className="py-4">
                    <div className="h-4 w-full animate-pulse rounded bg-muted/30" />
                  </TableCell>
                </TableRow>
              ))}
            {!isLoading && rows.map((row) => <BillingTenantRowView key={row.tenantId} row={row} />)}
            {!isLoading && !isError && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                  Nenhuma casa encontrada.
                </TableCell>
              </TableRow>
            )}
            {isError && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                  Não foi possível carregar a lista agora.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Single-tenant "Cobrança" view, reused by `tenants.tsx` (ruling 3): same situation badge and
 * the same 11 action dialogs, scoped to one house found in `rows`. */
export function BillingTenantCobrancaCard({ tenantId }: { tenantId: string }) {
  const fn = useServerFn(adminBillingTenantList);
  const { data, isLoading, isError } = useQuery({
    queryKey: BILLING_TENANT_LIST_QUERY_KEY,
    queryFn: () => fn() as Promise<AdminBillingTenantRow[]>,
  });

  const row = (data ?? []).find((r) => r.tenantId === tenantId) ?? null;

  if (isLoading) return <Card className="h-40 animate-pulse" />;
  if (isError || !row) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Não foi possível carregar a cobrança desta casa agora.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-primary" />
          Cobrança
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <TenantSituationCell row={row} />
        <TenantActionsRow row={row} />
      </CardContent>
    </Card>
  );
}
