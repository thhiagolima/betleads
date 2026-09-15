import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Send, Webhook, Loader2 } from "lucide-react";
import { TRIGGER_NAMES } from "@/lib/triggers";
import {
  getWhatsappExternalIntegration,
  saveWhatsappExternalIntegration,
  listWhatsappExternalEvents,
  testWhatsappExternalWebhook,
  sendAllWhatsappExternalEvents,
} from "@/lib/whatsapp-external.functions";

const ALL_TRIGGERS = Object.keys(TRIGGER_NAMES) as (keyof typeof TRIGGER_NAMES)[];

export function ExternalIntegrationTab() {
  const qc = useQueryClient();
  const getFn = useServerFn(getWhatsappExternalIntegration);
  const saveFn = useServerFn(saveWhatsappExternalIntegration);
  const eventsFn = useServerFn(listWhatsappExternalEvents);
  const testFn = useServerFn(testWhatsappExternalWebhook);
  const sendAllFn = useServerFn(sendAllWhatsappExternalEvents);

  const { data } = useQuery({
    queryKey: ["wa-external-integration"],
    queryFn: () => getFn(),
  });
  const { data: eventsData } = useQuery({
    queryKey: ["wa-external-events"],
    queryFn: () => eventsFn(),
    refetchInterval: 20000,
  });

  const [url, setUrl] = useState("");
  const [active, setActive] = useState(false);
  const [triggers, setTriggers] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [sendingAll, setSendingAll] = useState(false);
  const [bulkResults, setBulkResults] = useState<any[] | null>(null);

  useEffect(() => {
    const i = data?.integration as any;
    if (!i) return;
    setUrl(i.url ?? "");
    setActive(Boolean(i.active));
    setTriggers(Array.isArray(i.triggers) ? i.triggers : []);
  }, [data]);

  const toggleTrigger = (t: string) =>
    setTriggers((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  async function handleSave() {
    setSaving(true);
    try {
      await saveFn({ data: { url: url.trim(), active, triggers, disable_internal: true } });
      await qc.invalidateQueries({ queryKey: ["wa-external-integration"] });
      toast.success("Integração salva");
    } catch (e: any) {
      toast.error(e?.message ?? "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const res = await testFn({ data: {} } as any);
      if (res.ok) toast.success(`Evento de teste enviado (HTTP ${res.httpStatus ?? 200})`);
      else toast.error(`Falhou: ${res.reason ?? "erro"}`);
      await qc.invalidateQueries({ queryKey: ["wa-external-events"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Falha no teste");
    } finally {
      setTesting(false);
    }
  }

  const events = (eventsData?.events ?? []) as any[];

  async function handleSendAll() {
    setSendingAll(true);
    try {
      const res: any = await sendAllFn({ data: {} } as any);
      setBulkResults(res.results ?? []);
      toast.success(`Enviados ${res.total} eventos — ${res.ok} OK, ${res.failed} com erro`);
      await qc.invalidateQueries({ queryKey: ["wa-external-events"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Falha ao enviar todos os eventos");
    } finally {
      setSendingAll(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Webhook className="h-5 w-5 text-emerald-400" />
            Integração externa (CRM terceiro)
          </CardTitle>
          <CardDescription>
            Quando ativa, os gatilhos de WhatsApp desta conta são enviados para o webhook
            abaixo e nenhuma mensagem é disparada pelas sessões internas. Cada lead é
            enviado uma única vez por gatilho.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="wa-ext-url">URL do webhook</Label>
            <Input
              id="wa-ext-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://exemplo.com/api/webhook/..."
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Integração ativa</p>
              <p className="text-xs text-muted-foreground">
                Desliga o envio interno e passa a encaminhar os gatilhos.
              </p>
            </div>
            <Switch checked={active} onCheckedChange={setActive} />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Gatilhos encaminhados</Label>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setTriggers(ALL_TRIGGERS as string[])}>
                  Todos
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setTriggers([])}>
                  Limpar
                </Button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {ALL_TRIGGERS.map((t) => (
                <label
                  key={t}
                  className="flex items-center gap-2 rounded-md border p-2 text-sm cursor-pointer"
                >
                  <Checkbox
                    checked={triggers.includes(t)}
                    onCheckedChange={() => toggleTrigger(t)}
                  />
                  {TRIGGER_NAMES[t]}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Nenhum selecionado = todos os gatilhos são encaminhados.
            </p>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={saving || !url.trim()}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Salvar
            </Button>
            <Button variant="outline" onClick={handleTest} disabled={testing || !url.trim()}>
              {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Enviar evento de teste
            </Button>
            <Button variant="secondary" onClick={handleSendAll} disabled={sendingAll || !url.trim()}>
              {sendingAll ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Enviar todos os eventos
            </Button>
          </div>
        </CardContent>
      </Card>

      {bulkResults && (
        <Card>
          <CardHeader>
            <CardTitle>Resultado do último disparo em massa</CardTitle>
            <CardDescription>Um evento de amostra por gatilho.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {bulkResults.map((r) => (
              <div
                key={r.trigger}
                className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"
              >
                <span className="truncate">{r.label}</span>
                <Badge
                  variant="outline"
                  className={
                    r.ok
                      ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-400"
                      : "border-rose-500/30 bg-rose-500/15 text-rose-400"
                  }
                >
                  {r.ok ? `OK ${r.httpStatus ?? ""}` : (r.reason ?? "erro")}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Últimos eventos enviados</CardTitle>
          <CardDescription>50 registros mais recentes.</CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum evento enviado ainda.</p>
          ) : (
            <div className="space-y-2">
              {events.map((ev) => (
                <div
                  key={ev.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate">
                      {TRIGGER_NAMES[ev.trigger_type as keyof typeof TRIGGER_NAMES] ?? ev.trigger_type}
                      {ev.is_test && <span className="ml-2 text-xs text-muted-foreground">(teste)</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {ev.phone_e164 ?? "—"} · {new Date(ev.created_at).toLocaleString("pt-BR")}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      ev.status === "sent"
                        ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-400"
                        : ev.status === "failed"
                          ? "border-rose-500/30 bg-rose-500/15 text-rose-400"
                          : ""
                    }
                  >
                    {ev.status === "sent" ? `OK ${ev.http_status ?? ""}` : ev.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}