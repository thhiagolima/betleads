import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Plus, Save } from "lucide-react";
import { toast } from "sonner";
import { saveJourney } from "@/lib/journeys.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function JourneyEditor({
  id,
  initial,
}: {
  id?: string;
  initial?: { name: string; description: string | null; trigger_type: string };
}) {
  const navigate = useNavigate();
  const save = useServerFn(saveJourney);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [trigger, setTrigger] = useState(initial?.trigger_type ?? "manual");
  const mutation = useMutation({
    mutationFn: () =>
      save({
        data: {
          id,
          journey: {
            name,
            description: description || null,
            trigger_type: trigger,
            steps: [{ step_type: "end", label: "Encerrar", config: {} }],
          },
        },
      }),
    onSuccess: (result) => {
      toast.success("Jornada salva como rascunho");
      navigate({ to: "/jornadas/$journeyId", params: { journeyId: result.id } });
    },
    onError: (error: Error) => toast.error(error.message),
  });
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
          Defina o propósito agora. O construtor visual de etapas vem na próxima entrega.
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
          <span className="block text-xs font-normal text-muted-foreground">
            Use “manual” até configurarmos os gatilhos comportamentais.
          </span>
        </label>
        <div className="rounded-lg bg-muted/50 p-4 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <Plus className="h-4 w-4 text-primary" /> Etapa de encerramento incluída
          </div>
          <p className="mt-1 text-muted-foreground">
            Ao salvar, a jornada fica em rascunho e não dispara nenhuma mensagem.
          </p>
        </div>
        <Button disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
          <Save className="mr-2 h-4 w-4" /> Salvar rascunho
        </Button>
      </div>
    </div>
  );
}
