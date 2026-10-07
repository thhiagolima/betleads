import type { ReactNode } from "react";
import { MessageSquare } from "lucide-react";

import { PageHeader } from "@/components/ui-premium/page-header";
import { ProvidersPausedBanner } from "@/components/providers-paused-banner";
import { ChannelWorkspaceNav } from "@/components/channels/channel-workspace-nav";

export function SmsPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-5 p-4 sm:p-6">
      <PageHeader
        title="SMS"
        subtitle="Acompanhe a saúde do canal, entregas, créditos e histórico de SMS."
        icon={<MessageSquare className="h-5 w-5 text-primary-foreground" />}
        className="mb-0"
      />
      <ChannelWorkspaceNav channel="sms" />
      <ProvidersPausedBanner channel="sms" />
      {children}
    </div>
  );
}
