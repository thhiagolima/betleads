import { brl, num } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { type Data, dayLabel, pct } from "./format";

/** Minutes since the results table was last rebuilt. */
const minutesSince = (data: Data) =>
  data.health.updatedAt
    ? Math.round((Date.now() - new Date(data.health.updatedAt).getTime()) / 60_000)
    : null;

/**
 * Header pill for data health (C-10): fresh and consistent shows green; stale
 * data or a failed daily check shows amber. Opens the details in a side panel.
 */
export function HealthIndicator({ data }: { data: Data }) {
  const minutes = minutesSince(data);
  const failed = data.health.checks.some((check) => !check.ok);
  const ok = minutes != null && minutes <= 30 && !failed && !data.health.truncated;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant="ghost" className="gap-2 text-muted-foreground">
          <span
            className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`}
            aria-hidden="true"
          />
          {minutes == null
            ? "Sem atualização"
            : failed
              ? "Divergência nos dados"
              : `Atualizado há ${num(minutes)} min`}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Saúde dos dados</SheetTitle>
          <SheetDescription>
            Os números da Central são recalculados a cada 10 minutos.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          <HealthDetails data={data} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function HealthDetails({ data }: { data: Data }) {
  const { health } = data;
  const diff =
    health.rawSent != null && health.rawSent > 0
      ? Math.abs(health.tableSent - health.rawSent) / health.rawSent
      : null;
  const updated = health.updatedAt ? new Date(health.updatedAt) : null;
  const minutesAgo = updated ? Math.round((Date.now() - updated.getTime()) / 60_000) : null;
  return (
    <div className="space-y-3 text-sm">
      <HealthLine
        ok={minutesAgo != null && minutesAgo <= 30}
        label="Última atualização"
        value={
          updated
            ? `${updated.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} (há ${num(minutesAgo ?? 0)} min)`
            : "sem atualização"
        }
      />
      <HealthLine
        ok={diff != null && diff <= 0.01}
        label="Envios conferidos com o registro de SMS"
        value={
          health.rawSent == null
            ? "não disponível"
            : `${num(health.tableSent)} na tela · ${num(health.rawSent)} no registro (${pct(diff)} de diferença)`
        }
      />
      <ConsistencyChecks checks={health.checks} />
      {health.truncated && (
        <HealthLine
          ok={false}
          label="Volume"
          value="período muito longo: parte dos dados não foi carregada"
        />
      )}
      <p className="text-xs text-muted-foreground">
        O registro inclui mensagens de hoje que entram na próxima atualização; diferenças pequenas
        nas últimas horas são esperadas. Custo considera o preço do SMS da sua conta. WhatsApp,
        e-mail e voz ainda não entram no custo.
      </p>
    </div>
  );
}

function HealthLine({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`}
        aria-hidden="true"
      />
      <div>
        <p className="font-medium">
          {label} <span className="sr-only">{ok ? "(ok)" : "(atenção)"}</span>
        </p>
        <p className="text-muted-foreground">{value}</p>
      </div>
    </div>
  );
}

const CHECK_LABELS: Record<string, string> = {
  sends: "Envios conferem com o registro de SMS",
  cost: "Custo confere com o preço por segmento cobrado",
  direct: "Conversões por clique conferem com as atribuições",
};

function ConsistencyChecks({ checks }: { checks: Data["health"]["checks"] }) {
  if (checks.length === 0)
    return (
      <HealthLine
        ok={false}
        label="Checagem diária de consistência"
        value="ainda não rodou (roda todo dia às 03h40 para o dia anterior)"
      />
    );
  const latestDate = checks[0].date;
  const latest = checks.filter((check) => check.date === latestDate);
  const failures = checks.filter((check) => !check.ok);
  const format = (name: string, value: number) => (name === "cost" ? brl(value) : num(value));
  return (
    <>
      {latest.map((check) => (
        <HealthLine
          key={check.name}
          ok={check.ok}
          label={`${CHECK_LABELS[check.name] ?? check.name} (${dayLabel(check.date)})`}
          value={`tela ${format(check.name, check.actual)} · origem ${format(check.name, check.expected)}`}
        />
      ))}
      {failures.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {num(failures.length)} checagem(ns) com divergência nos últimos 14 dias:{" "}
          {failures
            .slice(0, 5)
            .map((check) => `${CHECK_LABELS[check.name] ?? check.name} em ${dayLabel(check.date)}`)
            .join("; ")}
          .
        </p>
      )}
    </>
  );
}
