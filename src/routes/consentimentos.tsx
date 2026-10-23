import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Download, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
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
      throw new Error(`Canal inválido: ${channel}`);
    if (!(["granted", "revoked"] as string[]).includes(status))
      throw new Error(`Status inválido: ${status}`);
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
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [channel, setChannel] = useState<Channel>("sms");
  const [subject, setSubject] = useState("");
  const [status, setStatus] = useState<Status>("revoked");
  const [reason, setReason] = useState("solicitacao_do_titular");
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
      toast.success("Consentimento atualizado e auditado");
      setSubject("");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const importCsv = useMutation({
    mutationFn: () => importFn({ data: { rows: parseCsv(csv) } }),
    onSuccess: (result) => {
      toast.success(`${result.imported} registros importados`);
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
      toast.success("Política de contato de voz atualizada");
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

  return (
    <Page>
      <PageHeader
        subtitle="Bloqueio central de SMS, e-mail e voz, com trilha de auditoria por conta."
        actions={
          <Button
            variant="outline"
            onClick={() => exportCsv.mutate()}
            disabled={exportCsv.isPending || (!debouncedSearch && total === 0)}
          >
            <Download className="mr-2 size-4" />
            {exportCsv.isPending ? "Exportando…" : "Exportar CSV"}
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Registrar decisão</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-6">
          <div>
            <Label>Canal</Label>
            <select
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={channel}
              onChange={(e) => setChannel(e.target.value as Channel)}
            >
              <option value="sms">SMS</option>
              <option value="email">E-mail</option>
              <option value="voice">Voz</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <Label>Telefone ou e-mail</Label>
            <Input
              className="mt-2"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={channel === "email" ? "cliente@exemplo.com" : "5511999999999"}
            />
          </div>
          <div>
            <Label>Status</Label>
            <select
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value as Status)}
            >
              <option value="revoked">Revogado</option>
              <option value="granted">Autorizado</option>
            </select>
          </div>
          <div>
            <Label>Base legal</Label>
            <Input
              className="mt-2"
              value={legalBasis}
              onChange={(e) => setLegalBasis(e.target.value)}
              placeholder="consentimento"
            />
          </div>
          <div>
            <Label>Motivo</Label>
            <Input className="mt-2" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="md:col-span-6">
            <Button
              onClick={() => save.mutate()}
              disabled={save.isPending || subject.trim().length < 3 || !reason.trim()}
            >
              Salvar decisão
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Importação em lote</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            CSV: channel,subject,status,reason,legal_basis,source. Limite de 5.000 linhas.
          </p>
          <Textarea
            className="min-h-28 font-mono text-xs"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
          />
          <Button
            variant="secondary"
            onClick={() => importCsv.mutate()}
            disabled={importCsv.isPending}
          >
            <Upload className="mr-2 size-4" />
            Importar e auditar
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Regras de contato por voz</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <label className="flex items-center gap-3 rounded-md border p-3 text-sm">
            <input
              type="checkbox"
              checked={voicePolicyEnabled}
              onChange={(e) => setVoicePolicyEnabled(e.target.checked)}
            />
            Aplicar limite e cooldown
          </label>
          <div>
            <Label>Cooldown por destinatário (horas)</Label>
            <Input
              className="mt-2"
              type="number"
              min={0}
              max={720}
              value={cooldownHours}
              onChange={(e) => setCooldownHours(Number(e.target.value))}
            />
          </div>
          <div>
            <Label>Máximo em 24h por destinatário</Label>
            <Input
              className="mt-2"
              type="number"
              min={1}
              max={100}
              value={rolling24hLimit}
              onChange={(e) => setRolling24hLimit(Number(e.target.value))}
            />
          </div>
          <div className="md:col-span-3">
            <p className="mb-3 text-xs text-muted-foreground">
              A janela de horário configurada para a conta continua obrigatória mesmo com os limites
              desativados.
            </p>
            <Button
              variant="secondary"
              onClick={() => savePolicy.mutate()}
              disabled={savePolicy.isPending}
            >
              Salvar política de voz
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Base central (
            {debouncedSearch
              ? `${total.toLocaleString("pt-BR")} encontrados`
              : total.toLocaleString("pt-BR")}
            )
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            className="mb-4 max-w-md"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pesquisar por telefone ou e-mail"
          />
          {total > items.length && (
            <p className="mb-3 text-xs text-muted-foreground">
              Mostrando os {items.length.toLocaleString("pt-BR")} mais recentes de{" "}
              {total.toLocaleString("pt-BR")}. Use a busca para encontrar um destinatário ou exporte
              o CSV para a base completa.
            </p>
          )}
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Canal</TableHead>
                  <TableHead>Destinatário</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Motivo</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead>Atualizado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                      {query.isLoading
                        ? "Carregando…"
                        : debouncedSearch
                          ? "Nenhum destinatário encontrado."
                          : "Nenhum consentimento registrado."}
                    </TableCell>
                  </TableRow>
                )}
                {items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{channelName[row.channel]}</TableCell>
                    <TableCell className="font-mono text-xs">{row.subject}</TableCell>
                    <TableCell>
                      <Badge variant={row.status === "revoked" ? "destructive" : "secondary"}>
                        {row.status === "revoked" ? "bloqueado" : "autorizado"}
                      </Badge>
                    </TableCell>
                    <TableCell>{row.reason}</TableCell>
                    <TableCell>{row.source}</TableCell>
                    <TableCell>{new Date(row.updated_at).toLocaleString("pt-BR")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Auditoria recente</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Canal</TableHead>
                  <TableHead>Destinatário</TableHead>
                  <TableHead>Alteração</TableHead>
                  <TableHead>Motivo / origem</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{new Date(row.created_at).toLocaleString("pt-BR")}</TableCell>
                    <TableCell>{channelName[row.channel]}</TableCell>
                    <TableCell className="font-mono text-xs">{row.subject}</TableCell>
                    <TableCell>
                      {row.previous_status ?? "novo"} → {row.new_status}
                    </TableCell>
                    <TableCell>
                      {row.reason ?? "-"} · {row.source ?? "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </Page>
  );
}
