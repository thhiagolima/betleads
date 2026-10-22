// PG1 Task 8 (fix round 1) — shared between /plano-e-creditos and /tenants'
// "Saldo SMS" tab, which must show the same month-usage/price-table summary
// (same `wallet_summary` shape) instead of two hand-maintained copies.
import {
  BILLING_ITEM_LABEL,
  BILLING_ITEMS,
  type BillingItem,
  brl,
  brlUnitPrice,
  num,
} from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type { BillingItem };

export type WalletPriceRow = {
  unit_price?: number;
  free_monthly_units?: number;
};

export type WalletMonthUsageRow = {
  item: BillingItem;
  units: number;
  free_units_used: number;
  billed_amount: number;
};

/**
 * "Consumo do mês": units/billed per channel, with the e-mail franchise line
 * ("X de 100.000 grátis") only when that item has a free monthly tier.
 */
export function MonthUsageCard({
  monthUsage,
  prices,
}: {
  monthUsage: WalletMonthUsageRow[];
  prices: Partial<Record<BillingItem, WalletPriceRow>>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Consumo do mês</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-3">
        {BILLING_ITEMS.map((item) => {
          const usage = monthUsage.find((row) => row.item === item);
          const freeUnits = Number(prices[item]?.free_monthly_units ?? 0);
          return (
            <Card key={item} className="bg-background/40">
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">{BILLING_ITEM_LABEL[item]}</p>
                <p className="mt-1 text-2xl font-bold">{num(Number(usage?.units ?? 0))}</p>
                {freeUnits > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {num(Number(usage?.free_units_used ?? 0))} de {num(freeUnits)} grátis
                  </p>
                )}
                <p className="mt-2 text-sm font-medium">
                  {brl(Number(usage?.billed_amount ?? 0))} cobrados
                </p>
              </CardContent>
            </Card>
          );
        })}
      </CardContent>
    </Card>
  );
}

/** "Preços vigentes": unit price (up to 3 decimals) and monthly franchise per channel. */
export function CurrentPricesCard({
  prices,
}: {
  prices: Partial<Record<BillingItem, WalletPriceRow>>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Preços vigentes</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Canal</TableHead>
              <TableHead className="text-right">Preço unitário</TableHead>
              <TableHead className="text-right">Franquia mensal</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {BILLING_ITEMS.map((item) => (
              <TableRow key={item}>
                <TableCell>{BILLING_ITEM_LABEL[item]}</TableCell>
                <TableCell className="text-right">
                  {brlUnitPrice(prices[item]?.unit_price ?? 0)}
                </TableCell>
                <TableCell className="text-right">
                  {Number(prices[item]?.free_monthly_units ?? 0) > 0
                    ? num(Number(prices[item]?.free_monthly_units))
                    : "-"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
