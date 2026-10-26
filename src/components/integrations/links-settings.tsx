import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { HomeCard } from "@/components/home/home-cards";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { getShortioSettings, saveShortioSettings } from "@/lib/shortio.functions";

/** Configuração do Short.io da casa. O servidor só responde ao admin da casa. */
export function LinksSettings() {
  const isDemo = useIsDemoTenant();
  const q = useQuery({ queryKey: ["shortio-settings"], queryFn: () => getShortioSettings() });
  const [saving, setSaving] = useState(false);
  const s = q.data?.settings;

  if (q.isError) {
    // The server only answers the house admin; anyone else used to see "Carregando…" forever.
    return (
      <HomeCard className="space-y-2 p-6 text-center">
        <p className="text-section">Não foi possível abrir as configurações de links</p>
        <p className="text-sm text-muted-foreground">
          Esta área é do administrador da casa. Se você é admin, tente de novo em instantes.
        </p>
      </HomeCard>
    );
  }
  if (!s) return <Skeleton className="h-80 rounded-2xl" />;

  async function save(form: FormData) {
    setSaving(true);
    try {
      await saveShortioSettings({
        data: {
          enabled: form.get("enabled") === "on",
          attribution_mode: "individual",
          fallback_mode: String(form.get("fallback")) as "block" | "passthrough",
          default_ttl_days: form.get("ttl") ? Number(form.get("ttl")) : null,
          allowed_destination_hosts: String(form.get("hosts") || "")
            .split(/[,\n]/)
            .map((x) => x.trim())
            .filter(Boolean),
          enabled_channels: ["sms", "email"],
        },
      });
      toast.success("Configuração de links salva");
      void q.refetch();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? `Não foi possível salvar: ${error.message}`
          : "Não foi possível salvar a configuração de links",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <HomeCard className="p-4 sm:p-5">
      <h2 className="text-section font-semibold">Configuração</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Os links das mensagens viram links curtos para contar os cliques de cada jogador.
      </p>
      <form action={save} className="mt-5 space-y-5">
        <div className="flex items-center gap-3">
          <Switch id="shortio-enabled" name="enabled" defaultChecked={s.enabled} />
          <Label htmlFor="shortio-enabled">Ativar links curtos</Label>
        </div>
        <p className="text-sm text-muted-foreground">
          O domínio dos links curtos fica em{" "}
          <Link to="/configuracoes/casa" className="text-primary underline underline-offset-4">
            Configuração da casa
          </Link>
          .
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="shortio-hosts">Sites permitidos</Label>
          <Input
            id="shortio-hosts"
            name="hosts"
            defaultValue={(s.allowed_destination_hosts ?? []).join(", ")}
            placeholder="site.com, app.site.com"
          />
          <p className="text-meta text-muted-foreground">
            Só links para estes sites são encurtados. Separe por vírgula. Em branco, vale para
            qualquer site.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="shortio-ttl">Validade do link (dias)</Label>
          <Input
            id="shortio-ttl"
            name="ttl"
            type="number"
            min="1"
            max="3650"
            defaultValue={s.default_ttl_days ?? ""}
          />
          <p className="text-meta text-muted-foreground">Em branco, o link não expira.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="shortio-fallback">Se o encurtador falhar</Label>
          <Select name="fallback" defaultValue={s.fallback_mode}>
            <SelectTrigger id="shortio-fallback">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="block">Não enviar a mensagem</SelectItem>
              <SelectItem value="passthrough">Enviar com o link original</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DemoDisabledTooltip active={isDemo}>
          <Button disabled={isDemo || saving}>{saving ? "Salvando…" : "Salvar"}</Button>
        </DemoDisabledTooltip>
      </form>
    </HomeCard>
  );
}
