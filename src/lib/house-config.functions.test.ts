// house-config.functions (Task 5): unit tests for the pure, exported helpers
// only. The createServerFn handlers themselves wrap Supabase and are covered
// by integration/manual verification, not unit tests here.
import { describe, expect, it } from "vitest";
import {
  computeShortenerPending,
  computeShowWizard,
  ensureActiveDomainOwnership,
  ensureDomainOwnership,
  ensureSenderOwnership,
  formatSenderLabel,
  isDnsSendRateLimited,
  isDomainVerified,
  projectHouseConfigSenders,
  recordDnsSend,
  selectComposerSenders,
  selectNewlyVerifiedDomains,
  selectRemovedDomainsForSuperAdmin,
} from "./house-config.functions";
import type { TenantDomain } from "./tenant-domains.server";

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

describe("ensureActiveDomainOwnership", () => {
  it("passes silently when the row belongs to the tenant and isn't removed", () => {
    expect(() =>
      ensureActiveDomainOwnership({ tenant_id: "t1", removed_at: null }, "t1"),
    ).not.toThrow();
  });

  it("throws when the row is null", () => {
    expect(() => ensureActiveDomainOwnership(null, "t1")).toThrow("Domínio não encontrado");
  });

  it("throws when the row belongs to a different tenant", () => {
    expect(() =>
      ensureActiveDomainOwnership({ tenant_id: "other", removed_at: null }, "t1"),
    ).toThrow("Domínio não encontrado");
  });

  it("throws when the row has been removed, even if it belongs to the tenant", () => {
    expect(() =>
      ensureActiveDomainOwnership({ tenant_id: "t1", removed_at: "2026-01-01T00:00:00Z" }, "t1"),
    ).toThrow("Domínio não encontrado");
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

describe("isDomainVerified", () => {
  it("is true for a verified, non-removed domain", () => {
    expect(isDomainVerified({ status: "verified", removed_at: null })).toBe(true);
  });

  it("is false when the domain row is missing", () => {
    expect(isDomainVerified(undefined)).toBe(false);
    expect(isDomainVerified(null)).toBe(false);
  });

  it("is false for a pending domain", () => {
    expect(isDomainVerified({ status: "pending", removed_at: null })).toBe(false);
  });

  it("is false for a verified domain that was later removed", () => {
    expect(isDomainVerified({ status: "verified", removed_at: "2026-01-01T00:00:00Z" })).toBe(
      false,
    );
  });
});

describe("projectHouseConfigSenders", () => {
  const sender = (overrides: Partial<Parameters<typeof projectHouseConfigSenders>[0][number]> = {}) => ({
    id: "s1",
    from_name: "Casa X",
    from_email: "contato@x.com",
    reply_to: null,
    domain_id: "d1",
    is_default: true,
    ...overrides,
  });

  it("flags domainVerified true for a sender on a verified, active domain", () => {
    const domainById = new Map([["d1", { status: "verified" as const, removed_at: null }]]);
    expect(projectHouseConfigSenders([sender()], domainById)).toEqual([
      {
        id: "s1",
        fromName: "Casa X",
        fromEmail: "contato@x.com",
        replyTo: null,
        domainId: "d1",
        isDefault: true,
        domainVerified: true,
      },
    ]);
  });

  it("flags domainVerified false when the sender's domain has been removed", () => {
    const domainById = new Map([
      ["d1", { status: "verified" as const, removed_at: "2026-01-01T00:00:00Z" }],
    ]);
    expect(projectHouseConfigSenders([sender()], domainById)[0].domainVerified).toBe(false);
  });

  it("flags domainVerified false when the sender has no domain at all", () => {
    const result = projectHouseConfigSenders([sender({ domain_id: null })], new Map());
    expect(result[0].domainVerified).toBe(false);
  });
});

describe("selectComposerSenders", () => {
  const sender = (overrides: Partial<Parameters<typeof selectComposerSenders>[0][number]> = {}) => ({
    id: "s1",
    from_name: "Casa X",
    from_email: "contato@x.com",
    reply_to: null,
    domain_id: "d1",
    is_default: true,
    ...overrides,
  });

  it("includes a sender whose domain is verified and active", () => {
    const domainById = new Map([["d1", { status: "verified" as const, removed_at: null }]]);
    expect(selectComposerSenders([sender()], domainById)).toEqual([
      { id: "s1", label: "Casa X <contato@x.com>", isDefault: true },
    ]);
  });

  it("excludes a sender whose domain was removed, even if status still reads verified", () => {
    const domainById = new Map([
      ["d1", { status: "verified" as const, removed_at: "2026-01-01T00:00:00Z" }],
    ]);
    expect(selectComposerSenders([sender()], domainById)).toEqual([]);
  });

  it("excludes a sender with no domain", () => {
    expect(selectComposerSenders([sender({ domain_id: null })], new Map())).toEqual([]);
  });

  it("excludes a sender whose domain is only pending", () => {
    const domainById = new Map([["d1", { status: "pending" as const, removed_at: null }]]);
    expect(selectComposerSenders([sender()], domainById)).toEqual([]);
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

describe("isDnsSendRateLimited / recordDnsSend", () => {
  it("allows up to 5 sends per domain within the rolling hour", () => {
    const log = new Map<string, number[]>();
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 5; i++) {
      expect(isDnsSendRateLimited(log, "d1", base + i * 1000)).toBe(false);
      recordDnsSend(log, "d1", base + i * 1000);
    }
    expect(isDnsSendRateLimited(log, "d1", base + 6000)).toBe(true);
  });

  it("tracks each domain independently", () => {
    const log = new Map<string, number[]>();
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 5; i++) {
      recordDnsSend(log, "d1", base + i * 1000);
    }
    expect(isDnsSendRateLimited(log, "d2", base)).toBe(false);
  });

  it("allows a send again once the oldest entry rolls out of the one-hour window", () => {
    const log = new Map<string, number[]>();
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 5; i++) {
      recordDnsSend(log, "d1", base + i * 1000);
    }
    expect(isDnsSendRateLimited(log, "d1", base + 3600_000 + 1)).toBe(false);
  });

  it("does not record a send on its own — checking the limit never consumes budget", () => {
    const log = new Map<string, number[]>();
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 10; i++) {
      expect(isDnsSendRateLimited(log, "d1", base)).toBe(false);
    }
    expect(log.get("d1") ?? []).toEqual([]);
  });
});

describe("selectRemovedDomainsForSuperAdmin", () => {
  function makeDomain(overrides: Partial<TenantDomain> = {}): TenantDomain {
    return {
      id: "d1",
      tenant_id: "t1",
      kind: "shortener",
      hostname: "go.suacasa.bet.br",
      status: "verified",
      is_default: false,
      dns_records: [],
      provider_domain_id: null,
      last_checked_at: null,
      verified_at: null,
      last_error: null,
      removed_at: null,
      created_at: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }

  it("returns an empty array for a non-super-admin, even when removed domains exist", () => {
    const domains = [makeDomain({ id: "a", removed_at: "2026-02-01T00:00:00Z" }), makeDomain({ id: "b" })];
    expect(selectRemovedDomainsForSuperAdmin(domains, false)).toEqual([]);
  });

  it("returns only the removed domains for a super admin", () => {
    const removed = makeDomain({ id: "a", removed_at: "2026-02-01T00:00:00Z" });
    const active = makeDomain({ id: "b" });
    expect(selectRemovedDomainsForSuperAdmin([removed, active], true)).toEqual([removed]);
  });

  it("returns an empty array for a super admin when nothing is removed", () => {
    expect(selectRemovedDomainsForSuperAdmin([makeDomain({ id: "a" })], true)).toEqual([]);
  });
});
