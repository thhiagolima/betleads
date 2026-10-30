// Área do Expert §8 — leituras do admin: detalhe da campanha com conteúdo
// (SMS, e-mail, voz por roteiro ou áudio) e uso do mês × teto por expert.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  admin: null as unknown as ReturnType<typeof createFakeDb>,
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import { expertCapMonth } from "@/lib/billing/expert-cap-alerts.server";
import {
  EXPERT_ADMIN_CAMPAIGN_NOT_FOUND,
  getExpertCampaignForAdminCore,
  listExpertUsageForAdminCore,
} from "./expert-campaigns-admin.server";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000a2";
const E1 = "00000000-0000-4000-8000-0000000000e1";
const E2 = "00000000-0000-4000-8000-0000000000e2";
const E3 = "00000000-0000-4000-8000-0000000000e3";
const NOW = new Date("2026-10-15T12:00:00Z");

beforeEach(() => {
  fake.admin.reset();
  fake.admin
    .rows("experts")
    .push(
      { id: E1, tenant_id: TENANT, nome: "Queiroz", teto_mensal: "100.00" },
      { id: E2, tenant_id: TENANT, nome: "Ana", teto_mensal: null },
      { id: E3, tenant_id: OTHER_TENANT, nome: "Outro", teto_mensal: 5 },
    );
});

describe("getExpertCampaignForAdminCore", () => {
  it("returns the SMS text, segments, audience and cost", async () => {
    fake.admin.rows("sms_campaigns").push({
      id: "s1",
      tenant_id: TENANT,
      expert_id: E1,
      name: "Promo",
      content: "Volte e ganhe bônus hoje!",
      status: "aguardando_aprovacao",
      approval_status: "pendente",
      total_count: 42,
      expert_estimated_cost: "3.3600",
      audience_criteria: { timing: "inactive30" },
      created_at: "2026-10-14T10:00:00Z",
      updated_at: "2026-10-14T10:00:00Z",
    });
    const detail = await getExpertCampaignForAdminCore(TENANT, { channel: "sms", id: "s1" });
    expect(detail).toMatchObject({
      name: "Promo",
      expertNome: "Queiroz",
      totalCount: 42,
      estimatedCost: 3.36,
      approvalStatus: "pendente",
      audienceDescription: "30+ dias sem depositar",
      content: { kind: "sms", text: "Volte e ganhe bônus hoje!", segments: 1 },
    });
  });

  it("returns the e-mail subject, preheader and HTML snapshot", async () => {
    fake.admin.rows("email_campaigns").push({
      id: "m1",
      tenant_id: TENANT,
      expert_id: E2,
      name: "News",
      status: "aguardando_aprovacao",
      approval_status: "pendente",
      template_snapshot: { subject: "Oi!", preheader: "", body_html: "<p>Olá</p>" },
      audience_filter: { audience_criteria: {} },
      stats: { total: 7 },
      blocked_reason: null,
      created_at: "2026-10-14T10:00:00Z",
    });
    const detail = await getExpertCampaignForAdminCore(TENANT, { channel: "email", id: "m1" });
    expect(detail.content).toEqual({
      kind: "email",
      subject: "Oi!",
      preheader: null,
      html: "<p>Olá</p>",
    });
    expect(detail.totalCount).toBe(7);
    expect(detail.audienceDescription).toBe("Toda a carteira do expert");
  });

  it("returns the voice script text or the asset name", async () => {
    fake.admin
      .rows("call_scripts")
      .push({ id: "sc1", tenant_id: TENANT, name: "Roteiro A", content: "Olá {nome}" });
    fake.admin
      .rows("journey_voice_assets")
      .push({ id: "a1", tenant_id: TENANT, name: "Áudio B", duration_seconds: 25 });
    fake.admin
      .rows("expert_voice_campaigns")
      .push(
        {
          id: "v1",
          tenant_id: TENANT,
          expert_id: E1,
          name: "V1",
          status: "aguardando_aprovacao",
          script_id: "sc1",
          voice_asset_id: null,
          total_count: 3,
          created_at: "x",
        },
        {
          id: "v2",
          tenant_id: TENANT,
          expert_id: E1,
          name: "V2",
          status: "aguardando_aprovacao",
          script_id: null,
          voice_asset_id: "a1",
          total_count: 3,
          created_at: "x",
        },
      );
    const script = await getExpertCampaignForAdminCore(TENANT, { channel: "voice", id: "v1" });
    expect(script.content).toEqual({
      kind: "voice",
      source: "script",
      name: "Roteiro A",
      text: "Olá {nome}",
      durationSeconds: null,
    });
    const asset = await getExpertCampaignForAdminCore(TENANT, { channel: "voice", id: "v2" });
    expect(asset.content).toEqual({
      kind: "voice",
      source: "asset",
      name: "Áudio B",
      text: null,
      durationSeconds: 25,
    });
  });

  it("never returns another house's campaign nor a house (non-expert) campaign", async () => {
    fake.admin
      .rows("sms_campaigns")
      .push(
        {
          id: "s-other",
          tenant_id: OTHER_TENANT,
          expert_id: E3,
          name: "x",
          content: "x",
          status: "agendada",
        },
        {
          id: "s-house",
          tenant_id: TENANT,
          expert_id: null,
          name: "x",
          content: "x",
          status: "agendada",
        },
      );
    await expect(
      getExpertCampaignForAdminCore(TENANT, { channel: "sms", id: "s-other" }),
    ).rejects.toThrow(EXPERT_ADMIN_CAMPAIGN_NOT_FOUND);
    await expect(
      getExpertCampaignForAdminCore(TENANT, { channel: "sms", id: "s-house" }),
    ).rejects.toThrow(EXPERT_ADMIN_CAMPAIGN_NOT_FOUND);
  });
});

