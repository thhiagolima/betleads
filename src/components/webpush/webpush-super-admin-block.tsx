// Web push (OneSignal) — Task 12: the super admin's block on the house's
// integration screen — activate a new origin (automatic OneSignal app, or
// paste an app id/key already created by hand) and manage existing origins
// (mark as legado/desativado, or add another domain). Only rendered for a
// super admin (gated by the caller, `webpush-integration-panel.tsx`).
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DataCard } from "@/components/ui-premium/data-card";
import {
  activateWebpushOriginFn,
  setWebpushAppStatusFn,
} from "@/lib/webpush/webpush.functions";
import { WEBPUSH_INTEGRATION_QUERY_KEY } from "@/components/webpush/webpush-query";

export type SuperAdminAppRow = {
  id: string;
  origin: string;
  status: "instalando" | "ativo" | "legado" | "desativado";
};

const STATUS_LABEL: Record<SuperAdminAppRow["status"], string> = {
  instalando: "instalando",
  ativo: "ativo",
  legado: "antigo (domínio bloqueado)",
  desativado: "desativado",
};

type ActivationMode = "api" | "manual";

export function WebpushSuperAdminBlock({
  tenantId,
  siteUrl,
  apps,
}: {
  tenantId: string;
  siteUrl: string | null;
  apps: SuperAdminAppRow[];
}) {
  const qc = useQueryClient();
  const activateFn = useServerFn(activateWebpushOriginFn);
  const setStatusFn = useServerFn(setWebpushAppStatusFn);

  const [origin, setOrigin] = useState(siteUrl ?? "");
  const [mode, setMode] = useState<ActivationMode>("api");
  const [appId, setAppId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showAdd, setShowAdd] = useState(apps.length === 0);

  const invalidate = () => qc.invalidateQueries({ queryKey: WEBPUSH_INTEGRATION_QUERY_KEY });

  const activate = useMutation({
    mutationFn: () =>
      mode === "api"
        ? activateFn({ data: { tenantId, origin, mode: "api" } })
        : activateFn({ data: { tenantId, origin, mode: "manual", appId, apiKey } }),
    onSuccess: () => {
      toast.success("Origem ativada");
      setAppId("");
      setApiKey("");
      setShowAdd(false);
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const setStatus = useMutation({
    mutationFn: (vars: { appRowId: string; status: SuperAdminAppRow["status"] }) =>
      setStatusFn({ data: { tenantId, appRowId: vars.appRowId, status: vars.status } }),
    onSuccess: invalidate,
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <DataCard
      title="Super admin · Web Push"
      description="Infraestrutura da OneSignal — visível só para a equipe Betleads."
    >
      <div className="space-y-5">
        {apps.length > 0 && (
          <div className="space-y-2">
            {apps.map((app) => (
              <div
                key={app.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/30 p-3"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate text-sm font-medium">{app.origin}</span>
                  <Badge variant="outline" className="text-meta shrink-0">
                    {STATUS_LABEL[app.status]}
                  </Badge>
                </div>
                {app.status !== "legado" && app.status !== "desativado" && (
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={setStatus.isPending}
                      onClick={() => setStatus.mutate({ appRowId: app.id, status: "legado" })}
                    >
                      Marcar como antigo (domínio bloqueado)
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={setStatus.isPending}
                      onClick={() => setStatus.mutate({ appRowId: app.id, status: "desativado" })}
                    >
                      Desativar
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {!showAdd && (
          <Button type="button" variant="outline" size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="h-3.5 w-3.5" /> Adicionar novo domínio
          </Button>
        )}

        {showAdd && (
          <div className="space-y-4 rounded-lg border border-border/60 bg-background/30 p-4">
            <div className="space-y-1.5">
              <Label htmlFor="webpush-origin">Endereço do site</Label>
              <Input
                id="webpush-origin"
                value={origin}
                placeholder="https://suacasa.bet.br"
                onChange={(e) => setOrigin(e.target.value)}
              />
            </div>

            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={mode === "api" ? "default" : "outline"}
                onClick={() => setMode("api")}
              >
                Criar app automaticamente
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "manual" ? "default" : "outline"}
                onClick={() => setMode("manual")}
              >
                Colar App ID e chave
              </Button>
            </div>

            {mode === "manual" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="webpush-app-id">App ID</Label>
                  <Input
                    id="webpush-app-id"
                    value={appId}
                    onChange={(e) => setAppId(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="webpush-api-key">Chave da API</Label>
                  <Input
                    id="webpush-api-key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </div>
              </div>
            )}

            <Button
              type="button"
              disabled={
                activate.isPending ||
                !origin.trim() ||
                (mode === "manual" && (!appId.trim() || !apiKey.trim()))
              }
              onClick={() => activate.mutate()}
            >
              {activate.isPending ? "Ativando…" : "Ativar"}
            </Button>
          </div>
        )}
      </div>
    </DataCard>
  );
}
