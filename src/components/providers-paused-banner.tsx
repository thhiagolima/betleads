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

const SHORT_BRASIL_MESSAGE = `Assunto: API de SMS Short Brasil indisponivel - lp01-short.painelsms.com

Ola, time Short Brasil.

Estamos tentando enviar SMS pela API documentada abaixo, mas o endpoint nao respondeu a conexao do nosso backend:

- POST http://lp01-short.painelsms.com/bot/single-sms.php
- Headers: usuario, chave, content-type: application/json
- Body: {"celular":"DDDNUMERO","mensagem":"...","parceiroId":"..."}

Precisamos confirmar:
1. Se o host lp01-short.painelsms.com esta operacional.
2. Se existe IP, firewall ou allowlist necessario.
3. Se ha endpoint alternativo ou HTTPS recomendado.

Obrigado.`;

const INFOBIP_MESSAGE = `Assunto: API Infobip indisponível

Olá, time Infobip.

O CRM está recebendo erros temporários ao enviar mensagens. Poderiam confirmar a saúde da conta, credenciais, domínio/remetente e eventuais restrições de rede?

Obrigado.`;

function supportMessageFor(channel: DispatchChannel): { title: string; body: string } {
  if (channel === "sms") {
    return { title: "Mensagem para a Short Brasil", body: SHORT_BRASIL_MESSAGE };
  }
  return { title: "Mensagem para a Infobip", body: INFOBIP_MESSAGE };
}

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
  const supportMessage = supportMessageFor(channel);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(supportMessage.body);
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
          <div className="font-medium">Disparos de {LABEL[channel]} pausados</div>
          <div className="text-xs opacity-80">
            {row.reason ?? "Pausa manual"}. Nada foi perdido — leads, campanhas e pendentes seguem
            na fila e voltam a ser processados assim que você clicar em <b>Iniciar disparos</b>.
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowMessage(true)}
            className="border-amber-500/40 text-amber-100 hover:bg-amber-500/10"
          >
            <Mail className="h-3.5 w-3.5 mr-1.5" /> {supportMessage.title}
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
            <DialogTitle>{supportMessage.title}</DialogTitle>
            <DialogDescription>
              Copie e envie ao suporte. Inclui o erro literal retornado pelo servidor deles.
            </DialogDescription>
          </DialogHeader>
          <Textarea readOnly value={supportMessage.body} className="h-[420px] font-mono text-xs" />
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
