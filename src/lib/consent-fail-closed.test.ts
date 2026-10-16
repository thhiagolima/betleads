// F0-13 (QA-03, QA-16) — consent and contact checks are fail-closed: when the
// database cannot answer, nothing is sent and the item is deferred/retried.

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  fail: false,
  rpcResult: { data: [] as unknown, error: null as { message: string } | null },
  queries: [] as Array<{ table: string; filters: string[] }>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: string[] = [];
    state.queries.push({ table, filters });
    const result = () =>
      state.fail ? { data: null, error: { message: "connection timeout" } } : { data: null, error: null };
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => (filters.push(`${c}=${String(v)}`), b),
      or: (e: string) => (filters.push(`or:${e}`), b),
      limit: async () =>
        state.fail ? result() : { data: [], error: null },
      maybeSingle: async () => result(),
    };
    return b;
  }
  return {
    supabaseAdmin: {
      from,
      rpc: vi.fn(async () => state.rpcResult),
    },
  };
});

import { channelEligibility, isSmsSuppressed } from "./channel-eligibility.server";
import { checkContactFrequencyLimit } from "./contact-frequency.server";
import { __resetSuppressionCacheForTests, isSuppressed } from "./email-deliverability.server";

const TENANT = "00000000-0000-4000-8000-000000000001";
const PLAYER = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
  state.fail = false;
  state.rpcResult = { data: [], error: null };
  state.queries.length = 0;
  __resetSuppressionCacheForTests();
});

describe("isSuppressed (e-mail)", () => {
  it("throws when the lookup fails instead of allowing the send", async () => {
    state.fail = true;
    await expect(isSuppressed("a@example.com", TENANT)).rejects.toThrow(/supressao de e-mail/);
  });

  it("does not cache a failed lookup as 'not suppressed'", async () => {
    state.fail = true;
    await expect(isSuppressed("a@example.com", TENANT)).rejects.toThrow();
    state.fail = false;
    await expect(isSuppressed("a@example.com", TENANT)).resolves.toBe(false);
    expect(state.queries.filter((q) => q.table === "suppressed_emails")).toHaveLength(2);
  });

  it("compares the normalized e-mail exactly, scoped to the tenant or global", async () => {
    await isSuppressed("  A_B@Example.com ", TENANT);
    expect(state.queries[0]).toEqual({
      table: "suppressed_emails",
      filters: ["email=a_b@example.com", `or:tenant_id.eq.${TENANT},tenant_id.is.null`],
    });
  });
});

describe("isSmsSuppressed (QA-04, QA-03)", () => {
  it("queries the digits-only form stored by sms_suppressions", async () => {
    await isSmsSuppressed(TENANT, "+5521980194445");
    await isSmsSuppressed(TENANT, "(21) 98019-4445");
    expect(state.queries.map((q) => q.filters)).toEqual([
      [`tenant_id=${TENANT}`, "phone=5521980194445"],
      [`tenant_id=${TENANT}`, "phone=5521980194445"],
    ]);
  });

  it("throws on a lookup error so the channel is not considered eligible", async () => {
    state.fail = true;
    await expect(isSmsSuppressed(TENANT, "+5521980194445")).rejects.toThrow(/supressao de SMS/);
    await expect(
      channelEligibility("sms", { telefone: "21980194445", email: null }, TENANT),
    ).rejects.toThrow();
  });
});

describe("checkContactFrequencyLimit (QA-16)", () => {
  it("defers when the RPC returns no row", async () => {
    state.rpcResult = { data: [], error: null };
    const r = await checkContactFrequencyLimit(TENANT, PLAYER);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("contact_limit_unverified");
    expect(Date.parse(String(r.retryAt))).toBeGreaterThan(Date.now());
  });

  it("defers (does not throw, does not allow) when the RPC fails", async () => {
    state.rpcResult = { data: null, error: { message: "timeout" } };
    const r = await checkContactFrequencyLimit(TENANT, PLAYER);
    expect(r).toMatchObject({ allowed: false, reason: "contact_limit_unverified" });
    expect(r.retryAt).not.toBeNull();
  });

  it("passes through the RPC decision", async () => {
    state.rpcResult = { data: [{ allowed: true, retry_at: null, blocked_reason: null }], error: null };
    await expect(checkContactFrequencyLimit(TENANT, PLAYER)).resolves.toEqual({
      allowed: true,
      retryAt: null,
      reason: null,
    });
    state.rpcResult = {
      data: [{ allowed: false, retry_at: "2026-10-17T10:00:00Z", blocked_reason: "global_limit_24h" }],
      error: null,
    };
    await expect(checkContactFrequencyLimit(TENANT, PLAYER)).resolves.toEqual({
      allowed: false,
      retryAt: "2026-10-17T10:00:00Z",
      reason: "global_limit_24h",
    });
  });
});
