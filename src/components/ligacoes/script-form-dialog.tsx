import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveCallScript } from "@/lib/calls.functions";
import { VariablePicker } from "./variable-picker";
import {
  FAKE_LEAD_CLIENT,
  renderScriptClient,
  VOICE_OPTIONS,
} from "./shared";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial?: any | null;
}

export function ScriptFormDialog({ open, onOpenChange, initial }: Props) {
  const qc = useQueryClient();
  const saveFn = useServerFn(saveCallScript);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [form, setForm] = useState(() => ({
    name: "",
    content: "",
    status: "draft" as "draft" | "active" | "inactive",
    default_voice_id: VOICE_OPTIONS[0].id,
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0.5,
    speed: 1.0,
    use_speaker_boost: true,
  }));

  useEffect(() => {
    if (!open) return;
    if (initial) {
      const vs = (initial.voice_settings as any) ?? {};
      setForm({
        name: initial.name ?? "",
        content: initial.content ?? "",
        status: initial.status ?? "draft",
        default_voice_id: initial.default_voice_id ?? VOICE_OPTIONS[0].id,
        stability: vs.stability ?? 0.5,
        similarity_boost: vs.similarity_boost ?? 0.75,
        style: vs.style ?? 0.5,
        speed: vs.speed ?? 1.0,
        use_speaker_boost: vs.use_speaker_boost ?? true,
      });
    } else {
      setForm({
        name: "",
        content: "Olá {primeiro_nome}, aqui é da {nome_expert}. Notamos que faz {dias_sem_login} dias que você não entra. Que tal voltar e usar seu saldo de {saldo}?",
        status: "draft",
        default_voice_id: VOICE_OPTIONS[0].id,
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.5,
        speed: 1.0,
        use_speaker_boost: true,
      });
    }
  }, [open, initial]);

  const mut = useMutation({
    mutationFn: (input: any) => saveFn({ data: input }),
    onSuccess: () => {
      toast.success(initial ? "Roteiro atualizado" : "Roteiro criado");
      qc.invalidateQueries({ queryKey: ["call-scripts"] });
      onOpenChange(false);
    },
    onError: (e: any) => toast.error(e?.message ?? "Erro ao salvar script"),
  });

  function insertToken(token: string) {
    const el = textareaRef.current;
    if (!el) {
      setForm((f) => ({ ...f, content: f.content + token }));
      return;
    }
    const start = el.selectionStart ?? form.content.length;
    const end = el.selectionEnd ?? form.content.length;
    const next = form.content.slice(0, start) + token + form.content.slice(end);
    setForm((f) => ({ ...f, content: next }));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + token.length;
    });
  }

  function submit() {
    if (!form.name.trim() || !form.content.trim()) {
      toast.error("Nome e conteúdo são obrigatórios");
      return;
    }
    mut.mutate({
      id: initial?.id,
      name: form.name.trim(),
      trigger_name: null,
      content: form.content,
      status: form.status,
      default_voice_id: form.default_voice_id,
      provider: "elevenlabs",
      voice_settings: {
        stability: form.stability,
        similarity_boost: form.similarity_boost,
        style: form.style,
        speed: form.speed,
        use_speaker_boost: form.use_speaker_boost,
      },
    });
  }

  const preview = renderScriptClient(form.content, FAKE_LEAD_CLIENT);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? "Editar template" : "Novo template"}</DialogTitle>
          <DialogDescription>
            Use variáveis entre chaves para personalizar a fala por lead.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div>
            <Label>Nome</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Ex: Reativação 7 dias"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(v: any) => setForm({ ...form, status: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Rascunho</SelectItem>
                  <SelectItem value="active">Ativo</SelectItem>
                  <SelectItem value="inactive">Inativo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Voz (ElevenLabs)</Label>
              <Select
                value={form.default_voice_id}
                onValueChange={(v) => setForm({ ...form, default_voice_id: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VOICE_OPTIONS.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <VariablePicker onInsert={insertToken} />

          <div>
            <Label>Conteúdo do roteiro</Label>
            <Textarea
              ref={textareaRef}
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              rows={6}
              className="font-mono text-sm"
            />
          </div>

          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
            <p className="mb-1 text-xs font-medium text-primary">Preview com lead de teste</p>
            <p className="text-sm leading-relaxed text-foreground">{preview}</p>
          </div>

          <div className="grid grid-cols-2 gap-4 rounded-lg border border-border p-4">
            <div className="col-span-2">
              <p className="text-sm font-medium">Ajustes de voz</p>
            </div>
            <SliderRow
              label="Estabilidade"
              value={form.stability}
              onChange={(v) => setForm({ ...form, stability: v })}
            />
            <SliderRow
              label="Similaridade"
              value={form.similarity_boost}
              onChange={(v) => setForm({ ...form, similarity_boost: v })}
            />
            <SliderRow
              label="Estilo"
              value={form.style}
              onChange={(v) => setForm({ ...form, style: v })}
            />
            <SliderRow
              label="Velocidade"
              value={form.speed}
              min={0.7}
              max={1.2}
              step={0.05}
              onChange={(v) => setForm({ ...form, speed: v })}
            />
            <div className="col-span-2 flex items-center justify-between">
              <Label htmlFor="speaker-boost" className="cursor-pointer text-sm">
                Speaker boost
              </Label>
              <Switch
                id="speaker-boost"
                checked={form.use_speaker_boost}
                onCheckedChange={(c) => setForm({ ...form, use_speaker_boost: c })}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={mut.isPending}>
            {mut.isPending ? "Salvando..." : "Salvar roteiro"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SliderRow({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.05,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{value.toFixed(2)}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(arr) => onChange(arr[0] ?? value)}
      />
    </div>
  );
}