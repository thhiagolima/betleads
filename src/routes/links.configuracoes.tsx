import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/ui-premium";
import { getShortioSettings, saveShortioSettings } from "@/lib/shortio.functions";

export const Route = createFileRoute("/links/configuracoes")({ component: LinkSettings });
function LinkSettings() {
  const q = useQuery({ queryKey: ["shortio-settings"], queryFn: () => getShortioSettings() });
  const [saving, setSaving] = useState(false);
  const data = q.data;
  const s = data?.settings;
  if (!s) return <div className="p-6">Carregando…</div>;
  async function save(form: FormData) {
    setSaving(true);
    try {
      await saveShortioSettings({
        enabled: form.get("enabled") === "on",
        domain: String(form.get("domain") || "") || null,
        attribution_mode: "individual",
        fallback_mode: String(form.get("fallback")) as "block" | "passthrough",
        default_ttl_days: form.get("ttl") ? Number(form.get("ttl")) : null,
        allowed_destination_hosts: String(form.get("hosts") || "")
          .split(/[,\n]/)
          .map((x) => x.trim())
          .filter(Boolean),
        enabled_channels: ["sms", "email"],
      });
      q.refetch();
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader title="Short.io" description="Domínio e regras de rastreamento de links." />
      <Card>
        <CardHeader>
          <CardTitle>Configuração do tenant</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={save} className="space-y-5">
            <div className="flex items-center gap-3">
              <Switch name="enabled" defaultChecked={s.enabled} />
              <Label>Ativar encurtamento e rastreio</Label>
            </div>
            <div>
              <Label>Domínio curto</Label>
              <Input name="domain" defaultValue={s.domain ?? ""} placeholder="go.sua-marca.com" />
            </div>
            <div>
              <Label>Hosts de destino permitidos</Label>
              <Input
                name="hosts"
                defaultValue={(s.allowed_destination_hosts ?? []).join(", ")}
                placeholder="site.com, app.site.com"
              />
            </div>
            <div>
              <Label>TTL em dias</Label>
              <Input
                name="ttl"
                type="number"
                min="1"
                max="3650"
                defaultValue={s.default_ttl_days ?? ""}
              />
            </div>
            <div>
              <Label>Falha da Short.io</Label>
              <select
                name="fallback"
                defaultValue={s.fallback_mode}
                className="mt-1 h-10 w-full rounded border bg-background px-3"
              >
                <option value="block">Bloquear envio</option>
                <option value="passthrough">Enviar URL original</option>
              </select>
            </div>
            <Button disabled={saving}>{saving ? "Salvando…" : "Salvar"}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
