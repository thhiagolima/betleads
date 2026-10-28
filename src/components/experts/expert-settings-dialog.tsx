// "Regras de crédito" dialog (Área do Expert, Fase 3, Task 6): configura a
// janela de clique da casa (`expert_settings.click_window_hours`) via
// `saveExpertSettings` (Task 3). Salvar recalcula os últimos 8 dias no
// servidor; aqui só avisamos isso na ajuda do campo, como no brief.
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveExpertSettings } from "@/lib/expert-metrics.functions";
import { EXPERTS_RANKING_QUERY_KEY } from "@/components/experts/experts-query";

const JANELA_MIN = 1;
const JANELA_MAX = 720;

function janelaError(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "Informe a janela em horas.";
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < JANELA_MIN || value > JANELA_MAX) {
    return `A janela precisa ser um número inteiro entre ${JANELA_MIN} e ${JANELA_MAX} horas.`;
  }
  return null;
}

export function ExpertSettingsDialog({
  open,
  onOpenChange,
  janelaHoras,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  janelaHoras: number;
  onSaved?: (janelaHoras: number) => void;
}) {
  const qc = useQueryClient();
  const saveFn = useServerFn(saveExpertSettings);
  const [value, setValue] = useState(String(janelaHoras));

  useEffect(() => {
    if (open) setValue(String(janelaHoras));
  }, [open, janelaHoras]);

  const save = useMutation({
    mutationFn: (clickWindowHours: number) => saveFn({ data: { clickWindowHours } }),
    onSuccess: (result) => {
      toast.success("Janela de clique atualizada.");
      onSaved?.(result.clickWindowHours);
      void qc.invalidateQueries({ queryKey: EXPERTS_RANKING_QUERY_KEY });
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const error = janelaError(value);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Regras de crédito</DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="janela-clique">Janela de clique (horas)</Label>
          <Input
            id="janela-clique"
            inputMode="numeric"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Padrão 72h. Vale para os próximos cálculos e recalcula os últimos 8 dias.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!!error || save.isPending}
            onClick={() => {
              const parsed = Number(value.trim());
              if (!error) save.mutate(parsed);
            }}
          >
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
