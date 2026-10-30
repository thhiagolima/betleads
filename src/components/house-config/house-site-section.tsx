// "Casa" tab: the house's site URL plus its quick links (Login, Depósito,
// Promo, ...). `variant="wizard"` drops the card chrome for Task 11's
// full-screen setup wizard; `variant="page"` (default) wraps it in a
// DataCard for the permanent configuration page.
import { useEffect, useImperativeHandle, useState, type Ref } from "react";
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
import { normalizeSiteUrl, suggestedQuickLinks } from "@/lib/house-config";
import { normalizeLinkDomain } from "@/lib/link-domain";
import { hasLinkDomainWork, type ClientLinkDomainPreview } from "@/lib/link-domain-plan";
import { previewLinkDomainChange } from "@/lib/link-domain.functions";
import { LinkDomainDialog } from "@/components/house-config/link-domain-dialog";
import {
  HOUSE_CONFIG_QUERY_KEY,
  invalidateHouseConfigQueries,
} from "@/components/house-config/house-config-query";

type QuickLinkDraft = { id?: string; label: string; path: string };

export const QUICK_LINKS_INCOMPLETE_ERROR = "Preencha o nome e o caminho de todas as URLs rápidas.";

/** Drops rows left completely blank (e.g. "Adicionar" clicked by mistake);
 * a half-filled row is an error (pt-BR) instead of a raw validation message. */
export function prepareQuickLinkDrafts(
  links: QuickLinkDraft[],
): { ok: true; links: QuickLinkDraft[] } | { ok: false; error: string } {
  const filled = links
    .map((l) => ({ ...l, label: l.label.trim(), path: l.path.trim() }))
    .filter((l) => l.label !== "" || l.path !== "");
  if (filled.some((l) => l.label === "" || l.path === "")) {
    return { ok: false, error: QUICK_LINKS_INCOMPLETE_ERROR };
  }
  return { ok: true, links: filled };
}

