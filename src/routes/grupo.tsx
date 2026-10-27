// Painel do grupo (spec §6, layout A — approved mockup in
// .superpowers/brainstorm/5093-1792850661/content/painel-grupo.html):
// period/compare bar, 6 group totals and the one-row-per-house scoreboard.
import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Trophy } from "lucide-react";

import { PageHeader } from "@/components/ui-premium";
import { useActiveGroup } from "@/hooks/use-active-group";
import { GroupPeriodBar, defaultGroupPeriod, type GroupPeriod } from "@/components/group/group-period-bar";
import { GroupTotals } from "@/components/group/group-totals";
import { GroupScoreboard } from "@/components/group/group-scoreboard";
import { getGroupOverview } from "@/lib/finance.functions";

export const Route = createFileRoute("/grupo")({ component: GrupoPainelPage });

function lastDayOfMonth(firstDay: string) {
  const [y, m] = firstDay.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Only used to show/hide the "sem outros custos" note (spec §5/§6); the
 * server decides the actual costMonth inclusion the same way. */
function isClosedMonthWindow(period: GroupPeriod) {
  if (period.preset === "month") return true;
  return period.range.from.endsWith("-01") && period.range.to === lastDayOfMonth(period.range.from);
}

function GrupoPainelPage() {
  const { groups, active } = useActiveGroup();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<GroupPeriod>(defaultGroupPeriod);

  const getOverview = useServerFn(getGroupOverview);
  const query = useQuery({
    queryKey: ["group-overview", active?.id, period],
    queryFn: () =>
      getOverview({
        data: { groupId: active!.id, range: period.range, compare: period.compare, preset: period.preset },
      }),
    enabled: !!active,
  });

  if (!groups.length) {
    return <p className="text-sm text-muted-foreground">Você não gerencia nenhum grupo.</p>;
  }

  if (!active || query.isLoading || !query.data) {
    return <div className="h-64 animate-pulse rounded-lg border border-border/40" />;
  }

  const { totals, tenants } = query.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Grupo ${active.nome}`}
        subtitle="Consolidado do grupo e placar das casas."
        icon={<Trophy className="h-5 w-5 text-primary-foreground" />}
      />
      <GroupPeriodBar value={period} onChange={setPeriod} />
      <GroupTotals current={totals.current} previous={totals.previous} />
      {!isClosedMonthWindow(period) && (
        <p className="text-xs text-muted-foreground">
          Resultado sem outros custos do mês (só entram em mês fechado).
        </p>
      )}
      <GroupScoreboard
        rows={tenants}
        onRowClick={(tenantId) => navigate({ to: "/grupo/casa", search: { tenant: tenantId } })}
      />
    </div>
  );
}
