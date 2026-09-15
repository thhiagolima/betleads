import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Megaphone,
  Loader2,
  PhoneOutgoing,
  Plus,
  Search,
  Trash2,
  Users,
  AlertTriangle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listCallScripts,
  listPlayersForCalls,
  bulkDispatchCalls,
} from "@/lib/calls.functions";

interface Target {
  key: string;
  lead_id: string | null;
  nome: string;
  phone: string | null;
}

interface DispatchResult {
  ok: boolean;
  lead_id: string | null;
  phone: string | null;
  error?: string;
}

interface ParsedError {
  message: string;
  hint?: "allowlist";
}

function parseProviderError(raw?: string): ParsedError {
  if (!raw) return { message: "Erro desconhecido" };
  // tenta achar JSON dentro da string (pode vir prefixado por "BusinessCode retornou 422: {...}")
  const jsonStart = raw.indexOf("{");
  const jsonStr = jsonStart >= 0 ? raw.slice(jsonStart) : raw;
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed === "object" && parsed.errors) {
      const fieldMsgs: string[] = [];
      let hint: ParsedError["hint"];
      for (const [field, msgs] of Object.entries(parsed.errors as Record<string, string[]>)) {
        for (const m of msgs) {
          fieldMsgs.push(`${field}: ${m}`);
          if (/allowlist/i.test(m)) hint = "allowlist";
        }
      }
      const head = parsed.message ? `${parsed.message} — ` : "";
      return { message: head + fieldMsgs.join(" | "), hint };
    }
    if (parsed?.message) return { message: String(parsed.message) };
  } catch {
    /* não é JSON */
  }
  return { message: raw.length > 240 ? raw.slice(0, 240) + "…" : raw };
}

