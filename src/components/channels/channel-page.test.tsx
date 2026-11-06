import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useLocation: () => "",
  useNavigate: () => vi.fn(),
  useRouterState: () => "/ligacoes",
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));

// These three are only rendered on the enabled-channel path; stubbed out so
// the test doesn't have to chain-mock their own server-fn/query dependencies.
vi.mock("@/components/billing/active-tenant-wallet-notice", () => ({
  ActiveTenantWalletNotice: () => null,
}));
vi.mock("@/components/providers-paused-banner", () => ({
  ProvidersPausedBanner: () => null,
}));
vi.mock("@/components/send-window-card", () => ({
  SendWindowCard: () => null,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const enabledChannels: { isEnabled: (channel: string) => boolean } = {
  isEnabled: () => true,
};

vi.mock("@/hooks/use-enabled-channels", () => ({
  useEnabledChannels: () => enabledChannels,
}));

import { ChannelPage } from "./channel-page";

describe("ChannelPage — canal desligado", () => {
  it("renderiza ChannelDisabledState quando o canal (voz -> voice) está desligado", () => {
    enabledChannels.isEnabled = (channel) => channel !== "voice";
    const html = renderToStaticMarkup(
      <ChannelPage channel="voz" subtitle="Ligações da casa">
        {() => <div>conteudo-de-voz</div>}
      </ChannelPage>,
    );
    expect(html).toContain("Canal Voz desabilitado");
    expect(html).toContain("O canal Voz está desabilitado para esta casa.");
    expect(html).not.toContain("conteudo-de-voz");
  });

  it("renderiza o conteúdo normal quando o canal está ligado", () => {
    enabledChannels.isEnabled = () => true;
    const html = renderToStaticMarkup(
      <ChannelPage channel="sms" subtitle="SMS da casa">
        {() => <div>conteudo-de-sms</div>}
      </ChannelPage>,
    );
    expect(html).toContain("conteudo-de-sms");
    expect(html).not.toContain("Canal SMS desabilitado");
  });
});

describe("ChannelPage — Web Push", () => {
  it("shows the Web Push disabled state when the channel is off", () => {
    enabledChannels.isEnabled = (channel) => channel !== "webpush";
    const html = renderToStaticMarkup(
      <ChannelPage
        channel="webpush"
        subtitle="Web Push da casa"
        notReady={<div>nao-instalado</div>}
      >
        {() => <div>conteudo-de-webpush</div>}
      </ChannelPage>,
    );
    expect(html).toContain("Canal Web push desabilitado");
    expect(html).not.toContain("nao-instalado");
    expect(html).not.toContain("conteudo-de-webpush");
  });

  it("shows only the notReady block, without Nova campanha or tabs, while not installed", () => {
    enabledChannels.isEnabled = () => true;
    const html = renderToStaticMarkup(
      <ChannelPage
        channel="webpush"
        subtitle="Web Push da casa"
        notReady={<div>nao-instalado</div>}
      >
        {() => <div>conteudo-de-webpush</div>}
      </ChannelPage>,
    );
    expect(html).toContain("nao-instalado");
    expect(html).not.toContain("Nova campanha");
    expect(html).not.toContain("conteudo-de-webpush");
  });

  it("renders the tabs and Nova campanha once installed", () => {
    enabledChannels.isEnabled = () => true;
    const html = renderToStaticMarkup(
      <ChannelPage channel="webpush" subtitle="Web Push da casa">
        {() => <div>conteudo-de-webpush</div>}
      </ChannelPage>,
    );
    expect(html).toContain("conteudo-de-webpush");
    expect(html).toContain("Nova campanha");
    expect(html).toContain("Histórico");
  });
});
