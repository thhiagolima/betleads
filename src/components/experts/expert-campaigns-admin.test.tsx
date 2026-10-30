import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));
vi.mock("@/hooks/use-is-demo-tenant", () => ({ useIsDemoTenant: () => false }));
vi.mock("@/lib/expert-campaigns.functions", () => ({
  approveExpertCampaign: vi.fn(),
  listExpertCampaignsForAdmin: vi.fn(),
  pauseExpertCampaign: vi.fn(),
  rejectExpertCampaign: vi.fn(),
  resumeExpertCampaign: vi.fn(),
}));
vi.mock("@/lib/expert-campaigns-admin.functions", () => ({
  getExpertCampaignForAdmin: vi.fn(),
  listExpertUsageForAdmin: vi.fn(),
}));

import {
  ExpertCampaignReviewBody,
  ExpertCampaignsTable,
  ExpertUsageBar,
} from "./expert-campaigns-admin";
import type { ExpertCampaignAdminDetail } from "@/lib/expert-campaigns-admin.server";
import type { ExpertCampaignListItem } from "@/lib/expert-campaigns.server";

const item = (overrides: Partial<ExpertCampaignListItem> = {}): ExpertCampaignListItem => ({
  id: "00000000-0000-4000-8000-000000000001",
  channel: "sms",
  name: "Promo",
  status: "agendada",
  approvalStatus: null,
  rejectionReason: null,
  lastError: null,
  scheduledAt: null,
  createdAt: "2026-10-10T10:00:00Z",
  updatedAt: "2026-10-10T10:00:00Z",
  totalCount: 1200,
  sentCount: 0,
  failedCount: 0,
  estimatedCost: 96,
  expertId: "e1",
  expertNome: "Queiroz",
  ...overrides,
});

const noop = () => undefined;

const table = (items: ExpertCampaignListItem[], showExpert = true) =>
  renderToStaticMarkup(
    <ExpertCampaignsTable
      items={items}
      showExpert={showExpert}
      emptyText="Nada aqui."
      onReview={noop}
      onPause={noop}
      onResume={noop}
    />,
  );

describe("ExpertCampaignsTable", () => {
  it("lists pending first with Revisar, and the other actions by status", () => {
    const html = table([
      item({ id: "a", name: "Agendada", createdAt: "2026-10-12T10:00:00Z" }),
      item({
        id: "p",
        name: "Pendente",
        status: "aguardando_aprovacao",
        approvalStatus: "pendente",
      }),
      item({
        id: "t",
        name: "NoTeto",
        status: "pausada",
        approvalStatus: "aprovada",
        lastError: "Teto mensal do expert atingido: a campanha foi pausada",
        createdAt: "2026-10-11T10:00:00Z",
      }),
      item({
        id: "r",
        name: "Recusada",
        status: "recusada",
        approvalStatus: "recusada",
        rejectionReason: "Link errado",
      }),
    ]);
    expect(html.indexOf("Pendente")).toBeLessThan(html.indexOf("Agendada<"));
    expect(html).toContain("Aguardando aprovação");
    expect(html).toContain("Pausada pelo teto");
    expect(html).toContain("Link errado");
    expect(html).toContain(">Revisar<");
    expect(html).toContain(">Pausar<");
    expect(html).toContain(">Retomar<");
    expect(html).toContain("Queiroz");
    expect(html).toContain("1.200");
    expect(html).toContain("R$ 96,00");
  });

  it("hides the Expert column on the expert's own tab and shows the empty text", () => {
    const html = table([], false);
    expect(html).not.toContain(">Expert<");
    expect(html).toContain("Nada aqui.");
  });
});

const detail = (overrides: Partial<ExpertCampaignAdminDetail> = {}): ExpertCampaignAdminDetail => ({
  id: "00000000-0000-4000-8000-000000000001",
  channel: "sms",
  name: "Promo",
  status: "aguardando_aprovacao",
  approvalStatus: "pendente",
  rejectionReason: null,
  lastError: null,
  scheduledAt: null,
  createdAt: "2026-10-10T10:00:00Z",
  updatedAt: "2026-10-10T10:00:00Z",
  totalCount: 42,
  estimatedCost: 3.36,
  expertId: "e1",
  expertNome: "Queiroz",
  audienceDescription: "30+ dias sem depositar",
  content: { kind: "sms", text: "Volte hoje e ganhe bônus!", segments: 1 },
  ...overrides,
});

