// Relatório de rendimento, bloco 2 ("Do contato ao depósito", spec §4): links
// gerados → leads que clicaram → depositaram por clique dentro da janela, e os
// contatos registrados. Puramente apresentacional.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReportBlock } from "@/lib/expert-report.functions";
import { num } from "@/lib/format";

/** Percentual inteiro pt-BR de `part / base`; null sem base. */
function share(part: number, base: number): string | null {
  if (base <= 0) return null;
  return `${Math.round((part / base) * 100).toLocaleString("pt-BR")}%`;
}

function Step({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-baseline justify-between gap-3 rounded-lg border border-border/70 bg-card px-4 py-3">
      <span className="text-body text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{num(value)}</span>
    </li>
  );
}

export function ReportFunnel({
  current,
  janelaHoras,
}: {
  current: ReportBlock;
  janelaHoras: number;
}) {
  const clicaramPct = share(current.leadsClicaram, current.leadsComLink);
  const depositaramPct = share(current.leadsDepositaramClique, current.leadsClicaram);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Do contato ao depósito</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ol className="space-y-2">
          <Step label="Links gerados" value={current.links} />
          <Step
            label={clicaramPct ? `Leads que clicaram (${clicaramPct})` : "Leads que clicaram"}
            value={current.leadsClicaram}
          />
          <Step
            label={
              depositaramPct
                ? `Depositaram em até ${janelaHoras}h (${depositaramPct} dos que clicaram)`
                : `Depositaram em até ${janelaHoras}h`
            }
            value={current.leadsDepositaramClique}
          />
        </ol>
        <p className="flex items-baseline justify-between gap-3 px-4 text-body">
          <span className="text-muted-foreground">Contatos registrados</span>
          <span className="font-semibold tabular-nums">{num(current.contatos)}</span>
        </p>
      </CardContent>
    </Card>
  );
}
