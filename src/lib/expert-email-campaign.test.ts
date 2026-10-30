// Área do Expert §8 — runCampaignSend com campanha de expert: destinatários
// resolvidos no servidor com o escopo atual (e-mails avulsos ignorados),
// remetente/encurtador da casa, link com origem 'expert', pausa por teto
// sem aviso de "sem saldo" da casa, pendente nunca enviada, e a casa não
// dispara campanha de expert pelo "Enviar agora".
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
vi.mock("./tenant-access.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tenant-access.server")>()),
  assertTenantNotDemoForSend: vi.fn(async () => undefined),
}));
vi.mock("./house-links.server", () => ({ loadHouseLinks: vi.fn(async () => ({})) }));
vi.mock("./email-send.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./email-send.server")>()),
  resolveSender: vi.fn(async () => ({ fromEmail: "casa@casa.bet", fromName: "Casa", replyTo: null, senderId: "s-1" })),
  sendInfobipEmail: vi.fn(),
}));
vi.mock("./billing/expert-cap-alerts.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./billing/expert-cap-alerts.server")>()),
  notifyExpertCapReached: vi.fn(async () => true),
}));
vi.mock("./billing/wallet-alerts.server", () => ({ notifyNoBalance: vi.fn(async () => false) }));

import { runCampaignSend } from "./email.functions";
import { resolveSender, sendInfobipEmail } from "./email-send.server";
import { notifyExpertCapReached } from "./billing/expert-cap-alerts.server";
import { notifyNoBalance } from "./billing/wallet-alerts.server";
import { assertNotExpertEmailCampaign, EXPERT_CAMPAIGN_HOUSE_REFUSED } from "./expert-email-campaign.server";

const T = "00000000-0000-4000-8000-00000000000a";
const EXPERT = "00000000-0000-4000-8000-0000000000e1";
const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function seed(opts: { approval?: string | null; status?: string; ativo?: boolean } = {}) {
  fake.db.reset();
  fake.db.rows("experts").push({ id: EXPERT, tenant_id: T, nome: "Eu", tipo: "restrito", ativo: opts.ativo ?? true, envio_modo: "livre", teto_mensal: null });
  fake.db.rows("expert_affiliates").push({ tenant_id: T, expert_id: EXPERT, affiliate_id: "AFF1" });
  fake.db.rows("players").push(
    { id: pid(1), tenant_id: T, email: "a@x.com", nome: "A", affiliate_id: "AFF1" },
    { id: pid(2), tenant_id: T, email: "b@x.com", nome: "B", affiliate_id: "AFF1" },
    { id: pid(3), tenant_id: T, email: "c@x.com", nome: "C", affiliate_id: "AFF2" },
  );
  fake.db.rows("email_campaigns").push({
    id: "camp-x",
    tenant_id: T,
    expert_id: EXPERT,
    approval_status: opts.approval ?? null,
    template_id: null,
    template_snapshot: { subject: "Oi", body_html: '<a href="https://casa.bet">x</a>' },
    sender_id: "sender-override",
    short_domain_id: "domain-override",
    status: opts.status ?? "enviando",
    blocked_reason: null,
    track_links: true,
    audience_filter: {
      audience_mode: "expert",
      audience_criteria: { level: null },
      extra_emails: ["intruso@evil.com"],
      target_player_ids: [pid(3)],
    },
  });
  fake.db.onRpc("resolve_sms_audience_v2", (args) => {
    const c = args._criteria as Record<string, unknown>;
    const allowed = new Set((c.affiliateIds as string[]) ?? []);
    const matched = fake.db.rows("players").filter((p) => !("affiliateIds" in c) || allowed.has(String(p.affiliate_id)));
    return {
      data: { phones: [], total: matched.length, emailPlayerIds: matched.map((p) => p.id), affiliateScoped: "affiliateIds" in c },
      error: null,
    };
  });
}

const ok = (n: number) => ({ ok: true, status: 200, body: {}, idempotencyKey: `k-${n}`, temporary: false, billing: { referenceId: `r${n}`, amount: 0.002 } });

beforeEach(() => {
  vi.mocked(sendInfobipEmail).mockReset();
  vi.mocked(resolveSender).mockClear();
  vi.mocked(notifyExpertCapReached).mockClear();
  vi.mocked(notifyNoBalance).mockClear();
});

