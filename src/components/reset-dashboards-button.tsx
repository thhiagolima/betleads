import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import {
  getDashboardResetAt,
  resetDashboards,
} from "@/lib/dashboard-settings.functions";

const EPOCH = "1970-01-01T00:00:00.000Z";

function formatBR(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function ResetDashboardsButton() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const getResetFn = useServerFn(getDashboardResetAt);
  const resetFn = useServerFn(resetDashboards);

  const { data: settings } = useQuery({
    queryKey: ["dashboard-reset-at"],
    queryFn: () => getResetFn(),
    refetchInterval: 60000,
  });

  const mut = useMutation({
    mutationFn: () => resetFn(),
    onSuccess: () => {
      toast.success("Dashboards zeradas. Os novos disparos começam do zero.");
      qc.invalidateQueries({ queryKey: ["dashboard-reset-at"] });
      qc.invalidateQueries({ queryKey: ["whatsapp-dashboard"] });
      qc.invalidateQueries({ queryKey: ["sms-dashboard"] });
      qc.invalidateQueries({ queryKey: ["email-dashboard"] });
      qc.invalidateQueries({ queryKey: ["calls-dashboard"] });
      setOpen(false);
    },
    onError: (e: any) => toast.error(e?.message ?? "Não foi possível zerar"),
  });

  const resetAt = settings?.reset_at ?? EPOCH;
  const hasReset = resetAt > EPOCH && new Date(resetAt).getFullYear() > 2000;

  return (
    <div className="flex items-center gap-2">
      {hasReset && (
        <span className="text-[10px] text-muted-foreground hidden sm:inline">
          Contando desde {formatBR(resetAt)}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 text-xs"
        onClick={() => setOpen(true)}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Zerar dashboards
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Zerar todas as dashboards?</AlertDialogTitle>
            <AlertDialogDescription>
              Os contadores das 4 dashboards (WhatsApp, SMS, Email, Ligações) voltam a zero
              a partir de agora. <strong>Nenhuma mensagem, ligação ou depósito é apagado</strong> —
              o histórico continua disponível nas abas de Histórico/Inbox/Logs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={mut.isPending}
              onClick={(e) => {
                e.preventDefault();
                mut.mutate();
              }}
            >
              {mut.isPending ? "Zerando…" : "Zerar agora"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}