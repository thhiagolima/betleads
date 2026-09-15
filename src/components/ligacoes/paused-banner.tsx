// Aviso fixo no topo da tela /ligacoes enquanto o motor está pausado.
// Pausa controlada manualmente pelos cron jobs (jobid 5 e 16). Quando o
// usuário pedir para retomar, basta `cron.alter_job(.., active := true)`.
import { Pause } from "lucide-react";

export function LigacoesPausedBanner() {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-amber-300 flex items-start gap-3">
      <Pause className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="flex-1 space-y-1">
        <div className="font-medium">Motor de ligações pausado</div>
        <div className="text-xs opacity-80">
          Nenhuma ligação será disparada. Fila e progressos de fluxo estão congelados.
          Para retomar, peça no chat “retomar ligações”.
        </div>
      </div>
    </div>
  );
}