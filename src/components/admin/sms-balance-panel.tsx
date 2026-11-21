import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw, Wallet } from "lucide-react";
import { toast } from "sonner";

import { formatDateTime } from "@/components/integrations/meta/meta-format";
import { SMS_BALANCE_BANNER_KEY } from "@/components/sms-balance-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  BALANCE_CHECK_INTERVAL_MINUTES,
  MAX_BALANCE_VIEWERS,
  type BalanceCheckResult,
  type BalanceStatus,
} from "@/lib/sms-balance";
import {
  getSmsBalanceOverview,
  runSmsBalanceCheckNow,
  saveSmsBalanceSettings,
} from "@/lib/sms-balance.functions";

const OVERVIEW_KEY = ["admin", "sms-balance"] as const;

const RESULT_LABEL: Record<BalanceCheckResult, string> = {
  ok: "Lido",
  login_failed: "Login recusado",
  read_failed: "Saldo não encontrado",
  error: "Erro",
};

const TONE_CLASS = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-danger",
  muted: "text-muted-foreground",
} as const;

const sms = (value: number) => `${value.toLocaleString("pt-BR")} SMS`;

function balanceText(status: BalanceStatus): { text: string; tone: keyof typeof TONE_CLASS } {
  if (status.balance == null) {
    return status.lastError
      ? { text: `Sem leitura recente: ${status.lastError}`, tone: "bad" }
      : { text: "Sem leitura recente", tone: "muted" };
  }
  const value = sms(status.balance);
  if (status.level === "empty") return { text: `${value} (sem saldo)`, tone: "bad" };
  if (status.level === "low") return { text: `${value} (abaixo do limite)`, tone: "warn" };
  return { text: value, tone: "ok" };
}

/** Painel do super admin: saldo da Short Brasil lido do painel, limite do aviso e quem vê a barra. */
export function SmsBalancePanel() {
  const fetchOverview = useServerFn(getSmsBalanceOverview);
  const saveFn = useServerFn(saveSmsBalanceSettings);
  const runFn = useServerFn(runSmsBalanceCheckNow);
  const qc = useQueryClient();
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: () => fetchOverview(),
    refetchInterval: 60_000,
  });

  const [thresholdText, setThresholdText] = useState("");
  const [emailsText, setEmailsText] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!data || dirty) return;
    setThresholdText(String(data.settings.lowThreshold));
    setEmailsText(data.viewers.map((v) => v.email).filter(Boolean).join("\n"));
  }, [data, dirty]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
    void qc.invalidateQueries({ queryKey: SMS_BALANCE_BANNER_KEY });
  };

  const save = useMutation({
    mutationFn: () => {
      const lowThreshold = Number(thresholdText.replace(/\D/g, ""));
      if (!thresholdText.trim() || !Number.isFinite(lowThreshold)) {
        throw new Error("Informe o limite em número de SMS.");
      }
      return saveFn({
        data: {
          lowThreshold,
          viewerEmails: emailsText.split(/[\n,;\s]+/).map((e) => e.trim()).filter(Boolean),
        },
      });
    },
    onSuccess: () => {
      toast.success("Aviso de saldo salvo.");
      setDirty(false);
      refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const run = useMutation({
    mutationFn: () => runFn(),
    onSuccess: (read) => {
      if (read.result === "ok") toast.success(`Saldo lido: ${sms(read.shortcodeSms ?? 0)}.`);
      else toast.error(read.error ?? "Não foi possível ler o saldo.");
      refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const status = data?.status;
  const balance = status ? balanceText(status) : null;

  return (
    <DataCard
      title="Saldo da Short Brasil"
      description={`A cada ${BALANCE_CHECK_INTERVAL_MINUTES} minutos a plataforma entra no painel da Short Brasil e lê o saldo de SMS da conta padrão. Com o saldo no limite ou abaixo, aparece uma barra no topo para os super admins e para os usuários listados aqui.`}
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
      {isError && <p className="text-body text-danger">Não foi possível carregar o saldo.</p>}
      {isLoading && <p className="text-body text-muted-foreground">Carregando…</p>}
      {data && !data.configured && (
        <p className="text-body text-danger">
          O login do painel não está configurado no servidor (SHORT_BRASIL_PAINEL_USUARIO e
          SHORT_BRASIL_PAINEL_SENHA). Sem ele o saldo não é lido.
        </p>
      )}

      {status && balance && (
        <dl className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-label text-muted-foreground">Saldo agora</dt>
            <dd className={`text-body font-medium ${TONE_CLASS[balance.tone]}`}>{balance.text}</dd>
          </div>
          <div>
            <dt className="text-label text-muted-foreground">Lido em</dt>
            <dd className="text-body">{status.balanceAt ? formatDateTime(status.balanceAt) : "—"}</dd>
          </div>
          <div>
            <dt className="text-label text-muted-foreground">Última tentativa</dt>
            <dd className="text-body">{status.lastCheckAt ? formatDateTime(status.lastCheckAt) : "Nenhuma"}</dd>
          </div>
        </dl>
      )}

      {data && (
        <div className="grid gap-4 md:grid-cols-[12rem_minmax(0,1fr)_auto] md:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="sms-balance-threshold">Avisar com até (SMS)</Label>
            <Input
              id="sms-balance-threshold"
              inputMode="numeric"
              value={thresholdText}
              onChange={(event) => {
                setThresholdText(event.target.value);
                setDirty(true);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sms-balance-viewers">
              Quem também vê o aviso (e-mail de login no CRM, um por linha, até {MAX_BALANCE_VIEWERS})
            </Label>
            <Textarea
              id="sms-balance-viewers"
              rows={3}
              placeholder="pessoa@exemplo.com"
              value={emailsText}
              onChange={(event) => {
                setEmailsText(event.target.value);
                setDirty(true);
              }}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
              Salvar
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => run.mutate()}
              disabled={run.isPending || !data.configured}
            >
              <Wallet className="mr-1.5 h-3.5 w-3.5" /> Ler agora
            </Button>
          </div>
        </div>
      )}

      {data && data.viewers.length > 0 && (
        <p className="text-meta text-muted-foreground">
          Veem o aviso além dos super admins: {data.viewers.map((v) => v.nome).join(", ")}.
        </p>
      )}

      {data && data.recent.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lido em</TableHead>
                <TableHead>Resultado</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recent.map((row) => (
                <TableRow key={row.checked_at}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(row.checked_at)}</TableCell>
                  <TableCell>
                    <Badge variant={row.result === "ok" ? "secondary" : "destructive"}>
                      {RESULT_LABEL[row.result]}
                    </Badge>
                    {row.result !== "ok" && row.error ? (
                      <div className="mt-1 text-meta text-muted-foreground">{row.error}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    {row.shortcode_sms != null ? sms(row.shortcode_sms) : "—"}
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
