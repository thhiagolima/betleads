// F0-13 (QA-03) — sendInfobipEmail is fail-closed on the consent check: if the
// consent or the suppression lookup errors, the provider is never called and
// the result is temporary (not_sent), so every caller re-queues the item.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consent: vi.fn(async (): Promise<string | null> => null),
  suppressed: vi.fn(async () => false),
  provider: vi.fn(async () => ({
    ok: true,
    status: 200,
    body: {},
    idempotencyKey: "k",
    temporary: false,
  })),
}));

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
// The demo send guard has its own coverage (demo-send-guard.channels.test.ts).
vi.mock("./tenant-access.server", () => ({
  assertTenantNotDemoForSend: vi.fn(async () => undefined),
}));
vi.mock("./consent.server", () => ({ getChannelConsentStatus: mocks.consent }));
vi.mock("./email-deliverability.server", () => ({
  augmentEmailHtml: vi.fn(async (html: string) => ({ html, unsubscribeUrl: null })),
  isSuppressed: mocks.suppressed,
}));
vi.mock("./infobip-email.server", () => ({ callInfobipEmail: mocks.provider }));
vi.mock("./shortio.server", () => ({
  prepareTrackedEmailHtml: vi.fn(async (content: string) => ({ content, links: [] })),
  markTrackedDispatchesSent: vi.fn(async () => undefined),
  markTrackedDispatchesFailed: vi.fn(async () => undefined),
}));

import { sendInfobipEmail } from "./email-send.server";

const input = {
  to: "jogador@example.test",
  from: "casa@example.test",
  subject: "Oi",
  html: "<p>Oi</p>",
  tenantId: "00000000-0000-4000-8000-000000000001",
};

beforeEach(() => {
  mocks.consent.mockReset().mockResolvedValue(null);
  mocks.suppressed.mockReset().mockResolvedValue(false);
  mocks.provider.mockClear();
});

describe("sendInfobipEmail consent check (fail-closed)", () => {
  it("does not send and returns a temporary not_sent result when the consent lookup fails", async () => {
    mocks.consent.mockRejectedValue(new Error("Falha ao validar consentimento: timeout"));
    const r = await sendInfobipEmail(input);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, temporary: true, errorKind: "not_sent" });
    expect(JSON.stringify(r.body)).toContain("consent_check_failed");
  });

  it("does not send when the suppression lookup fails", async () => {
    mocks.suppressed.mockRejectedValue(new Error("Falha ao consultar lista de supressao"));
    const r = await sendInfobipEmail(input);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, temporary: true, errorKind: "not_sent" });
  });

  it("still blocks permanently on revoked consent and on suppression", async () => {
    mocks.consent.mockResolvedValue("revoked");
    await expect(sendInfobipEmail(input)).resolves.toMatchObject({
      ok: false,
      temporary: false,
      body: { suppressed: true, reason: "consent_revoked" },
    });
    mocks.consent.mockResolvedValue(null);
    mocks.suppressed.mockResolvedValue(true);
    await expect(sendInfobipEmail(input)).resolves.toMatchObject({
      ok: false,
      temporary: false,
      body: { suppressed: true, reason: "recipient_in_suppression_list" },
    });
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it("sends when consent and suppression checks pass", async () => {
    const r = await sendInfobipEmail(input);
    expect(mocks.provider).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });
});
