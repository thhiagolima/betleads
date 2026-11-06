import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({}),
  useMutation: () => ({}),
  useQueryClient: () => ({}),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/components/campaigns/channel-campaign-composer", () => ({
  ChannelCampaignComposer: () => null,
}));
vi.mock("@/components/campaigns/individual-sms-dialog", () => ({
  IndividualSmsDialog: () => null,
}));
vi.mock("@/components/system-dialog-host", () => ({ requestConfirmation: vi.fn() }));
vi.mock("@/lib/sms.functions", () => ({
  cancelScheduledSmsCampaign: vi.fn(),
  listScheduledSmsCampaigns: vi.fn(),
  resumeSmsCampaign: vi.fn(),
}));
vi.mock("@/lib/email.functions", () => ({
  listEmailCampaigns: vi.fn(),
  sendEmailCampaignNow: vi.fn(),
}));
vi.mock("@/lib/calls.functions", () => ({ listCallQueue: vi.fn() }));
vi.mock("@/lib/campaign-drafts.functions", () => ({
  deleteCampaignDraft: vi.fn(),
  listCampaignDrafts: vi.fn(),
}));
vi.mock("@/lib/webpush/campaigns.functions", () => ({
  cancelWebpushCampaignFn: vi.fn(),
  listWebpushCampaignsFn: vi.fn(),
  resumeWebpushCampaignFn: vi.fn(),
}));
vi.mock("@/hooks/use-enabled-channels", () => ({
  useEnabledChannels: () => ({ isEnabled: () => true }),
}));

import { CampaignRow, type Campaign } from "./campaigns-hub";
import { expertCampaignToRow } from "@/lib/expert-campaign-rows";

const row = (campaign: Campaign, variant?: "house" | "expert") =>
  renderToStaticMarkup(
    <CampaignRow
      campaign={campaign}
      variant={variant}
      cancelPending={false}
      resumePending={false}
      onCancel={() => undefined}
      onResume={() => undefined}
    />,
  );

const pausedSms: Campaign = {
  id: "c1",
  name: "Recarga",
  scheduled_at: "2026-10-20T12:00:00.000Z",
  status: "pausada",
  total_count: 10,
  sent_count: 2,
  failed_count: 0,
  channel: "sms",
  cancellable: true,
  resumable: true,
};

const pausedWebpush: Campaign = {
  id: "wp1",
  name: "Promo push",
  scheduled_at: "2026-11-05T12:00:00.000Z",
  status: "pausada",
  total_count: 500,
  sent_count: 100,
  failed_count: 0,
  channel: "webpush",
  cancellable: true,
  resumable: true,
};

describe("CampaignRow", () => {
  it("house: report, resume and the wallet link stay", () => {
    const html = row(pausedSms);
    expect(html).toContain("Relatório");
    expect(html).toContain("Retomar");
    expect(html).toContain('href="/plano-e-creditos"');
  });

  it("webpush: paused for lack of balance shows Retomar and the wallet link", () => {
    const html = row(pausedWebpush);
    expect(html).toContain("Retomar");
    expect(html).toContain('href="/plano-e-creditos"');
  });

  it("webpush: an 'agendada' (not paused) row has no Retomar", () => {
    const html = row({ ...pausedWebpush, status: "agendada", resumable: false });
    expect(html).not.toContain("Retomar");
    expect(html).not.toContain('href="/plano-e-creditos"');
  });

  it("expert: no report, resume or wallet link; can still cancel", () => {
    const html = row(pausedSms, "expert");
    expect(html).not.toContain("Relatório");
    expect(html).not.toContain("Retomar");
    expect(html).not.toContain("/plano-e-creditos");
    expect(html).toContain("Cancelar");
  });

  it("expert: refused campaign shows the rejection reason", () => {
    const html = row(
      expertCampaignToRow({
        id: "c2",
        channel: "email",
        name: "Black Friday",
        status: "recusada",
        approvalStatus: "recusada",
        rejectionReason: "Promessa de ganho não permitida",
        lastError: null,
        scheduledAt: null,
        createdAt: "2026-10-20T12:00:00.000Z",
        updatedAt: null,
        totalCount: 50,
        sentCount: 0,
        failedCount: 0,
        estimatedCost: 0.5,
      }),
      "expert",
    );
    expect(html).toContain("Recusada");
    expect(html).toContain("Motivo da recusa:");
    expect(html).toContain("Promessa de ganho não permitida");
  });

  it("cap pause is labelled 'Pausada pelo teto'", () => {
    const html = row(
      { ...pausedSms, last_error: "Teto mensal do expert atingido", resumable: false },
      "expert",
    );
    expect(html).toContain("Pausada pelo teto");
  });
});