function sameLinks(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** What the admin typed but hasn't saved yet (wizard "Avançar" saves it). */
export function computeHouseSiteDirty(
  draft: { siteUrl: string; links: QuickLinkDraft[] },
  saved: { siteUrl: string | null; quickLinks: { id: string; label: string; path: string }[] },
): { site: boolean; links: boolean } {
  const typed = draft.siteUrl.trim();
  let site = false;
  if (typed) {
    const normalized = normalizeSiteUrl(typed);
    site = !normalized.ok || normalized.url !== (saved.siteUrl ?? "");
  }

  const prepared = prepareQuickLinkDrafts(draft.links);
  let links: boolean;
  if (!prepared.ok) {
    links = true;
  } else {
    const a = prepared.links.map((l) => `${l.id ?? ""}|${l.label}|${l.path}`);
    const b = saved.quickLinks.map((l) => `${l.id}|${l.label.trim()}|${l.path.trim()}`);
    // The pre-filled suggestions are only a UI hint: left untouched on a house
    // with no saved links, they are not "unsaved changes" (nothing is written
    // until the admin edits or saves them).
    const untouchedSuggestions =
      saved.quickLinks.length === 0 &&
      sameLinks(a, suggestedQuickLinks().map((l) => `|${l.label}|${l.path}`));
    links = !untouchedSuggestions && !sameLinks(a, b);
  }
  return { site, links };
}

/** Imperative handle the setup wizard uses so "Avançar" on the Casa step
 * saves whatever is still unsaved. Resolves `false` (after a toast) when a
 * save failed — the wizard then stays on the step. */
export type HouseSiteSaveHandle = { saveIfDirty: () => Promise<boolean> };

export function HouseSiteSection({
  variant = "page",
  saveRef,
}: {
  variant?: "page" | "wizard";
  saveRef?: Ref<HouseSiteSaveHandle>;
}) {
  const isDemo = useIsDemoTenant();
  const qc = useQueryClient();
  const getConfig = useServerFn(getHouseConfig);
  const saveSiteFn = useServerFn(saveHouseSite);
  const saveLinksFn = useServerFn(saveQuickLinks);
  const previewLinkDomainFn = useServerFn(previewLinkDomainChange);

  const query = useQuery({ queryKey: HOUSE_CONFIG_QUERY_KEY, queryFn: () => getConfig() });
  const config = query.data;
  const canEdit = config?.canEdit ?? false;

  const [siteUrl, setSiteUrl] = useState("");
  const [links, setLinks] = useState<QuickLinkDraft[]>([]);
  const [initialized, setInitialized] = useState(false);

  const [linkDomainDialogOpen, setLinkDomainDialogOpen] = useState(false);
  const [linkDomainAutoPreview, setLinkDomainAutoPreview] = useState<ClientLinkDomainPreview | null>(null);

  function closeLinkDomainDialog(next: boolean) {
    setLinkDomainDialogOpen(next);
    if (!next) setLinkDomainAutoPreview(null);
  }

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

  // Config, composer pickers and setup status (wizard summary / checklist).
  const refresh = () => invalidateHouseConfigQueries(qc);

  const saveSite = useMutation({
    mutationFn: () => saveSiteFn({ data: { siteUrl } }),
    onSuccess: async (result) => {
      toast.success("URL da casa salva");
      refresh();

      // The URL is already saved at this point — a failure previewing the
      // link-domain change below is not shown as an error, just logged.
      if (!result.previousSiteUrl) return;
      const prevHost = normalizeLinkDomain(result.previousSiteUrl);
      const nextHost = normalizeLinkDomain(result.siteUrl);
      if (!prevHost.ok || !nextHost.ok || prevHost.domain === nextHost.domain) return;
      try {
        const preview = (await previewLinkDomainFn({
          data: { fromDomain: prevHost.domain, toDomain: nextHost.domain },
        })) as unknown as ClientLinkDomainPreview;
        if (hasLinkDomainWork(preview)) {
          setLinkDomainAutoPreview(preview);
          setLinkDomainDialogOpen(true);
        }
      } catch (error) {
        console.warn("Falha ao pré-visualizar troca de domínio nos links após salvar a URL da casa", error);
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const saveLinks = useMutation({
    mutationFn: async () => {
      const prepared = prepareQuickLinkDrafts(links);
      if (!prepared.ok) throw new Error(prepared.error);
      return saveLinksFn({
        data: { links: prepared.links.map((l) => ({ id: l.id, label: l.label, path: l.path })) },
      });
    },
    onSuccess: (result) => {
      // Adopt the saved rows (with their ids) so a second save updates them
      // in place instead of re-creating them.
      setLinks(result.links.map((l) => ({ id: l.id, label: l.label, path: l.path })));
      toast.success("URLs rápidas salvas");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  useImperativeHandle(
    saveRef,
    () => ({
      async saveIfDirty() {
        // Read-only viewer, demo house or config not loaded: nothing to save.
        if (!config || !canEdit || isDemo) return true;
        const dirty = computeHouseSiteDirty(
          { siteUrl, links },
          { siteUrl: config.siteUrl ?? null, quickLinks: config.quickLinks },
        );
        try {
          if (dirty.site) await saveSite.mutateAsync();
          if (dirty.links) await saveLinks.mutateAsync();
          return true;
        } catch {
          // The mutation's onError already showed the toast.
          return false;
        }
      },
    }),
    [config, canEdit, isDemo, siteUrl, links, saveSite, saveLinks],
  );

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
          {canEdit && (
            <DemoDisabledTooltip active={isDemo}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isDemo}
                onClick={() => setLinkDomainDialogOpen(true)}
              >
                Trocar domínio nos links
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

  const currentSiteHost = config?.siteUrl ? normalizeLinkDomain(config.siteUrl) : null;
  const linkDomainDialog = (
    <LinkDomainDialog
      open={linkDomainDialogOpen}
      onOpenChange={closeLinkDomainDialog}
      initialTo={currentSiteHost?.ok ? currentSiteHost.domain : undefined}
      initialPreview={linkDomainAutoPreview ?? undefined}
    />
  );

  if (variant === "wizard") {
    return (
      <>
        {content}
        {linkDomainDialog}
      </>
    );
  }

  return (
    <DataCard
      title="Casa"
      description="URL do site e atalhos usados em campanhas e jornadas."
      icon={<Home className="h-4 w-4" />}
    >
      {content}
      {linkDomainDialog}
    </DataCard>
  );
}
