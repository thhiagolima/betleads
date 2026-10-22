// "Casa" tab: the house's site URL plus its quick links (Login, Depósito,
// Promo, ...). `variant="wizard"` drops the card chrome for Task 11's
// full-screen setup wizard; `variant="page"` (default) wraps it in a
// DataCard for the permanent configuration page.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Home, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataCard } from "@/components/ui-premium";
import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { useIsDemoTenant } from "@/hooks/use-is-demo-tenant";
import { getHouseConfig, saveHouseSite, saveQuickLinks } from "@/lib/house-config.functions";
import { suggestedQuickLinks } from "@/lib/house-config";
import {
  COMPOSER_OPTIONS_QUERY_KEY,
  HOUSE_CONFIG_QUERY_KEY,
} from "@/components/house-config/house-config-query";

type QuickLinkDraft = { id?: string; label: string; path: string };

export function HouseSiteSection({ variant = "page" }: { variant?: "page" | "wizard" }) {
  const isDemo = useIsDemoTenant();
  const qc = useQueryClient();
  const getConfig = useServerFn(getHouseConfig);
  const saveSiteFn = useServerFn(saveHouseSite);
  const saveLinksFn = useServerFn(saveQuickLinks);

  const query = useQuery({ queryKey: HOUSE_CONFIG_QUERY_KEY, queryFn: () => getConfig() });
  const config = query.data;
  const canEdit = config?.canEdit ?? false;

  const [siteUrl, setSiteUrl] = useState("");
  const [links, setLinks] = useState<QuickLinkDraft[]>([]);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!config || initialized) return;
    setSiteUrl(config.siteUrl ?? "");
    setLinks(
      config.quickLinks.length > 0
        ? config.quickLinks.map((l) => ({ id: l.id, label: l.label, path: l.path }))
        : suggestedQuickLinks(),
    );
    setInitialized(true);
  }, [config, initialized]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: HOUSE_CONFIG_QUERY_KEY });
    qc.invalidateQueries({ queryKey: COMPOSER_OPTIONS_QUERY_KEY });
  };

  const saveSite = useMutation({
    mutationFn: () => saveSiteFn({ data: { siteUrl } }),
    onSuccess: () => {
      toast.success("URL da casa salva");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const saveLinks = useMutation({
    mutationFn: () =>
      saveLinksFn({
        data: { links: links.map((l) => ({ id: l.id, label: l.label, path: l.path })) },
      }),
    onSuccess: () => {
      toast.success("URLs rápidas salvas");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function updateLink(index: number, patch: Partial<QuickLinkDraft>) {
    setLinks((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLink(index: number) {
    setLinks((prev) => prev.filter((_, i) => i !== index));
  }

  function addLink() {
    setLinks((prev) => [...prev, { label: "", path: "" }]);
  }

  const content = (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label>URL da casa</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://suacasa.bet.br"
            disabled={!canEdit}
            className="max-w-sm"
          />
          {canEdit && (
            <DemoDisabledTooltip active={isDemo}>
              <Button
                type="button"
                size="sm"
                disabled={isDemo || saveSite.isPending}
                onClick={() => saveSite.mutate()}
              >
                {saveSite.isPending ? "Salvando…" : "Salvar"}
              </Button>
            </DemoDisabledTooltip>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>URLs rápidas</Label>
          {canEdit && (
            <Button type="button" variant="outline" size="sm" onClick={addLink}>
              <Plus className="h-4 w-4" /> Adicionar
            </Button>
          )}
        </div>

        <div className="space-y-2">
          {links.map((l, index) => (
            <div key={l.id ?? index} className="flex flex-wrap items-center gap-2">
              <Input
                value={l.label}
                onChange={(e) => updateLink(index, { label: e.target.value })}
                placeholder="Login"
                disabled={!canEdit}
                className="max-w-[160px]"
              />
              <Input
                value={l.path}
                onChange={(e) => updateLink(index, { path: e.target.value })}
                placeholder="/login"
                disabled={!canEdit}
                className="max-w-[200px]"
              />
              {canEdit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remover ${l.label || "URL rápida"}`}
                  onClick={() => removeLink(index)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>

        {canEdit && (
          <DemoDisabledTooltip active={isDemo}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isDemo || saveLinks.isPending}
              onClick={() => saveLinks.mutate()}
            >
              {saveLinks.isPending ? "Salvando…" : "Salvar URLs rápidas"}
            </Button>
          </DemoDisabledTooltip>
        )}
      </div>
    </div>
  );

  if (variant === "wizard") return content;

  return (
    <DataCard
      title="Casa"
      description="URL do site e atalhos usados em campanhas e jornadas."
      icon={<Home className="h-4 w-4" />}
    >
      {content}
    </DataCard>
  );
}
