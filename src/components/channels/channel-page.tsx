import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { ActiveTenantWalletNotice } from "@/components/billing/active-tenant-wallet-notice";
import { ProvidersPausedBanner } from "@/components/providers-paused-banner";
import { SendWindowCard } from "@/components/send-window-card";
import { Button } from "@/components/ui/button";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { PageTabs } from "@/components/ui-premium/page-tabs";
import type { DispatchChannel } from "@/lib/dispatch-pause.functions";
import { useEnabledChannels } from "@/hooks/use-enabled-channels";

import { ChannelDisabledState } from "./channel-disabled-state";
import {
  CHANNEL_ID_TO_PROVIDER_CHANNEL,
  CHANNEL_TABS,
  resolveChannelHash,
  type ChannelId,
  type ChannelTab,
} from "./channel-tabs";
import { tourAnchor } from "@/help/anchor";

const CHANNEL_ROUTE = {
  sms: "/sms",
  email: "/email",
  voz: "/ligacoes",
  webpush: "/webpush",
} as const;
// Web push has no provider pause switch (dispatch_pause covers sms/email/call),
// so it shows no paused banner.
const PAUSE_CHANNEL: Partial<Record<ChannelId, DispatchChannel>> = {
  sms: "sms",
  email: "email",
  voz: "call",
};
// The campaigns composer opens on the channel the user came from.
const NEW_CAMPAIGN_CHANNEL: Record<ChannelId, "sms" | "email" | "voice" | "webpush"> = {
  sms: "sms",
  email: "email",
  voz: "voice",
  webpush: "webpush",
};

/**
 * The shell shared by SMS, Email, Voz and Web Push: header, channel status strip
 * (paused banner, wallet notice, then send window), visible tabs synced with the URL hash,
 * then the active tab. Clicking a tab pushes a history entry, so the browser
 * "back" button goes back to the previous tab.
 */
export function ChannelPage<C extends ChannelId>({
  channel,
  subtitle,
  actions,
  notReady,
  children,
}: {
  channel: C;
  subtitle: string;
  /** Channel-specific actions shown after "Nova campanha". */
  actions?: ReactNode;
  /**
   * Shown instead of the status strip and tabs, without "Nova campanha",
   * while the channel is on but can't send yet (web push not installed).
   */
  notReady?: ReactNode;
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
        ...(resolution.redirect.hash ? { hash: resolution.redirect.hash } : {}),
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

  const { isEnabled } = useEnabledChannels();
  const providerChannel = CHANNEL_ID_TO_PROVIDER_CHANNEL[channel];
  if (!isEnabled(providerChannel)) {
    // Direct route hit (link, bookmark, old automation) on a channel the
    // super admin turned off: no tabs, no actions, just the guard.
    return (
      <Page>
        <PageHeader subtitle={subtitle} />
        <ChannelDisabledState channel={providerChannel} />
      </Page>
    );
  }

  if (notReady) {
    return (
      <Page>
        <PageHeader subtitle={subtitle} actions={actions} />
        {notReady}
      </Page>
    );
  }

  const pauseChannel = PAUSE_CHANNEL[channel];
  return (
    <Page>
      <PageHeader
        subtitle={subtitle}
        actions={
          <>
            <Button asChild className="h-9" {...tourAnchor("canal.header.nova-campanha")}>
              <Link to="/campanhas" search={{ newChannel: NEW_CAMPAIGN_CHANNEL[channel] } as never}>
                <Plus className="size-4" aria-hidden="true" />
                Nova campanha
              </Link>
            </Button>
            {actions}
          </>
        }
      />
      {pauseChannel ? <ProvidersPausedBanner channel={pauseChannel} /> : null}
      {/* PG3: empty/low balance for the active house, with its own threshold.
          SMS already shows it in its overview, next to the balance KPI. */}
      {channel === "sms" ? null : <ActiveTenantWalletNotice />}
      {/* The web push dispatcher doesn't follow the send window. */}
      {channel === "webpush" ? null : <SendWindowCard compact />}
      <div {...tourAnchor("canal.abas")}>
        <PageTabs
          value={tab}
          onValueChange={setTab}
          items={CHANNEL_TABS[channel] as ReadonlyArray<{ value: ChannelTab<C>; label: string }>}
        />
      </div>
      <div role="tabpanel" aria-labelledby={`tab-${tab}`} className="min-w-0">
        {children(tab, setTab)}
      </div>
    </Page>
  );
}
