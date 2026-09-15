import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getSendWindowStatus,
  updateSendWindow,
} from "@/lib/send-window.functions";
import { DataCard } from "@/components/ui-premium/data-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Clock, MoonStar, SunMedium } from "lucide-react";
import { toast } from "sonner";

const WEEKDAYS = [
  { v: 1, l: "Seg" },
  { v: 2, l: "Ter" },
  { v: 3, l: "Qua" },
  { v: 4, l: "Qui" },
  { v: 5, l: "Sex" },
  { v: 6, l: "Sáb" },
  { v: 0, l: "Dom" },
];

function formatDateTimeBR(iso: string | null, timezone: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: timezone,
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function SendWindowCard({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const fetchStatus = useServerFn(getSendWindowStatus);
  const saveFn = useServerFn(updateSendWindow);
  const { data, isLoading } = useQuery({
    queryKey: ["send-window-status"],
    queryFn: () => fetchStatus(),
    refetchInterval: 60_000,
  });

  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState("06:00");
  const [end, setEnd] = useState("22:00");
  const [tz, setTz] = useState("America/Sao_Paulo");
  const [enabled, setEnabled] = useState(true);
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);

  function openEdit() {
    if (!data) return;
    setStart(data.settings.start);
    setEnd(data.settings.end);
    setTz(data.settings.timezone);
    setEnabled(data.settings.enabled);
    setDays(data.settings.weekdays);
    setEditing(true);
  }

  const mut = useMutation({
    mutationFn: () =>
      saveFn({
        data: { start, end, timezone: tz, enabled, weekdays: days },
      }),
    onSuccess: () => {
      toast.success("Janela de envio atualizada");
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["send-window-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const within = data?.within_window ?? true;
  const settings = data?.settings;

  if (compact) {
    return (
      <div className="rounded-lg border border-border/40 bg-background/30 px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {within ? (
            <SunMedium className="h-4 w-4 text-emerald-400 shrink-0" />
          ) : (
            <MoonStar className="h-4 w-4 text-amber-400 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {within ? "Dentro da janela de envio" : "Fora da janela — disparos em fila"}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {settings
                ? `${settings.start}–${settings.end} (${settings.timezone})`
                : "Carregando…"}
              {!within && data?.next_allowed_at && (
                <> · retoma {formatDateTimeBR(data.next_allowed_at, settings?.timezone ?? "America/Sao_Paulo")}</>
              )}
            </p>
          </div>
        </div>
        {!within && data && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {data.pending.tomorrow_total} na fila
          </span>
        )}
      </div>
    );
  }

  return (
    <DataCard
      title="Janela de envio"
      description="Horário permitido para todos os disparos automáticos (SMS, email e ligações)"
      icon={<Clock className="h-4 w-4" />}
      actions={
        editing ? (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
            <Button size="sm" onClick={() => mut.mutate()} disabled={mut.isPending}>
              {mut.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={openEdit} disabled={isLoading}>
            Configurar
          </Button>
        )
      }
    >
      {isLoading || !data ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : editing ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Início
              </Label>
              <Input
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="mt-2 bg-background/60"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Fim
              </Label>
              <Input
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="mt-2 bg-background/60"
              />
            </div>
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Timezone
            </Label>
            <Input
              value={tz}
              onChange={(e) => setTz(e.target.value)}
              className="mt-2 bg-background/60"
              placeholder="America/Sao_Paulo"
            />
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground mb-2 block">
              Dias permitidos
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((d) => {
                const active = days.includes(d.v);
                return (
                  <button
                    key={d.v}
                    type="button"
                    onClick={() =>
                      setDays((cur) =>
                        active ? cur.filter((x) => x !== d.v) : [...cur, d.v],
                      )
                    }
                    className={
                      "rounded-md border px-3 py-1.5 text-xs font-medium transition-colors " +
                      (active
                        ? "border-primary/50 bg-primary/15 text-primary"
                        : "border-border/40 bg-background/40 text-muted-foreground hover:border-primary/30")
                    }
                  >
                    {d.l}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border/40 bg-background/30 p-3">
            <div>
              <p className="text-sm font-medium">Janela ativa</p>
              <p className="text-xs text-muted-foreground">
                Desligado = envia 24h, todos os dias.
              </p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span
              className={
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium " +
                (within
                  ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                  : "bg-amber-500/15 text-amber-300 border border-amber-500/30")
              }
            >
              {within ? (
                <SunMedium className="h-3.5 w-3.5" />
              ) : (
                <MoonStar className="h-3.5 w-3.5" />
              )}
              {within ? "Dentro da janela" : "Fora da janela"}
            </span>
            {!settings?.enabled && (
              <span className="text-xs text-muted-foreground">
                (janela desativada — enviando 24h)
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-border/40 bg-background/30 p-3">
              <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Horário permitido
              </p>
              <p className="mt-1 text-sm font-medium">
                {settings?.start} – {settings?.end}
              </p>
              <p className="text-xs text-muted-foreground">{settings?.timezone}</p>
            </div>
            <div className="rounded-lg border border-border/40 bg-background/30 p-3">
              <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Próxima retomada
              </p>
              <p className="mt-1 text-sm font-medium">
                {within
                  ? "—"
                  : formatDateTimeBR(
                      data.next_allowed_at,
                      settings?.timezone ?? "America/Sao_Paulo",
                    )}
              </p>
              <p className="text-xs text-muted-foreground">
                {within ? "Em envio agora" : "Início da próxima janela"}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Stat label="Pendentes fora da janela" value={data.pending.outside_total} />
            <Stat label="Para próxima janela" value={data.pending.tomorrow_total} tone="amber" />
            <Stat
              label="Última execução"
              value={
                data.last_run_at
                  ? formatDateTimeBR(data.last_run_at, settings?.timezone ?? "America/Sao_Paulo")
                  : "—"
              }
              compact
            />
          </div>

          <div className="rounded-lg border border-border/40 bg-background/30 p-3 text-xs text-muted-foreground space-y-1">
            <p>
              <span className="text-foreground font-medium">Email:</span>{" "}
              {data.pending.by_channel.email_flows.tomorrow} agendados para a próxima janela ·{" "}
              {data.pending.by_channel.email_campaigns.tomorrow} campanhas
            </p>
            <p>
              <span className="text-foreground font-medium">Ligações:</span>{" "}
              {data.pending.by_channel.calls.tomorrow} agendadas para a próxima janela
            </p>
          </div>
        </div>
      )}
    </DataCard>
  );
}

function Stat({
  label,
  value,
  tone,
  compact,
}: {
  label: string;
  value: number | string;
  tone?: "amber";
  compact?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/30 p-3">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p
        className={
          "mt-1 font-medium " +
          (compact ? "text-sm" : "text-2xl ") +
          (tone === "amber" ? "text-amber-300" : "text-foreground")
        }
      >
        {value}
      </p>
    </div>
  );
}