describe("runCampaignSend: campanha de expert", () => {
  it("só jogadores do escopo; ignora e-mails avulsos e ids gravados; origem expert; remetente da casa", async () => {
    seed();
    vi.mocked(sendInfobipEmail).mockResolvedValue(ok(1) as never);
    const r = await runCampaignSend("camp-x");
    expect(r).toMatchObject({ enviados: 2, total: 2 });
    const tos = vi.mocked(sendInfobipEmail).mock.calls.map(([a]) => a.to).sort();
    expect(tos).toEqual(["a@x.com", "b@x.com"]);
    for (const [a] of vi.mocked(sendInfobipEmail).mock.calls) {
      expect(a).toMatchObject({
        expertId: EXPERT,
        linkTracking: { sourceType: "expert", sourceId: EXPERT, shortDomainId: null },
      });
    }
    expect(vi.mocked(resolveSender).mock.calls[0][0]).toMatchObject({ senderId: null });
  });

  it("teto atingido: pausa com motivo próprio, avisa o admin do expert, nunca o 'sem saldo' da casa", async () => {
    seed();
    vi.mocked(sendInfobipEmail)
      .mockResolvedValueOnce(ok(1) as never)
      .mockResolvedValueOnce({ ok: false, status: 0, body: {}, idempotencyKey: "k", temporary: false, errorKind: "expert_cap" } as never);
    const r = await runCampaignSend("camp-x");
    expect(r).toMatchObject({ enviados: 1, pausadaPorTeto: true, pausadaPorSaldo: false });
    const camp = fake.db.rows("email_campaigns")[0];
    expect(camp.status).toBe("pausada");
    expect(String(camp.blocked_reason)).toContain("Teto mensal do expert");
    expect(notifyExpertCapReached).toHaveBeenCalledWith(T, EXPERT);
    expect(notifyNoBalance).not.toHaveBeenCalled();
  });

  it("pendente de aprovação nunca é enviada", async () => {
    seed({ approval: "pendente", status: "aguardando_aprovacao" });
    await expect(runCampaignSend("camp-x")).rejects.toThrow(/aguarda a aprovação/);
    expect(sendInfobipEmail).not.toHaveBeenCalled();
  });

  it("expert desativado: pausa sem enviar", async () => {
    seed({ ativo: false });
    await runCampaignSend("camp-x");
    expect(sendInfobipEmail).not.toHaveBeenCalled();
    expect(fake.db.rows("email_campaigns")[0]).toMatchObject({ status: "pausada" });
  });

  it("a casa não envia campanha de expert pelo 'Enviar agora'", async () => {
    seed();
    await expect(assertNotExpertEmailCampaign("camp-x")).rejects.toThrow(EXPERT_CAMPAIGN_HOUSE_REFUSED);
  });
});

describe("runCampaignSend: expert campaign in batches", () => {
  it("cap reached in the second batch pauses it; no recipient is sent twice", async () => {
    seed();
    const { EMAIL_CAMPAIGN_BATCH_SIZE } = await import("./email.functions");
    for (let i = 10; i < EMAIL_CAMPAIGN_BATCH_SIZE + 30; i++)
      fake.db.rows("players").push({ id: pid(i), tenant_id: T, email: `p${i}@x.com`, nome: "P", affiliate_id: "AFF1" });
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as never);
    let calls = 0;
    vi.mocked(sendInfobipEmail).mockImplementation(async () => {
      calls += 1;
      return (calls === EMAIL_CAMPAIGN_BATCH_SIZE + 5
        ? { ok: false, status: 0, body: {}, idempotencyKey: "k", temporary: false, errorKind: "expert_cap" }
        : ok(calls)) as never;
    });
    const first = await runCampaignSend("camp-x");
    expect(first).toMatchObject({ enviados: EMAIL_CAMPAIGN_BATCH_SIZE, continuaEmLotes: true });
    const camp = fake.db.rows("email_campaigns")[0];
    expect(camp.status).toBe("agendada");
    Object.assign(camp, { status: "enviando" });
    const second = await runCampaignSend("camp-x");
    expect(second).toMatchObject({ pausadaPorTeto: true, enviados: 4, continuaEmLotes: false });
    expect(camp.status).toBe("pausada");
    expect(notifyExpertCapReached).toHaveBeenCalledWith(T, EXPERT);
    const tos = vi.mocked(sendInfobipEmail).mock.calls.map(([a]) => a.to);
    expect(new Set(tos).size).toBe(tos.length);
    timer.mockRestore();
  });
});
