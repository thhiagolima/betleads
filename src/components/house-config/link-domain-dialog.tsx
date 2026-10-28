// "Trocar domínio nos links": two-step dialog that previews, then applies, a
// host swap across a house's hand-written links (journeys/templates/quick
// links/tracking). Step 1 collects the two domains and calls
// `previewLinkDomainChange`; step 2 shows the preview grouped by kind with a
// checkbox per item and applies the selected subset through
// `applyLinkDomainChange`, guarded by a confirmation AlertDialog.
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { invalidateHouseConfigQueries } from "@/components/house-config/house-config-query";
import {
  hasLinkDomainWork,
  type ClientLinkDomainItem,
  type ClientLinkDomainPreview,
  type LinkDomainItemKind,
} from "@/lib/link-domain-plan";
import { applyLinkDomainChange, previewLinkDomainChange } from "@/lib/link-domain.functions";
import type { ApplyLinkDomainResult } from "@/lib/link-domain.server";

const KIND_LABELS: Record<LinkDomainItemKind, string> = {
  journey_step: "Jornadas",
  sms_template: "Templates de SMS",
  email_template: "Templates de e-mail",
  quick_link: "URLs rápidas",
};

const KIND_ORDER: LinkDomainItemKind[] = ["journey_step", "sms_template", "email_template", "quick_link"];

export type LinkDomainItemGroup = { kind: LinkDomainItemKind; label: string; items: ClientLinkDomainItem[] };

/** Groups the preview's items by kind, in display order, dropping empty
 * groups. Pure — exported for unit tests. */
export function groupLinkDomainItems(items: ClientLinkDomainItem[]): LinkDomainItemGroup[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_LABELS[kind],
    items: items.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);
}

/** All non-blocked items, pre-checked — the dialog's default selection.
 * Pure — exported for unit tests. */
export function initialSelection(preview: ClientLinkDomainPreview): Set<string> {
  return new Set(preview.items.filter((item) => item.blockedReason === null).map((item) => item.key));
}

/** How many items the "Trocar N itens" button will act on: the selected
 * items plus the tracking-hosts change when its checkbox is on. Pure —
 * exported for unit tests. */
export function countSelectedForApply(
  preview: ClientLinkDomainPreview,
  selected: Set<string>,
  trackingChecked: boolean,
): number {
  return selected.size + (trackingChecked && preview.trackingHosts !== null ? 1 : 0);
}

/** Whether `preview.outOfScope` has nothing to show — i.e. the "Ainda com
 * {from} (não trocados aqui)" section should stay hidden. Pure — exported
 * for unit tests (Radix's Dialog/AlertDialog render through a portal, which
 * `renderToStaticMarkup` can't capture server-side — see the test file for
 * why this component's JSX-level logic is tested through these pure
 * helpers instead of a full render). */
export function outOfScopeIsEmpty(preview: ClientLinkDomainPreview): boolean {
  const { scheduledCampaigns, legacyFlows, subdomainLinks } = preview.outOfScope;
  return scheduledCampaigns.length === 0 && legacyFlows.length === 0 && subdomainLinks === 0;
}

/** The pt-BR segment-warning line shown under an item whose tracking-off SMS
 * crosses into another segment. Pure — exported for unit tests. */
export function formatSegmentWarning(warning: { before: number; after: number }): string {
  return `Passa de ${warning.before} para ${warning.after} partes de SMS (rastreio desligado).`;
}

function pluralPart(count: number, singular: string, plural: string): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Joins pt-BR parts with ", " and a final " e " before the last one
 * ("a, b e c" / "a e b" / "a"). */