const body = (props: Partial<Parameters<typeof ExpertCampaignReviewBody>[0]> = {}) =>
  renderToStaticMarkup(
    <ExpertCampaignReviewBody
      detail={detail()}
      mode="review"
      reason=""
      error={null}
      pending={false}
      onReasonChange={noop}
      onApprove={noop}
      onStartReject={noop}
      onCancelReject={noop}
      onConfirmReject={noop}
      onClose={noop}
      {...props}
    />,
  );

const buttonHtml = (html: string, label: string) => {
  const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
  expect(match, `button ${label}`).not.toBeNull();
  return match![0];
};

describe("ExpertCampaignReviewBody", () => {
  it("shows the SMS content, recipients, cost and audience with Aprovar / Recusar", () => {
    const html = body();
    expect(html).toContain("Volte hoje e ganhe bônus!");
    expect(html).toContain("1 segmento");
    expect(html).toContain(">42<");
    expect(html).toContain("R$ 3,36");
    expect(html).toContain("30+ dias sem depositar");
    expect(buttonHtml(html, "Aprovar")).not.toMatch(/ disabled=""/);
    expect(buttonHtml(html, "Recusar")).not.toMatch(/ disabled=""/);
  });

  it("renders the e-mail HTML in a sandboxed iframe", () => {
    const html = body({
      detail: detail({
        channel: "email",
        content: {
          kind: "email",
          subject: "Oi!",
          preheader: null,
          html: "<p>Olá<script>x</script></p>",
        },
      }),
    });
    expect(html).toContain("Oi!");
    expect(html).toMatch(/<iframe[^>]*sandbox=""/);
  });

  it("shows the voice script or the asset name", () => {
    expect(
      body({
        detail: detail({
          channel: "voice",
          content: {
            kind: "voice",
            source: "script",
            name: "Roteiro A",
            text: "Olá, tudo bem?",
            durationSeconds: null,
          },
        }),
      }),
    ).toContain("Olá, tudo bem?");
    expect(
      body({
        detail: detail({
          channel: "voice",
          content: {
            kind: "voice",
            source: "asset",
            name: "Áudio B",
            text: null,
            durationSeconds: 25,
          },
        }),
      }),
    ).toContain("Áudio B · 25s");
  });

  it("requires a reason to reject", () => {
    const empty = body({ mode: "reject", reason: "   " });
    expect(empty).toContain("Motivo da recusa");
    expect(buttonHtml(empty, "Recusar campanha")).toMatch(/ disabled=""/);
    const filled = body({ mode: "reject", reason: "O link do bônus está errado" });
    expect(buttonHtml(filled, "Recusar campanha")).not.toMatch(/ disabled=""/);
  });

  it("shows the server error message", () => {
    const html = body({
      error:
        "O expert continua no teto mensal. Aumente o teto na tela Experts ou aguarde a virada do mês.",
    });
    expect(html).toMatch(/role="alert"[^>]*>O expert continua no teto mensal/);
  });

  it("has no decision buttons once the campaign is no longer pending", () => {
    const html = body({
      detail: detail({ status: "recusada", approvalStatus: "recusada", rejectionReason: "Link" }),
    });
    expect(html).not.toContain(">Aprovar<");
    expect(html).toContain("Motivo da recusa: </span>Link");
    expect(html).toContain(">Fechar<");
  });

  it("disables decisions on the demo house", () => {
    const html = body({ disabled: true });
    expect(buttonHtml(html, "Aprovar")).toMatch(/ disabled=""/);
  });
});

describe("ExpertUsageBar", () => {
  it("shows usage × teto with a progressbar", () => {
    const html = renderToStaticMarkup(<ExpertUsageBar usage={{ teto: 100, usado: 42.5 }} />);
    expect(html).toContain("R$ 42,50 de R$ 100,00");
    expect(html).toContain('aria-valuenow="43"');
  });

  it("shows only the spend when there is no cap", () => {
    const html = renderToStaticMarkup(<ExpertUsageBar usage={{ teto: null, usado: 5 }} />);
    expect(html).toContain("Sem teto");
    expect(html).not.toContain("progressbar");
  });
});
