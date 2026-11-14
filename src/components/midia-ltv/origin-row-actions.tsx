// U2 de ESCOPO_ORIGEM_UTM_2026-11-14: dar apelido a um valor e mandar uma fonte, meio
// ou campanha para um canal. Só admin ou gestor da casa (a RPC confere de novo).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Pencil, Shapes } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CHANNEL_LABELS,
  GROUP_LABELS,
  RULE_CHANNELS,
  type OriginGroup,
  type RuleChannel,
} from "@/lib/origin-breakdown";
import { setUtmLabel, upsertChannelRule } from "@/lib/origin.functions";

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

export function LabelEditor({
  group,
  value,
  current,
}: {
  group: Exclude<OriginGroup, "channel">;
  value: string;
  current: string | null;
}) {
  const qc = useQueryClient();
  const save = useServerFn(setUtmLabel);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(current ?? "");
  const mutation = useMutation({
    mutationFn: (next: string) => save({ data: { dimension: group, value, label: next } }),
    onSuccess: (_, next) => {
      toast.success(next.trim() ? "Nome salvo" : "Nome removido");
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["origin-breakdown"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Não foi possível salvar o nome"),
  });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setLabel(current ?? "");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={current ? `Trocar o nome de ${value}` : `Dar nome a ${value}`}
          title={current ? "Trocar o nome" : "Dar um nome"}
          className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
          onClick={stop}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80" onClick={stop} align="start">
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate(label);
          }}
        >
          <p className="text-label text-muted-foreground">
            Nome para {GROUP_LABELS[group].toLowerCase()}{" "}
            <span className="break-all font-mono text-foreground">{value}</span>. Vale para toda a
            equipe da casa.
          </p>
          <Input
            autoFocus
            maxLength={120}
            aria-label="Nome"
            placeholder="Ex.: CBO Black Novembro"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            {current && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate("")}
              >
                Remover nome
              </Button>
            )}
            <Button type="submit" size="sm" disabled={mutation.isPending || !label.trim()}>
              Salvar
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function ChannelRuleButton({
  group,
  value,
}: {
  group: "source" | "medium" | "campaign";
  value: string;
}) {
  const qc = useQueryClient();
  const save = useServerFn(upsertChannelRule);
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<RuleChannel | "">("");
  const mutation = useMutation({
    mutationFn: (next: RuleChannel) =>
      save({ data: { field: group, match: "exact", pattern: value, channel: next } }),
    onSuccess: () => {
      toast.success("Regra salva. Os números já usam o canal novo.");
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["origin-breakdown"] });
      void qc.invalidateQueries({ queryKey: ["origin-channel-rules"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Não foi possível salvar a regra"),
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Escolher o canal de ${value}`}
          title="Escolher o canal"
          className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
          onClick={stop}
        >
          <Shapes className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80" onClick={stop} align="start">
        <div className="space-y-2">
          <p className="text-label text-muted-foreground">
            Todo cadastro com {GROUP_LABELS[group].toLowerCase()} igual a{" "}
            <span className="break-all font-mono text-foreground">{value}</span> passa a contar no
            canal escolhido, em todos os períodos.
          </p>
          <Select value={channel} onValueChange={(next) => setChannel(next as RuleChannel)}>
            <SelectTrigger aria-label="Canal">
              <SelectValue placeholder="Escolha o canal" />
            </SelectTrigger>
            <SelectContent>
              {RULE_CHANNELS.map((key) => (
                <SelectItem key={key} value={key}>
                  {CHANNEL_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!channel || mutation.isPending}
              onClick={() => channel && mutation.mutate(channel)}
            >
              Salvar regra
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
