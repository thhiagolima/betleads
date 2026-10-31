import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BellRing, CircleAlert, Megaphone, RefreshCw } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { relativeTimePtBr } from "@/components/integrations/meta-connection-model";
import { ToneBadge } from "@/components/integrations/meta/meta-badges";
import { formatDateTime } from "@/components/integrations/meta/meta-format";
import { RunStatusBadge, triggerLabel } from "@/components/integrations/meta/sync-history";
import type { MetaHouseRow } from "@/lib/meta-admin.server";
import { adminListMetaHouses, adminTestMetaAlert } from "@/lib/meta-admin.functions";
import { cn } from "@/lib/utils";

// Painel "Meta Ads por casa" (MB4-03): saúde da integração Meta de cada casa e o
// botão que testa o caminho dos alertas (Sentry ou log).

export const META_HOUSES_QUERY_KEY = ["admin", "integrations", "meta-houses"] as const;

// Indexado por string: um código novo do servidor (ainda sem rótulo aqui) cai no
// rótulo genérico em vez de quebrar o painel.
export const META_ALERT_LABEL: Record<string, string> = {
  run_stuck: "Sincronização travada",
  account_error: "Conta com erro",
  connection_error: "Chave com erro",
  token_expiring: "Chave expirando",
  house_stale: "Dados atrasados",
};

export const META_ALERT_FALLBACK_LABEL = "Alerta da Meta";

const META_ALERT_ERROR_CODES = new Set(["run_stuck", "account_error", "connection_error"]);

