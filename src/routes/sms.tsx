import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { RotateCw, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { smsProviderStatus, getSmsDashboard, listScheduledSmsCampaigns } from "@/lib/sms.functions";
import { getBillingPrices } from "@/lib/billing/billing.functions";
import { WalletBalanceNotice } from "@/components/billing/wallet-balance-notice";
import { walletNoticeInputFromPortal } from "@/lib/billing/wallet-notice";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { MetricCard } from "@/components/ui-premium/metric-card";
import { SmsPageShell } from "@/components/sms/sms-page-shell";
import { SmsChannelHealth } from "@/components/sms/sms-channel-health";
import { SmsHistoryPanel } from "@/components/sms/sms-history-panel";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getSmsCreditPortal } from "@/lib/sms-credits.functions";
import { brl, num } from "@/lib/format";

export const Route = createFileRoute("/sms")({
  component: SmsPage,
});

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

// ---------------- Page ----------------

function SmsPage() {
  // /sms é pai de /sms/templates: nas rotas filhas renderiza só a filha.
  const pathname = useLocation({ select: (l) => l.pathname });
  if (pathname !== "/sms") return <Outlet />;
  return <SmsHome />;
}

function SmsHome() {
  const navigate = useNavigate();
  const hash = useLocation({ select: (l) => l.hash });
  const aliases: Record<string, "saude" | "historico" | "campanhas"> = {
    dashboard: "saude",
    massa: "saude",
    campanhas: "campanhas",
    enviar: "saude",
    saude: "saude",
    historico: "historico",
    fila: "campanhas",
    configuracoes: "saude",
  };
  const currentTab = aliases[hash] ?? "saude";
  useEffect(() => {
    if (currentTab === "campanhas") {
      void navigate({ to: "/campanhas", replace: true });
    }
  }, [currentTab, navigate]);
  return (
    <SmsPageShell>
      <SmsCompactWorkspace
        tab={currentTab}
        onTabChange={(tab) => navigate({ to: "/sms", hash: tab, replace: true })}
      />
    </SmsPageShell>
  );
}

function SmsCompactWorkspace({
  tab,
  onTabChange,
}: {
  tab: "saude" | "historico" | "campanhas";
  onTabChange: (tab: string) => void;
}) {
  const qc = useQueryClient();
  const dashboardFn = useServerFn(getSmsDashboard);
  const campaignsFn = useServerFn(listScheduledSmsCampaigns);
  const statusFn = useServerFn(smsProviderStatus);
  const portalFn = useServerFn(getSmsCreditPortal);
  const dashboard = useQuery({
    queryKey: ["sms-compact-dashboard"],
    queryFn: () => dashboardFn({ data: { range_days: 30 } }),
    refetchInterval: 15_000,
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
  const totals = dashboard.data?.totals;
  const today = dashboard.data?.today;
  const sent = readNumber(totals?.sent);
  const failed = readNumber(totals?.failed);
  // Sem "Entregues"/taxa de entrega: o callback da Short Brasil não confirma
  // entrega (nenhum SMS é marcado entregue), então mostramos Enviados e Falhas.
  // "enviando" é o status que o despacho grava enquanto a campanha roda.
  const queue = ((campaigns.data?.campaigns ?? []) as SmsCampaignRow[]).filter((campaign) =>
    ["agendada", "running", "processando", "enviando"].includes(campaign.status),
  ).length;
  const kpis = [
    {
      label: "Saldo disponível",
      value: brl(balance),
      hint: exempt ? "casa isenta" : "para envio de SMS",
    },
    { label: "Fila", value: num(queue), hint: "campanhas aguardando" },
    {
      label: "Enviados hoje",
      value: num(readNumber(today?.sent)),
      hint: `${num(sent)} em 30 dias`,
    },
    {
      label: "Falhas",
      value: num(failed),
      hint: "nos últimos 30 dias",
    },
  ];

  if (tab === "saude") {
    return (
      <SmsChannelHealth
        configured={!!provider.data?.configured}
        balance={exempt ? "Casa isenta" : `Saldo ${brl(balance)}`}
        queue={queue}
        failed={num(failed)}
        metrics={kpis}
        onRefresh={() => qc.invalidateQueries({ queryKey: ["sms-compact-dashboard"] })}
        onOpenHistory={() => onTabChange("historico")}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Badge
          className={
            provider.data?.configured ? "bg-success/15 text-success" : "bg-warning/15 text-warning"
          }
        >
          {provider.data?.configured ? "canal disponível" : "canal indisponível"}
        </Badge>
        <Button
          variant="outline"
          size="sm"
          onClick={() => qc.invalidateQueries({ queryKey: ["sms-compact-dashboard"] })}
        >
          <RotateCw className="mr-2 h-3.5 w-3.5" /> Atualizar
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.location.assign("/plano-e-creditos")}
        >
          <CreditCard className="mr-2 h-3.5 w-3.5" />{" "}
          {exempt ? "Casa isenta" : `Saldo ${brl(balance)}`}
        </Button>
      </div>
      {credits.data ? (
        <WalletBalanceNotice
          balance={balance}
          exempt={exempt}
          smsUnitPrice={smsUnitPrice}
          canBuy={canBuyCredits}
          threshold={walletNoticeInputFromPortal(credits.data).threshold}
        />
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((item) => (
          <MetricCard
            key={item.label}
            label={item.label}
            value={item.value}
            hint={item.hint}
            className="py-3"
          />
        ))}
      </div>

      {tab === "historico" && <SmsHistoryPanel />}
    </div>
  );
}

type SmsCampaignRow = {
  id: string;
  name: string;
  scheduled_at: string;
  status: string;
  total_count: number;
  sent_count: number | null;
  failed_count: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string | null;
};

function readNumber(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
