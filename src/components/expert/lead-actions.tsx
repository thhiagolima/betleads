// Ações de mensagem da ficha do lead (Área do Expert, Fase 2, Task 7): link
// rastreado da oferta, mensagem pronta para o WhatsApp e sugestão da IA.
//
// O texto é sempre renderizado no servidor (`renderExpertMessage`) na hora de
// abrir o WhatsApp ou copiar, com `{link}` = o link gerado nesta sessão — o
// servidor só aceita um link que o próprio expert gerou para este lead.
// Erros das ações aparecem com a mensagem do servidor (já em pt-BR).
import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Copy, MessageCircle, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { HomeCard } from "@/components/home/home-cards";
import { suggestExpertApproach } from "@/lib/expert-ai.functions";
import { generateExpertLink } from "@/lib/expert-links.functions";
import type { ExpertLeadSheet } from "@/lib/expert-lead-sheet";
import { listExpertTemplates, renderExpertMessage } from "@/lib/expert-templates.functions";
import { normalizeBrazilianPhone } from "@/lib/phone-normalization";

import { actionErrorMessage } from "./sheet-format";

const MESSAGE_MAX = 1000;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ActionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <HomeCard className="p-4 sm:p-5">
      <h2 className="text-section">{title}</h2>
      {subtitle && <p className="mt-0.5 text-label text-muted-foreground">{subtitle}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </HomeCard>
  );
}

type GeneratedLink = { id: string; sentUrl: string; shortened: boolean };

