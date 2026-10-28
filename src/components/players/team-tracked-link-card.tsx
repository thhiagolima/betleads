// "Link rastreado (seu rendimento)" card on the house player page (Área do
// Expert, Fase 3, Task 7; spec §7.1). Rendered only for someone of the house
// team with an active performance profile (`getMyTeamExpertProfile`): they
// paste the offer link, get a tracked link credited to their profile
// (`generateTeamTrackedLink`), copy it or open WhatsApp with the link already
// in the text. Same generate → copy UX as the expert's lead page
// (`components/expert/lead-actions.tsx`), without message templates.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Copy, MessageCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HomeCard } from "@/components/home/home-cards";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { normalizeBrazilianPhone } from "@/lib/phone-normalization";
import { generateTeamTrackedLink, getMyTeamExpertProfile } from "@/lib/team-expert.functions";

type GeneratedLink = { id: string; sentUrl: string; shortened: boolean };

export function TeamTrackedLinkCard({
  playerId,
  telefone,
  onGenerated,
}: {
  playerId: string;
  telefone: string | null | undefined;
  onGenerated?: () => void;
}) {
  const getProfileFn = useServerFn(getMyTeamExpertProfile);
  // The profile belongs to the house chosen in the header: keyed by it, so
  // switching houses never reuses the previous house's answer.
  const tenant = useActiveTenant();
  const tenantId = tenant.data?.activeTenantId ?? null;
  const profileQuery = useQuery({
    queryKey: ["team-expert-profile", tenantId],
    queryFn: () => getProfileFn(),
    enabled: !!tenantId,
    staleTime: 5 * 60_000,
  });

  if (!profileQuery.data) return null;
  return <TeamTrackedLinkForm playerId={playerId} telefone={telefone} onGenerated={onGenerated} />;
}

function TeamTrackedLinkForm({
  playerId,
  telefone,
  onGenerated,
}: {
  playerId: string;
  telefone: string | null | undefined;
  onGenerated?: () => void;
}) {
  const waNumber = normalizeBrazilianPhone(telefone)?.replace(/^\+/, "") ?? null;
  const [offerUrl, setOfferUrl] = useState("");
  const [oferta, setOferta] = useState("");
  const [link, setLink] = useState<GeneratedLink | null>(null);
  const [copied, setCopied] = useState(false);

  const generateFn = useServerFn(generateTeamTrackedLink);
  const generate = useMutation({
    mutationFn: () => generateFn({ data: { playerId, url: offerUrl, oferta } }),
    onSuccess: (generated) => {
      setLink(generated);
      setCopied(false);
      toast.success("Link gerado.");
      onGenerated?.();
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Não foi possível gerar o link."),
  });

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.sentUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      toast.success("Link copiado.");
    } catch {
      toast.error("Não foi possível copiar.");
    }
  }

  function openWhatsApp() {
    if (!link || !waNumber) return;
    window.open(
      `https://wa.me/${waNumber}?text=${encodeURIComponent(link.sentUrl)}`,
      "_blank",
      "noopener,noreferrer",
    );
  }

  const fieldClass = "h-11 sm:h-9";

  return (
    <HomeCard className="space-y-3 p-4 sm:p-5">
      <div>
        <h2 className="text-section">Link rastreado (seu rendimento)</h2>
        <p className="mt-0.5 text-label text-muted-foreground">
          Os depósitos que vierem deste link contam para o seu perfil de rendimento.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="team-offer-url">URL da oferta</Label>
          <Input
            id="team-offer-url"
            type="url"
            inputMode="url"
            placeholder="https://..."
            value={offerUrl}
            maxLength={2048}
            onChange={(event) => setOfferUrl(event.target.value)}
            className={fieldClass}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="team-offer-name">Nome da oferta</Label>
          <Input
            id="team-offer-name"
            placeholder="Ex.: Cashback de sexta"
            value={oferta}
            maxLength={60}
            onChange={(event) => setOferta(event.target.value)}
            className={fieldClass}
          />
        </div>
      </div>
      <Button
        className={`${fieldClass} w-full sm:w-auto`}
        disabled={generate.isPending || !offerUrl.trim() || !oferta.trim()}
        onClick={() => generate.mutate()}
      >
        {generate.isPending ? "Gerando…" : "Gerar link"}
      </Button>
      {link && (
        <div className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              readOnly
              value={link.sentUrl}
              aria-label="Link gerado"
              className={`${fieldClass} min-w-0 flex-1`}
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                className={`${fieldClass} flex-1 gap-1.5`}
                onClick={() => void copyLink()}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                Copiar
              </Button>
              <Button
                className={`${fieldClass} flex-1 gap-1.5`}
                disabled={!waNumber}
                onClick={openWhatsApp}
              >
                <MessageCircle className="h-4 w-4" />
                Abrir no WhatsApp
              </Button>
            </div>
          </div>
          {!link.shortened && (
            <p className="text-label text-muted-foreground">
              Encurtador não configurado; o link é rastreado mesmo assim.
            </p>
          )}
          {!waNumber && (
            <p className="text-label text-muted-foreground">Jogador sem telefone válido.</p>
          )}
        </div>
      )}
    </HomeCard>
  );
}
