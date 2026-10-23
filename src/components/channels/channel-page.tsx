import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { ProvidersPausedBanner } from "@/components/providers-paused-banner";
import { SendWindowCard } from "@/components/send-window-card";
import { Button } from "@/components/ui/button";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import type { DispatchChannel } from "@/lib/dispatch-pause.functions";

import { CHANNEL_TABS, resolveChannelHash, type ChannelId, type ChannelTab } from "./channel-tabs";

const CHANNEL_ROUTE = { sms: "/sms", email: "/email", voz: "/ligacoes" } as const;
const PAUSE_CHANNEL: Record<ChannelId, DispatchChannel> = {
  sms: "sms",
  email: "email",
  voz: "call",
};
// The campaigns composer opens on the channel the user came from.
const NEW_CAMPAIGN_CHANNEL: Record<ChannelId, "sms" | "email" | "voice"> = {
  sms: "sms",
  email: "email",
  voz: "voice",
};

/**
 * The shell shared by SMS, Email and Voz: header, channel status strip
 * (paused banner, then send window), visible tabs synced with the URL hash,
 * then the active tab. Clicking a tab pushes a history entry, so the browser
 * "back" button goes back to the previous tab.
 */
export function ChannelPage<C extends ChannelId>({
  channel,
  subtitle,
  actions,
  children,
}: {
  channel: C;
  subtitle: string;
  /** Channel-specific actions shown after "Nova campanha". */
  actions?: ReactNode;
  children: (tab: ChannelTab<C>, setTab: (tab: ChannelTab<C>) => void) => ReactNode;
}) {
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const route = CHANNEL_ROUTE[channel];
  const resolution = resolveChannelHash(channel, hash);
  const tab = (
    resolution.kind === "tab" ? resolution.tab : CHANNEL_TABS[channel][0].value
  ) as ChannelTab<C>;

  useEffect(() => {
    if (resolution.kind === "redirect") {
      void navigate({
        to: resolution.redirect.to,
        search: resolution.redirect.search as never,
        replace: true,
      });
    } else if (!resolution.canonical) {
      // Old alias (e.g. #dashboard): show the new tab name in the URL.
      void navigate({ to: route, hash: resolution.tab, replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);

  const setTab = (next: ChannelTab<C>) => {
    void navigate({ to: route, hash: next });
  };

  return (
    <Page>
      <PageHeader
        subtitle={subtitle}
        actions={
          <>
            <Button asChild className="h-9">
              <Link to="/campanhas" search={{ newChannel: NEW_CAMPAIGN_CHANNEL[channel] } as never}>
                <Plus className="size-4" aria-hidden="true" />
                Nova campanha
              </Link>
            </Button>
            {actions}
          </>
        }
      />
      <ProvidersPausedBanner channel={PAUSE_CHANNEL[channel]} />
      <SendWindowCard compact />
      <PageTabs
        value={tab}
        onValueChange={setTab}
        items={CHANNEL_TABS[channel] as ReadonlyArray<{ value: ChannelTab<C>; label: string }>}
      />
      <div role="tabpanel" aria-labelledby={`tab-${tab}`} className="min-w-0">
        {children(tab, setTab)}
      </div>
    </Page>
  );
}