export function LeadActions({
  sheet,
  onChanged,
}: {
  sheet: ExpertLeadSheet;
  onChanged: () => void;
}) {
  const playerId = sheet.lead.id;
  const waNumber = normalizeBrazilianPhone(sheet.lead.telefone)?.replace(/^\+/, "") ?? null;

  // ---------------------------------------------------------------- link
  const [offerUrl, setOfferUrl] = useState("");
  const [oferta, setOferta] = useState("");
  const [link, setLink] = useState<GeneratedLink | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const generateLinkFn = useServerFn(generateExpertLink);
  const generateLink = useMutation({
    mutationFn: () => generateLinkFn({ data: { playerId, url: offerUrl, oferta } }),
    onSuccess: (generated) => {
      setLink(generated);
      setLinkCopied(false);
      toast.success("Link gerado.");
      onChanged();
    },
    onError: (error) => toast.error(actionErrorMessage(error)),
  });

  async function copyLink() {
    if (!link) return;
    if (await copyText(link.sentUrl)) {
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1500);
      toast.success("Link copiado.");
    } else {
      toast.error("Não foi possível copiar.");
    }
  }

  // ---------------------------------------------------------------- message
  const listTemplatesFn = useServerFn(listExpertTemplates);
  const templatesQuery = useQuery({
    queryKey: ["expert-templates"],
    queryFn: () => listTemplatesFn(),
    staleTime: 60_000,
  });
  const meus = templatesQuery.data?.meus ?? [];
  const casa = templatesQuery.data?.casa ?? [];

  const [templateKey, setTemplateKey] = useState("");
  const [text, setText] = useState("");

  function pickTemplate(key: string) {
    setTemplateKey(key);
    const template = [...meus, ...casa].find((t) => `${t.origem}:${t.id}` === key);
    if (template) setText(template.conteudo.slice(0, MESSAGE_MAX));
  }

  const missingLink = text.includes("{link}") && !link;
  const messageReady = text.trim().length > 0 && !missingLink;

  const renderFn = useServerFn(renderExpertMessage);
  const render = useMutation({
    mutationFn: () => renderFn({ data: { playerId, conteudo: text, link: link?.sentUrl } }),
  });

  async function openWhatsApp() {
    if (!waNumber || !messageReady) return;
    // A aba é aberta já no clique (antes do await) para não cair no bloqueio
    // de pop-up; depois de renderizar, ela vai para o wa.me.
    const tab = window.open("", "_blank");
    try {
      const { texto } = await render.mutateAsync();
      const url = `https://wa.me/${waNumber}?text=${encodeURIComponent(texto)}`;
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      tab?.close();
      toast.error(actionErrorMessage(error));
    }
  }

  async function copyMessage() {
    if (!messageReady) return;
    try {
      const { texto } = await render.mutateAsync();
      if (await copyText(texto)) toast.success("Texto copiado.");
      else toast.error("Não foi possível copiar.");
    } catch (error) {
      toast.error(actionErrorMessage(error));
    }
  }

  // ---------------------------------------------------------------- AI
  const suggestFn = useServerFn(suggestExpertApproach);
  const suggest = useMutation({
    mutationFn: () => suggestFn({ data: { playerId } }),
    onError: (error) => toast.error(actionErrorMessage(error)),
  });

  function applySuggestion() {
    const suggestion = suggest.data;
    if (!suggestion) return;
    setText(suggestion.mensagem.slice(0, MESSAGE_MAX));
    setTemplateKey("");
    if (!oferta.trim()) setOferta(suggestion.oferta.slice(0, 60));
    toast.success("Mensagem colocada no texto.");
  }

  const fieldClass = "h-11 sm:h-9";

  return (
    <div className="space-y-3">
      <ActionCard title="Link da oferta">
        <div className="space-y-1.5">
          <Label htmlFor="expert-offer-url">URL da oferta</Label>
          <Input
            id="expert-offer-url"
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
          <Label htmlFor="expert-offer-name">Nome da oferta</Label>
          <Input
            id="expert-offer-name"
            placeholder="Ex.: Cashback de sexta"
            value={oferta}
            maxLength={60}
            onChange={(event) => setOferta(event.target.value)}
            className={fieldClass}
          />
        </div>
        <Button
          className={`${fieldClass} w-full`}
          disabled={generateLink.isPending || !offerUrl.trim() || !oferta.trim()}
          onClick={() => generateLink.mutate()}
        >
          {generateLink.isPending ? "Gerando…" : "Gerar link"}
        </Button>
        {link && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={link.sentUrl}
                aria-label="Link gerado"
                className={`${fieldClass} min-w-0 flex-1`}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button variant="outline" className={`${fieldClass} gap-1.5`} onClick={copyLink}>
                {linkCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                Copiar
              </Button>
            </div>
            {!link.shortened && (
              <p className="text-label text-muted-foreground">
                Encurtador não configurado; o link é rastreado mesmo assim.
              </p>
            )}
          </div>
        )}
      </ActionCard>

      <ActionCard title="Mensagem">
        <div className="space-y-1.5">
          <Label htmlFor="expert-template">Modelo</Label>
          <Select value={templateKey} onValueChange={pickTemplate}>
            <SelectTrigger id="expert-template" className={fieldClass}>
              <SelectValue
                placeholder={templatesQuery.isLoading ? "Carregando modelos…" : "Escolha um modelo"}
              />
            </SelectTrigger>
            <SelectContent>
              {meus.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Meus modelos</SelectLabel>
                  {meus.map((t) => (
                    <SelectItem key={t.id} value={`meu:${t.id}`}>
                      {t.nome}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {casa.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Da casa</SelectLabel>
                  {casa.map((t) => (
                    <SelectItem key={t.id} value={`casa:${t.id}`}>
                      {t.nome}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {!templatesQuery.isLoading && meus.length === 0 && casa.length === 0 && (
                <p className="px-2 py-1.5 text-label text-muted-foreground">
                  Nenhum modelo disponível.
                </p>
              )}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="expert-message">Texto</Label>
          <Textarea
            id="expert-message"
            rows={6}
            maxLength={MESSAGE_MAX}
            placeholder="Escreva a mensagem ou escolha um modelo. Use {link} para o link da oferta."
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        {missingLink && (
          <p className="text-label text-warning">
            Gere o link da oferta para preencher {"{link}"}.
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            className={`${fieldClass} flex-1 gap-1.5`}
            disabled={!waNumber || !messageReady || render.isPending}
            onClick={() => void openWhatsApp()}
          >
            <MessageCircle className="h-4 w-4" />
            Abrir no WhatsApp
          </Button>
          <Button
            variant="outline"
            className={`${fieldClass} flex-1 gap-1.5`}
            disabled={!messageReady || render.isPending}
            onClick={() => void copyMessage()}
          >
            <Copy className="h-4 w-4" />
            Copiar texto
          </Button>
        </div>
        {!waNumber && <p className="text-label text-muted-foreground">Lead sem telefone válido.</p>}
      </ActionCard>

      <ActionCard title="Sugestão da IA">
        <Button
          variant="outline"
          className={`${fieldClass} w-full gap-1.5`}
          disabled={suggest.isPending}
          onClick={() => suggest.mutate()}
        >
          <Sparkles className="h-4 w-4" />
          {suggest.isPending ? "Pensando…" : "Sugerir abordagem"}
        </Button>
        {suggest.data && (
          <div className="space-y-2 rounded-lg border border-border/70 p-3">
            <p className="text-body font-medium">{suggest.data.oferta}</p>
            <p className="whitespace-pre-wrap text-body text-muted-foreground">
              {suggest.data.mensagem}
            </p>
            <Button variant="secondary" className={fieldClass} onClick={applySuggestion}>
              Usar esta mensagem
            </Button>
          </div>
        )}
      </ActionCard>
    </div>
  );
}
