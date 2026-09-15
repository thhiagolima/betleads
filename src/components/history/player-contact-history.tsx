import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MessageSquare, Mail, Phone, MessageCircle } from "lucide-react";
import { getPlayerContactHistory, type ChannelKey } from "@/lib/history.functions";
import { StatusBadge } from "./status-badge";

const ICONS: Record<ChannelKey, React.ReactNode> = {
  whatsapp: <MessageCircle className="h-3.5 w-3.5 text-emerald-400" />,
  sms: <MessageSquare className="h-3.5 w-3.5 text-sky-400" />,
  email: <Mail className="h-3.5 w-3.5 text-amber-400" />,
  calls: <Phone className="h-3.5 w-3.5 text-violet-400" />,
};

const LABEL: Record<ChannelKey, string> = {
  whatsapp: "WhatsApp",
  sms: "SMS",
  email: "Email",
  calls: "Ligação",
};

export function PlayerContactHistoryDialog({
  playerId,
  playerName,
  open,
  onOpenChange,
}: {
  playerId: string | null;
  playerName?: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const fn = useServerFn(getPlayerContactHistory);
  const q = useQuery({
    queryKey: ["player-contact-history", playerId],
    queryFn: () => fn({ data: { playerId: playerId!, limit: 80 } }),
    enabled: !!playerId && open,
  });
  const items = q.data?.items ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Histórico de contatos</DialogTitle>
          <DialogDescription>
            {playerName ? `Tudo que já foi enviado para ${playerName}.` : "Tudo que já foi enviado para esse lead."}
          </DialogDescription>
        </DialogHeader>
        {q.isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Carregando…</p>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nenhum contato registrado para esse lead ainda.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((it, i) => (
              <li
                key={i}
                className="flex items-start gap-3 rounded-md border border-white/5 bg-muted/30 p-3"
              >
                <div className="mt-0.5">{ICONS[it.channel]}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium">{LABEL[it.channel]}</span>
                    <span className="text-muted-foreground">
                      {new Date(it.at).toLocaleString("pt-BR")}
                    </span>
                    <StatusBadge color={it.status_color} label={it.status_label} />
                    {it.flow && (
                      <span className="text-muted-foreground">· {it.flow}</span>
                    )}
                    {it.step && (
                      <span className="text-muted-foreground">· {it.step}</span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                    {it.preview}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}