/** Rótulo em português do código de alerta; código desconhecido = rótulo genérico. */
export function metaAlertLabel(code: string) {
  return Object.hasOwn(META_ALERT_LABEL, code) ? META_ALERT_LABEL[code] : META_ALERT_FALLBACK_LABEL;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function MetaHousesPanel() {
  const listFn = useServerFn(adminListMetaHouses);
  const testFn = useServerFn(adminTestMetaAlert);
  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useQuery({
    queryKey: META_HOUSES_QUERY_KEY,
    queryFn: () => listFn() as Promise<MetaHouseRow[]>,
  });
  const test = useMutation({
    mutationFn: () => testFn(),
    onSuccess: (result) => {
      toast.success("Alerta de teste enviado.", {
        description: result.sentry ? undefined : "Sentry desativado: o alerta foi para o log.",
      });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  // O "há X h" anda junto com a leitura da lista, não a cada render.
  const now = useMemo(
    () => (dataUpdatedAt ? new Date(dataUpdatedAt) : new Date()),
    [dataUpdatedAt],
  );

  return (
    <MetaHousesCard
      houses={data ?? []}
      loading={isLoading}
      failed={isError}
      now={now}
      refreshing={isFetching}
      onRefresh={() => void refetch()}
      testing={test.isPending}
      onTest={() => test.mutate()}
    />
  );
}

export function MetaHousesCard({
  houses,
  loading,
  failed,
  now,
  refreshing,
  onRefresh,
  testing,
  onTest,
}: {
  houses: MetaHouseRow[];
  loading: boolean;
  failed: boolean;
  now: Date;
  refreshing: boolean;
  onRefresh: () => void;
  testing: boolean;
  onTest: () => void;
}) {
  const withAlerts = houses.filter((house) => house.alerts.length > 0).length;
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-primary" /> Meta Ads por casa
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Chaves, contas e a última leitura de cada casa com a Meta conectada.
            {houses.length > 0 &&
              ` ${withAlerts === 0 ? "Nenhuma casa com alerta." : `${withAlerts} ${withAlerts === 1 ? "casa com alerta" : "casas com alerta"}.`}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onTest} disabled={testing}>
            <BellRing className="h-4 w-4" /> Testar alerta
          </Button>
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} /> Atualizar
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {failed && (
          <p role="alert" className="flex items-center gap-2 px-6 pb-4 text-sm text-destructive">
            <CircleAlert className="h-4 w-4 shrink-0" /> Não foi possível carregar as casas.
          </p>
        )}
        {loading ? (
          <p className="px-6 pb-6 text-center text-sm text-muted-foreground">Carregando…</p>
        ) : houses.length === 0 && !failed ? (
          <p className="px-6 pb-6 text-center text-sm text-muted-foreground">
            Nenhuma casa com a Meta conectada.
          </p>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Casa</TableHead>
                    <TableHead>Chaves</TableHead>
                    <TableHead>Contas</TableHead>
                    <TableHead>Última leitura</TableHead>
                    <TableHead>Última sincronização</TableHead>
                    <TableHead>Alertas</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {houses.map((house) => (
                    <TableRow key={house.tenantId} className="align-top">
                      <TableCell className="font-medium">{houseName(house)}</TableCell>
                      <TableCell className="text-meta">
                        <ConnectionsText house={house} />
                      </TableCell>
                      <TableCell className="text-meta">
                        <AccountsText house={house} />
                      </TableCell>
                      <TableCell className="text-meta">
                        <LastReadText house={house} now={now} />
                      </TableCell>
                      <TableCell>
                        <LatestRun house={house} />
                      </TableCell>
                      <TableCell className="max-w-sm">
                        <Alerts house={house} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <ul className="space-y-3 px-4 pb-4 md:hidden">
              {houses.map((house) => (
                <li
                  key={house.tenantId}
                  className="space-y-2 rounded-lg border border-border/70 p-3"
                  aria-label={houseName(house)}
                >
                  <p className="font-medium">{houseName(house)}</p>
                  <dl className="grid grid-cols-2 gap-2 text-meta">
                    <Field label="Chaves">
                      <ConnectionsText house={house} />
                    </Field>
                    <Field label="Contas">
                      <AccountsText house={house} />
                    </Field>
                    <Field label="Última leitura">
                      <LastReadText house={house} now={now} />
                    </Field>
                    <Field label="Última sincronização">
                      <LatestRun house={house} />
                    </Field>
                  </dl>
                  <Alerts house={house} />
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function houseName(house: MetaHouseRow) {
  return house.tenantName ?? house.tenantId;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function ConnectionsText({ house }: { house: MetaHouseRow }) {
  const { connected, error, total } = house.connections;
  return (
    <span>
      {connected} de {total} {total === 1 ? "conectada" : "conectadas"}
      {error > 0 && <span className="block text-destructive">{error} com erro</span>}
    </span>
  );
}

function AccountsText({ house }: { house: MetaHouseRow }) {
  const { selected, total, inError } = house.accounts;
  return (
    <span>
      {selected} de {total} {total === 1 ? "marcada" : "marcadas"}
      {inError > 0 && <span className="block text-destructive">{inError} em erro</span>}
    </span>
  );
}

function LastReadText({ house, now }: { house: MetaHouseRow; now: Date }) {
  if (!house.lastSuccessAt) return <span className="text-muted-foreground">sem leitura</span>;
  return (
    <span title={formatDateTime(house.lastSuccessAt) ?? undefined}>
      {relativeTimePtBr(house.lastSuccessAt, now)}
    </span>
  );
}

function LatestRun({ house }: { house: MetaHouseRow }) {
  const run = house.latestRun;
  if (!run) return <span className="text-meta text-muted-foreground">nenhuma</span>;
  return (
    <div className="flex flex-col items-start gap-1">
      <RunStatusBadge status={run.status} />
      <span className="text-meta text-muted-foreground">
        {triggerLabel({ trigger_type: run.triggerType, days: null })} ·{" "}
        {formatDateTime(run.finishedAt ?? run.createdAt) ?? "—"}
      </span>
    </div>
  );
}

function Alerts({ house }: { house: MetaHouseRow }) {
  if (house.alerts.length === 0) {
    return <ToneBadge tone="ok">sem alertas</ToneBadge>;
  }
  return (
    <ul className="space-y-1.5">
      {house.alerts.map((alert, index) => (
        <li key={`${alert.code}-${index}`} className="space-y-0.5">
          <ToneBadge tone={META_ALERT_ERROR_CODES.has(alert.code) ? "error" : "attention"}>
            {metaAlertLabel(alert.code)}
          </ToneBadge>
          <p className="break-words text-meta text-muted-foreground">{alert.message}</p>
        </li>
      ))}
    </ul>
  );
}
