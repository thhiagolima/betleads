import { useMoney } from "@/hooks/use-tenant-currency";
import { num } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type Data, cost } from "./format";
import { InfoTip } from "./shared";

/**
 * Broad view (influenced): returns after any SMS, with or without a click.
 * Same ruler as the Recuperado pelo CRM (2 days stopped, 7 days, people,
 * every deposit) and contains it, so it is the upper end of a range and the
 * two numbers must never be summed.
 */
export function Reactivations({ data }: { data: Data }) {
  const { money } = useMoney();
  const { totals } = data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          Reativações após SMS
          <InfoTip text="Conta quem estava há 2 dias ou mais sem depositar quando recebeu o SMS (ou se cadastrou há 2 dias ou mais sem depositar) e voltou a depositar em até 7 dias depois dele, mesmo sem clicar. Soma todos os depósitos dos 7 dias a partir da volta e conta cada jogador uma vez no período. Voltar depois do SMS não prova que o SMS causou a volta; o efeito real aparece no Teste de controle abaixo." />
        </CardTitle>
        <CardDescription>
          Jogadores parados que voltaram a depositar até 7 dias depois de receber um SMS, com ou sem
          clique.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-6 tabular-nums">
          {[
            [num(totals.influencedPlayers), "jogadores reativados"],
            [money(totals.influencedRevenue), "depositado em 7 dias"],
            [cost(totals.costPerRecovered), "custo por reativação"],
          ].map(([value, label]) => (
            <div key={label}>
              <p className="text-kpi-sm">{value}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
        <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          Mesma régua do Recuperado pelo CRM (2 dias parado, 7 dias, pessoas, todos os depósitos):
          inclui todo o Recuperado pelo CRM e mais quem voltou sem clicar no link. Por isso é sempre
          igual ou maior. Não some os dois.
        </p>
      </CardContent>
    </Card>
  );
}
