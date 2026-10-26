import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Download, ShieldCheck, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DataCard } from "@/components/ui-premium/data-card";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  exportChannelConsents,
  importChannelConsents,
  listChannelConsents,
  saveChannelConsent,
  saveVoiceContactPolicy,
} from "@/lib/consent.functions";

export const Route = createFileRoute("/consentimentos")({ component: ConsentPage });

type Channel = "sms" | "email" | "voice";
type Status = "granted" | "revoked";
type ConsentRow = {
  id: string;
  channel: Channel;
  subject: string;
  status: Status;
  legal_basis: string | null;
  reason: string;
  source: string;
  updated_at: string;
};
type AuditRow = {
  id: string;
  channel: Channel;
  subject: string;
  previous_status: string | null;
  new_status: string;
  reason: string | null;
  source: string | null;
  created_at: string;
};

const channelName: Record<Channel, string> = { sms: "SMS", email: "E-mail", voice: "Voz" };

const VIEWS = [
  { value: "base", label: "Base" },
  { value: "registrar", label: "Registrar" },
  { value: "historico", label: "Histórico" },
  { value: "voz", label: "Limites de voz" },
] as const;
type View = (typeof VIEWS)[number]["value"];

const STATUS_LABEL: Record<string, string> = { revoked: "Bloqueado", granted: "Autorizado" };
const SOURCE_LABEL: Record<string, string> = {
  operator: "Equipe",
  csv: "Importação",
  unsubscribe: "Link de descadastro",
};
const REASON_LABEL: Record<string, string> = {
  solicitacao_do_titular: "Pedido do titular",
  unsubscribe: "Pediu descadastro",
  complaint: "Marcou como spam",
  bounce_hard: "E-mail inexistente",
  repeated_failures: "Falhas repetidas",
  manual: "Bloqueio manual",
};
/** Known codes get a label; anything else is shown as typed, without underscores. */
const humanize = (map: Record<string, string>, value: string | null | undefined) =>
  !value ? "—" : (map[value] ?? value.replaceAll("_", " "));
const dateTime = (value: string) =>
  new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

function parseCsv(value: string) {
  const lines = value.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("Informe o cabeçalho e ao menos uma linha");
  const headers = lines[0].split(",").map((v) => v.trim().toLowerCase());
  const required = ["channel", "subject", "status", "reason"];
  if (required.some((name) => !headers.includes(name)))
    throw new Error(`Cabeçalho obrigatório: ${required.join(",")}`);
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((v) => v.trim());
    const get = (name: string) => cells[headers.indexOf(name)] ?? "";
    const channel = get("channel") as Channel;
    const status = get("status") as Status;
    if (!(["sms", "email", "voice"] as string[]).includes(channel))
      throw new Error(`Canal inválido: ${channel} (use sms, email ou voice)`);
    if (!(["granted", "revoked"] as string[]).includes(status))
      throw new Error(`Situação inválida: ${status} (use granted ou revoked)`);
    return {
      channel,
      subject: get("subject"),
      status,
      reason: get("reason"),
      legalBasis: get("legal_basis") || undefined,
      source: get("source") || "csv",
    };
  });
}

function ConsentPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listChannelConsents);
  const saveFn = useServerFn(saveChannelConsent);
  const importFn = useServerFn(importChannelConsents);
  const savePolicyFn = useServerFn(saveVoiceContactPolicy);
  const exportFn = useServerFn(exportChannelConsents);
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash.replace(/^#/, "") });
  const view: View = VIEWS.find((item) => item.value === hash)?.value ?? "base";
  const setView = (next: View) =>
    void navigate({ to: "/consentimentos", hash: next === "base" ? undefined : next });
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [channel, setChannel] = useState<Channel>("sms");
  const [subject, setSubject] = useState("");
  const [status, setStatus] = useState<Status>("revoked");
  const [reason, setReason] = useState("Pedido do titular");
  const [legalBasis, setLegalBasis] = useState("");
  const [csv, setCsv] = useState("channel,subject,status,reason,legal_basis,source\n");
  const [voicePolicyEnabled, setVoicePolicyEnabled] = useState(true);
  const [cooldownHours, setCooldownHours] = useState(24);
  const [rolling24hLimit, setRolling24hLimit] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  // Busca no servidor (por destinatário), sobre a base inteira da casa.
  const query = useQuery({
    queryKey: ["channel-consents", debouncedSearch],
    queryFn: () => listFn({ data: { search: debouncedSearch || null } }),
    placeholderData: keepPreviousData,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["channel-consents"] });
  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          channel,
          subject,
          status,
          reason,
          legalBasis: legalBasis || undefined,
          source: "operator",
        },
      }),
    onSuccess: () => {
      toast.success("Decisão registrada");
      setSubject("");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const importCsv = useMutation({
    mutationFn: () => importFn({ data: { rows: parseCsv(csv) } }),
    onSuccess: (result) => {
      toast.success(`${result.imported.toLocaleString("pt-BR")} registros importados`);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  // Dependências primitivas: refazer a busca não sobrescreve o que o operador
  // está editando, só uma mudança real na política salva.
  const policy = query.data?.voicePolicy;
  const policyEnabled = policy?.enabled;
  const policyCooldown = policy?.cooldown_hours;
  const policyLimit = policy?.rolling_24h_limit;
  useEffect(() => {
    if (policyEnabled === undefined) return;
    setVoicePolicyEnabled(policyEnabled);
    if (policyCooldown !== undefined) setCooldownHours(policyCooldown);
    if (policyLimit !== undefined) setRolling24hLimit(policyLimit);
  }, [policyEnabled, policyCooldown, policyLimit]);
  const savePolicy = useMutation({
    mutationFn: () =>
      savePolicyFn({ data: { enabled: voicePolicyEnabled, cooldownHours, rolling24hLimit } }),
    onSuccess: () => {
      toast.success("Limites de voz salvos");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const items = (query.data?.items ?? []) as ConsentRow[];
  const total = query.data?.total ?? 0;
  const audit = (query.data?.audit ?? []) as AuditRow[];

  // Exportação vem do servidor: base inteira da casa, sem o recorte da tela.
  const exportCsv = useMutation({
    mutationFn: () => exportFn({ data: {} }),
    onSuccess: (result) => {
      const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `consentimentos-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      if (result.truncated)
        toast.warning(
          `Exportação limitada a ${result.rows.toLocaleString("pt-BR")} registros. Fale com o suporte para a base completa.`,
        );
      else toast.success(`${result.rows.toLocaleString("pt-BR")} registros exportados`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const select = "mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-body";

  return (
    <Page>
      <PageHeader
        subtitle="Quem pediu para não receber SMS, e-mail ou ligações. Um bloqueio vale para todas as campanhas e automações da casa."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportCsv.mutate()}
            disabled={exportCsv.isPending || (!debouncedSearch && total === 0)}
          >
            <Download className="mr-2 size-4" aria-hidden="true" />
            {exportCsv.isPending ? "Exportando…" : "Exportar CSV"}
          </Button>
        }
      />

      <PageTabs
        value={view}
        onValueChange={setView}
        label="Seções de consentimentos"
        items={VIEWS}
      />

      <div role="tabpanel" aria-labelledby={`tab-${view}`} className="space-y-4">
        {view === "base" && (
          <DataCard
            title={
              debouncedSearch
                ? `${total.toLocaleString("pt-BR")} encontrados`
                : `${total.toLocaleString("pt-BR")} ${total === 1 ? "registro" : "registros"}`
            }
            description="A busca olha a base inteira da casa."
          >
            <Input
              className="mb-4 max-w-md"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por telefone ou e-mail"
              aria-label="Buscar por telefone ou e-mail"
            />
            {total > items.length && (
              <p className="mb-3 text-meta text-muted-foreground">
                Mostrando os {items.length.toLocaleString("pt-BR")} mais recentes de{" "}
                {total.toLocaleString("pt-BR")}. Use a busca ou exporte o CSV para ver todos.
              </p>
            )}
            {query.isLoading ? (
              <div className="space-y-2" aria-busy="true" aria-label="Carregando">
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} className="h-12 rounded-lg" />
                ))}
              </div>
            ) : query.isError ? (
              <EmptyState
                title="Não foi possível carregar os consentimentos"
                description="Tente novamente em instantes."
                action={
                  <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                    Tentar novamente
                  </Button>
                }
              />
            ) : items.length === 0 ? (
              <EmptyState
                icon={<ShieldCheck />}
                title={
                  debouncedSearch ? "Nenhum destinatário encontrado" : "Nenhum bloqueio registrado"
                }
                description={
                  debouncedSearch
                    ? "Confira o número (com DDD) ou o e-mail."
                    : "Descadastros pelo link do e-mail e decisões da equipe aparecem aqui."
                }
                action={
                  debouncedSearch ? undefined : (
                    <Button size="sm" variant="outline" onClick={() => setView("registrar")}>
                      Registrar decisão
                    </Button>
                  )
                }
              />
            ) : (
              <>
                <ul className="divide-y divide-border md:hidden">
                  {items.map((row) => (
                    <li key={row.id} className="py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-mono text-body">{row.subject}</p>
                          <p className="text-meta text-muted-foreground">
                            {channelName[row.channel]} · {humanize(REASON_LABEL, row.reason)}
                          </p>
                        </div>
                        <StatusBadge status={row.status} />
                      </div>
                      <p className="mt-1 text-meta text-muted-foreground">
                        {humanize(SOURCE_LABEL, row.source)} · {dateTime(row.updated_at)}
                      </p>
                    </li>
                  ))}
                </ul>
                <div className="hidden overflow-x-auto md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Canal</TableHead>
                        <TableHead>Destinatário</TableHead>
                        <TableHead>Situação</TableHead>
                        <TableHead>Motivo</TableHead>
                        <TableHead>Origem</TableHead>
                        <TableHead>Atualizado</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>{channelName[row.channel]}</TableCell>
                          <TableCell className="font-mono">{row.subject}</TableCell>
                          <TableCell>
                            <StatusBadge status={row.status} />
                          </TableCell>
                          <TableCell>{humanize(REASON_LABEL, row.reason)}</TableCell>
                          <TableCell>{humanize(SOURCE_LABEL, row.source)}</TableCell>
                          <TableCell className="whitespace-nowrap">
                            {dateTime(row.updated_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </DataCard>
        )}

        {view === "registrar" && (
          <>
            <DataCard
              title="Registrar decisão"
              description="Bloqueie ou autorize um telefone ou e-mail. Toda decisão fica no histórico."
            >
              <div className="grid gap-4 md:grid-cols-6">
                <div>
                  <Label htmlFor="consent-channel">Canal</Label>
                  <select
                    id="consent-channel"
                    className={select}
                    value={channel}
                    onChange={(e) => setChannel(e.target.value as Channel)}
                  >
                    <option value="sms">SMS</option>
                    <option value="email">E-mail</option>
                    <option value="voice">Voz</option>
                  </select>
                </div>
                <div className="md:col-span-2">
                  <Label htmlFor="consent-subject">Telefone ou e-mail</Label>
                  <Input
                    id="consent-subject"
                    className="mt-2"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder={channel === "email" ? "cliente@exemplo.com" : "11999999999"}
                  />
                </div>
                <div>
                  <Label htmlFor="consent-status">Decisão</Label>
                  <select
                    id="consent-status"
                    className={select}
                    value={status}
                    onChange={(e) => setStatus(e.target.value as Status)}
                  >
                    <option value="revoked">Bloquear</option>
                    <option value="granted">Autorizar</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="consent-basis">Base legal (opcional)</Label>
                  <Input
                    id="consent-basis"
                    className="mt-2"
                    value={legalBasis}
                    onChange={(e) => setLegalBasis(e.target.value)}
                    placeholder="Consentimento"
                  />
                </div>
                <div>
                  <Label htmlFor="consent-reason">Motivo</Label>
                  <Input
                    id="consent-reason"
                    className="mt-2"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
              </div>
              <Button
                className="mt-4"
                onClick={() => save.mutate()}
                disabled={save.isPending || subject.trim().length < 3 || !reason.trim()}
              >
                {save.isPending ? "Salvando…" : "Salvar decisão"}
              </Button>
            </DataCard>

            <DataCard
              title="Importar em lote"
              description="Cole um CSV com até 5.000 linhas. Colunas: channel (sms, email ou voice), subject (telefone ou e-mail), status (revoked para bloquear, granted para autorizar), reason e, se quiser, legal_basis e source."
            >
              <Textarea
                className="min-h-28 font-mono text-meta"
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                aria-label="Conteúdo do CSV"
              />
              <Button
                className="mt-3"
                variant="secondary"
                onClick={() => importCsv.mutate()}
                disabled={importCsv.isPending}
              >
                <Upload className="mr-2 size-4" aria-hidden="true" />
                {importCsv.isPending ? "Importando…" : "Importar"}
              </Button>
            </DataCard>
          </>
        )}

        {view === "historico" && (
          <DataCard title="Histórico" description="As 100 alterações mais recentes.">
            {query.isLoading ? (
              <Skeleton className="h-40 rounded-lg" />
            ) : audit.length === 0 ? (
              <EmptyState title="Nenhuma alteração ainda" />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Data</TableHead>
                      <TableHead>Canal</TableHead>
                      <TableHead>Destinatário</TableHead>
                      <TableHead>Alteração</TableHead>
                      <TableHead>Motivo</TableHead>
                      <TableHead>Origem</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {audit.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="whitespace-nowrap">
                          {dateTime(row.created_at)}
                        </TableCell>
                        <TableCell>{channelName[row.channel]}</TableCell>
                        <TableCell className="font-mono">{row.subject}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {row.previous_status
                            ? humanize(STATUS_LABEL, row.previous_status)
                            : "Novo"}{" "}
                          → {humanize(STATUS_LABEL, row.new_status)}
                        </TableCell>
                        <TableCell>{humanize(REASON_LABEL, row.reason)}</TableCell>
                        <TableCell>{humanize(SOURCE_LABEL, row.source)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </DataCard>
        )}

        {view === "voz" && (
          <DataCard
            title="Limites de voz"
            description="Quantas vezes o mesmo número pode receber ligação. A janela de envio da casa vale sempre, mesmo com os limites desligados."
          >
            <div className="grid gap-4 md:grid-cols-3">
              <label className="flex items-center gap-3 rounded-lg border border-border p-3 text-body">
                <input
                  type="checkbox"
                  checked={voicePolicyEnabled}
                  onChange={(e) => setVoicePolicyEnabled(e.target.checked)}
                />
                Aplicar os limites
              </label>
              <div>
                <Label htmlFor="voice-cooldown">Intervalo mínimo entre ligações (horas)</Label>
                <Input
                  id="voice-cooldown"
                  className="mt-2"
                  type="number"
                  min={0}
                  max={720}
                  value={cooldownHours}
                  onChange={(e) => setCooldownHours(Number(e.target.value))}
                />
              </div>
              <div>
                <Label htmlFor="voice-limit">Máximo de ligações em 24 h</Label>
                <Input
                  id="voice-limit"
                  className="mt-2"
                  type="number"
                  min={1}
                  max={100}
                  value={rolling24hLimit}
                  onChange={(e) => setRolling24hLimit(Number(e.target.value))}
                />
              </div>
            </div>
            <Button
              className="mt-4"
              variant="secondary"
              onClick={() => savePolicy.mutate()}
              disabled={savePolicy.isPending}
            >
              {savePolicy.isPending ? "Salvando…" : "Salvar limites"}
            </Button>
          </DataCard>
        )}
      </div>
    </Page>
  );
}

function StatusBadge({ status }: { status: Status }) {
  return (
    <Badge variant={status === "revoked" ? "destructive" : "secondary"}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}
