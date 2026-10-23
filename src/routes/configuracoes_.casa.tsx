// Permanent "Configuração da casa" page: Casa (site + quick links),
// Encurtador (shortener domains) and E-mail (email domains + senders) tabs.
// Visible to every tenant member (read); writes are gated per-section by
// `canEdit` from `getHouseConfig` (tenant admin, non-demo). Reused by Task
// 11's setup wizard via each section's `variant="wizard"`.
import { createFileRoute } from "@tanstack/react-router";
import { Building2 } from "lucide-react";

import { PageHeader } from "@/components/ui-premium";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DomainsSection } from "@/components/house-config/domains-section";
import { EmailSendersSection } from "@/components/house-config/email-senders-section";
import { HouseSiteSection } from "@/components/house-config/house-site-section";

export const Route = createFileRoute("/configuracoes_/casa")({ component: HouseConfigPage });

function HouseConfigPage() {
  return (
    <div className="space-y-6 max-w-5xl">
      <PageHeader
        title="Configuração da casa"
        subtitle="URL da casa, domínios de encurtador e de e-mail, e remetentes."
        icon={<Building2 className="h-5 w-5 text-primary-foreground" />}
      />

      <Tabs defaultValue="casa">
        <TabsList>
          <TabsTrigger value="casa">Casa</TabsTrigger>
          <TabsTrigger value="encurtador">Encurtador</TabsTrigger>
          <TabsTrigger value="email">E-mail</TabsTrigger>
        </TabsList>

        <TabsContent value="casa" className="mt-4">
          <HouseSiteSection />
        </TabsContent>

        <TabsContent value="encurtador" className="mt-4">
          <DomainsSection kind="shortener" />
        </TabsContent>

        <TabsContent value="email" className="mt-4 space-y-4">
          <DomainsSection kind="email" />
          <EmailSendersSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
