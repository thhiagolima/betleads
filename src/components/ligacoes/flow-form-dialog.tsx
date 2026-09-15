import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Phone,
  Timer,
  Settings2,
  MessageSquare,
  Wand2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { listCallScripts } from "@/lib/calls.functions";
import { saveCallFlow } from "@/lib/call-flows.functions";
import { TRIGGER_OPTIONS, VOICE_OPTIONS } from "./shared";
import { VariablePicker } from "./variable-picker";
import { SequenceBuilderDialog } from "./sequence-builder-dialog";

// === Tipos do formulário ===

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

interface ExitConditions {
  login: boolean;
  deposit: boolean;
  first_deposit: boolean;
  voltou_jogar: boolean;
  deposit_amount_gte: number | null;
  bets_count_gte: number | null;
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial?: any | null;
}

const SMS_CONDITION_OPTIONS: { v: SmsCondition; l: string; threshold?: boolean }[] = [
  { v: "always", l: "Sempre" },
  { v: "answered", l: "Se atendeu" },
  { v: "not_answered", l: "Se NÃO atendeu" },
  { v: "listened_gte", l: "Se ouviu X segundos ou mais", threshold: true },
  { v: "listened_lt", l: "Se ouviu menos de X segundos", threshold: true },
  { v: "hangup_before", l: "Se desligou antes de X segundos", threshold: true },
  { v: "voicemail", l: "Se caixa postal" },
  { v: "busy", l: "Se número ocupado" },
  { v: "no_answer", l: "Se não houve resposta" },
  { v: "failed", l: "Se chamada caiu / falhou" },
];

const DEFAULT_EXIT: ExitConditions = {
  login: true,
  deposit: true,
  first_deposit: true,
  voltou_jogar: false,
  deposit_amount_gte: null,
  bets_count_gte: null,
};

const DEFAULT_STATE = {
  name: "",
  trigger_name: "",
  is_active: true,
  exit_conditions: { ...DEFAULT_EXIT },
  blocks: [] as Block[],
};

// === Conversão de delay (UI <-> segundos) ===
type DelayUnit = "s" | "m" | "h" | "d";
function splitDelay(totalSeconds: number): { value: number; unit: DelayUnit } {
  if (totalSeconds <= 0) return { value: 1, unit: "m" };
  if (totalSeconds % 86400 === 0) return { value: totalSeconds / 86400, unit: "d" };
  if (totalSeconds % 3600 === 0) return { value: totalSeconds / 3600, unit: "h" };
  if (totalSeconds % 60 === 0) return { value: totalSeconds / 60, unit: "m" };
  return { value: totalSeconds, unit: "s" };
}
function joinDelay(value: number, unit: DelayUnit): number {
  const v = Math.max(1, Math.floor(value || 1));
  switch (unit) {
    case "s": return v;
    case "m": return v * 60;
    case "h": return v * 3600;
    case "d": return v * 86400;
  }
}
function formatDelay(totalSeconds: number): string {
  const { value, unit } = splitDelay(totalSeconds);
  const u = unit === "s" ? "seg" : unit === "m" ? "min" : unit === "h" ? "h" : "d";
  return `${value} ${u}`;
}

