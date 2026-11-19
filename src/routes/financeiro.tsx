// House "Financeiro" page (spec §4, §5, §9): Painel (default) with the
// result dashboard, Lançamentos (list of days; a day opens its modal with CRM
// numbers and the manual Anúncios/GGR), other costs and rates/viewer settings. Visible
// to anyone with `can_view_finance` (admin, group manager, super admin, or
// a gestor the admin released) — the server double-checks on every call.
// The open tab, and the month and open day (`dia`), live in the URL.
import { createFileRoute } from "@tanstack/react-router";
import { useActiveTenant } from "@/hooks/use-active-tenant";
import { Page, PageHeader } from "@/components/ui-premium";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import { FinanceDashboardView } from "@/components/finance/dashboard/finance-dashboard";
import { FinanceMonthView } from "@/components/finance/finance-month-grid";
import { FinanceOtherCosts } from "@/components/finance/finance-other-costs";
import { FinanceSettingsPanel } from "@/components/finance/finance-settings-panel";
import {
  launchPendingSearch,
  parseFinanceSearch,
  type FinanceSearch,
  type FinanceTab,
} from "@/lib/finance/search";

const FINANCE_TAB_ITEMS: ReadonlyArray<{ value: FinanceTab; label: string }> = [
  { value: "painel", label: "Painel" },
  { value: "lancamentos", label: "Lançamentos" },
  { value: "outros-custos", label: "Outros custos" },
  { value: "configuracoes", label: "Configurações" },
];

export const Route = createFileRoute("/financeiro")({
  validateSearch: (search: Record<string, unknown>): FinanceSearch => parseFinanceSearch(search),
  component: FinanceiroPage,
});

function FinanceiroPage() {
  const { active, isLoading } = useActiveTenant();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  if (isLoading || !active) {
    return <div className="h-64 animate-pulse rounded-lg border border-border/40" />;
  }

  const canSee = active.role === "super_admin" || active.can_view_finance === true;
  if (!canSee) {
    return (
      <Page className="max-w-6xl">
        <PageHeader title="Financeiro" />
        <p className="text-sm text-muted-foreground">
          Você não tem acesso ao financeiro desta casa.
        </p>
      </Page>
    );
  }

  const tab = search.tab ?? "painel";
  // Changing tab drops month/dia: they only mean something for "Lançar agora".
  const openTab = (next: FinanceTab) =>
    void navigate({ search: next === "painel" ? {} : { tab: next } });

  return (
    <Page className="max-w-6xl">
      <PageHeader
        title="Financeiro"
        subtitle="Resultado da casa: o que entrou, o que saiu e quanto sobrou."
      />

      <PageTabs
        value={tab}
        onValueChange={openTab}
        label="Seções do financeiro"
        items={FINANCE_TAB_ITEMS}
      />

      <div role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "painel" && (
          <FinanceDashboardView
            initialScope={{ kind: "tenant", tenantId: active.id }}
            canPickScope={active.role === "super_admin"}
            onLaunchPending={(date) => void navigate({ search: launchPendingSearch(date) })}
          />
        )}

        {tab === "lancamentos" && (
          <FinanceMonthView
            tenantId={active.id}
            initialMonth={search.month}
            focusDate={search.dia}
            onDayChange={(dia) =>
              void navigate({
                search: (prev) => ({
                  ...prev,
                  month: dia ? dia.slice(0, 7) : prev.month,
                  dia: dia ?? undefined,
                }),
                replace: true,
              })
            }
          />
        )}

        {tab === "outros-custos" && (
          <FinanceOtherCosts tenantId={active.id} initialMonth={search.month} />
        )}

        {tab === "configuracoes" && <FinanceSettingsPanel tenantId={active.id} />}
      </div>
    </Page>
  );
}
