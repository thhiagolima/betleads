import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowDown, ArrowLeft, Clock3, MessageSquare, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { saveJourney } from "@/lib/journeys.functions";
import type { JourneyStepInput } from "@/lib/journeys.shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type EditableStep = { kind: "wait"; seconds: number } | { kind: "sms"; content: string };

export function JourneyEditor({
  id,
  initial,
  initialSteps = [],
}: {
  id?: string;
  initial?: { name: string; description: string | null; trigger_type: string };
  initialSteps?: Array<{ step_type: string; config: Record<string, unknown> }>;
}) {
  const navigate = useNavigate();
  const save = useServerFn(saveJourney);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [trigger, setTrigger] = useState(initial?.trigger_type ?? "manual");
  const [steps, setSteps] = useState<EditableStep[]>(() =>
    initialSteps.flatMap((step) =>
      step.step_type === "wait"
        ? [{ kind: "wait" as const, seconds: Number(step.config.delay_seconds ?? 3600) }]
        : step.step_type === "sms"
          ? [{ kind: "sms" as const, content: String(step.config.content ?? "") }]
          : [],
    ),
  );
  const serializedSteps = (): JourneyStepInput[] => [
    ...steps
      .map((step) =>
        step.kind === "wait"
          ? { step_type: "wait" as const, config: { delay_seconds: Math.max(60, step.seconds) } }
          : { step_type: "sms" as const, config: { content: step.content } },
      )
      .filter((step) => step.step_type !== "sms" || step.config.content.trim()),
    { step_type: "end", label: "Encerrar", config: {} },
  ];
  const mutation = useMutation({
    mutationFn: () =>
      save({
        data: {
          id,
          journey: {
            name,
            description: description || null,
            trigger_type: trigger,
            steps: serializedSteps(),
          },
        },
      }),
    onSuccess: (result) => {
      toast.success("Jornada salva como rascunho");
      navigate({ to: "/jornadas/$journeyId", params: { journeyId: result.id } });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const add = (kind: EditableStep["kind"]) =>
    setSteps((current) => [
      ...current,
      kind === "wait" ? { kind, seconds: 3600 } : { kind, content: "" },
    ]);
  const update = (index: number, step: EditableStep) =>
    setSteps((current) => current.map((item, position) => (position === index ? step : item)));
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
      <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/jornadas" })}>
        <ArrowLeft className="mr-1 h-4 w-4" /> Jornadas
      </Button>
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">
          Jornadas multicanal
        </p>
        <h1 className="mt-1 text-2xl font-semibold">{id ? "Editar jornada" : "Nova jornada"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Monte a sequência de contato. A jornada só dispara após ser publicada.
        </p>
      </div>
      <div className="space-y-5 rounded-xl border p-5">
        <label className="block space-y-2 text-sm font-medium">
          Nome
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ex.: Recuperar jogadores inativos"
          />
        </label>
        <label className="block space-y-2 text-sm font-medium">
          Descrição
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Objetivo e público da jornada"
          />
        </label>
        <label className="block space-y-2 text-sm font-medium">
          Gatilho
          <Input
            value={trigger}
            onChange={(event) => setTrigger(event.target.value)}
            placeholder="manual"
          />
        </label>
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Sequência</p>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => add("wait")}>
                <Clock3 className="mr-1 h-4 w-4" /> Espera
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => add("sms")}>
                <MessageSquare className="mr-1 h-4 w-4" /> SMS
              </Button>
            </div>
          </div>
          {steps.map((step, index) => (
            <div key={index} className="rounded-lg border p-4">
              {index > 0 && (
                <ArrowDown className="-mt-7 mb-2 ml-4 h-4 w-4 bg-background text-muted-foreground" />
              )}
              <div className="mb-3 flex items-center justify-between font-medium">
                {step.kind === "wait" ? "Aguardar" : "Enviar SMS"}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    setSteps((current) => current.filter((_, position) => position !== index))
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {step.kind === "wait" ? (
                <label className="text-sm">
                  Segundos de espera
                  <Input
                    type="number"
                    min={60}
                    value={step.seconds}
                    onChange={(event) =>
                      update(index, { kind: "wait", seconds: Number(event.target.value) })
                    }
                  />
                </label>
              ) : (
                <Textarea
                  value={step.content}
                  onChange={(event) => update(index, { kind: "sms", content: event.target.value })}
                  placeholder="Mensagem SMS. Use variáveis como {{nome}}."
                />
              )}
            </div>
          ))}
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            Encerrar jornada
          </div>
        </section>
        <Button disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
          <Save className="mr-2 h-4 w-4" /> Salvar rascunho
        </Button>
      </div>
    </div>
  );
}
