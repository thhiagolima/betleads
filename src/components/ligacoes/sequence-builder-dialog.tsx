// Gerador rápido de blocos em sequência para Fluxos de Ligação.
// O usuário escolhe N roteiros, um SMS por etapa, condição do SMS e delay
// entre etapas — o componente devolve uma lista de blocos prontos (Ligação
// + SMS condicional + Delay), que são anexados ao fluxo atual.

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown, Wand2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

type SmsCondition =
  | "always"
  | "answered"
  | "not_answered"
  | "listened_gte"
  | "listened_lt"
  | "hangup_before"
  | "voicemail"
  | "busy"
  | "failed"
  | "no_answer";

interface BlockSms {
  condition: SmsCondition;
  threshold_seconds: number | null;
  template: string;
}
interface CallBlock {
  block_type: "call";
  name: string;
  script_id: string | null;
  voice_id: string | null;
  max_call_seconds: number;
  max_attempts: number;
  delay_after_seconds: number;
  sms: BlockSms[];
}
interface DelayBlock {
  block_type: "delay";
  delay_seconds: number;
}
type Block = CallBlock | DelayBlock;

interface ScriptOption {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  scripts: ScriptOption[];
  onGenerate: (blocks: Block[]) => void;
}

type Step = { script_id: string | null; sms: string };

type DelayUnit = "m" | "h" | "d";
function unitToSeconds(value: number, unit: DelayUnit) {
  const v = Math.max(0, Math.floor(value || 0));
  return unit === "m" ? v * 60 : unit === "h" ? v * 3600 : v * 86400;
}

const SMS_CONDS: { v: SmsCondition; l: string }[] = [
  { v: "answered", l: "Se atendeu" },
  { v: "not_answered", l: "Se NÃO atendeu" },
  { v: "always", l: "Sempre" },
  { v: "voicemail", l: "Se caixa postal" },
  { v: "no_answer", l: "Sem resposta" },
];

export function SequenceBuilderDialog({
  open,
  onOpenChange,
  scripts,
  onGenerate,
}: Props) {
  const [steps, setSteps] = useState<Step[]>([
    { script_id: null, sms: "" },
    { script_id: null, sms: "" },
  ]);
  const [smsCondition, setSmsCondition] = useState<SmsCondition>("answered");
  const [delayValue, setDelayValue] = useState(1);
  const [delayUnit, setDelayUnit] = useState<DelayUnit>("d");
  const [maxCallSeconds, setMaxCallSeconds] = useState(60);

  useEffect(() => {
    if (open) {
      setSteps([
        { script_id: null, sms: "" },
        { script_id: null, sms: "" },
      ]);
      setSmsCondition("answered");
      setDelayValue(1);
      setDelayUnit("d");
      setMaxCallSeconds(60);
    }
  }, [open]);

  const delaySeconds = useMemo(
    () => unitToSeconds(delayValue, delayUnit),
    [delayValue, delayUnit],
  );

  function update(idx: number, patch: Partial<Step>) {
    setSteps((s) => s.map((st, i) => (i === idx ? { ...st, ...patch } : st)));
  }
  function add() {
    setSteps((s) => [...s, { script_id: null, sms: "" }]);
  }
  function remove(idx: number) {
    setSteps((s) => s.filter((_, i) => i !== idx));
  }
  function move(idx: number, dir: -1 | 1) {
    setSteps((s) => {
      const next = [...s];
      const t = idx + dir;
      if (t < 0 || t >= next.length) return s;
      [next[idx], next[t]] = [next[t], next[idx]];
      return next;
    });
  }
  function fillFromAll() {
    // preenche todas as etapas com os scripts disponíveis em ordem
    if (!scripts.length) {
      toast.error("Nenhum roteiro disponível");
      return;
    }
    setSteps(
      scripts.map((sc) => ({ script_id: sc.id, sms: "" })),
    );
  }

  function generate() {
    const valid = steps.filter((s) => s.script_id);
    if (valid.length === 0) {
      toast.error("Selecione ao menos 1 roteiro");
      return;
    }
    const blocks: Block[] = [];
    valid.forEach((s, i) => {
      const sms: BlockSms[] = s.sms.trim()
        ? [
            {
              condition: smsCondition,
              threshold_seconds: null,
              template: s.sms,
            },
          ]
        : [];
      const scriptName =
        scripts.find((sc) => sc.id === s.script_id)?.name ?? `Ligação ${i + 1}`;
      blocks.push({
        block_type: "call",
        name: scriptName,
        script_id: s.script_id,
        voice_id: null,
        max_call_seconds: maxCallSeconds,
        max_attempts: 1,
        delay_after_seconds: i < valid.length - 1 ? delaySeconds : 0,
        sms,
      });
    });
    onGenerate(blocks);
    onOpenChange(false);
    toast.success(`${blocks.length} blocos adicionados ao fluxo`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" />
            Gerar fluxo em sequência
          </DialogTitle>
          <DialogDescription>
            Escolha os roteiros na ordem desejada e o SMS de cada etapa. O sistema
            monta automaticamente todos os blocos com o mesmo delay entre eles.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <section className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card/40 p-3 sm:grid-cols-4">
            <div>
              <Label className="text-xs">Delay entre etapas</Label>
              <div className="flex gap-1">
                <Input
                  type="number"
                  min={1}
                  value={delayValue}
                  onChange={(e) =>
                    setDelayValue(Math.max(1, Number(e.target.value) || 1))
                  }
                />
                <Select
                  value={delayUnit}
                  onValueChange={(v) => setDelayUnit(v as DelayUnit)}
                >
                  <SelectTrigger className="w-[80px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="m">min</SelectItem>
                    <SelectItem value="h">h</SelectItem>
                    <SelectItem value="d">dias</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-xs">Condição do SMS</Label>
              <Select
                value={smsCondition}
                onValueChange={(v) => setSmsCondition(v as SmsCondition)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SMS_CONDS.map((c) => (
                    <SelectItem key={c.v} value={c.v}>
                      {c.l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Duração máx. da ligação (seg)</Label>
              <Input
                type="number"
                min={5}
                max={600}
                value={maxCallSeconds}
                onChange={(e) =>
                  setMaxCallSeconds(Math.max(5, Number(e.target.value) || 60))
                }
              />
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={fillFromAll}
                className="w-full"
              >
                Usar todos os roteiros
              </Button>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm">
                Etapas{" "}
                <Badge variant="secondary" className="ml-1">
                  {steps.length}
                </Badge>
              </Label>
              <Button size="sm" variant="outline" onClick={add}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Etapa
              </Button>
            </div>

            {steps.map((s, i) => (
              <div
                key={i}
                className="rounded-lg border border-border bg-card/40 p-3"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    Etapa {i + 1}
                  </span>
                  <div className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      disabled={i === steps.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive"
                      onClick={() => remove(i)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Select
                    value={s.script_id ?? "__none"}
                    onValueChange={(v) =>
                      update(i, { script_id: v === "__none" ? null : v })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione o roteiro de ligação" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">— sem roteiro —</SelectItem>
                      {scripts.map((sc) => (
                        <SelectItem key={sc.id} value={sc.id}>
                          {sc.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Textarea
                    rows={3}
                    value={s.sms}
                    onChange={(e) => update(i, { sms: e.target.value })}
                    placeholder="SMS pós-ligação (opcional). Variáveis: {primeiro_nome}, {saldo}…"
                  />
                </div>
              </div>
            ))}
          </section>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={generate}>
            <Wand2 className="mr-1 h-3.5 w-3.5" />
            Gerar {steps.filter((s) => s.script_id).length} blocos
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}