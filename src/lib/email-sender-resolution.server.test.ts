// Task 8 — a house only sends e-mail from a sender whose domain is a verified,
// non-removed e-mail domain of that house. resolveSender never reads
// email_smtp_configs; a campaign without a verified sender is blocked with
// EMAIL_DOMAIN_NOT_VERIFIED before the provider is called.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));
const send = vi.hoisted(() => ({
  sendInfobipEmail: vi.fn(async (_input: Record<string, unknown>) => ({
    ok: true,
    status: 200,
    body: {},
    idempotencyKey: "k",
    temporary: false,
  })),
}));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});
vi.mock("./tenant-access.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tenant-access.server")>()),
  assertTenantNotDemoForSend: vi.fn(async () => undefined),
}));
vi.mock("./email-send.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./email-send.server")>()),
  sendInfobipEmail: send.sendInfobipEmail,
}));

import { EmailDomainNotVerifiedError, resolveSender, STALE_SENDER_MESSAGE } from "./email-send.server";
import { runCampaignSend } from "./email.functions";
import { campaignSenderColumn, campaignShortDomainColumn } from "./campaign-refs.server";
import { legacyEmailBlockSenderConfig } from "./journeys.shared";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const DOM_VERIFIED = "10000000-0000-4000-8000-000000000001";
const DOM_VERIFIED_2 = "10000000-0000-4000-8000-000000000002";
const DOM_PENDING = "10000000-0000-4000-8000-000000000003";
const DOM_REMOVED = "10000000-0000-4000-8000-000000000004";
const DOM_OTHER = "10000000-0000-4000-8000-000000000005";
const DOM_SHORT = "10000000-0000-4000-8000-000000000006";
const S_DEFAULT = "20000000-0000-4000-8000-000000000001";
const S_PROMO = "20000000-0000-4000-8000-000000000002";
const S_PENDING = "20000000-0000-4000-8000-000000000003";
const S_REMOVED = "20000000-0000-4000-8000-000000000004";
const S_OTHER = "20000000-0000-4000-8000-000000000005";
const S_LEGACY = "20000000-0000-4000-8000-000000000006";

function domain(over: Record<string, unknown>) {
  return { tenant_id: TENANT, kind: "email", status: "verified", removed_at: null, ...over };
}
function sender(over: Record<string, unknown>) {
  return {
    tenant_id: TENANT,
    name: "Casa",
    from_name: "Casa",
    reply_to: null,
    is_default: false,
    ...over,
  };
}

function seedDomains() {
  fake.db
    .rows("tenant_domains")
    .push(
      domain({ id: DOM_VERIFIED, hostname: "mail.casa.bet" }),
      domain({ id: DOM_VERIFIED_2, hostname: "promo.casa.bet" }),
      domain({ id: DOM_PENDING, hostname: "novo.casa.bet", status: "pending" }),
      domain({ id: DOM_REMOVED, hostname: "velho.casa.bet", removed_at: "2026-10-20T00:00:00Z" }),
      domain({ id: DOM_OTHER, tenant_id: OTHER, hostname: "mail.outra.bet" }),
      domain({ id: DOM_SHORT, kind: "shortener", hostname: "go.casa.bet" }),
    );
}

function seedSenders(extra: Array<Record<string, unknown>> = []) {
  fake.db.rows("email_senders").push(
    sender({
      id: S_DEFAULT,
      from_email: "contato@mail.casa.bet",
      from_name: "Casa Bet",
      reply_to: "suporte@casa.bet",
      domain_id: DOM_VERIFIED,
      is_default: true,
    }),
    sender({ id: S_PROMO, from_email: "promo@promo.casa.bet", domain_id: DOM_VERIFIED_2 }),
    sender({ id: S_PENDING, from_email: "x@novo.casa.bet", domain_id: DOM_PENDING }),
    sender({ id: S_REMOVED, from_email: "x@velho.casa.bet", domain_id: DOM_REMOVED }),
    sender({
      id: S_OTHER,
      tenant_id: OTHER,
      from_email: "x@mail.outra.bet",
      domain_id: DOM_OTHER,
      is_default: true,
    }),
    ...extra,
  );
}

const DEFAULT_RESULT = {
  fromEmail: "contato@mail.casa.bet",
  fromName: "Casa Bet",
  replyTo: "suporte@casa.bet",
  senderId: S_DEFAULT,
};

beforeEach(() => {
  fake.db.reset();
  send.sendInfobipEmail.mockClear();
});

