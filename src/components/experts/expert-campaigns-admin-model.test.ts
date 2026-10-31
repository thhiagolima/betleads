import { describe, expect, it } from "vitest";

import {
  campaignActions,
  campaignStatusInfo,
  rejectReasonError,
  sortApprovalQueue,
  usageView,
  type AdminCampaign,
} from "./expert-campaigns-admin-model";

const c = (overrides: Partial<AdminCampaign & { id: string }> = {}) => ({
  id: "x",
  channel: "sms" as const,
  status: "agendada",
  approvalStatus: null,
  lastError: null,
  createdAt: "2026-10-10T10:00:00Z",
  ...overrides,
});

describe("campaignStatusInfo", () => {
  it("labels approval and pause states", () => {
    expect(
      campaignStatusInfo(c({ status: "aguardando_aprovacao", approvalStatus: "pendente" })).label,
    ).toBe("Aguardando aprovação");
    expect(campaignStatusInfo(c({ status: "recusada", approvalStatus: "recusada" })).label).toBe(
      "Recusada",
    );
    expect(
      campaignStatusInfo(
        c({
          status: "pausada",
          lastError: "Teto mensal do expert atingido: a campanha foi pausada",
        }),
      ).label,
    ).toBe("Pausada pelo teto");
    expect(
      campaignStatusInfo(c({ status: "pausada", lastError: "Pausada pelo admin" })).label,
    ).toBe("Pausada pelo admin");
    expect(campaignStatusInfo(c({ status: "pausada", lastError: "Sem saldo" })).label).toBe(
      "Pausada",
    );
  });
});

describe("campaignActions", () => {
  it("offers review only for pending campaigns", () => {
    expect(
      campaignActions(c({ status: "aguardando_aprovacao", approvalStatus: "pendente" })),
    ).toEqual(["review"]);
    expect(campaignActions(c({ status: "recusada", approvalStatus: "recusada" }))).toEqual([]);
  });

  it("pauses what the server can pause, per channel", () => {
    expect(campaignActions(c({ status: "enviando" }))).toEqual(["pause"]);
    expect(campaignActions(c({ channel: "email", status: "agendada" }))).toEqual(["pause"]);
    expect(campaignActions(c({ channel: "voice", status: "enfileirada" }))).toEqual(["pause"]);
    expect(
      campaignActions(
        c({ channel: "voice", status: "aguardando_aprovacao", approvalStatus: null }),
      ),
    ).toEqual([]);
    expect(campaignActions(c({ status: "enviado" }))).toEqual([]);
  });

  it("resumes paused campaigns that were never refused", () => {
    expect(campaignActions(c({ status: "pausada", approvalStatus: "aprovada" }))).toEqual([
      "resume",
    ]);
    expect(campaignActions(c({ status: "pausada", approvalStatus: null }))).toEqual(["resume"]);
  });
});

describe("sortApprovalQueue", () => {
  it("puts pending first (oldest first), then the rest newest first", () => {
    const items = [
      c({ id: "a", createdAt: "2026-10-01" }),
      c({
        id: "p2",
        status: "aguardando_aprovacao",
        approvalStatus: "pendente",
        createdAt: "2026-10-05",
      }),
      c({ id: "b", createdAt: "2026-10-09" }),
      c({
        id: "p1",
        status: "aguardando_aprovacao",
        approvalStatus: "pendente",
        createdAt: "2026-10-02",
      }),
    ];
    expect(sortApprovalQueue(items).map((i) => i.id)).toEqual(["p1", "p2", "b", "a"]);
  });
});

describe("rejectReasonError", () => {
  it("requires a reason", () => {
    expect(rejectReasonError("")).toBe("Informe o motivo da recusa.");
    expect(rejectReasonError("   ")).toBe("Informe o motivo da recusa.");
    expect(rejectReasonError("Link errado")).toBeNull();
    expect(rejectReasonError("x".repeat(501))).toMatch(/500/);
  });
});

describe("usageView", () => {
  it("covers no cap, blocked, reached and partial", () => {
    expect(usageView({ teto: null, usado: 10 })).toMatchObject({
      percent: null,
      status: "Sem teto",
    });
    expect(usageView({ teto: 0, usado: 0 })).toMatchObject({ tone: "blocked", percent: 100 });
    expect(usageView({ teto: 100, usado: 120 })).toMatchObject({
      tone: "danger",
      status: "Teto atingido",
    });
    expect(usageView({ teto: 100, usado: 85 })).toMatchObject({
      tone: "warning",
      percent: 85,
      status: "85% do teto",
    });
    expect(usageView({ teto: 100, usado: 10 })).toMatchObject({ tone: "ok", percent: 10 });
  });
});
