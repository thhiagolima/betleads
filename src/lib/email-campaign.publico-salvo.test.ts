// SA-11 — a campaign saved as "Público salvo" is a hand-picked lead list. When
// its ids are missing it must stop with a clear message, never fall into the
// segment path (which used to resolve to every player with an e-mail).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  resolveSender: vi.fn(async () => ({
    fromEmail: "a@a.com",
    fromName: "A",
    replyTo: null,
    senderId: "s-1",
  })),
  sendInfobipEmail: vi.fn(),
}));

import { runCampaignSend } from "./email.functions";
import { sendInfobipEmail } from "./email-send.server";

const A = "00000000-0000-4000-8000-00000000000a";

function seed(audienceFilter: Record<string, unknown>) {
  fake.db.reset();
  fake.db.rows("email_campaigns").push({
    id: "camp-a",
    tenant_id: A,
    template_id: "tpl-a",
    template_snapshot: null,
    status: "enviando",
    locked_by: "lock-1",
    blocked_reason: null,
    stats: {},
    audience_filter: audienceFilter,
  });
  fake.db.rows("email_templates").push({
    id: "tpl-a",
    tenant_id: A,
    lifecycle_status: "published",
    subject: "Oi",
    body_html: "<p>Oi</p>",
  });
  fake.db
    .rows("players")
    .push(
      { id: "p1", tenant_id: A, email: "p1@x.com" },
      { id: "p2", tenant_id: A, email: "p2@x.com" },
    );
}

beforeEach(() => {
  vi.mocked(sendInfobipEmail).mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("'Público salvo' without leads never becomes the whole base", () => {
  it.each([
    ["legacy filter (no audience_mode)", { segmento: "Público salvo", target_player_ids: [] }],
    ["audience_mode segmento", { audience_mode: "segmento", segmento: "Público salvo" }],
  ])("%s -> clear error, nobody e-mailed", async (_label, filter) => {
    seed(filter);
    await expect(runCampaignSend("camp-a", { lockToken: "lock-1" })).rejects.toThrow(
      /público salvo não tem nenhum lead/i,
    );
    expect(sendInfobipEmail).not.toHaveBeenCalled();
  });

  it("an unknown segment name is refused too", async () => {
    seed({ audience_mode: "segmento", segmento: "Segmento que não existe" });
    await expect(runCampaignSend("camp-a", { lockToken: "lock-1" })).rejects.toThrow(
      /Público de e-mail desconhecido/,
    );
    expect(sendInfobipEmail).not.toHaveBeenCalled();
  });

  it("'leads' mode with no ids keeps its own message", async () => {
    seed({ audience_mode: "leads", segmento: "Público salvo", target_player_ids: [] });
    await expect(runCampaignSend("camp-a", { lockToken: "lock-1" })).rejects.toThrow(
      /Selecione pelo menos um lead/,
    );
    expect(sendInfobipEmail).not.toHaveBeenCalled();
  });
});
