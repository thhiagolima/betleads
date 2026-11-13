import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw, Send } from "lucide-react";
import { toast } from "sonner";

import { formatDateTime } from "@/components/integrations/meta/meta-format";
import { SMS_ROUTE_PROBE_STATUS_KEY } from "@/components/sms-route-probe-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { DataCard } from "@/components/ui-premium/data-card";
import {
  MAX_PROBE_PHONES,
  PROBE_INTERVAL_MINUTES,
  type ProbeResult,
  type ProbeStatus,
} from "@/lib/sms-route-probe";
import {
  getSmsRouteProbeOverview,
  runSmsRouteProbeNow,
  saveSmsRouteProbeSettings,
} from "@/lib/sms-route-probe.functions";

const OVERVIEW_KEY = ["admin", "sms-route-probe"] as const;

const RESULT_LABEL: Record<ProbeResult, string> = {
  accepted: "Aceito",
  no_balance: "Sem saldo",
  auth_error: "Credencial recusada",
  error: "Erro no envio",
};

function deliveryLabel(result: ProbeResult, status: string | null): string {
  if (result !== "accepted") return "—";
  if (status === "delivered") return "Entregue";
  if (status === "failed") return "Não entregue";
  return "Aguardando";
}

function balanceText(status: ProbeStatus): { text: string; tone: "ok" | "bad" | "muted" } {
  if (status.balance === "no_balance") {
    return {
      text: `Sem saldo${status.noBalanceSince ? ` desde ${formatDateTime(status.noBalanceSince)}` : ""}`,
      tone: "bad",
    };
  }
  if (status.balance === "ok") return { text: "Com saldo (último teste aceito)", tone: "ok" };
  if (status.lastError) return { text: `Erro no último teste: ${status.lastError}`, tone: "bad" };
  return { text: "Sem teste nas últimas 24 h", tone: "muted" };
}

function deliveryText(status: ProbeStatus): { text: string; tone: "ok" | "bad" | "muted" } {
  switch (status.delivery) {
    case "delivering":
      return {
        text: `Entregando${status.lastDeliveredAt ? ` (última entrega ${formatDateTime(status.lastDeliveredAt)})` : ""}`,
        tone: "ok",
      };
    case "not_delivering":
      return {
        text: `Sem confirmação de entrega${status.notDeliveringSince ? ` desde ${formatDateTime(status.notDeliveringSince)}` : ""}`,
        tone: "bad",
      };
    case "pending":
      return { text: "Aguardando a confirmação do último teste", tone: "muted" };
    default:
      return { text: "Sem teste aceito nas últimas 24 h", tone: "muted" };
  }
}

const TONE_CLASS = {
  ok: "text-success",
  bad: "text-danger",
  muted: "text-muted-foreground",
} as const;

