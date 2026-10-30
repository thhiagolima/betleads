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
vi.mock("./email-segments.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./email-segments.server")>()),
  loadPlayersByIds: vi.fn(async () => [
    { id: "p-1", email: "Ana@x.com", nome: "Ana" },
    { id: "p-2", email: "bia@x.com", nome: "Bia" },
    { id: "p-3", email: "caio@x.com", nome: "Caio" },
  ]),
}));
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

import {
  claimEmailCampaignForSendNow,
  EMAIL_CAMPAIGN_STATUS_CHECK_EVERY,
  emailCampaignStatusPatch,
  runCampaignSend,
} from "./email.functions";
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

const sentTo = () =>
  vi.mocked(sendInfobipEmail).mock.calls.map((call) => (call[0] as { to: string }).to);

describe("runCampaignSend re-run (fix round 1)", () => {
  it("after 'pausada por saldo', a re-run sends and charges only the remaining recipients", async () => {
    seed(["a@x.com", "b@x.com", "c@x.com", "d@x.com"]);
    vi.mocked(sendInfobipEmail)
      .mockResolvedValueOnce(ok(1) as never)
      .mockResolvedValueOnce(noBalance as never);
    await runCampaignSend("camp-a");
    expect(fake.db.rows("email_campaigns")[0].status).toBe("pausada");

    // The house sends it again: "Enviar agora" claims it back to enviando.
    fake.db.rows("email_campaigns")[0].status = "enviando";
    vi.mocked(sendInfobipEmail).mockReset();
    let n = 10;
    vi.mocked(sendInfobipEmail).mockImplementation(async () => ok(n++) as never);
    const result = await runCampaignSend("camp-a");

    expect(sentTo()).toEqual(["b@x.com", "c@x.com", "d@x.com"]);
    expect(result).toMatchObject({ enviados: 3, jaEnviados: 1, total: 4, pausadaPorSaldo: false });
    const camp = fake.db.rows("email_campaigns")[0];
    expect(camp.status).toBe("concluida");
    expect(camp.stats).toMatchObject({ enviados: 4, total: 4 });
    const charged = fake.db
      .rows("email_send_logs")
      .filter((l) => Number(l.billed_amount) > 0)
      .map((l) => l.to_email);
    expect(charged).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com"]);
  });

  it("skips a player already sent (by player_id) or delivered, retries pending/error rows", async () => {
    seed([]);
    fake.db.rows("email_campaigns")[0].audience_filter = {
      audience_mode: "leads",
      target_player_ids: ["p-1", "p-2", "p-3"],
    };
    fake.db.rows("email_send_logs").push(
      // Sent under another address: still the same player.
      { campaign_id: "camp-a", player_id: "p-1", to_email: "old@x.com", status: "sent", sent_at: "2026-10-01T00:00:00Z" },
      // Temporary failure: must be retried.
      { campaign_id: "camp-a", player_id: "p-2", to_email: "bia@x.com", status: "pending", sent_at: null },
      // Bounced after being accepted: keeps sent_at, never resent.
      { campaign_id: "camp-a", player_id: "p-3", to_email: "caio@x.com", status: "bounced", sent_at: "2026-10-01T00:00:00Z" },
      // Another campaign: ignored.
      { campaign_id: "camp-z", player_id: "p-2", to_email: "bia@x.com", status: "sent", sent_at: "2026-10-01T00:00:00Z" },
    );
    vi.mocked(sendInfobipEmail).mockResolvedValue(ok(1) as never);
    const result = await runCampaignSend("camp-a");
    expect(sentTo()).toEqual(["bia@x.com"]);
    expect(result).toMatchObject({ enviados: 1, jaEnviados: 2, total: 3 });
  });

  it("matches extra addresses (no player) by lowercased e-mail; delivered counts as sent", async () => {
    seed(["a@x.com", "b@x.com"]);
    fake.db.rows("email_send_logs").push({
      campaign_id: "camp-a",
      player_id: null,
      to_email: "A@X.com",
      status: "delivered",
      sent_at: null,
    });
    vi.mocked(sendInfobipEmail).mockResolvedValue(ok(1) as never);
    await runCampaignSend("camp-a");
    expect(sentTo()).toEqual(["b@x.com"]);
  });

  it("everyone already received it: nothing is sent and the campaign is concluded", async () => {
    seed(["a@x.com"]);
    fake.db.rows("email_send_logs").push({
      campaign_id: "camp-a",
      player_id: null,
      to_email: "a@x.com",
      status: "sent",
      sent_at: "2026-10-01T00:00:00Z",
    });
    const result = await runCampaignSend("camp-a");
    expect(sendInfobipEmail).not.toHaveBeenCalled();
    expect(result).toMatchObject({ enviados: 0, jaEnviados: 1, total: 1 });
    expect(fake.db.rows("email_campaigns")[0]).toMatchObject({ status: "concluida", blocked_reason: null });
  });

  it("the throw-path log row carries the billing columns when the result is known", async () => {
    seed(["a@x.com"]);
    vi.mocked(sendInfobipEmail).mockResolvedValueOnce({
      ok: false,
      status: 400,
      body: {},
      idempotencyKey: "k-1",
      temporary: false,
      billing: { referenceId: "email:k-1", amount: 0 },
    } as never);
    // The log insert after the send fails hard (network), landing in the catch.
    const realFrom = fake.db.client.from;
    const insert = vi.spyOn(fake.db.client, "from");
    let first = true;
    insert.mockImplementation(((table: string) => {
      if (table === "email_send_logs" && first) {
        // The dedup read happens first; fail only the first insert.
        const builder = realFrom(table);
        return {
          ...builder,
          insert: () => {
            first = false;
            return Promise.reject(new Error("rede caiu"));
          },
        };
      }
      return realFrom(table);
    }) as never);
    await runCampaignSend("camp-a");
    insert.mockRestore();
    const logs = fake.db.rows("email_send_logs");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      status: "error",
      billing_reference_id: "email:k-1",
      billed_amount: 0,
    });
  });
});