export function BulkCallTab() {
  const listScripts = useServerFn(listCallScripts);
  const listPlayers = useServerFn(listPlayersForCalls);
  const bulkFn = useServerFn(bulkDispatchCalls);

  const [scriptId, setScriptId] = useState<string>("");
  const [campaignName, setCampaignName] = useState("");
  const [search, setSearch] = useState("");
  const [targets, setTargets] = useState<Target[]>([]);
  const [rawPhones, setRawPhones] = useState("");
  const [lastResult, setLastResult] = useState<{
    total: number;
    queued: number;
    pending: number;
    failed: number;
    results: DispatchResult[];
  } | null>(null);

  const { data: scriptsData } = useQuery({
    queryKey: ["call-scripts"],
    queryFn: () => listScripts(),
  });
  const scripts = scriptsData?.scripts ?? [];

  const { data: playersData, isFetching } = useQuery({
    queryKey: ["players-for-calls", search],
    queryFn: () => listPlayers({ data: { search, limit: 20 } }),
  });
  const players = playersData?.players ?? [];

  const phoneTargets = useMemo<Target[]>(() => {
    const list = Array.from(
      new Set(
        rawPhones
          .split(/[\s,;\n]+/)
          .map((p) => p.trim())
          .filter((p) => p.replace(/\D/g, "").length >= 10),
      ),
    );
    return list.map((p) => ({
      key: `raw:${p}`,
      lead_id: null,
      nome: p,
      phone: p,
    }));
  }, [rawPhones]);

  const allTargets = useMemo(() => {
    const seen = new Set<string>();
    const out: Target[] = [];
    for (const t of [...targets, ...phoneTargets]) {
      const sig = t.lead_id ?? t.phone ?? t.key;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(t);
    }
    return out;
  }, [targets, phoneTargets]);

  function addLead(p: any) {
    setTargets((prev) => {
      if (prev.some((t) => t.lead_id === p.id)) return prev;
      return [
        ...prev,
        {
          key: `lead:${p.id}`,
          lead_id: p.id,
          nome: p.nome,
          phone: p.telefone ?? null,
        },
      ];
    });
  }

  function removeTarget(key: string) {
    setTargets((prev) => prev.filter((t) => t.key !== key));
  }

  const bulkMut = useMutation({
    mutationFn: async () => {
      return bulkFn({
        data: {
          script_id: scriptId,
          campaign_name: campaignName || undefined,
          targets: allTargets.map((t) => ({
            lead_id: t.lead_id,
            phone_number: t.phone,
          })),
        },
      });
    },
    onSuccess: (res: any) => {
      setLastResult({
        total: res.total,
        queued: res.queued,
        pending: res.pending ?? 0,
        failed: res.failed,
        results: (res.results ?? []) as DispatchResult[],
      });
      if (res.failed === 0 && (res.pending ?? 0) === 0) {
        toast.success(`${res.queued} ligações disparadas`);
      } else if (res.failed === 0) {
        toast.info(`${res.pending} ligação(ões) ficaram pendentes para retentativa`);
      } else if (res.queued === 0) {
        const firstErr = (res.results ?? []).find((r: DispatchResult) => !r.ok);
        const parsed = parseProviderError(firstErr?.error);
        toast.error(`Falha em todas (${res.failed})`, {
          description: parsed.message,
        });
      } else {
        toast.warning(`${res.queued} disparadas, ${res.failed} falharam`);
      }
    },
    onError: (e: any) => toast.error(e?.message ?? "Falha no disparo em massa"),
  });

  const canSend =
    Boolean(scriptId) && allTargets.length > 0 && !bulkMut.isPending;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Megaphone className="h-5 w-5 text-primary" />
              Envio em massa de ligações
            </CardTitle>
            <CardDescription>
              Escolha um script e selecione vários leads — geramos o áudio (com
              cache) e disparamos via BusinessCode para cada um.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Script</Label>
                <Select value={scriptId} onValueChange={setScriptId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione um script..." />
                  </SelectTrigger>
                  <SelectContent>
                    {scripts.length === 0 && (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        Nenhum script — crie um na aba Scripts.
                      </div>
                    )}
                    {scripts.map((s: any) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Nome da campanha (opcional)</Label>
                <Input
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="Ex: Recuperação VIP — semana 22"
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Search className="h-4 w-4" /> Buscar leads
              </Label>
              <Input
                placeholder="Nome ou telefone..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-card/50">
                {isFetching && (
                  <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                    Buscando...
                  </p>
                )}
                {!isFetching && players.length === 0 && (
                  <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                    Nenhum lead encontrado
                  </p>
                )}
                {players.map((p: any) => {
                  const added = targets.some((t) => t.lead_id === p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => addLead(p)}
                      disabled={added}
                      className="flex w-full items-center justify-between gap-2 border-b border-border/40 px-3 py-2 text-left text-sm last:border-0 hover:bg-muted disabled:opacity-50"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{p.nome}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {p.telefone ?? "sem telefone"} ·{" "}
                          {p.vip ? "VIP" : (p.status ?? "ativo")}
                        </p>
                      </div>
                      {added ? (
                        <Badge variant="secondary" className="gap-1">
                          adicionado
                        </Badge>
                      ) : (
                        <Plus className="h-4 w-4 text-primary" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Ou cole números avulsos</Label>
              <Textarea
                rows={3}
                placeholder="+5511999990000, +5521980194445..."
                value={rawPhones}
                onChange={(e) => setRawPhones(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {phoneTargets.length} número(s) avulso(s) detectado(s). Sem
                lead_id — variáveis do script viram placeholder.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" /> Destinatários ({allTargets.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {allTargets.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                Nenhum destinatário adicionado ainda.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {allTargets.map((t) => (
                  <li
                    key={t.key}
                    className="flex items-center justify-between gap-2 py-2 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{t.nome}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {t.phone ?? "sem telefone"}{" "}
                        {t.lead_id ? "· lead" : "· avulso"}
                      </p>
                    </div>
                    {t.lead_id && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => removeTarget(t.key)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Resumo do disparo</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Script" value={scripts.find((s: any) => s.id === scriptId)?.name ?? "—"} />
            <Row label="Destinatários" value={String(allTargets.length)} />
            <Row label="Provedor" value="BusinessCode" />
            <Separator />
            <Button
              className="w-full gap-2"
              onClick={() => bulkMut.mutate()}
              disabled={!canSend}
            >
              {bulkMut.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <PhoneOutgoing className="h-4 w-4" />
              )}
              Disparar {allTargets.length || ""} ligaç{allTargets.length === 1 ? "ão" : "ões"}
            </Button>
            {lastResult && (
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs">
                <p className="mb-1 font-medium">Último disparo</p>
                <p>Total: {lastResult.total}</p>
                <p className="text-emerald-400">Disparadas: {lastResult.queued}</p>
                <p className="text-amber-400">Pendentes: {lastResult.pending}</p>
                <p className="text-rose-400">Falhas: {lastResult.failed}</p>
              </div>
            )}
            {lastResult && lastResult.failed > 0 && (
              <FailureDetails
                results={lastResult.results}
                targets={allTargets}
              />
            )}
            <p className="text-xs text-muted-foreground">
              Cada destinatário gera (ou reutiliza do cache) o áudio e é disparado
              individualmente. Acompanhe o resultado em Histórico.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function FailureDetails({
  results,
  targets,
}: {
  results: DispatchResult[];
  targets: Target[];
}) {
  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) return null;
  const parsed = failures.map((f) => ({ ...f, parsed: parseProviderError(f.error) }));
  const allAllowlist = parsed.every((p) => p.parsed.hint === "allowlist");

  function nameFor(f: DispatchResult): string {
    if (f.lead_id) {
      const t = targets.find((x) => x.lead_id === f.lead_id);
      if (t) return t.nome;
    }
    return f.phone ?? "destinatário";
  }

  return (
    <div className="space-y-2">
      {allAllowlist && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle className="text-xs">Host de áudio não autorizado na BusinessCode</AlertTitle>
          <AlertDescription className="text-xs leading-relaxed">
            O host do áudio gerado não está liberado no provedor. No painel da
            BusinessCode, adicione esse host à <code className="text-[10px]">MESSAGING_AUDIO_URL_ALLOWLIST</code>{" "}
            (lista separada por vírgula no <code className="text-[10px]">.env</code>) ou ative{" "}
            <code className="text-[10px]">MESSAGING_AUDIO_URL_ALLOW_ANY=true</code>. Depois disso o disparo passa
            sem nenhuma mudança aqui.
          </AlertDescription>
        </Alert>
      )}
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
        <p className="mb-2 text-xs font-medium text-rose-400">
          Falhas detalhadas ({failures.length})
        </p>
        <ul className="max-h-48 space-y-2 overflow-y-auto pr-1">
          {parsed.map((f, i) => (
            <li key={i} className="text-xs">
              <p className="font-medium">{nameFor(f)}</p>
              <p className="text-rose-400/90 break-words">{f.parsed.message}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}