describe("listExpertUsageForAdminCore", () => {
  beforeEach(() => {
    const month = expertCapMonth(NOW);
    fake.admin
      .rows("expert_monthly_usage")
      .push(
        { tenant_id: TENANT, expert_id: E1, month, amount: "42.5" },
        { tenant_id: TENANT, expert_id: E1, month: "2026-09-01", amount: "999" },
        { tenant_id: OTHER_TENANT, expert_id: E3, month, amount: "1" },
      );
    fake.admin
      .rows("sms_campaigns")
      .push(
        {
          id: "p1",
          tenant_id: TENANT,
          expert_id: E1,
          status: "aguardando_aprovacao",
          approval_status: "pendente",
          expert_estimated_cost: "2",
        },
        {
          id: "p2",
          tenant_id: TENANT,
          expert_id: E1,
          status: "recusada",
          approval_status: "recusada",
          expert_estimated_cost: "9",
        },
      );
    fake.admin.rows("email_campaigns").push({
      id: "p3",
      tenant_id: TENANT,
      expert_id: E1,
      status: "aguardando_aprovacao",
      approval_status: "pendente",
      expert_estimated_cost: "0.5",
    });
    fake.admin.rows("expert_voice_campaigns").push({
      id: "p4",
      tenant_id: TENANT,
      expert_id: E2,
      status: "aguardando_aprovacao",
      approval_status: "pendente",
      expert_estimated_cost: null,
    });
  });

  it("returns teto, this month's usage and pending approvals per expert of the house", async () => {
    const result = await listExpertUsageForAdminCore(TENANT, {}, NOW);
    expect(result.mes).toBe("2026-10");
    expect(result.items).toEqual([
      { expertId: E1, teto: 100, usado: 42.5, pendentes: 2, pendentesEstimado: 2.5 },
      { expertId: E2, teto: null, usado: 0, pendentes: 1, pendentesEstimado: 0 },
    ]);
  });

  it("filters by expert", async () => {
    const result = await listExpertUsageForAdminCore(TENANT, { expertId: E2 }, NOW);
    expect(result.items.map((i) => i.expertId)).toEqual([E2]);
  });
});
