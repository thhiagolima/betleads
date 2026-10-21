// house-config.functions (Task 5): unit tests for the pure, exported helpers
// only. The createServerFn handlers themselves wrap Supabase and are covered
// by integration/manual verification, not unit tests here.
import { describe, expect, it } from "vitest";
import {
  computeShortenerPending,
  computeShowWizard,
  ensureDomainOwnership,
  ensureSenderOwnership,
  formatSenderLabel,
  recordAndCheckDnsSendRateLimit,
  selectNewlyVerifiedDomains,
} from "./house-config.functions";

describe("ensureDomainOwnership", () => {
  it("passes silently when the row belongs to the tenant", () => {
    expect(() => ensureDomainOwnership({ tenant_id: "t1" }, "t1")).not.toThrow();
  });

  it("throws when the row is null", () => {
    expect(() => ensureDomainOwnership(null, "t1")).toThrow("Domínio não encontrado");
  });

  it("throws when the row belongs to a different tenant", () => {
    expect(() => ensureDomainOwnership({ tenant_id: "other" }, "t1")).toThrow(
      "Domínio não encontrado",
    );
  });
});

describe("ensureSenderOwnership", () => {
  it("passes silently when the row belongs to the tenant", () => {
    expect(() => ensureSenderOwnership({ tenant_id: "t1" }, "t1")).not.toThrow();
  });

  it("throws when the row is missing or belongs to another tenant", () => {
    expect(() => ensureSenderOwnership(null, "t1")).toThrow("Remetente não encontrado");
    expect(() => ensureSenderOwnership({ tenant_id: "other" }, "t1")).toThrow(
      "Remetente não encontrado",
    );
  });
});

describe("formatSenderLabel", () => {
  it("formats as '<fromName> <<fromEmail>>'", () => {
    expect(formatSenderLabel("Casa X", "contato@x.com")).toBe("Casa X <contato@x.com>");
  });
});

describe("computeShortenerPending", () => {
  it("is false with no shortener domains at all", () => {
    expect(computeShortenerPending([])).toBe(false);
  });

  it("is true when pending/failed exists and none verified", () => {
    expect(computeShortenerPending(["pending"])).toBe(true);
    expect(computeShortenerPending(["failed"])).toBe(true);
  });

  it("is false once a verified domain exists, regardless of others", () => {
    expect(computeShortenerPending(["verified"])).toBe(false);
    expect(computeShortenerPending(["pending", "verified"])).toBe(false);
  });
});

describe("selectNewlyVerifiedDomains", () => {
  it("selects only verified domains with verified_at set and no notice seen", () => {
    const rows = [
      {
        id: "1",
        hostname: "go.x.com",
        kind: "shortener" as const,
        status: "verified" as const,
        verified_at: "2026-01-01T00:00:00Z",
        verified_notice_seen_at: null,
      },
      {
        id: "2",
        hostname: "mail.x.com",
        kind: "email" as const,
        status: "verified" as const,
        verified_at: "2026-01-01T00:00:00Z",
        verified_notice_seen_at: "2026-01-02T00:00:00Z",
      },
      {
        id: "3",
        hostname: "pending.x.com",
        kind: "shortener" as const,
        status: "pending" as const,
        verified_at: null,
        verified_notice_seen_at: null,
      },
    ];
    expect(selectNewlyVerifiedDomains(rows)).toEqual([
      { id: "1", hostname: "go.x.com", kind: "shortener" },
    ]);
  });
});

describe("computeShowWizard", () => {
  it("is true only for a non-super-admin tenant admin with no onboarding decision yet", () => {
    expect(
      computeShowWizard({
        isAdmin: true,
        isSuperAdmin: false,
        onboardingCompletedAt: null,
        onboardingSkippedAt: null,
      }),
    ).toBe(true);
  });

  it("is false for a super admin even if they are also a tenant admin", () => {
    expect(
      computeShowWizard({
        isAdmin: true,
        isSuperAdmin: true,
        onboardingCompletedAt: null,
        onboardingSkippedAt: null,
      }),
    ).toBe(false);
  });

  it("is false for a non-admin", () => {
    expect(
      computeShowWizard({
        isAdmin: false,
        isSuperAdmin: false,
        onboardingCompletedAt: null,
        onboardingSkippedAt: null,
      }),
    ).toBe(false);
  });

  it("is false once onboarding was completed or skipped", () => {
    expect(
      computeShowWizard({
        isAdmin: true,
        isSuperAdmin: false,
        onboardingCompletedAt: "2026-01-01T00:00:00Z",
        onboardingSkippedAt: null,
      }),
    ).toBe(false);
    expect(
      computeShowWizard({
        isAdmin: true,
        isSuperAdmin: false,
        onboardingCompletedAt: null,
        onboardingSkippedAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe(false);
  });
});

describe("recordAndCheckDnsSendRateLimit", () => {
  it("allows up to 5 sends per domain within the rolling hour", () => {
    const log = new Map<string, number[]>();
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 5; i++) {
      expect(recordAndCheckDnsSendRateLimit(log, "d1", base + i * 1000)).toBe(true);
    }
    expect(recordAndCheckDnsSendRateLimit(log, "d1", base + 6000)).toBe(false);
  });

  it("tracks each domain independently", () => {
    const log = new Map<string, number[]>();
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 5; i++) {
      recordAndCheckDnsSendRateLimit(log, "d1", base + i * 1000);
    }
    expect(recordAndCheckDnsSendRateLimit(log, "d2", base)).toBe(true);
  });

  it("allows a send again once the oldest entry rolls out of the one-hour window", () => {
    const log = new Map<string, number[]>();
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 5; i++) {
      recordAndCheckDnsSendRateLimit(log, "d1", base + i * 1000);
    }
    expect(recordAndCheckDnsSendRateLimit(log, "d1", base + 3600_000 + 1)).toBe(true);
  });
});