export function FlowFormDialog({ open, onOpenChange, initial }: Props) {
  const qc = useQueryClient();
  const saveFn = useServerFn(saveCallFlow);
  const listScriptsFn = useServerFn(listCallScripts);

  const { data: scriptsData } = useQuery({
    queryKey: ["call-scripts"],
    queryFn: () => listScriptsFn(),
    enabled: open,
  });
  const allScripts = scriptsData?.scripts ?? [];

  const [form, setForm] = useState(DEFAULT_STATE);
  const [seqOpen, setSeqOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      const ec = (initial.exit_conditions ?? {}) as Partial<ExitConditions>;
      const rawBlocks = ((initial.call_flow_blocks ?? []) as any[])
        .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
        .map((b: any): Block => {
          if (b.block_type === "delay") {
            // Compat: blocos antigos guardaram o intervalo em `delay_after_seconds`.
            const raw =
              b.delay_seconds && b.delay_seconds > 0
                ? b.delay_seconds
                : b.delay_after_seconds && b.delay_after_seconds > 0
                  ? b.delay_after_seconds
                  : 86400;
            return { block_type: "delay", delay_seconds: raw };
          }
          const sms = ((b.call_flow_block_sms ?? []) as any[])
            .sort((a, c) => (a.priority ?? 0) - (c.priority ?? 0))
            .map((s: any): BlockSms => ({
              condition: s.condition,
              threshold_seconds: s.threshold_seconds ?? null,
              template: s.template ?? "",
            }));
          return {
            block_type: "call",
            name: b.name ?? "",
            script_id: b.script_id ?? null,
            voice_id: b.voice_id ?? null,
            max_call_seconds: b.max_call_seconds ?? 60,
            max_attempts: b.max_attempts ?? 1,
            delay_after_seconds: b.delay_after_seconds ?? 0,
            sms,
          };
        });
      setForm({
        name: initial.name ?? "",
        trigger_name: initial.trigger_name ?? "",
        is_active: initial.is_active ?? true,
        exit_conditions: {
          login: ec.login ?? true,
          deposit: ec.deposit ?? true,
          first_deposit: ec.first_deposit ?? true,
          voltou_jogar: ec.voltou_jogar ?? false,
          deposit_amount_gte: ec.deposit_amount_gte ?? null,
          bets_count_gte: ec.bets_count_gte ?? null,
        },
        blocks: rawBlocks,
      });
    } else {
      setForm({ ...DEFAULT_STATE, exit_conditions: { ...DEFAULT_EXIT }, blocks: [] });
    }
  }, [open, initial]);

  const mut = useMutation({
    mutationFn: (input: any) => saveFn({ data: input }),
    onSuccess: () => {
      toast.success(initial ? "Fluxo atualizado" : "Fluxo criado");
      qc.invalidateQueries({ queryKey: ["call-flows"] });
      onOpenChange(false);
    },
    onError: (e: any) => toast.error(e?.message ?? "Erro ao salvar fluxo"),
  });

  function submit() {
    if (!form.name.trim()) return toast.error("Nome obrigatório");
    if (form.blocks.length === 0)
      return toast.error("Adicione ao menos 1 bloco (Ligação ou Delay)");
    for (const [i, b] of form.blocks.entries()) {
      if (b.block_type === "call" && !b.script_id) {
        return toast.error(`Bloco ${i + 1}: selecione um roteiro de ligação`);
      }
    }
    mut.mutate({
      id: initial?.id,
      name: form.name.trim(),
      trigger_name: form.trigger_name || null,
      is_active: form.is_active,
      exit_conditions: form.exit_conditions,
      blocks: form.blocks,
    });
  }

  // === Helpers de blocos ===
  function addCallBlock() {
    setForm((f) => ({
      ...f,
      blocks: [
        ...f.blocks,
        {
          block_type: "call",
          name: `Ligação ${f.blocks.filter((b) => b.block_type === "call").length + 1}`,
          script_id: null,
          voice_id: null,
          max_call_seconds: 60,
          max_attempts: 1,
          delay_after_seconds: 0,
          sms: [],
        },
      ],
    }));
  }
  function addDelayBlock() {
    setForm((f) => ({
      ...f,
      blocks: [
        ...f.blocks,
        { block_type: "delay", delay_seconds: 86400 },
      ],
    }));
  }
  function removeBlock(idx: number) {
    setForm((f) => ({ ...f, blocks: f.blocks.filter((_, i) => i !== idx) }));
  }
  function moveBlock(idx: number, dir: -1 | 1) {
    setForm((f) => {
      const next = [...f.blocks];
      const t = idx + dir;
      if (t < 0 || t >= next.length) return f;
      [next[idx], next[t]] = [next[t], next[idx]];
      return { ...f, blocks: next };
    });
  }
  function updateBlock(idx: number, patch: Partial<Block>) {
    setForm((f) => {
      const next = [...f.blocks];
      next[idx] = { ...next[idx], ...patch } as Block;
      return { ...f, blocks: next };
    });
  }
  function addSmsToBlock(idx: number) {
    setForm((f) => {
      const next = [...f.blocks];
      const b = next[idx];
      if (b.block_type !== "call") return f;
      next[idx] = { ...b, sms: [...b.sms, { condition: "answered", threshold_seconds: null, template: "" }] };
      return { ...f, blocks: next };
    });
  }
  function updateSms(blockIdx: number, smsIdx: number, patch: Partial<BlockSms>) {
    setForm((f) => {
      const next = [...f.blocks];
      const b = next[blockIdx];
      if (b.block_type !== "call") return f;
      const sms = [...b.sms];
      sms[smsIdx] = { ...sms[smsIdx], ...patch };
      next[blockIdx] = { ...b, sms };
      return { ...f, blocks: next };
    });
  }
  function removeSms(blockIdx: number, smsIdx: number) {
    setForm((f) => {
      const next = [...f.blocks];
      const b = next[blockIdx];
      if (b.block_type !== "call") return f;
      next[blockIdx] = { ...b, sms: b.sms.filter((_, i) => i !== smsIdx) };
      return { ...f, blocks: next };
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? "Editar fluxo" : "Novo fluxo"}</DialogTitle>
          <DialogDescription>
            Automação sequencial: ligações e delays na ordem que você definir. Sem randomização.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6">
          {/* Configuração */}
          <section className="rounded-lg border border-border bg-card/40 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
              <Settings2 className="h-4 w-4 text-primary" /> Configuração
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Nome</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ex: Recuperação VIP"
                />
              </div>
              <div>
                <Label>Gatilho</Label>
                <Select
                  value={form.trigger_name || "__none"}
                  onValueChange={(v) =>
                    setForm({ ...form, trigger_name: v === "__none" ? "" : v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione um gatilho" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Nenhum</SelectItem>
                    {TRIGGER_OPTIONS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
              <Label htmlFor="flow-active" className="cursor-pointer text-sm">
                Fluxo ativo
              </Label>
              <Switch
                id="flow-active"
                checked={form.is_active}
                onCheckedChange={(c) => setForm({ ...form, is_active: c })}
              />
            </div>
          </section>

          {/* Sequência de blocos */}
          <section className="rounded-lg border border-border bg-card/40 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Phone className="h-4 w-4 text-primary" /> Sequência de blocos
                <Badge variant="secondary" className="ml-1">{form.blocks.length}</Badge>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => setSeqOpen(true)}
                >
                  <Wand2 className="mr-1 h-3.5 w-3.5" /> Gerar em sequência
                </Button>
                <Button size="sm" variant="outline" onClick={addCallBlock}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Ligação
                </Button>
                <Button size="sm" variant="outline" onClick={addDelayBlock}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Delay
                </Button>
              </div>
            </div>

            {form.blocks.length === 0 ? (
              <p className="rounded-md border border-dashed border-border py-6 text-center text-xs text-muted-foreground">
                Nenhum bloco. Adicione uma Ligação ou um Delay para começar.
              </p>
            ) : (
              <div className="space-y-3">
                {form.blocks.map((b, i) => (
                  <BlockEditor
                    key={i}
                    index={i}
                    block={b}
                    total={form.blocks.length}
                    allScripts={allScripts}
                    onMove={(dir) => moveBlock(i, dir)}
                    onRemove={() => removeBlock(i)}
                    onUpdate={(patch) => updateBlock(i, patch)}
                    onAddSms={() => addSmsToBlock(i)}
                    onUpdateSms={(si, patch) => updateSms(i, si, patch)}
                    onRemoveSms={(si) => removeSms(i, si)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Condições de saída */}
          <section className="rounded-lg border border-border bg-card/40 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
              <Settings2 className="h-4 w-4 text-primary" /> Condições de saída
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {([
                ["login", "se fizer login"],
                ["deposit", "se depositar"],
                ["first_deposit", "se fizer primeiro depósito"],
                ["voltou_jogar", "se voltar a jogar"],
              ] as const).map(([k, label]) => {
                const ativo = form.exit_conditions[k];
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() =>
                      setForm({
                        ...form,
                        exit_conditions: { ...form.exit_conditions, [k]: !ativo },
                      })
                    }
                    className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                      ativo
                        ? "border-primary/30 bg-primary/15 text-primary"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    {ativo ? "› " : ""}{label}
                  </button>
                );
              })}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Sair se valor depositado ≥ (R$)</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.exit_conditions.deposit_amount_gte ?? ""}
                  placeholder="vazio = desativado"
                  onChange={(e) => {
                    const raw = e.target.value;
                    setForm({
                      ...form,
                      exit_conditions: {
                        ...form.exit_conditions,
                        deposit_amount_gte: raw === "" ? null : Math.max(0, Number(raw)),
                      },
                    });
                  }}
                />
              </div>
              <div>
                <Label className="text-xs">Sair se quantidade de apostas ≥</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.exit_conditions.bets_count_gte ?? ""}
                  placeholder="vazio = desativado"
                  onChange={(e) => {
                    const raw = e.target.value;
                    setForm({
                      ...form,
                      exit_conditions: {
                        ...form.exit_conditions,
                        bets_count_gte: raw === "" ? null : Math.max(0, Math.floor(Number(raw))),
                      },
                    });
                  }}
                />
              </div>
            </div>

            <p className="mt-2 text-xs text-muted-foreground">
              Quando qualquer condição acontecer, o player sai do fluxo imediatamente (verificação em tempo real).
            </p>
          </section>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={mut.isPending}>
            {mut.isPending ? "Salvando..." : "Salvar fluxo"}
          </Button>
        </DialogFooter>
      </DialogContent>
      <SequenceBuilderDialog
        open={seqOpen}
        onOpenChange={setSeqOpen}
        scripts={allScripts.map((s: any) => ({ id: s.id, name: s.name }))}
        onGenerate={(newBlocks) =>
          setForm((f) => ({ ...f, blocks: [...f.blocks, ...newBlocks] }))
        }
      />
    </Dialog>
  );
}

// =================================================================
// Editor de um único bloco (call | delay)
// =================================================================

interface BlockEditorProps {
  index: number;
  total: number;
  block: Block;
  allScripts: any[];
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onUpdate: (patch: Partial<Block>) => void;
  onAddSms: () => void;
  onUpdateSms: (smsIdx: number, patch: Partial<BlockSms>) => void;
  onRemoveSms: (smsIdx: number) => void;
}

function BlockEditor({
  index,
  total,
  block,
  allScripts,
  onMove,
  onRemove,
  onUpdate,
  onAddSms,
  onUpdateSms,
  onRemoveSms,
}: BlockEditorProps) {
  return (
    <div className="rounded-md border border-border bg-muted/20">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Badge variant="outline" className="font-mono text-[10px]">{index + 1}</Badge>
        {block.block_type === "call" ? (
          <>
            <Phone className="h-3.5 w-3.5 text-primary" />
            <span className="text-sm font-medium">Ligação</span>
          </>
        ) : (
          <>
            <Timer className="h-3.5 w-3.5 text-primary" />
            <span className="text-sm font-medium">Delay · {formatDelay(block.delay_seconds)}</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon" variant="ghost" onClick={() => onMove(-1)} disabled={index === 0}>
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => onMove(1)} disabled={index === total - 1}>
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      <div className="p-3">
        {block.block_type === "delay" ? (
          <DelayBlockEditor
            seconds={block.delay_seconds}
            onChange={(s) => onUpdate({ delay_seconds: s } as Partial<DelayBlock>)}
          />
        ) : (
          <CallBlockEditor
            block={block}
            allScripts={allScripts}
            onUpdate={(p) => onUpdate(p)}
            onAddSms={onAddSms}
            onUpdateSms={onUpdateSms}
            onRemoveSms={onRemoveSms}
          />
        )}
      </div>
    </div>
  );
}

function DelayBlockEditor({ seconds, onChange }: { seconds: number; onChange: (s: number) => void }) {
  const { value, unit } = splitDelay(seconds);
  return (
    <div className="grid grid-cols-[1fr_140px] gap-2">
      <div>
        <Label className="text-xs">Valor</Label>
        <Input
          type="number"
          min={1}
          value={value}
          onChange={(e) => onChange(joinDelay(Math.max(1, Number(e.target.value) || 1), unit))}
        />
      </div>
      <div>
        <Label className="text-xs">Unidade</Label>
        <Select value={unit} onValueChange={(u) => onChange(joinDelay(value, u as DelayUnit))}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="s">Segundos</SelectItem>
            <SelectItem value="m">Minutos</SelectItem>
            <SelectItem value="h">Horas</SelectItem>
            <SelectItem value="d">Dias</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function CallBlockEditor({
  block,
  allScripts,
  onUpdate,
  onAddSms,
  onUpdateSms,
  onRemoveSms,
}: {
  block: CallBlock;
  allScripts: any[];
  onUpdate: (p: Partial<CallBlock>) => void;
  onAddSms: () => void;
  onUpdateSms: (smsIdx: number, patch: Partial<BlockSms>) => void;
  onRemoveSms: (smsIdx: number) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">Nome interno</Label>
          <Input
            value={block.name}
            placeholder="Ex: Tentativa 1"
            onChange={(e) => onUpdate({ name: e.target.value })}
          />
        </div>
        <div>
          <Label className="text-xs">Roteiro / áudio</Label>
          <Select
            value={block.script_id ?? ""}
            onValueChange={(v) => onUpdate({ script_id: v || null })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Selecionar..." />
            </SelectTrigger>
            <SelectContent>
              {allScripts.map((s: any) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">Voz (opcional, sobrescreve a do roteiro)</Label>
          <Select
            value={block.voice_id ?? "__default"}
            onValueChange={(v) => onUpdate({ voice_id: v === "__default" ? null : v })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default">Padrão do roteiro</SelectItem>
              {VOICE_OPTIONS.map((v) => (
                <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Tempo máximo (seg)</Label>
          <Input
            type="number"
            min={5}
            max={600}
            value={block.max_call_seconds}
            onChange={(e) => onUpdate({ max_call_seconds: Math.max(5, Number(e.target.value) || 60) })}
          />
        </div>
      </div>

      <div>
        <Label className="text-xs">Tentativas</Label>
        <Input
          type="number"
          min={1}
          max={10}
          value={block.max_attempts}
          onChange={(e) => onUpdate({ max_attempts: Math.max(1, Number(e.target.value) || 1) })}
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          Para criar intervalo entre ligações (ex.: 1 dia), adicione um bloco de Delay logo após este.
        </p>
      </div>

      {/* SMS condicionais */}
      <div className="rounded-md border border-border bg-background/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <MessageSquare className="h-3.5 w-3.5 text-primary" /> SMS pós-ligação por resultado
            <Badge variant="secondary" className="text-[10px]">{block.sms.length}</Badge>
          </div>
          <Button size="sm" variant="outline" onClick={onAddSms}>
            <Plus className="mr-1 h-3 w-3" /> Adicionar SMS
          </Button>
        </div>

        {block.sms.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            Nenhum SMS configurado. A primeira condição que casar dispara o SMS correspondente.
          </p>
        ) : (
          <div className="space-y-3">
            {block.sms.map((s, si) => {
              const meta = SMS_CONDITION_OPTIONS.find((o) => o.v === s.condition);
              const needsThreshold = !!meta?.threshold;
              return (
                <SmsRow
                  key={si}
                  index={si}
                  sms={s}
                  needsThreshold={needsThreshold}
                  onChange={(p) => onUpdateSms(si, p)}
                  onRemove={() => onRemoveSms(si)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SmsRow({
  index,
  sms,
  needsThreshold,
  onChange,
  onRemove,
}: {
  index: number;
  sms: BlockSms;
  needsThreshold: boolean;
  onChange: (p: Partial<BlockSms>) => void;
  onRemove: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function insertToken(token: string) {
    const el = textareaRef.current;
    if (!el) {
      onChange({ template: sms.template + token });
      return;
    }
    const start = el.selectionStart ?? sms.template.length;
    const end = el.selectionEnd ?? sms.template.length;
    const next = sms.template.slice(0, start) + token + sms.template.slice(end);
    onChange({ template: next });
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + token.length;
    });
  }

  return (
    <div className="rounded-md border border-border bg-muted/30 p-2">
      <div className="mb-2 flex items-center gap-2">
        <Badge variant="outline" className="font-mono text-[10px]">SMS {index + 1}</Badge>
        <Select value={sms.condition} onValueChange={(v) => onChange({ condition: v as SmsCondition })}>
          <SelectTrigger className="h-8 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SMS_CONDITION_OPTIONS.map((o) => (
              <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {needsThreshold && (
          <Input
            type="number"
            min={1}
            placeholder="X seg"
            className="h-8 w-[90px]"
            value={sms.threshold_seconds ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              onChange({ threshold_seconds: raw === "" ? null : Math.max(1, Number(raw)) });
            }}
          />
        )}
        <Button size="icon" variant="ghost" onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </Button>
      </div>
      <VariablePicker onInsert={insertToken} />
      <Textarea
        ref={textareaRef}
        rows={2}
        value={sms.template}
        onChange={(e) => onChange({ template: e.target.value })}
        placeholder="{primeiro_nome}, seu benefício continua disponível: {link_deposito}"
        className="mt-2 font-mono text-sm"
      />
    </div>
  );
}