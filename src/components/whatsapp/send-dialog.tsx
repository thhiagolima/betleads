import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { ExternalLink, Send, Loader2, Lock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import {
  resolveSessionForLead,
  sendToLeadFromSession,
  sendWhatsappMessage,
} from "@/lib/whatsapp.functions";

function digitsOf(p: string | null | undefined) {
  return (p ?? "").replace(/\D/g, "");
}

export function EnviarPeloWhatsAppDialog({
  open,
  onOpenChange,
  phone,
  leadName,
  mensagem,
  onSent,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  phone: string | null | undefined;
  leadName: string;
  mensagem: string;
  onSent?: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const resolveFn = useServerFn(resolveSessionForLead);
  const sendToLeadFn = useServerFn(sendToLeadFromSession);
  const sendTextFn = useServerFn(sendWhatsappMessage);

  const [text, setText] = useState(mensagem);
  const [selectedSession, setSelectedSession] = useState<string>("");

  useEffect(() => {
    if (open) {
      setText(mensagem);
      setSelectedSession("");
    }
  }, [open, mensagem]);

  const digits = digitsOf(phone);

  const { data, isLoading } = useQuery({
    queryKey: ["resolve-session", digits],
    queryFn: () => resolveFn({ data: { phone: digits } }),
    enabled: open && digits.length > 0,
    staleTime: 0,
  });

  useEffect(() => {
    if (data && !data.pinned && !selectedSession) {
      const firstConnected = data.sessions.find((s) => s.status === "connected");
      if (firstConnected) setSelectedSession(firstConnected.id);
    }
  }, [data, selectedSession]);

  const sendMut = useMutation({
    mutationFn: async () => {
      if (!text.trim()) throw new Error("Mensagem vazia");
      if (data?.pinned) {
        if (data.orphaned || data.session_status !== "connected") {
          throw new Error("A sessão vinculada a este lead está offline. Realoque o lead ou escolha outra sessão em WhatsApp → Sessões.");
        }
        if (!data.chat_id) {
          throw new Error("Não encontrei a conversa vinculada deste lead. Realoque o lead em WhatsApp → Sessões antes de enviar.");
        }
        // Conversa já existe → manda no chat_id direto pra preservar histórico/ordem
        return sendTextFn({ data: { chat_id: data.chat_id, text: text.trim() } }).then(
          () => ({ chat_id: data.chat_id, session_name: data.session_name }),
        );
      }
      if (!selectedSession) throw new Error("Escolha uma sessão");
      const res = await sendToLeadFn({
        data: { session_id: selectedSession, phone: digits, text: text.trim() },
      });
      return { chat_id: res.chat_id, session_name: res.session_name };
    },
    onSuccess: (res) => {
      toast.success(`Mensagem enviada via ${res.session_name ?? "WhatsApp"}`, {
        action: {
          label: "Abrir no Inbox",
          onClick: () => {
            navigate({
              to: "/whatsapp",
              search: { tab: "inbox", chat: res.chat_id } as any,
            });
          },
        },
      });
      onOpenChange(false);
      onSent?.();
    },
    onError: (e: any) => {
      qc.invalidateQueries({ queryKey: ["resolve-session", digits] });
      toast.error(e?.message ?? "Falha ao enviar");
    },
  });

  const pinnedUnavailable = Boolean(
    data?.pinned && (data.orphaned || data.session_status !== "connected" || !data.chat_id),
  );

  const fallbackWhatsappWeb = () => {
    if (!digits) return;
    const url = `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Enviar WhatsApp para {leadName}</DialogTitle>
          <DialogDescription>
            {digits ? `+${digits}` : "Sem telefone cadastrado"}
          </DialogDescription>
        </DialogHeader>

        {!digits ? (
          <p className="text-sm text-muted-foreground py-4">
            Cadastre um telefone para este lead.
          </p>
        ) : isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Verificando sessão…
          </div>
        ) : data?.pinned ? (
          <div className="space-y-3">
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs flex gap-2">
              <Lock className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                {pinnedUnavailable ? (
                  <>
                    A sessão vinculada <strong>{data.session_name ?? "—"}</strong> está indisponível. Realoque o lead antes de enviar.
                  </>
                ) : (
                  <>
                    Esta conversa já está vinculada à sessão <strong>{data.session_name ?? "—"}</strong>. Só dá pra responder por este número.
                  </>
                )}
              </div>
            </div>
            <div>
              <Label className="text-xs">Mensagem</Label>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={5}
                className="mt-1"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {(data?.sessions.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nenhuma sessão WhatsApp cadastrada. Crie uma em WhatsApp →
                Sessões.
              </p>
            ) : (
              <div>
                <Label className="text-xs">Escolha o WhatsApp de envio</Label>
                <RadioGroup
                  value={selectedSession}
                  onValueChange={setSelectedSession}
                  className="mt-2 space-y-1.5"
                >
                  {data?.sessions.map((s) => {
                    const disabled = s.status !== "connected";
                    return (
                      <label
                        key={s.id}
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer ${
                          disabled
                            ? "opacity-50 cursor-not-allowed border-border"
                            : selectedSession === s.id
                              ? "border-primary bg-primary/5"
                              : "border-border hover:bg-muted/40"
                        }`}
                      >
                        <RadioGroupItem value={s.id} disabled={disabled} />
                        <span className="flex-1">{s.name}</span>
                        <Badge
                          variant="outline"
                          className={
                            s.status === "connected"
                              ? "text-[10px] bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                              : "text-[10px] bg-slate-500/15 text-slate-300 border-slate-500/30"
                          }
                        >
                          {s.status === "connected" ? "Conectado" : "Offline"}
                        </Badge>
                      </label>
                    );
                  })}
                </RadioGroup>
              </div>
            )}
            <div>
              <Label className="text-xs">Mensagem</Label>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={5}
                className="mt-1"
              />
            </div>
          </div>
        )}

        <DialogFooter className="flex sm:justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={fallbackWhatsappWeb}
            disabled={!digits}
            className="gap-1.5"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Abrir no WhatsApp Web
          </Button>
          <Button
            type="button"
            onClick={() => sendMut.mutate()}
            disabled={
              !digits ||
              !text.trim() ||
              sendMut.isPending ||
              pinnedUnavailable ||
              (!data?.pinned && !selectedSession)
            }
            className="gap-1.5"
          >
            {sendMut.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Enviar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}