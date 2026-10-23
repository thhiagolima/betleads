import { Link } from "@tanstack/react-router";
import { CreditCard } from "lucide-react";

import { ChannelBlock } from "@/components/channels/channel-overview";
import { MetricRow } from "@/components/home/home-cards";
import { Button } from "@/components/ui/button";
import { num } from "@/lib/format";

/**
 * "Saúde do canal" block of the SMS overview. No delivery rate: the SMS
 * provider does not confirm delivery, so only availability, queue and
 * failures are shown.
 */
export function SmsChannelHealth({
  configured,
  balanceLabel,
  scheduledCampaigns,
  playersInJourneys,
  activeFlows,
  conversions,
  onOpenHistory,
}: {
  configured: boolean | undefined;
  /** Fully formatted, e.g. "R$ 123,45" or "Casa isenta". */
  balanceLabel: string;
  scheduledCampaigns: number;
  playersInJourneys: number;
  activeFlows: number;
  conversions: number;
  onOpenHistory: () => void;
}) {
  return (
    <ChannelBlock
      title="Saúde do canal"
      description="Disponibilidade, saldo e o que está programado para sair."
      action={
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" className="h-9">
            <Link to="/plano-e-creditos">
              <CreditCard className="size-4" aria-hidden="true" />
              Plano e créditos
            </Link>
          </Button>
          <Button variant="outline" className="h-9" onClick={onOpenHistory}>
            Ver histórico
          </Button>
        </div>
      }
    >
      <div className="grid gap-x-8 md:grid-cols-2">
        <div>
          <MetricRow
            label="Disponibilidade"
            value={configured === undefined ? "—" : configured ? "Disponível" : "Indisponível"}
            valueClassName={
              configured === undefined ? undefined : configured ? "text-success" : "text-warning"
            }
          />
          <MetricRow label="Saldo para envio" value={balanceLabel} />
          <MetricRow label="Campanhas agendadas" value={num(scheduledCampaigns)} />
        </div>
        <div>
          <MetricRow label="Jogadores em jornadas" value={num(playersInJourneys)} />
          <MetricRow label="Jornadas de SMS ativas" value={num(activeFlows)} />
          <MetricRow label="Depositaram em até 72h após o SMS" value={num(conversions)} />
        </div>
      </div>
    </ChannelBlock>
  );
}