describe("resolveSender", () => {
  it("returns the requested sender when its domain is a verified domain of the house", async () => {
    seedDomains();
    seedSenders();
    await expect(resolveSender({ tenantId: TENANT, senderId: S_PROMO })).resolves.toEqual({
      fromEmail: "promo@promo.casa.bet",
      fromName: "Casa",
      replyTo: null,
      senderId: S_PROMO,
    });
  });

  it.each([
    ["another house's sender", S_OTHER],
    ["a sender on a pending domain", S_PENDING],
    ["a sender on a removed domain", S_REMOVED],
    ["an unknown sender", "20000000-0000-4000-8000-0000000000ff"],
  ])("blocks (null + warning) for an explicit %s, never switching sender", async (_label, requested) => {
    seedDomains();
    seedSenders();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(resolveSender({ tenantId: TENANT, senderId: requested })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("blocks an explicit legacy sender (no domain_id), even when it is the default", async () => {
    seedDomains();
    seedSenders([sender({ id: S_LEGACY, from_email: "legado@casa.bet", domain_id: null })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(resolveSender({ tenantId: TENANT, senderId: S_LEGACY })).resolves.toBeNull();
    warn.mockRestore();
  });

  it("uses the verified default when no sender is requested", async () => {
    seedDomains();
    seedSenders();
    await expect(resolveSender({ tenantId: TENANT })).resolves.toEqual(DEFAULT_RESULT);
    await expect(resolveSender({ tenantId: TENANT, senderId: null })).resolves.toEqual(DEFAULT_RESULT);
  });

  it("falls back to the oldest verified sender when there is no default and none is requested", async () => {
    seedDomains();
    fake.db.rows("email_senders").push(
      sender({ id: S_PROMO, from_email: "promo@promo.casa.bet", domain_id: DOM_VERIFIED_2, created_at: "2026-01-02T00:00:00Z" }),
      sender({ id: S_DEFAULT, from_email: "contato@mail.casa.bet", domain_id: DOM_VERIFIED, created_at: "2026-01-01T00:00:00Z" }),
    );
    await expect(resolveSender({ tenantId: TENANT })).resolves.toMatchObject({ senderId: S_DEFAULT });
  });

  it("returns null when the house has no sender on a verified domain", async () => {
    seedDomains();
    fake.db.rows("email_senders").push(
      sender({
        id: S_PENDING,
        from_email: "x@novo.casa.bet",
        domain_id: DOM_PENDING,
        is_default: true,
      }),
      sender({ id: S_REMOVED, from_email: "x@velho.casa.bet", domain_id: DOM_REMOVED }),
    );
    await expect(resolveSender({ tenantId: TENANT, senderId: S_PENDING })).resolves.toBeNull();
  });

  it("ignores a legacy sender without domain_id, even when it is the default", async () => {
    seedDomains();
    fake.db.rows("email_senders").push(
      sender({
        id: S_LEGACY,
        from_email: "legacy@casa.bet",
        domain: "casa.bet",
        domain_id: null,
        is_default: true,
      }),
    );
    await expect(resolveSender({ tenantId: TENANT, senderId: S_LEGACY })).resolves.toBeNull();
    await expect(resolveSender({ tenantId: TENANT })).resolves.toBeNull();
  });

  it("ignores a sender pointing at a shortener domain", async () => {
    seedDomains();
    fake.db.rows("email_senders").push(
      sender({
        id: S_LEGACY,
        from_email: "x@go.casa.bet",
        domain_id: DOM_SHORT,
        is_default: true,
      }),
    );
    await expect(resolveSender({ tenantId: TENANT })).resolves.toBeNull();
  });

  it("never reads email_smtp_configs, even when the house has a default SMTP config", async () => {
    seedDomains();
    fake.db.rows("email_smtp_configs").push({
      id: "smtp-1",
      tenant_id: TENANT,
      from_email: "smtp@casa.bet",
      from_name: "SMTP",
      is_default: true,
      config: {},
    });
    await expect(resolveSender({ tenantId: TENANT, senderId: "smtp-1" })).resolves.toBeNull();
    expect(fake.db.calls.some((c) => c.table === "email_smtp_configs")).toBe(false);
  });
});

describe("EmailDomainNotVerifiedError", () => {
  it("carries the stable code and the pt-BR message", () => {
    const error = new EmailDomainNotVerifiedError();
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("EMAIL_DOMAIN_NOT_VERIFIED");
    expect(error.message).toBe(
      "Configure e verifique um domínio de e-mail da casa para enviar e-mails.",
    );
  });
});

function seedCampaign(over: Record<string, unknown> = {}) {
  fake.db.rows("email_templates").push({
    id: "tpl-1",
    tenant_id: TENANT,
    lifecycle_status: "published",
    subject: "Oi",
    body_html: "<p>oi</p>",
  });
  fake.db.rows("email_campaigns").push({
    id: "camp-1",
    tenant_id: TENANT,
    template_id: "tpl-1",
    template_snapshot: null,
    smtp_id: null,
    sender_id: null,
    short_domain_id: null,
    track_links: true,
    status: "rascunho",
    audience_filter: { audience_mode: "emails", extra_emails: ["jogador@x.com"] },
    ...over,
  });
}

describe("runCampaignSend sender", () => {
  it("blocks with EMAIL_DOMAIN_NOT_VERIFIED: nothing sent, nothing logged, campaign untouched", async () => {
    seedDomains();
    fake.db.rows("email_senders").push(
      sender({
        id: S_PENDING,
        from_email: "x@novo.casa.bet",
        domain_id: DOM_PENDING,
        is_default: true,
      }),
    );
    fake.db.rows("email_smtp_configs").push({
      id: "smtp-1",
      tenant_id: TENANT,
      from_email: "smtp@casa.bet",
      is_default: true,
      config: {},
    });
    seedCampaign({ sender_id: S_PENDING, smtp_id: "smtp-1" });

    const error = await runCampaignSend("camp-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailDomainNotVerifiedError);
    expect((error as EmailDomainNotVerifiedError).code).toBe("EMAIL_DOMAIN_NOT_VERIFIED");
    expect(send.sendInfobipEmail).not.toHaveBeenCalled();
    expect(fake.db.rows("email_send_logs")).toHaveLength(0);
    expect(fake.db.rows("email_campaigns")[0].status).toBe("rascunho");
    expect(fake.db.calls.some((c) => c.table === "email_smtp_configs")).toBe(false);
  });

  it("an explicit sender whose domain lost verification blocks the campaign and records the reason", async () => {
    seedDomains();
    seedSenders();
    seedCampaign({ sender_id: S_PENDING });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const error = await runCampaignSend("camp-1").catch((e: unknown) => e);
    warn.mockRestore();
    expect(error).toBeInstanceOf(EmailDomainNotVerifiedError);
    expect((error as Error).message).toBe(STALE_SENDER_MESSAGE);
    // The house still has a verified default, but it is NOT used.
    expect(send.sendInfobipEmail).not.toHaveBeenCalled();
    expect(fake.db.rows("email_campaigns")[0].blocked_reason).toBe(STALE_SENDER_MESSAGE);
  });

  it("a campaign without a sender and no verified domain records the generic reason", async () => {
    seedDomains();
    seedCampaign({ sender_id: null });

    await expect(runCampaignSend("camp-1")).rejects.toBeInstanceOf(EmailDomainNotVerifiedError);
    expect(fake.db.rows("email_campaigns")[0].blocked_reason).toBe(
      "Configure e verifique um domínio de e-mail da casa para enviar e-mails.",
    );
  });

  it("clears a previous blocked_reason once the sender qualifies again", async () => {
    seedDomains();
    seedSenders();
    seedCampaign({ sender_id: S_PROMO, blocked_reason: "antigo" });

    await runCampaignSend("camp-1");
    expect(fake.db.rows("email_campaigns")[0].blocked_reason).toBeNull();
  });

  it("sends from the campaign's verified sender and passes its short domain to link tracking", async () => {
    seedDomains();
    seedSenders();
    seedCampaign({ sender_id: S_PROMO, short_domain_id: DOM_SHORT });

    await runCampaignSend("camp-1");
    expect(send.sendInfobipEmail).toHaveBeenCalledTimes(1);
    const input = send.sendInfobipEmail.mock.calls[0][0] as { from: string; linkTracking: unknown };
    expect(input.from).toBe("promo@promo.casa.bet");
    expect(input.linkTracking).toMatchObject({ tenantId: TENANT, shortDomainId: DOM_SHORT });
  });
});

describe("campaign reference columns", () => {
  it("campaignSenderColumn keeps a sender of the house and rejects another house's", async () => {
    seedDomains();
    seedSenders();
    await expect(campaignSenderColumn(TENANT, S_PENDING)).resolves.toEqual({
      sender_id: S_PENDING,
    });
    await expect(campaignSenderColumn(TENANT, null)).resolves.toEqual({ sender_id: null });
    await expect(campaignSenderColumn(TENANT, undefined)).resolves.toEqual({});
    await expect(campaignSenderColumn(TENANT, S_OTHER)).rejects.toThrow(
      "Selecione um remetente de e-mail desta conta.",
    );
  });

  it("campaignShortDomainColumn accepts a non-removed shortener of the house only", async () => {
    seedDomains();
    await expect(campaignShortDomainColumn(TENANT, DOM_SHORT)).resolves.toEqual({
      short_domain_id: DOM_SHORT,
    });
    await expect(campaignShortDomainColumn(TENANT, null)).resolves.toEqual({});
    await expect(campaignShortDomainColumn(TENANT, DOM_VERIFIED)).rejects.toThrow(
      "Domínio do encurtador indisponível para esta conta",
    );
  });
});

describe("legacy e-mail flow conversion", () => {
  it("maps the block's sender_id and never the SMTP config id", () => {
    // Rows as read from email_flow_blocks (select "*").
    const withSender = { sender_id: S_PROMO, smtp_config_id: "smtp-1" };
    const smtpOnly = { sender_id: null, smtp_config_id: "smtp-1" };
    expect(legacyEmailBlockSenderConfig(withSender)).toEqual({ sender_id: S_PROMO });
    expect(legacyEmailBlockSenderConfig(smtpOnly)).toEqual({});
  });
});
