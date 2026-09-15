import { createFileRoute } from "@tanstack/react-router";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Sparkles, Settings, Sliders, Brain, Shield, Plug } from "lucide-react";
import { PageHeader } from "@/components/ui-premium/page-header";
import { DataCard } from "@/components/ui-premium/data-card";
import { toast } from "sonner";
import { SendWindowCard } from "@/components/send-window-card";

export const Route = createFileRoute("/configuracoes")({
  component: ConfigPage,
});

function ConfigPage() {
  return (
    <div className="space-y-6 max-w-5xl">
      <PageHeader
        title="Configurações"
        subtitle="Preferências da plataforma, IA, segurança e integrações."
        icon={<Settings className="h-5 w-5 text-primary-foreground" />}
      />

      <SendWindowCard />

      <div className="grid gap-4 lg:grid-cols-2">
        <DataCard
          title="Plataforma"
          description="Identidade e configurações regionais"
          icon={<Sliders className="h-4 w-4" />}
        >
          <div className="space-y-4">
            {[
              { label: "Nome da operação", value: "BETLEADS Casa de Aposta" },
              { label: "Moeda padrão", value: "BRL" },
              { label: "Fuso horário", value: "America/Sao_Paulo" },
            ].map((f) => (
              <div key={f.label}>
                <Label className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {f.label}
                </Label>
                <Input defaultValue={f.value} className="mt-2 bg-background/60" />
              </div>
            ))}
          </div>
        </DataCard>

        <DataCard
          title="Preferências"
          description="Comportamentos automáticos da plataforma"
          icon={<Sparkles className="h-4 w-4" />}
        >
          <div className="space-y-3">
            {[
              { label: "Atualização em tempo real", desc: "Receber eventos via stream" },
              { label: "Alertas de risco alto", desc: "Notificar quando players entram em risco" },
              { label: "Detecção automática de VIP", desc: "Promover players com base no LTV" },
              { label: "Sumário diário por IA", desc: "Resumo das principais movimentações" },
            ].map((p) => (
              <div
                key={p.label}
                className="flex items-center justify-between rounded-lg border border-border/40 bg-background/30 p-3 transition-colors hover:border-primary/30"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{p.label}</p>
                  <p className="text-xs text-muted-foreground truncate">{p.desc}</p>
                </div>
                <Switch defaultChecked />
              </div>
            ))}
          </div>
        </DataCard>

        <DataCard
          className="lg:col-span-2"
          title="Modelo de IA"
          description="Gateway nativo Lovable AI — sem chave necessária"
          icon={<Brain className="h-4 w-4" />}
          actions={
            <Button
              variant="outline"
              onClick={() => toast.success("Preferências salvas")}
            >
              Salvar
            </Button>
          }
        >
          <div className="rounded-lg border border-border/40 bg-background/30 p-4">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground mb-1">
              Modelo padrão
            </p>
            <p className="font-mono text-sm text-foreground">google/gemini-3-flash-preview</p>
          </div>
        </DataCard>

        <DataCard
          title="Segurança"
          description="Controles de acesso e auditoria"
          icon={<Shield className="h-4 w-4" />}
        >
          <div className="space-y-3">
            {[
              { label: "Autenticação em 2 fatores", desc: "Em breve" },
              { label: "Auditoria de ações", desc: "Registrar logins e alterações" },
            ].map((p) => (
              <div
                key={p.label}
                className="flex items-center justify-between rounded-lg border border-border/40 bg-background/30 p-3"
              >
                <div>
                  <p className="text-sm font-medium">{p.label}</p>
                  <p className="text-xs text-muted-foreground">{p.desc}</p>
                </div>
                <Switch />
              </div>
            ))}
          </div>
        </DataCard>

        <DataCard
          title="Integrações"
          description="Conexões externas ativas"
          icon={<Plug className="h-4 w-4" />}
        >
          <div className="space-y-2">
            {[
              { name: "Evolution API", status: "Conectado" },
              { name: "Lovable AI Gateway", status: "Conectado" },
              { name: "Webhooks", status: "Ativo" },
            ].map((i) => (
              <div
                key={i.name}
                className="flex items-center justify-between rounded-lg border border-border/40 bg-background/30 p-3"
              >
                <p className="text-sm font-medium">{i.name}</p>
                <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 pulse-realtime" />
                  {i.status}
                </span>
              </div>
            ))}
          </div>
        </DataCard>
      </div>
    </div>
  );
}