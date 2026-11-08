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
          <InfoTip text="Jogadores que estavam há 2 dias ou mais sem depositar (ou que nunca depositaram), receberam um SMS e voltaram a depositar em até 3 dias, mesmo sem clicar no link. O valor é tudo o que depositaram nesses 3 dias. Já inclui o Recuperado pelo CRM (quem clicou), por isso é sempre igual ou maior: não some os dois. Voltar depois do SMS não prova que foi por causa dele: o efeito real aparece no Teste de controle, logo abaixo." />
        </CardTitle>
        <CardDescription>
          Jogadores parados que voltaram a depositar em até 3 dias depois de receber um SMS,
          clicando ou não no link.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-6 tabular-nums">
          {[
            [num(totals.influencedPlayers), "jogadores voltaram"],
            [money(totals.influencedRevenue), "depositaram em até 3 dias"],
            [cost(totals.costPerRecovered), "custo em SMS por jogador"],
          ].map(([value, label]) => (
            <div key={label}>
              <p className="text-kpi-sm">{value}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
        <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          Este número já inclui os jogadores do Recuperado pelo CRM (quem clicou no link) e soma
          quem voltou sem clicar. Por isso é sempre igual ou maior. Não some os dois.
        </p>
      </CardContent>
    </Card>
  );
}
