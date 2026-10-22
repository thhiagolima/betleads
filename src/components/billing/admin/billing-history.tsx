// Design section 6, item 10: "Histórico da casa: linha do tempo de faturas, pagamentos,
// descontos, extensões, dias grátis, bloqueios e trocas de plano, cada um com autor e data."
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { History } from "lucide-react";

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
  adminTenantBillingHistory,
  type BillingHistoryItem,
} from "@/lib/billing/billing-admin.functions";

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString("pt-BR");
}

export function BillingHistoryCard({
  tenantId,
  queryKey,
}: {
  tenantId: string | null;
  queryKey: unknown[];
}) {
  const fn = useServerFn(adminTenantBillingHistory);
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => fn({ data: { tenantId: tenantId! } }) as Promise<BillingHistoryItem[]>,
    enabled: !!tenantId,
  });

  const items = data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5 text-primary" />
          Histórico da casa
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Quando</TableHead>
              <TableHead>Evento</TableHead>
              <TableHead>Detalhe</TableHead>
              <TableHead>Autor</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={4} className="py-4">
                    <div className="h-4 w-full animate-pulse rounded bg-muted/30" />
                  </TableCell>
                </TableRow>
              ))}
            {!isLoading &&
              items.map((item, index) => (
                <TableRow key={`${item.kind}-${item.at}-${index}`}>
                  <TableCell className="whitespace-nowrap">{fmtDateTime(item.at)}</TableCell>
                  <TableCell>{item.title}</TableCell>
                  <TableCell className="max-w-xs truncate">{item.detail}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {item.actor ?? "-"}
                  </TableCell>
                </TableRow>
              ))}
            {!isLoading && !isError && items.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                  Nenhum evento de cobrança ainda.
                </TableCell>
              </TableRow>
            )}
            {isError && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                  Não foi possível carregar o histórico agora.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
