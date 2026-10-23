// PG3 Task 6 — an e-mail campaign without balance stops at the first
// `insufficient_balance` (spec decision 7): the rest is not attempted, the
// campaign is left "pausada" with the reason in blocked_reason, and the
// e-mails already sent keep their billing columns in email_send_logs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
// The demo send guard has its own coverage (demo-send-guard.channels.test.ts).
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

function seed(emails: string[]) {
  fake.db.reset();
  fake.db.rows("email_campaigns").push({
    id: "camp-a",
    tenant_id: A,
    template_id: "tpl-a",
    template_snapshot: null,
    status: "enviando",
    blocked_reason: null,
    audience_filter: { audience_mode: "emails", extra_emails: emails },
  });
  fake.db.rows("email_templates").push({
    id: "tpl-a",
    tenant_id: A,
    lifecycle_status: "published",
    subject: "Oi",
    body_html: "<p>Oi</p>",
  });
}

const ok = (n: number) => ({
  ok: true,
  status: 200,
  body: {},
  idempotencyKey: `k-${n}`,
  temporary: false,
  billing: { referenceId: `email:k-${n}`, amount: 0.002 },
});

const noBalance = {
  ok: false,
  status: 0,
  body: { error: "Saldo insuficiente" },
  idempotencyKey: "k-x",
  temporary: false,
  errorKind: "insufficient_balance",
};

beforeEach(() => {
  vi.mocked(sendInfobipEmail).mockReset();
});

describe("runCampaignSend without balance", () => {
  it("stops at the first insufficient_balance and pauses the campaign", async () => {
    seed(["a@x.com", "b@x.com", "c@x.com", "d@x.com"]);
    vi.mocked(sendInfobipEmail)
      .mockResolvedValueOnce(ok(1) as never)
      .mockResolvedValueOnce(noBalance as never)
      .mockResolvedValue(ok(3) as never);

    const result = await runCampaignSend("camp-a");

    expect(sendInfobipEmail).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ enviados: 1, falhas: 0, total: 4, pausadaPorSaldo: true });

    const camp = fake.db.rows("email_campaigns")[0];
    expect(camp.status).toBe("pausada");
    expect(String(camp.blocked_reason)).toContain("Saldo insuficiente");
    expect(camp.stats).toMatchObject({ enviados: 1, falhas: 0, total: 4 });

    // Only the e-mail actually sent is logged; the refused one is not a
    // delivery attempt (nothing sent, nothing charged).
    const logs = fake.db.rows("email_send_logs");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      to_email: "a@x.com",
      status: "sent",
      billing_reference_id: "email:k-1",
      billed_amount: 0.002,
    });
  });

  it("a campaign with balance completes and logs the billing columns of each e-mail", async () => {
    seed(["a@x.com", "b@x.com"]);
    vi.mocked(sendInfobipEmail)
      .mockResolvedValueOnce(ok(1) as never)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        body: {},
        idempotencyKey: "k-2",
        temporary: false,
        billing: { referenceId: "email:k-2", amount: 0 },
      } as never);

    const result = await runCampaignSend("camp-a");

    expect(result).toMatchObject({ enviados: 1, falhas: 1, pausadaPorSaldo: false });
    expect(fake.db.rows("email_campaigns")[0].status).toBe("concluida");
    const logs = fake.db.rows("email_send_logs");
    expect(logs.map((l) => [l.billing_reference_id, l.billed_amount])).toEqual([
      ["email:k-1", 0.002],
      ["email:k-2", 0],
    ]);
  });
});
