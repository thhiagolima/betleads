import type { ReactNode } from "react";

import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { ProvidersPausedBanner } from "@/components/providers-paused-banner";

export function SmsPageShell({ children }: { children: ReactNode }) {
  return (
    <Page>
      <PageHeader subtitle="Acompanhe a saúde do canal, envios, saldo e histórico de SMS." />
      <ProvidersPausedBanner channel="sms" />
      {children}
    </Page>
  );
}
