// E-mail campaigns without a recipient limit: runCampaignSend sends one
// batch (EMAIL_CAMPAIGN_BATCH_SIZE or the time budget), puts the campaign
// back to 'agendada' for the tick, and the next claimed runs continue until
// everyone was attempted — never sending (or charging) anyone twice. A pause
// or a wallet refusal mid-way stops it; resuming continues where it stopped.
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
  resolveSender: vi.fn(async () => ({ fromEmail: "a@a.com", fromName: "A", replyTo: null, senderId: "s-1" })),
  sendInfobipEmail: vi.fn(),
}));

import {
  claimEmailCampaignForSendNow,
  EMAIL_CAMPAIGN_BATCH_SIZE,
  runCampaignSend,
} from "./email.functions";
import { sendInfobipEmail } from "./email-send.server";

const A = "00000000-0000-4000-8000-00000000000a";
const TOTAL = EMAIL_CAMPAIGN_BATCH_SIZE * 2 + 40;
const emails = Array.from({ length: TOTAL }, (_, i) => `u${i}@x.com`);

function seed() {
  fake.db.reset();
  fake.db.rows("email_campaigns").push({
    id: "camp-a",
    tenant_id: A,
    template_id: "tpl-a",
    template_snapshot: null,
    status: "rascunho",
    blocked_reason: null,
    stats: {},
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

const camp = () => fake.db.rows("email_campaigns")[0];
const sentTo = () => vi.mocked(sendInfobipEmail).mock.calls.map(([a]) => a.to);

/** What the tick does: claim an 'agendada' campaign (claim_due_email_campaigns) and run it. */
async function tickRun() {
  expect(camp().status).toBe("agendada");
  const lock = `tick-${Math.random()}`;
  Object.assign(camp(), { status: "enviando", locked_by: lock, locked_at: new Date().toISOString() });
  return runCampaignSend("camp-a", { lockToken: lock });
}

async function sendNow() {
  const lock = await claimEmailCampaignForSendNow("camp-a", A);
  expect(lock).toBeTruthy();
  return runCampaignSend("camp-a", { lockToken: lock });
}

const ok = { ok: true, status: 200, body: {}, idempotencyKey: "k", temporary: false, billing: { referenceId: "r", amount: 0.002 } };

beforeEach(() => {
  vi.mocked(sendInfobipEmail).mockReset();
  vi.mocked(sendInfobipEmail).mockResolvedValue(ok as never);
  // The 30 ms breath between sends: immediate in tests.
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
    fn();
    return 0;
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("e-mail campaign in batches", () => {
  it("'Enviar agora' sends the first batch; the tick sends the rest; nobody twice", async () => {
    seed();
    const first = await sendNow();
    expect(first).toMatchObject({ enviados: EMAIL_CAMPAIGN_BATCH_SIZE, total: TOTAL, continuaEmLotes: true });
    expect(camp()).toMatchObject({ status: "agendada", locked_by: null });
    expect((camp().stats as Record<string, unknown>).lote_em_andamento).toBe(true);

    const second = await tickRun();
    expect(second).toMatchObject({ enviados: EMAIL_CAMPAIGN_BATCH_SIZE, continuaEmLotes: true });
    const third = await tickRun();
    expect(third).toMatchObject({ enviados: 40, continuaEmLotes: false, jaEnviados: EMAIL_CAMPAIGN_BATCH_SIZE * 2 });
    expect(camp().status).toBe("concluida");
    expect(camp().stats).toMatchObject({ enviados: TOTAL, total: TOTAL });

    const to = sentTo();
    expect(to).toHaveLength(TOTAL);
    expect(new Set(to).size).toBe(TOTAL);
    expect(fake.db.rows("email_send_logs")).toHaveLength(TOTAL);
  });

  it("a failing address does not stall the next batches (attempted ones are skipped)", async () => {
    seed();
    vi.mocked(sendInfobipEmail).mockImplementation(async (a) =>
      (a.to === "u0@x.com"
        ? { ok: false, status: 400, body: "bad", idempotencyKey: "k", temporary: false }
        : ok) as never,
    );
    await sendNow();
    await tickRun();
    await tickRun();
    expect(camp().status).toBe("concluida");
    expect(sentTo().filter((t) => t === "u0@x.com")).toHaveLength(1);
  });

  it("time budget: a run past its deadline stops after one send and continues later", async () => {
    seed();
    const lock = await claimEmailCampaignForSendNow("camp-a", A);
    const r = await runCampaignSend("camp-a", { lockToken: lock, deadline: Date.now() - 1 });
    expect(r).toMatchObject({ enviados: 1, continuaEmLotes: true });
    expect(camp().status).toBe("agendada");
  });

  it("paused between batches: the tick does not pick it; resuming continues without duplicates", async () => {
    seed();
    await sendNow();
    Object.assign(camp(), { status: "pausada", locked_by: null });
    // claim_due_email_campaigns only claims 'agendada': nothing happens while paused.
    const resumed = await sendNow();
    expect(resumed).toMatchObject({ jaEnviados: EMAIL_CAMPAIGN_BATCH_SIZE, enviados: EMAIL_CAMPAIGN_BATCH_SIZE });
    await tickRun();
    expect(camp().status).toBe("concluida");
    expect(new Set(sentTo()).size).toBe(TOTAL);
    expect(sentTo()).toHaveLength(TOTAL);
  });

  it("paused during a batch: the run stops at the next status check and keeps 'pausada'", async () => {
    seed();
    let calls = 0;
    vi.mocked(sendInfobipEmail).mockImplementation(async () => {
      calls += 1;
      if (calls === 25) Object.assign(camp(), { status: "pausada", locked_by: null });
      return ok as never;
    });
    const r = await sendNow();
    expect(r).toMatchObject({ interrompida: true, continuaEmLotes: false });
    expect(calls).toBe(30);
    expect(camp().status).toBe("pausada");
  });

  it("wallet refusal mid-way pauses; resuming after a top-up finishes without double charge", async () => {
    seed();
    let calls = 0;
    vi.mocked(sendInfobipEmail).mockImplementation(async () => {
      calls += 1;
      return (calls === EMAIL_CAMPAIGN_BATCH_SIZE + 10
        ? { ok: false, status: 0, body: {}, idempotencyKey: "k", temporary: false, errorKind: "insufficient_balance" }
        : ok) as never;
    });
    await sendNow();
    const refused = await tickRun();
    expect(refused).toMatchObject({ pausadaPorSaldo: true, enviados: 9, continuaEmLotes: false });
    expect(camp().status).toBe("pausada");
    await sendNow();
    await tickRun();
    expect(camp().status).toBe("concluida");
    const charged = vi.mocked(sendInfobipEmail).mock.calls.length - 1; // the refused one charged nothing
    expect(charged).toBe(TOTAL);
    expect(fake.db.rows("email_send_logs")).toHaveLength(TOTAL);
  });
});
