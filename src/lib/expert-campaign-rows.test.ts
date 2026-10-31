import { describe, expect, it } from "vitest";

import { getChannelOperationState } from "./channel-operation-state";
import {
  expertCampaignToRow,
  matchesExpertStatus,
  type ExpertCampaignItem,
} from "./expert-campaign-rows";

function item(overrides: Partial<ExpertCampaignItem> = {}): ExpertCampaignItem {
  return {
    id: "c1",
    channel: "sms",
    name: "Bônus",
    status: "aguardando_aprovacao",
    approvalStatus: "pendente",
    rejectionReason: null,
    lastError: null,
    scheduledAt: null,
    createdAt: "2026-10-20T12:00:00.000Z",
    updatedAt: null,
    totalCount: 120,
    sentCount: 0,
    failedCount: 0,
    estimatedCost: 9.6,
    ...overrides,
  };
}

describe("expertCampaignToRow", () => {
  it("maps the list item to a hub row", () => {
    const row = expertCampaignToRow(item());
    expect(row).toMatchObject({
      id: "c1",
      channel: "sms",
      status: "aguardando_aprovacao",
      scheduled_at: "2026-10-20T12:00:00.000Z",
      date_is_creation: true,
      total_count: 120,
      cancellable: true,
      resumable: false,
    });
  });

  it("carries the rejection reason, stop reason and batch flag", () => {
    const row = expertCampaignToRow(
      item({
        channel: "email",
        status: "recusada",
        rejectionReason: "Link fora da política",
        batchInProgress: true,
      }),
    );
    expect(row.rejection_reason).toBe("Link fora da política");
    expect(row.batch_in_progress).toBe(true);
  });

  it("only cancellable statuses get Cancelar", () => {
    expect(expertCampaignToRow(item({ status: "enviando" })).cancellable).toBe(false);
    expect(expertCampaignToRow(item({ channel: "voice", status: "enfileirada" })).cancellable).toBe(
      true,
    );
  });
});

describe("expert status filters", () => {
  it("Pendentes is waiting for approval; refused goes to Finalizadas", () => {
    expect(matchesExpertStatus("pendentes", "aguardando_aprovacao")).toBe(true);
    expect(matchesExpertStatus("pendentes", "agendada")).toBe(false);
    expect(matchesExpertStatus("finalizadas", "recusada")).toBe(true);
    expect(matchesExpertStatus("enviando", "enfileirada")).toBe(true);
    expect(matchesExpertStatus("pausadas", "pausada")).toBe(true);
  });
});

describe("hub status labels", () => {
  it("approval, refusal, cap pause and batched e-mail", () => {
    expect(getChannelOperationState("aguardando_aprovacao", "sms").label).toBe(
      "Aguardando aprovação",
    );
    expect(getChannelOperationState("aguardando_aprovacao", "sms").tone).toContain("text-info");
    expect(getChannelOperationState("recusada", "email").label).toBe("Recusada");
    expect(getChannelOperationState("recusada", "email").tone).toContain("text-danger");
    expect(
      getChannelOperationState("pausada", "sms", { lastError: "Teto mensal do expert atingido" })
        .label,
    ).toBe("Pausada pelo teto");
    expect(
      getChannelOperationState("pausada", "email", {
        lastError:
          "Teto mensal do expert atingido: a campanha foi pausada até o mês virar ou o admin aumentar o teto.",
      }).label,
    ).toBe("Pausada pelo teto");
    // Any other pause keeps the old label (house behaviour unchanged).
    expect(getChannelOperationState("pausada", "sms", { lastError: "Sem saldo" }).label).toBe(
      "Pausada",
    );
    expect(getChannelOperationState("agendada", "email", { batchInProgress: true }).label).toBe(
      "Enviando em lotes",
    );
    expect(getChannelOperationState("agendada", "sms", { batchInProgress: true }).label).toBe(
      "Agendada",
    );
    expect(getChannelOperationState("agendada", "email").label).toBe("Agendada");
    expect(getChannelOperationState("enfileirada", "voice").label).toBe("Enviando");
  });
});