function joinPtBr(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

/** The toast description shown on a successful apply, built from the RPC's
 * actual counts — e.g. "3 etapas de jornada, 2 templates de SMS, 1 template
 * de e-mail, 1 URL rápida e a lista do rastreio". Zero-count parts are
 * omitted; singular/plural follows each count. Pure — exported for unit
 * tests. */
export function formatApplyResultToast(result: ApplyLinkDomainResult): string {
  const parts = [
    pluralPart(result.journey_steps, "etapa de jornada", "etapas de jornada"),
    pluralPart(result.sms_templates, "template de SMS", "templates de SMS"),
    pluralPart(result.email_templates, "template de e-mail", "templates de e-mail"),
    pluralPart(result.quick_links, "URL rápida", "URLs rápidas"),
  ].filter((part): part is string => part !== null);
  if (result.tracking_hosts) {
    parts.push("a lista do rastreio");
  }
  return joinPtBr(parts);
}

export function LinkDomainDialog({
  open,
  onOpenChange,
  initialFrom,
  initialTo,
  initialPreview,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialFrom?: string;
  initialTo?: string;
  initialPreview?: ClientLinkDomainPreview;
}) {
  const qc = useQueryClient();
  const previewFn = useServerFn(previewLinkDomainChange);
  const applyFn = useServerFn(applyLinkDomainChange);

  const [step, setStep] = useState<"input" | "preview">(initialPreview ? "preview" : "input");
  const [fromInput, setFromInput] = useState(initialFrom ?? "");
  const [toInput, setToInput] = useState(initialTo ?? "");
  const [preview, setPreview] = useState<ClientLinkDomainPreview | null>(initialPreview ?? null);
  const [selected, setSelected] = useState<Set<string>>(initialPreview ? initialSelection(initialPreview) : new Set());
  const [trackingChecked, setTrackingChecked] = useState(initialPreview ? initialPreview.trackingHosts !== null : true);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Re-seed every piece of state whenever the dialog opens, so a reopen never
  // shows stale leftovers from a previous run.
  useEffect(() => {
    if (!open) return;
    if (initialPreview) {
      setPreview(initialPreview);
      setSelected(initialSelection(initialPreview));
      setTrackingChecked(initialPreview.trackingHosts !== null);
      setStep("preview");
    } else {
      setPreview(null);
      setSelected(new Set());
      setTrackingChecked(true);
      setFromInput(initialFrom ?? "");
      setToInput(initialTo ?? "");
      setStep("input");
    }
    setConfirmOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only on open, not on every prop identity change.
  }, [open]);

  const previewMutation = useMutation({
    mutationFn: () => previewFn({ data: { fromDomain: fromInput, toDomain: toInput } }),
    onSuccess: (result) => {
      const typed = result as unknown as ClientLinkDomainPreview;
      setPreview(typed);
      setSelected(initialSelection(typed));
      setTrackingChecked(typed.trackingHosts !== null);
      setStep("preview");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const applyMutation = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error("Abra a prévia de novo.");
      return applyFn({
        data: {
          fromDomain: preview.from,
          toDomain: preview.to,
          itemKeys: [...selected],
          includeTrackingHosts: trackingChecked,
        },
      });
    },
    onSuccess: (result) => {
      const description = formatApplyResultToast(result);
      toast.success("Domínio trocado nos links", description ? { description } : undefined);
      invalidateHouseConfigQueries(qc);
      setConfirmOpen(false);
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function goBackToInput() {
    if (preview) {
      setFromInput((prev) => (prev ? prev : preview.from));
      setToInput((prev) => (prev ? prev : preview.to));
    }
    setStep("input");
  }

  function toggleItem(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  const count = preview ? countSelectedForApply(preview, selected, trackingChecked) : 0;
  const groups = preview ? groupLinkDomainItems(preview.items) : [];
  const isEmpty = preview ? preview.items.length === 0 && preview.trackingHosts === null : false;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Trocar domínio nos links</DialogTitle>
            {step === "preview" && preview && (
              <DialogDescription>
                De {preview.from} para {preview.to}.
              </DialogDescription>
            )}
          </DialogHeader>

          {step === "input" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="link-domain-from">Domínio antigo</Label>
                <Input
                  id="link-domain-from"
                  value={fromInput}
                  onChange={(e) => setFromInput(e.target.value)}
                  placeholder="casa-antiga.bet.br"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="link-domain-to">Domínio novo</Label>
                <Input
                  id="link-domain-to"
                  value={toInput}
                  onChange={(e) => setToInput(e.target.value)}
                  placeholder="suacasa.bet.br"
                />
              </div>
            </div>
          )}

          {step === "preview" && preview && (
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
              {isEmpty && <p className="text-sm text-muted-foreground">Nenhum link com {preview.from} encontrado.</p>}

              {groups.map((group) => (
                <div key={group.kind} className="space-y-2">
                  <div className="text-sm font-medium">{group.label}</div>
                  <div className="space-y-2">
                    {group.items.map((item) => (
                      <label key={item.key} className="flex items-start gap-2 rounded-md border p-2">
                        <Checkbox
                          checked={selected.has(item.key)}
                          disabled={item.blockedReason !== null}
                          onCheckedChange={() => toggleItem(item.key)}
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="text-sm">
                            {item.title}
                            {item.detail && <span className="text-muted-foreground"> · {item.detail}</span>}
                          </div>
                          <div className="break-words text-xs text-muted-foreground">
                            {item.sample.before} → {item.sample.after}
                          </div>
                          {item.blockedReason && <div className="text-xs text-destructive">{item.blockedReason}</div>}
                          {item.segmentWarning && (
                            <div className="text-xs text-amber-600">{formatSegmentWarning(item.segmentWarning)}</div>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))}

              {preview.trackingHosts && (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Domínios permitidos do rastreio</div>
                  <label className="flex items-start gap-2 rounded-md border p-2">
                    <Checkbox
                      checked={trackingChecked}
                      onCheckedChange={() => setTrackingChecked((prev) => !prev)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                      {preview.trackingHosts.current.join(", ")} → {preview.trackingHosts.next.join(", ")}
                    </div>
                  </label>
                </div>
              )}

              {!outOfScopeIsEmpty(preview) && (
                <div className="space-y-1 rounded-md border border-dashed p-2">
                  <div className="text-sm font-medium">Ainda com {preview.from} (não trocados aqui)</div>
                  <ul className="list-inside list-disc text-xs text-muted-foreground">
                    {preview.outOfScope.scheduledCampaigns.map((c) => (
                      <li key={c.id}>{c.name}</li>
                    ))}
                    {preview.outOfScope.legacyFlows.map((f) => (
                      <li key={f.id}>{f.name}</li>
                    ))}
                    {preview.outOfScope.subdomainLinks > 0 && (
                      <li>{preview.outOfScope.subdomainLinks} link(s) em subdomínio</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {step === "input" && (
              <Button type="button" disabled={previewMutation.isPending} onClick={() => previewMutation.mutate()}>
                {previewMutation.isPending ? "Procurando…" : "Procurar"}
              </Button>
            )}
            {step === "preview" && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={applyMutation.isPending}
                  onClick={goBackToInput}
                >
                  Voltar
                </Button>
                <Button type="button" disabled={count === 0 || applyMutation.isPending} onClick={() => setConfirmOpen(true)}>
                  {`Trocar ${count} itens`}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Trocar domínio nos links</AlertDialogTitle>
            <AlertDialogDescription>
              {`Trocar o domínio em ${count} itens? Isso não pode ser desfeito automaticamente.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction disabled={applyMutation.isPending} onClick={() => applyMutation.mutate()}>
              Trocar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
