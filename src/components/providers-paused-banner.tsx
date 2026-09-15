import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Copy, Mail, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  getDispatchPauseState,
  setDispatchPause,
  type DispatchChannel,
} from "@/lib/dispatch-pause.functions";

const LABEL: Record<DispatchChannel, string> = {
  sms: "SMS",
  email: "Email",
  call: "Ligações",
};

const BUSINESSCODE_MESSAGE = `Assunto: API de SMS e Email retornando HTTP 503 (HTML do Apache) — dash.businesscode.com.br

Olá, time BusinessCode.

Desde hoje todos os nossos disparos de SMS e Email estão falhando. Os endpoints abaixo estão respondendo HTTP 503 Service Unavailable com uma página HTML do Apache, em vez do JSON esperado. Já tentamos com retry/backoff (6 tentativas) e o comportamento se mantém.

Endpoints afetados:
- POST https://dash.businesscode.com.br/api/v1/messaging/email
- POST https://dash.businesscode.com.br/api/v1/messaging/sms

Resposta retornada (literal):
- Status: 503 Service Unavailable
- Content-Type: text/html; charset=iso-8859-1
- Corpo:
<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">
<html><head><title>503 Service Unavailable</title></head>
<body><h1>Service Unavailable</h1>
<p>The server is temporarily unable to service your request due to maintenance downtime or capacity problems. Please try again later.</p>
<hr><address>Apache/2.4.58 (Win64) OpenSSL/3.1.3 PHP/8.2.12 Server at dash.businesscode.com.br Port 443</address>
</body></html>

Volume impactado nas últimas 6 horas: 7.928 e-mails travados em "pending" e dezenas de SMS marcados como erro — todos com a mesma resposta.

Token de autenticação, payload e Content-Type estão corretos (o mesmo request funciona quando o servidor responde). O 503 vem do Apache antes mesmo da aplicação processar.

O que precisamos saber:
1. Confirmar se há manutenção ou sobrecarga em curso em dash.businesscode.com.br.
2. Previsão de normalização.
3. Se existe endpoint/host alternativo enquanto isso.

Obrigado.`;

export function ProvidersPausedBanner({ channel }: { channel: DispatchChannel }) {
  const fetchState = useServerFn(getDispatchPauseState);
  const togglePause = useServerFn(setDispatchPause);
  const qc = useQueryClient();
  const [showMessage, setShowMessage] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data } = useQuery({
    queryKey: ["dispatch-pause-state"],
    queryFn: () => fetchState(),
    refetchInterval: 15_000,
  });

  const mut = useMutation({
    mutationFn: (paused: boolean) =>
      togglePause({
        data: {
          channel,
          paused,
          reason: paused ? "Pausa manual" : undefined,
        },
      }),
    onSuccess: (_r, paused) => {
      toast.success(
        paused
          ? `Disparos de ${LABEL[channel]} pausados.`
          : `Disparos de ${LABEL[channel]} retomados — fila vai drenar nos próximos segundos.`,
      );
      qc.invalidateQueries({ queryKey: ["dispatch-pause-state"] });
    },
    onError: (e: unknown) => {
      toast.error(
        `Não foi possível alterar a pausa: ${e instanceof Error ? e.message : String(e)}`,
      );
    },
  });

  const row = data?.[channel];
  if (!row?.paused) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(BUSINESSCODE_MESSAGE);
      setCopied(true);
      toast.success("Mensagem copiada.");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto manualmente.");
    }
  };

  return (
    <>
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-amber-200 flex items-start gap-3">
        <Pause className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="flex-1 space-y-1">
          <div className="font-medium">
            Disparos de {LABEL[channel]} pausados
          </div>
          <div className="text-xs opacity-80">
            {row.reason ?? "Pausa manual"}. Nada foi perdido — leads, campanhas
            e pendentes seguem na fila e voltam a ser processados assim que você
            clicar em <b>Iniciar disparos</b>.
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowMessage(true)}
            className="border-amber-500/40 text-amber-100 hover:bg-amber-500/10"
          >
            <Mail className="h-3.5 w-3.5 mr-1.5" /> Mensagem para BusinessCode
          </Button>
          <Button
            size="sm"
            onClick={() => mut.mutate(false)}
            disabled={mut.isPending}
            className="bg-amber-500 text-amber-950 hover:bg-amber-400"
          >
            <Play className="h-3.5 w-3.5 mr-1.5" /> Iniciar disparos
          </Button>
        </div>
      </div>

      <Dialog open={showMessage} onOpenChange={setShowMessage}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Mensagem para a BusinessCode</DialogTitle>
            <DialogDescription>
              Copie e envie ao suporte. Inclui o erro literal retornado pelo
              servidor deles.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            readOnly
            value={BUSINESSCODE_MESSAGE}
            className="h-[420px] font-mono text-xs"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowMessage(false)}>
              Fechar
            </Button>
            <Button onClick={copy}>
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 mr-1.5" /> Copiado
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5 mr-1.5" /> Copiar mensagem
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ProvidersPauseControl({ channel }: { channel: DispatchChannel }) {
  // Mostra um botão "Pausar" quando NÃO está pausado, para uso futuro.
  const fetchState = useServerFn(getDispatchPauseState);
  const togglePause = useServerFn(setDispatchPause);
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["dispatch-pause-state"],
    queryFn: () => fetchState(),
    refetchInterval: 30_000,
  });

  const mut = useMutation({
    mutationFn: () =>
      togglePause({
        data: { channel, paused: true, reason: "Pausa manual" },
      }),
    onSuccess: () => {
      toast.success(`Disparos de ${LABEL[channel]} pausados.`);
      qc.invalidateQueries({ queryKey: ["dispatch-pause-state"] });
    },
  });

  if (data?.[channel]?.paused) return null;
  return (
    <Button size="sm" variant="outline" onClick={() => mut.mutate()} disabled={mut.isPending}>
      <Pause className="h-3.5 w-3.5 mr-1.5" /> Pausar disparos
    </Button>
  );
}