describe("emailCampaignStatusPatch", () => {
  it("pausing clears the run lock and the blocked reason", () => {
    expect(emailCampaignStatusPatch("pausada")).toEqual({
      status: "pausada",
      blocked_reason: null,
      locked_at: null,
      locked_by: null,
    });
  });

  it("other statuses only clear the blocked reason", () => {
    expect(emailCampaignStatusPatch("agendada")).toEqual({ status: "agendada", blocked_reason: null });
  });
});

describe("runCampaignSend run lock (pause / cancel / concurrent send)", () => {
  const emails = (n: number) => Array.from({ length: n }, (_, i) => `r${i}@x.com`);
  const camp = () => fake.db.rows("email_campaigns")[0];

  it("a pause while running stops at the next status check and is not overwritten", async () => {
    seed(emails(25));
    camp().locked_by = "lock-1";
    let n = 0;
    vi.mocked(sendInfobipEmail).mockImplementation(async () => {
      n++;
      // The house pauses after the 3rd e-mail (emailCampaignStatusPatch).
      if (n === 3) Object.assign(camp(), emailCampaignStatusPatch("pausada"));
      return ok(n) as never;
    });

    const result = await runCampaignSend("camp-a", { lockToken: "lock-1" });

    expect(sendInfobipEmail).toHaveBeenCalledTimes(EMAIL_CAMPAIGN_STATUS_CHECK_EVERY);
    expect(result).toMatchObject({ enviados: EMAIL_CAMPAIGN_STATUS_CHECK_EVERY, interrompida: true });
    expect(camp().status).toBe("pausada");
    expect(camp().stats).toMatchObject({ enviados: EMAIL_CAMPAIGN_STATUS_CHECK_EVERY, total: 25 });
  });

  it("a cancel also stops the run", async () => {
    seed(emails(25));
    let n = 0;
    vi.mocked(sendInfobipEmail).mockImplementation(async () => {
      n++;
      if (n === 1) camp().status = "cancelada";
      return ok(n) as never;
    });

    const result = await runCampaignSend("camp-a");

    expect(sendInfobipEmail).toHaveBeenCalledTimes(EMAIL_CAMPAIGN_STATUS_CHECK_EVERY);
    expect(result.interrompida).toBe(true);
    expect(camp().status).toBe("cancelada");
  });

  it("a pause after the last check is not overwritten with concluida", async () => {
    seed(["a@x.com", "b@x.com"]);
    let n = 0;
    vi.mocked(sendInfobipEmail).mockImplementation(async () => {
      n++;
      if (n === 2) Object.assign(camp(), emailCampaignStatusPatch("pausada"));
      return ok(n) as never;
    });

    const result = await runCampaignSend("camp-a");

    expect(result).toMatchObject({ enviados: 2, interrompida: true });
    expect(camp().status).toBe("pausada");
    expect(camp().stats).toMatchObject({ enviados: 2, total: 2 });
  });

  it("a campaign claimed by another run (other lock) sends nothing", async () => {
    seed(["a@x.com"]);
    camp().locked_by = "someone-else";
    vi.mocked(sendInfobipEmail).mockResolvedValue(ok(1) as never);

    const result = await runCampaignSend("camp-a", { lockToken: "mine" });

    expect(sendInfobipEmail).not.toHaveBeenCalled();
    expect(result.interrompida).toBe(true);
    expect(camp()).toMatchObject({ status: "enviando", locked_by: "someone-else" });
  });

  it("a campaign that is not claimed (not enviando) sends nothing", async () => {
    seed(["a@x.com"]);
    camp().status = "pausada";
    vi.mocked(sendInfobipEmail).mockResolvedValue(ok(1) as never);

    const result = await runCampaignSend("camp-a");

    expect(sendInfobipEmail).not.toHaveBeenCalled();
    expect(result.interrompida).toBe(true);
    expect(camp().status).toBe("pausada");
  });

  it("a finished run concludes and releases its lock", async () => {
    seed(["a@x.com"]);
    camp().locked_by = "lock-1";
    camp().locked_at = "2026-10-30T00:00:00Z";
    vi.mocked(sendInfobipEmail).mockResolvedValue(ok(1) as never);

    const result = await runCampaignSend("camp-a", { lockToken: "lock-1" });

    expect(result.interrompida).toBe(false);
    expect(camp()).toMatchObject({ status: "concluida", locked_by: null, locked_at: null });
  });
});

describe("claimEmailCampaignForSendNow", () => {
  const camp = () => fake.db.rows("email_campaigns")[0];

  it("claims from an allowed status once; a second send-now or a running campaign is refused", async () => {
    for (const from of ["rascunho", "agendada", "pausada", "concluida"]) {
      seed(["a@x.com"]);
      camp().status = from;
      const token = await claimEmailCampaignForSendNow("camp-a", A);
      expect(token, from).toEqual(expect.any(String));
      expect(camp()).toMatchObject({ status: "enviando", locked_by: token });
      expect(await claimEmailCampaignForSendNow("camp-a", A), from).toBeNull();
      expect(camp().locked_by).toBe(token);
    }
  });

  it("never claims a campaign of another house or in another status", async () => {
    seed(["a@x.com"]);
    camp().status = "rascunho";
    expect(await claimEmailCampaignForSendNow("camp-a", "00000000-0000-4000-8000-00000000000b")).toBeNull();
    camp().status = "cancelada";
    expect(await claimEmailCampaignForSendNow("camp-a", A)).toBeNull();
    expect(camp().status).toBe("cancelada");
  });
});
