import { beforeEach, describe, expect, it, vi } from "vitest";

// Breaker state per key, driven by the tests. The real breaker RPCs have their
// own coverage (sms-provider-breaker.db.test.ts).
const breakers = vi.hoisted(() => ({
  state: new Map<string, "closed" | "open" | "half_open">(),
  probeHolder: new Map<string, string>(),
  released: [] as string[],
}));

const snapshot = (key: string) => {
  const state = breakers.state.get(key) ?? "closed";
  return state === "closed"
    ? { state, reason: null, lastError: null, since: null, retryAt: null }
    : {
        state,
        reason: "no_balance",
        lastError: "505",
        since: "2026-10-29T12:00:00.000Z",
        retryAt: "2099-01-01T00:00:00.000Z",
      };
};

vi.mock("./sms-provider-breaker.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sms-provider-breaker.server")>();
  return {
    ...actual,
    acquireSmsSendGate: vi.fn(async (holder: string, key: string) => {
      const state = breakers.state.get(key) ?? "closed";
      if (state === "closed") return { mode: "closed" as const };
      const holderNow = breakers.probeHolder.get(key);
      if (state === "half_open" && (!holderNow || holderNow === holder)) {
        breakers.probeHolder.set(key, holder);
        return { mode: "probe" as const, holder, snapshot: snapshot(key) };
      }
      return { mode: "open" as const, snapshot: snapshot(key) };
    }),
    readSmsBreaker: vi.fn(async ({ key }: { key: string }) => snapshot(key)),
    cachedSmsBreaker: vi.fn((key: string) => snapshot(key)),
    releaseSmsProbe: vi.fn(async (_holder: string, key: string) => {
      breakers.released.push(key);
    }),
  };
});

const OWN = "11111111-1111-4111-8111-111111111111";
const ON_PLATFORM = "00000000-0000-4000-8000-0000000000a1";
const ON_OWN = "00000000-0000-4000-8000-0000000000b2";
const UNAVAILABLE = "00000000-0000-4000-8000-0000000000c3";

vi.mock("./provider-accounts.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-accounts.server")>();
  return {
    ...actual,
    resolveSmsAccount: vi.fn(async (tenantId: string | null) => {
      if (tenantId === UNAVAILABLE) {
        throw new actual.ProviderAccountUnavailableError("conta desativada");
      }
      return tenantId === ON_OWN
        ? { ...actual.envShortBrasilAccount(), id: OWN }
        : actual.envShortBrasilAccount();
    }),
  };
});

import { SmsAccountGates } from "./sms-account-gates.server";

const OWN_KEY = `sms:${OWN}`;

beforeEach(() => {
  breakers.state.clear();
  breakers.probeHolder.clear();
  breakers.released = [];
});

describe("SmsAccountGates", () => {
  it("an account that is down holds only the houses on it", async () => {
    breakers.state.set("sms", "open");
    const gates = new SmsAccountGates("run-1");

    expect(await gates.admit(ON_PLATFORM, "a")).toMatchObject({
      mode: "open",
      key: "sms",
      probeInFlight: false,
    });
    expect(await gates.admit(ON_OWN, "b")).toEqual({ mode: "closed", key: OWN_KEY });
    expect(await gates.blockedTenants([ON_PLATFORM, ON_OWN])).toEqual([ON_PLATFORM]);
  });

  it("the house's own account down never stops the platform houses", async () => {
    breakers.state.set(OWN_KEY, "open");
    const gates = new SmsAccountGates("run-1");

    expect(await gates.admit(ON_OWN, "a")).toMatchObject({
      mode: "open",
      key: OWN_KEY,
      message: expect.stringContaining("Envio de SMS suspenso"),
    });
    expect((await gates.admit(ON_PLATFORM, "b")).mode).toBe("closed");
  });

  it("half-open: one probe item per account; the others wait for its verdict", async () => {
    breakers.state.set(OWN_KEY, "half_open");
    const gates = new SmsAccountGates("run-1");

    expect((await gates.admit(ON_OWN, "probe")).mode).toBe("probe");
    expect(await gates.admit(ON_OWN, "second")).toMatchObject({ mode: "open", probeInFlight: true });
    expect(gates.blockedKeys()).toEqual(new Set([OWN_KEY]));

    // The probe was accepted: the breaker closed.
    breakers.state.set(OWN_KEY, "closed");
    await gates.settle("probe");
    expect((await gates.admit(ON_OWN, "third")).mode).toBe("closed");
    expect(gates.blockedKeys().size).toBe(0);
  });

  it("a refused probe reopens the account for the rest of the run", async () => {
    breakers.state.set(OWN_KEY, "half_open");
    const gates = new SmsAccountGates("run-1");
    expect((await gates.admit(ON_OWN, "probe")).mode).toBe("probe");

    breakers.state.set(OWN_KEY, "open");
    await gates.markOpen(ON_OWN, "probe"); // ignored: settle reads the verdict
    await gates.settle("probe");
    expect((await gates.admit(ON_OWN, "next")).mode).toBe("open");
  });

  it("a regular send refused by the account stops only that account", async () => {
    const gates = new SmsAccountGates("run-1");
    expect((await gates.admit(ON_OWN, "a")).mode).toBe("closed");

    breakers.state.set(OWN_KEY, "open");
    await gates.markOpen(ON_OWN, "a");
    expect((await gates.admit(ON_OWN, "b")).mode).toBe("open");
    expect((await gates.admit(ON_PLATFORM, "c")).mode).toBe("closed");
    expect(await gates.retryAt(ON_OWN, 60_000)).toBe("2099-01-01T00:00:00.000Z");
  });

  it("a breaker opened by a send of this process is seen before the next refresh", async () => {
    const gates = new SmsAccountGates("run-1");
    expect((await gates.admit(ON_PLATFORM, "a")).mode).toBe("closed");
    breakers.state.set("sms", "open"); // reportSmsProviderAccountFailure updated the cache
    expect((await gates.admit(ON_PLATFORM, "b")).mode).toBe("open");
  });

  it("a house whose own account is unavailable is not gated (the send fails as misconfigured)", async () => {
    breakers.state.set("sms", "open");
    const gates = new SmsAccountGates("run-1");
    expect(await gates.admit(UNAVAILABLE, "a")).toEqual({ mode: "closed", key: null });
    expect(await gates.blockedTenants([UNAVAILABLE])).toEqual([]);
  });

  it("release hands back only the probes this run took", async () => {
    breakers.state.set(OWN_KEY, "half_open");
    breakers.state.set("sms", "open");
    const gates = new SmsAccountGates("run-1");
    await gates.admit(ON_OWN, "probe");
    await gates.admit(ON_PLATFORM, "x");
    await gates.release();
    expect(breakers.released).toEqual([OWN_KEY]);
  });
});
