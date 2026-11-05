// Permanent "Configuração da casa" page: Casa (site + quick links),
// Encurtador (shortener domains) and E-mail (email domains + senders) tabs.
// Visible to every tenant member (read); writes are gated per-section by
// `canEdit` from `getHouseConfig` (tenant admin, non-demo). Reused by Task
// 11's setup wizard via each section's `variant="wizard"`.
// Not nested under /configuracoes (that page has no <Outlet>).
import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import { DomainsSection } from "@/components/house-config/domains-section";
import { EmailSendersSection } from "@/components/house-config/email-senders-section";
import { HouseSiteSection } from "@/components/house-config/house-site-section";
import { HOUSE_CONFIG_QUERY_KEY } from "@/components/house-config/house-config-query";
import { getHouseConfig } from "@/lib/house-config.functions";

export const Route = createFileRoute("/configuracoes_/casa")({ component: HouseConfigPage });

const VIEWS = [
  { value: "casa", label: "Casa" },
  { value: "encurtador", label: "Encurtador" },
  { value: "email", label: "E-mail" },
] as const;
type View = (typeof VIEWS)[number]["value"];

/** Pure (no hooks) so it's testable without the route/query machinery around
 * it; `canEdit` is `undefined` while `getHouseConfig` hasn't resolved yet,
 * which must not flash the notice for an admin who can in fact edit. */
export function HouseConfigReadOnlyNotice({ canEdit }: { canEdit: boolean | undefined }) {
  if (canEdit === undefined || canEdit) return null;
  return (
    <p className="rounded-lg border border-border/40 bg-background/30 p-3 text-sm text-muted-foreground">
      Só o administrador da casa pode alterar estas configurações.
    </p>
  );
}

function HouseConfigPage() {
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash.replace(/^#/, "") });
  const view: View = VIEWS.find((item) => item.value === hash)?.value ?? "casa";
  const setView = (next: View) =>
    void navigate({ to: "/configuracoes/casa", hash: next === "casa" ? undefined : next });

  // Every section already gates its own writes on `canEdit` (tenant admin,
  // non-demo); this reads the same cached query just to tell a non-admin up
  // front why every control on the page is read-only.
  const getConfig = useServerFn(getHouseConfig);
  const { data: config } = useQuery({ queryKey: HOUSE_CONFIG_QUERY_KEY, queryFn: () => getConfig() });

  return (
    <Page className="max-w-5xl">
      <PageHeader subtitle="Endereço da casa, domínios do encurtador e de e-mail, e remetentes." />

      <HouseConfigReadOnlyNotice canEdit={config?.canEdit} />

      <PageTabs
        value={view}
        onValueChange={setView}
        label="Seções da configuração da casa"
        items={VIEWS}
      />

      <div role="tabpanel" aria-labelledby={`tab-${view}`} className="space-y-4">
        {view === "casa" && <HouseSiteSection />}
        {view === "encurtador" && <DomainsSection kind="shortener" />}
        {view === "email" && (
          <>
            <DomainsSection kind="email" />
            <EmailSendersSection />
          </>
        )}
      </div>
    </Page>
  );
}
