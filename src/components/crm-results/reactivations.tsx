import { useMoney } from "@/hooks/use-tenant-currency";
import { num } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type Data, cost } from "./format";
import { InfoTip } from "./shared";

/**
 * Broad view (influenced): returns after any SMS, with or without a click.
 * Lives in "Prova e método", away from the Recuperado pelo CRM, because its
 * window, unit and value differ and the two numbers must never be summed.
 */
export function Reactivations({ data }: { data: Data }) {
  const { money } = useMoney();
  const { totals } = data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          Reativações após SMS
          <InfoTip text="Conta quem estava há 2 dias ou mais sem depositar (ou se cadastrou há 2 dias ou mais sem depositar) e depositou em até 3 dias depois de um SMS, mesmo sem clicar. Conta voltas, não pessoas: quem voltou duas vezes conta duas. Voltar depois do SMS não prova que o SMS causou a volta; o efeito real aparece no Teste de controle abaixo." />
        </CardTitle>
        <CardDescription>
          Jogadores parados que voltaram a depositar até 3 dias depois de receber um SMS, com ou sem
          clique.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-6 tabular-nums">
          {[
            [num(totals.influencedPlayers), "reativações"],
            [money(totals.influencedRevenue), "1º depósito na volta"],
            [cost(totals.costPerRecovered), "custo por reativação"],
          ].map(([value, label]) => (
            <div key={label}>
              <p className="text-kpi-sm">{value}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
        <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          Outra régua: conta voltas (não pessoas), só o 1º depósito e janela de 3 dias. Por isso
          pode ser maior em jogadores e menor em valor que o Recuperado pelo CRM. Muitos jogadores
          estão nos dois números: não some.
        </p>
      </CardContent>
    </Card>
  );
}
