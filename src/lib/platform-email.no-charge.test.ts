// PG3 Task 6 — the platform's own e-mails (billing notices, DNS
// instructions) are never charged to a house's wallet (spec non-goal).
// Both `sendPlatformEmail`s call the provider adapter directly, never
// `sendInfobipEmail` (which reserves) nor the wallet.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(async () => ({ data: null, error: null })),
  provider: vi.fn(async () => ({
    ok: true,
    status: 200,
    body: {},
    idempotencyKey: "k",
    temporary: false,
  })),
  reserveForDelivery: vi.fn(),
  reserveUsage: vi.fn(),
  sendInfobipEmail: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: mocks.rpc,
    from: () => {
      throw new Error("platform e-mail must not touch the database");
    },
  },
}));
vi.mock("@/lib/infobip-email.server", () => ({ callInfobipEmail: mocks.provider }));
vi.mock("./infobip-email.server", () => ({ callInfobipEmail: mocks.provider }));
vi.mock("./billing/wallet.server", () => ({
  reserveForDelivery: mocks.reserveForDelivery,
  reserveUsage: mocks.reserveUsage,
  refundForDelivery: vi.fn(),
  refundUsage: vi.fn(),
}));
vi.mock("./email-send.server", () => ({ sendInfobipEmail: mocks.sendInfobipEmail }));

import { sendPlatformEmail as sendDnsPlatformEmail } from "./platform-email.server";
import { sendPlatformEmail as sendBillingPlatformEmail } from "./billing/billing-emails.server";

beforeEach(() => {
  vi.clearAllMocks();
});

function expectNoCharge() {
  expect(mocks.provider).toHaveBeenCalledTimes(1);
  expect(mocks.sendInfobipEmail).not.toHaveBeenCalled();
  expect(mocks.reserveForDelivery).not.toHaveBeenCalled();
  expect(mocks.reserveUsage).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
}

describe("platform e-mails are never charged", () => {
  it("DNS instructions (platform-email.server)", async () => {
    await sendDnsPlatformEmail({ to: "admin@casa.bet", subject: "DNS", html: "<p>x</p>" });
    expectNoCharge();
  });

  it("billing notices (billing-emails.server)", async () => {
    const result = await sendBillingPlatformEmail({
      to: "admin@casa.bet",
      subject: "Fatura",
      html: "<p>x</p>",
      idempotencyKey: "invoice-1:issued",
    });
    expect(result.ok).toBe(true);
    expectNoCharge();
  });

  it("neither module imports the wallet or the charged send path", () => {
    for (const file of ["src/lib/platform-email.server.ts", "src/lib/billing/billing-emails.server.ts"]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/from\s+["'][^"']*wallet\.server["']/);
      expect(source, file).not.toMatch(/from\s+["'][^"']*email-send\.server["']/);
    }
  });
});
