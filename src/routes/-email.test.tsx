import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const queryState = { data: undefined as unknown, isLoading: false, isFetching: false, dataUpdatedAt: 0 };

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, hash, children, className }: { to: string; hash?: string; children: ReactNode; className?: string }) => (
      <a href={hash ? `${to}#${hash}` : to} className={className}>
        {children}
      </a>
    ),
    createFileRoute: () => (options: unknown) => options,
  };
});
vi.mock("@/hooks/use-realtime-invalidate", () => ({ useRealtimeInvalidate: () => undefined }));
vi.mock("@/lib/email.functions", () => ({
  listEmailCampaigns: vi.fn(),
  listEmailTemplates: vi.fn(),
  saveEmailTemplate: vi.fn(),
  deleteEmailTemplate: vi.fn(),
  duplicateEmailTemplate: vi.fn(),
  getEmailDashboard: vi.fn(),
}));

// Isolates the health block from the KPI cards / chart it's rendered next to.
vi.mock("@/components/channels/channel-overview", () => ({
  ChannelOverview: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ChannelBlock: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ChannelSendsChart: () => null,
  useChannelPeriod: () => ({
    preset: "today",
    range: undefined,
    query: { from: "2026-11-05", to: "2026-11-05", includesToday: true },
    setPeriod: () => undefined,
  }),
}));

import { DashboardTab } from "./email";

function healthFor(senderConfigured: boolean) {
  return {
    totals: { active_campaigns: 0, conversions: 0 },
    health: { sender_configured: senderConfigured, channel_active: true },
    recent_events: [],
  };
}

describe("DashboardTab (saúde do /email)", () => {
  it("shows a 'Configurar' link to /configuracoes/casa#email when the sender is not set", () => {
    queryState.data = healthFor(false);
    const html = renderToStaticMarkup(<DashboardTab />);
    expect(html).toContain("Não configurado");
    expect(html).toMatch(/<a href="\/configuracoes\/casa#email"[^>]*>Configurar<\/a>/);
  });

  it("shows no link once the sender is configured", () => {
    queryState.data = healthFor(true);
    const html = renderToStaticMarkup(<DashboardTab />);
    expect(html).toContain("Configurado");
    expect(html).not.toContain("Configurar</a>");
  });
});
