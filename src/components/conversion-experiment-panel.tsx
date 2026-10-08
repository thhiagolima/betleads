import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createConversionExperiment,
  getConversionExperimentResults,
  listConversionExperiments,
  setConversionExperimentStatus,
} from "@/lib/conversion-p2.functions";

export function ConversionExperimentPanel({
  sourceType,
  sourceId,
}: {
  sourceType: "campaign" | "journey";
  sourceId: string;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [urlA, setUrlA] = useState("");
  const [urlB, setUrlB] = useState("");
  const experiments = useQuery({
    queryKey: ["conversion-experiments", sourceType, sourceId],
    queryFn: () => listConversionExperiments({ data: { sourceType, sourceId } }),
  });
  const active = experiments.data?.rows.find((row: any) => row.status === "active");
  const results = useQuery({
    queryKey: ["conversion-experiment-result", active?.id],
    queryFn: () => getConversionExperimentResults({ data: { id: active!.id } }),
    enabled: !!active?.id,
  });
  const create = useMutation({
    mutationFn: async () => {
      const created = await createConversionExperiment({
        data: {
          sourceType,
          sourceId,
          name: "Teste automático de CTA",
          dimension: "cta",
          variantA: { destination_url: urlA, label: "A" },
          variantB: { destination_url: urlB, label: "B" },
        },
      });
      await setConversionExperimentStatus({ data: { id: created.id, status: "active" } });
    },
    onSuccess: () => {
      setOpen(false);
      setUrlA("");
      setUrlB("");
      client.invalidateQueries({ queryKey: ["conversion-experiments", sourceType, sourceId] });
    },
  });
  const pause = useMutation({
    mutationFn: () =>
      setConversionExperimentStatus({ data: { id: active.id, status: "completed" } }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["conversion-experiments", sourceType, sourceId] }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <section className="rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Teste A/B</h2>
          <p className="text-xs text-muted-foreground">
            Divisão automática e estável de 50% para cada CTA.
          </p>
        </div>
        {!active && !open ? (
          <button className="rounded-md border px-3 py-2 text-sm" onClick={() => setOpen(true)}>
            Criar teste A/B
          </button>
        ) : null}
      </div>
      {open ? (
        <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={submit}>
          <label className="text-sm">
            Destino A
            <input
              required
              type="url"
              value={urlA}
              onChange={(event) => setUrlA(event.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2"
              placeholder="https://…"
            />
          </label>
          <label className="text-sm">
            Destino B
            <input
              required
              type="url"
              value={urlB}
              onChange={(event) => setUrlB(event.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2"
              placeholder="https://…"
            />
          </label>
          <div className="flex gap-2 md:col-span-2">
            <button
              disabled={create.isPending}
              className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
            >
              {create.isPending ? "Ativando…" : "Ativar 50/50"}
            </button>
            <button
              type="button"
              className="rounded-md border px-3 py-2 text-sm"
              onClick={() => setOpen(false)}
            >
              Cancelar
            </button>
          </div>
          {create.isError ? (
            <p className="text-sm text-destructive md:col-span-2">{create.error.message}</p>
          ) : null}
        </form>
      ) : null}
      {active ? (
        <div className="mt-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">{active.name} · ativo</p>
            <button
              className="rounded-md border px-3 py-1.5 text-sm"
              disabled={pause.isPending}
              onClick={() => pause.mutate()}
            >
              Encerrar teste
            </button>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(results.data?.variants ?? []).map((variant) => (
              <div className="rounded-md bg-muted/40 p-3" key={variant.variant}>
                <p className="font-medium">Variante {variant.variant}</p>
                <p className="text-sm text-muted-foreground">
                  {variant.recipients} destinatários · {variant.conversions} conversões ·{" "}
                  {(variant.conversionRate * 100).toFixed(1)}%
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