/** Painel do super admin: SMS de controle a cada 30 min para medir saldo e entrega da rota. */
export function SmsRouteProbePanel() {
  const fetchOverview = useServerFn(getSmsRouteProbeOverview);
  const saveFn = useServerFn(saveSmsRouteProbeSettings);
  const runFn = useServerFn(runSmsRouteProbeNow);
  const qc = useQueryClient();
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: () => fetchOverview(),
    refetchInterval: 60_000,
  });

  const [phonesText, setPhonesText] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!data || dirty) return;
    setPhonesText(data.settings.phones.join("\n"));
    setEnabled(data.settings.enabled);
  }, [data, dirty]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
    void qc.invalidateQueries({ queryKey: SMS_ROUTE_PROBE_STATUS_KEY });
  };

  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          enabled,
          phones: phonesText.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean),
        },
      }),
    onSuccess: (saved) => {
      toast.success(saved.enabled ? "Teste da rota ligado." : "Configuração salva.");
      setDirty(false);
      refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const run = useMutation({
    mutationFn: () => runFn(),
    onSuccess: (result) => {
      if (result.skipped === "no_phones") {
        toast.error("Cadastre e salve pelo menos um número antes de testar.");
      } else if (result.results.includes("no_balance")) {
        toast.error("A Short Brasil recusou o SMS: conta sem saldo.");
      } else if (result.results.every((r) => r === "accepted")) {
        toast.success(`SMS de controle aceito para ${result.sent} número(s).`);
      } else {
        toast.error("A Short Brasil recusou o SMS de controle. Veja o erro na tabela.");
      }
      refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const status = data?.status;
  const balance = status ? balanceText(status) : null;
  const delivery = status ? deliveryText(status) : null;

  return (
    <DataCard
      title="Teste da rota SMS"
      description={`A cada ${PROBE_INTERVAL_MINUTES} minutos a plataforma manda um SMS de controle pela Short Brasil (texto variado e código único) para os números abaixo. Mostra se a conta tem saldo e se os SMS estão chegando. Não é cobrado de nenhuma casa.`}
      actions={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void refetch()}
          disabled={isFetching}
          aria-label="Atualizar"
        >
          <RefreshCw className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </Button>
      }
      bodyClassName="space-y-5"
    >
      {isError && <p className="text-body text-danger">Não foi possível carregar o teste da rota.</p>}
      {isLoading && <p className="text-body text-muted-foreground">Carregando…</p>}

      {status && balance && delivery && (
        <dl className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-label text-muted-foreground">Saldo da conta</dt>
            <dd className={`text-body font-medium ${TONE_CLASS[balance.tone]}`}>{balance.text}</dd>
          </div>
          <div>
            <dt className="text-label text-muted-foreground">Entrega</dt>
            <dd className={`text-body font-medium ${TONE_CLASS[delivery.tone]}`}>{delivery.text}</dd>
          </div>
          <div>
            <dt className="text-label text-muted-foreground">Último teste</dt>
            <dd className="text-body">
              {status.lastProbeAt ? formatDateTime(status.lastProbeAt) : "Nenhum"}
              {data?.accountLabel ? (
                <span className="text-meta text-muted-foreground"> · conta {data.accountLabel}</span>
              ) : null}
            </dd>
          </div>
        </dl>
      )}

      {data && (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="sms-route-probe-phones">
              Números que recebem o teste (um por linha, até {MAX_PROBE_PHONES})
            </Label>
            <Textarea
              id="sms-route-probe-phones"
              rows={3}
              placeholder="11999998888"
              value={phonesText}
              onChange={(event) => {
                setPhonesText(event.target.value);
                setDirty(true);
              }}
            />
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Switch
                id="sms-route-probe-enabled"
                checked={enabled}
                onCheckedChange={(value) => {
                  setEnabled(value);
                  setDirty(true);
                }}
              />
              <Label htmlFor="sms-route-probe-enabled">
                Enviar a cada {PROBE_INTERVAL_MINUTES} min
              </Label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
                Salvar
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => run.mutate()}
                disabled={run.isPending || dirty || data.settings.phones.length === 0}
                title={dirty ? "Salve antes de testar" : undefined}
              >
                <Send className="mr-1.5 h-3.5 w-3.5" /> Testar agora
              </Button>
            </div>
          </div>
        </div>
      )}

      {data && data.recent.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Enviado em</TableHead>
                <TableHead>Número</TableHead>
                <TableHead>Código</TableHead>
                <TableHead>Envio</TableHead>
                <TableHead>Entrega</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recent.map((row) => (
                <TableRow key={row.probe_code}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(row.sent_at)}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-meta">{row.phone}</TableCell>
                  <TableCell className="font-mono text-meta">{row.probe_code}</TableCell>
                  <TableCell>
                    <Badge variant={row.result === "accepted" ? "secondary" : "destructive"}>
                      {RESULT_LABEL[row.result]}
                    </Badge>
                    {row.result !== "accepted" && row.error ? (
                      <div className="mt-1 text-meta text-muted-foreground">{row.error}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {deliveryLabel(row.result, row.delivery_status)}
                    {row.result === "accepted" && row.delivery_status === "failed" && row.error ? (
                      <div className="text-meta text-muted-foreground">{row.error}</div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </DataCard>
  );
}
