// Permanent "Configuração da casa" page: Casa (site + quick links),
// Encurtador (shortener domains) and E-mail (email domains + senders) tabs.
// Visible to every tenant member (read); writes are gated per-section by
// `canEdit` from `getHouseConfig` (tenant admin, non-demo). Reused by Task
// 11's setup wizard via each section's `variant="wizard"`.
// Not nested under /configuracoes (that page has no <Outlet>).
import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";

import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import { DomainsSection } from "@/components/house-config/domains-section";
import { EmailSendersSection } from "@/components/house-config/email-senders-section";
import { HouseSiteSection } from "@/components/house-config/house-site-section";

export const Route = createFileRoute("/configuracoes_/casa")({ component: HouseConfigPage });

const VIEWS = [
  { value: "casa", label: "Casa" },
  { value: "encurtador", label: "Encurtador" },
  { value: "email", label: "E-mail" },
] as const;
type View = (typeof VIEWS)[number]["value"];

function HouseConfigPage() {
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash.replace(/^#/, "") });
  const view: View = VIEWS.find((item) => item.value === hash)?.value ?? "casa";
  const setView = (next: View) =>
    void navigate({ to: "/configuracoes/casa", hash: next === "casa" ? undefined : next });

  return (
    <Page className="max-w-5xl">
      <PageHeader subtitle="Endereço da casa, domínios do encurtador e de e-mail, e remetentes." />

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
