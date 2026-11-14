// U2 de ESCOPO_ORIGEM_UTM_2026-11-14: regras de canal da casa (lista, criar, apagar).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataCard } from "@/components/ui-premium/data-card";
import { tourAnchor } from "@/help/anchor";
import {
  CHANNEL_LABELS,
  RULE_CHANNELS,
  RULE_FIELD_LABELS,
  RULE_MATCH_LABELS,
  type RuleChannel,
} from "@/lib/origin-breakdown";
import { deleteChannelRule, listChannelRules, upsertChannelRule } from "@/lib/origin.functions";

type Field = keyof typeof RULE_FIELD_LABELS;
type Match = keyof typeof RULE_MATCH_LABELS;

export function OriginRulesCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const fetchRules = useServerFn(listChannelRules);
  const save = useServerFn(upsertChannelRule);
  const remove = useServerFn(deleteChannelRule);
  const [field, setField] = useState<Field>("source");
  const [match, setMatch] = useState<Match>("exact");
  const [pattern, setPattern] = useState("");
  const [channel, setChannel] = useState<RuleChannel | "">("");

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["origin-channel-rules"],
    queryFn: () => fetchRules(),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["origin-channel-rules"] });
    void qc.invalidateQueries({ queryKey: ["origin-breakdown"] });
  };

  const create = useMutation({
    mutationFn: () => save({ data: { field, match, pattern, channel: channel as RuleChannel } }),
    onSuccess: () => {
      toast.success("Regra salva");
      setPattern("");
      setChannel("");
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Não foi possível salvar a regra"),
  });
  const drop = useMutation({
    mutationFn: (id: string) => remove({ data: { id } }),
    onSuccess: () => {
      toast.success("Regra apagada");
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Não foi possível apagar a regra"),
  });

  return (
    <DataCard
      title="Regras de canal da casa"
      description="Mande uma fonte, um meio ou uma campanha para o canal certo. A regra vale para todos os períodos e vence a classificação automática; links das mensagens do CRM continuam fora."
      {...tourAnchor("midia.origem.regras")}
    >
      <div className="space-y-3 px-4 pb-4 sm:px-5 sm:pb-5">
        {isLoading ? null : rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhuma regra ainda. Os canais vêm da classificação automática.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {rules.map((rule) => (
              <li key={rule.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  {RULE_FIELD_LABELS[rule.field]} {RULE_MATCH_LABELS[rule.match]}{" "}
                  <span className="break-all font-mono">{rule.pattern}</span> →{" "}
                  <strong>{CHANNEL_LABELS[rule.channel]}</strong>
                </span>
                {canEdit && (
                  <button
                    type="button"
                    aria-label={`Apagar a regra ${rule.pattern}`}
                    className="rounded p-1 text-muted-foreground hover:text-danger"
                    disabled={drop.isPending}
                    onClick={() => drop.mutate(rule.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit ? (
          <form
            className="grid gap-2 sm:grid-cols-[auto_auto_1fr_auto_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              if (pattern.trim() && channel) create.mutate();
            }}
          >
            <Select value={field} onValueChange={(v) => setField(v as Field)}>
              <SelectTrigger aria-label="Campo da regra" className="sm:w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(RULE_FIELD_LABELS) as Field[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {RULE_FIELD_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={match} onValueChange={(v) => setMatch(v as Match)}>
              <SelectTrigger aria-label="Tipo de comparação" className="sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(RULE_MATCH_LABELS) as Match[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {RULE_MATCH_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="Texto da regra"
              placeholder="Ex.: kwai, live_, influencer_joao"
              maxLength={120}
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
            />
            <Select value={channel} onValueChange={(v) => setChannel(v as RuleChannel)}>
              <SelectTrigger aria-label="Canal da regra" className="sm:w-52">
                <SelectValue placeholder="Canal" />
              </SelectTrigger>
              <SelectContent>
                {RULE_CHANNELS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {CHANNEL_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" disabled={!pattern.trim() || !channel || create.isPending}>
              Adicionar
            </Button>
          </form>
        ) : (
          <p className="text-meta text-muted-foreground">
            Só o administrador ou o gestor da casa muda as regras.
          </p>
        )}
      </div>
    </DataCard>
  );
}
