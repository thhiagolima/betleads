import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { WalletBalanceNotice } from "@/components/billing/wallet-balance-notice";
import { ChannelPage } from "@/components/channels/channel-page";
import {
  ChannelOverview,
  ChannelSendsChart,
  useChannelPeriod,
} from "@/components/channels/channel-overview";
import { SmsChannelHealth } from "@/components/sms/sms-channel-health";
import { SmsHistoryPanel } from "@/components/sms/sms-history-panel";
import { SmsTemplatesPanel } from "@/components/sms/sms-templates-panel";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { POLL_INTERVALS } from "@/hooks/use-updated-ago";
import { getBillingPrices } from "@/lib/billing/billing.functions";
import { walletNoticeInputFromPortal } from "@/lib/billing/wallet-notice";
import { CHART_COLORS } from "@/lib/chart-theme";
import { brl, num } from "@/lib/format";
import { getSmsCreditPortal } from "@/lib/sms-credits.functions";
import { getSmsDashboard, listScheduledSmsCampaigns, smsProviderStatus } from "@/lib/sms.functions";

export const Route = createFileRoute("/sms")({
  component: SmsPage,
});

function SmsPage() {
  return (
    <ChannelPage channel="sms" subtitle="Envios, saldo, templates e histórico do canal de SMS.">
      {(tab, setTab) =>
        tab === "templates" ? (
          <SmsTemplatesPanel />
        ) : tab === "historico" ? (
          <SmsHistoryPanel />
        ) : (
          <SmsOverview onOpenHistory={() => setTab("historico")} />
        )
      }
    </ChannelPage>
  );
}

/**
 * House-facing SMS unit price (PG1 Task 7): reads the price book through
 * `getBillingPrices`, never a hard-coded literal. `null` while loading —
 * callers must show "—", not a fallback price.
 */
function useSmsUnitPrice(): number | null {
  const pricesFn = useServerFn(getBillingPrices);
  const { data } = useQuery({
    queryKey: ["billing-prices"],
    queryFn: () => pricesFn(),
    staleTime: 5 * 60_000,
  });
  return data?.sms.unitPrice ?? null;
}

// Status the dispatcher writes while a scheduled campaign has not finished.
const OPEN_CAMPAIGN_STATUSES = ["agendada", "running", "processando", "enviando"];

function SmsOverview({ onOpenHistory }: { onOpenHistory: () => void }) {
  const period = useChannelPeriod();
  const { query } = period;
  const dashboardFn = useServerFn(getSmsDashboard);
  const campaignsFn = useServerFn(listScheduledSmsCampaigns);
  const statusFn = useServerFn(smsProviderStatus);
  const portalFn = useServerFn(getSmsCreditPortal);

  const dashboard = useQuery({
    // Prefix shared with the individual SMS dialog, which invalidates it after a send.
    queryKey: ["sms-compact-dashboard", query.from, query.to],
    queryFn: () => dashboardFn({ data: { from: query.from, to: query.to } }),
    refetchInterval: query.includesToday ? POLL_INTERVALS.dashboard : false,
    placeholderData: (previous) => previous,
  });
  const campaigns = useQuery({
    queryKey: ["sms-home-campaigns"],
    queryFn: () => campaignsFn(),
    refetchInterval: 30_000,
  });
  const provider = useQuery({
    queryKey: ["sms-provider-status"],
    queryFn: () => statusFn(),
    refetchInterval: 30_000,
  });
  const activeTenant = useActiveTenant();
  const activeTenantId = activeTenant.data?.activeTenantId ?? null;
  const credits = useQuery({
    queryKey: ["sms-credits", "portal", activeTenantId],
    queryFn: () => portalFn({ data: { tenantId: activeTenantId } }),
    enabled: !!activeTenantId,
    refetchInterval: 30_000,
  });
  const smsUnitPrice = useSmsUnitPrice();

  const summary = (credits.data?.summary ?? {}) as { balance?: number; exempt?: boolean };
  const balance = readNumber(summary.balance);
  const exempt = Boolean(summary.exempt);
  const canBuyCredits = Boolean((credits.data as { canBuy?: boolean } | undefined)?.canBuy);
  const balanceLabel = !credits.data ? "—" : exempt ? "Casa isenta" : brl(balance);
  const totals = dashboard.data?.totals;
  const scheduledCampaigns = (
    (campaigns.data?.campaigns ?? []) as Array<{ status: string }>
  ).filter((campaign) => OPEN_CAMPAIGN_STATUSES.includes(campaign.status)).length;
  // Messages waiting to go out right now: pending sends plus journey steps already due.
  const queued = readNumber(totals?.pending) + readNumber(totals?.queue_due);
  const smsLeft =
    !exempt && smsUnitPrice && smsUnitPrice > 0 ? Math.floor(balance / smsUnitPrice) : null;

  return (
    <ChannelOverview
      period={period}
      updatedAt={dashboard.dataUpdatedAt}
      isFetching={dashboard.isFetching}
      isLoading={dashboard.isLoading}
      notice={
        credits.data ? (
          <WalletBalanceNotice
            balance={balance}
            exempt={exempt}
            smsUnitPrice={smsUnitPrice}
            canBuy={canBuyCredits}
            threshold={walletNoticeInputFromPortal(credits.data).threshold}
          />
        ) : null
      }
      // No "Entregues" or delivery rate: the SMS provider does not confirm delivery.
      kpis={[
        {
          title: "Enviados",
          value: num(readNumber(totals?.sent)),
          detail: `para ${num(readNumber(totals?.unique_recipients))} números diferentes`,
        },
        { title: "Falhas", value: num(readNumber(totals?.failed)), detail: "não saíram" },
        {
          title: "Na fila",
          value: num(queued),
          detail:
            scheduledCampaigns > 0
              ? `${num(scheduledCampaigns)} campanha(s) agendada(s)`
              : "aguardando envio agora",
        },
        {
          title: "Créditos disponíveis",
          value: balanceLabel,
          detail: exempt
            ? "sem cobrança por envio"
            : smsLeft !== null
              ? `dá para cerca de ${num(smsLeft)} SMS`
              : undefined,
        },
      ]}
      chart={
        <ChannelSendsChart
          historyChannel="sms"
          period={period}
          daily={dashboard.data?.by_day}
          series={[{ key: "enviados", label: "Enviados", color: CHART_COLORS.primary }]}
        />
      }
    >
      <SmsChannelHealth
        configured={provider.data ? !!provider.data.configured : undefined}
        balanceLabel={balanceLabel}
        scheduledCampaigns={scheduledCampaigns}
        playersInJourneys={readNumber(totals?.players_in_flow)}
        activeFlows={readNumber(totals?.active_flows)}
        conversions={readNumber(totals?.conversions)}
        onOpenHistory={onOpenHistory}
      />
    </ChannelOverview>
  );
}

function readNumber(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
