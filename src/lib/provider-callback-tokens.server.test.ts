import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./sms-bulk.test-support";

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("./sms-bulk.test-support");
  fake.db = createFakeDb();
  return { supabaseAdmin: fake.db.client };
});

import {
  __resetCallbackTokensForTests,
  callbackTokenFor,
  ensureCallbackToken,
  loadOwnedAccountIds,
  resolveCallbackScope,
  scopeAllowsRow,
  touchCallbackReceived,
} from "./provider-callback-tokens.server";
import { encryptProviderCredentials } from "./secret-box.server";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OWN_A = "11111111-1111-4111-8111-111111111111";
const OWN_B = "22222222-2222-4222-8222-222222222222";
const PLATFORM = "00000000-0000-4000-a000-00000000a002";

beforeEach(() => {
  vi.stubEnv("PROVIDER_CREDENTIALS_ENCRYPTION_KEY", "k".repeat(40));
  fake.db.reset();
  __resetCallbackTokensForTests();
  fake.db.rows("provider_accounts").push(
    {
      id: OWN_A,
      owner_tenant_id: TENANT,
      callback_token_encrypted: null,
      last_callback_at: null,
    },
    {
      id: OWN_B,
      owner_tenant_id: TENANT,
      callback_token_encrypted: null,
      last_callback_at: null,
    },
    {
      id: PLATFORM,
      owner_tenant_id: null,
      callback_token_encrypted: null,
      last_callback_at: null,
    },
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const account = (id: string) =>
  fake.db.rows("provider_accounts").find((row) => row.id === id) as Record<string, unknown>;

describe("ensureCallbackToken", () => {
  it("creates pa_<id without hyphens>_<32 bytes base64url>, stored encrypted, idempotent", async () => {
    const token = await ensureCallbackToken(OWN_A);
    expect(token).toMatch(new RegExp(`^pa_${OWN_A.replace(/-/g, "")}_[A-Za-z0-9_-]{43}$`));
    const stored = account(OWN_A).callback_token_encrypted as string;
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain(token);

    __resetCallbackTokensForTests(); // no in-process cache: read back from the row
    expect(await ensureCallbackToken(OWN_A)).toBe(token);
    expect(account(OWN_A).callback_token_encrypted).toBe(stored);
  });

  it("each account gets its own token", async () => {
    expect(await ensureCallbackToken(OWN_A)).not.toBe(await ensureCallbackToken(OWN_B));
  });
});

describe("callbackTokenFor", () => {
  it("owned account -> account token; platform account -> null", async () => {
    const token = await callbackTokenFor({ id: OWN_A, ownerTenantId: TENANT });
    expect(token).toMatch(/^pa_/);
    expect(await callbackTokenFor({ id: PLATFORM, ownerTenantId: null })).toBeNull();
    expect(account(PLATFORM).callback_token_encrypted).toBeNull();
  });
});

describe("resolveCallbackScope", () => {
  it("accepts the account token with the right secret", async () => {
    const token = await ensureCallbackToken(OWN_A);
    __resetCallbackTokensForTests();
    expect(await resolveCallbackScope(token, "global")).toEqual({
      kind: "account",
      accountId: OWN_A,
      tenantId: TENANT,
    });
  });

  it("refuses a pa_ token with a wrong secret", async () => {
    const token = await ensureCallbackToken(OWN_A);
    const forged =
      `${token.slice(0, -4)}AAAA` === token
        ? `${token.slice(0, -4)}BBBB`
        : `${token.slice(0, -4)}AAAA`;
    expect(await resolveCallbackScope(forged, "global")).toBeNull();
    // Another account's secret on A's id.
    const tokenB = await ensureCallbackToken(OWN_B);
    const mixed = `pa_${OWN_A.replace(/-/g, "")}_${tokenB.split("_").slice(2).join("_")}`;
    expect(await resolveCallbackScope(mixed, "global")).toBeNull();
  });

  it("refuses the token of an account without owner", async () => {
    const token = `pa_${PLATFORM.replace(/-/g, "")}_${"x".repeat(43)}`;
    account(PLATFORM).callback_token_encrypted = await encryptProviderCredentials({ token });
    expect(await resolveCallbackScope(token, "global")).toBeNull();
  });

  it("refuses an account token whose house no longer owns the account", async () => {
    const token = await ensureCallbackToken(OWN_A);
    account(OWN_A).owner_tenant_id = null;
    __resetCallbackTokensForTests();
    expect(await resolveCallbackScope(token, "global")).toBeNull();
  });

  it("global token -> platform; anything else -> null", async () => {
    expect(await resolveCallbackScope("global", "global")).toEqual({ kind: "platform" });
    expect(await resolveCallbackScope("globalx", "global")).toBeNull();
    expect(await resolveCallbackScope(null, "global")).toBeNull();
    expect(await resolveCallbackScope("global", undefined)).toBeNull();
    expect(await resolveCallbackScope("", "")).toBeNull();
    expect(await resolveCallbackScope("pa_garbage", "global")).toBeNull();
  });
});

describe("scopeAllowsRow", () => {
  const owned = new Set([OWN_A, OWN_B]);
  const scopeA = { kind: "account", accountId: OWN_A, tenantId: TENANT } as const;

  it("account scope only accepts its own rows", () => {
    expect(scopeAllowsRow(scopeA, OWN_A, owned)).toBe(true);
    expect(scopeAllowsRow(scopeA, OWN_B, owned)).toBe(false);
    expect(scopeAllowsRow(scopeA, PLATFORM, owned)).toBe(false);
    expect(scopeAllowsRow(scopeA, null, owned)).toBe(false);
  });

  it("platform scope refuses owned-account rows", () => {
    expect(scopeAllowsRow({ kind: "platform" }, OWN_A, owned)).toBe(false);
    expect(scopeAllowsRow({ kind: "platform" }, PLATFORM, owned)).toBe(true);
    expect(scopeAllowsRow({ kind: "platform" }, null, owned)).toBe(true);
  });
});

describe("loadOwnedAccountIds", () => {
  it("lists the accounts with an owner", async () => {
    expect([...(await loadOwnedAccountIds())].sort()).toEqual([OWN_A, OWN_B]);
  });
});

describe("touchCallbackReceived", () => {
  it("writes last_callback_at at most once a minute per account", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    await touchCallbackReceived(OWN_A);
    expect(account(OWN_A).last_callback_at).toBe("2026-11-07T12:00:00.000Z");
    vi.setSystemTime(new Date("2026-11-07T12:00:30Z"));
    await touchCallbackReceived(OWN_A);
    expect(account(OWN_A).last_callback_at).toBe("2026-11-07T12:00:00.000Z");
    await touchCallbackReceived(OWN_B);
    expect(account(OWN_B).last_callback_at).toBe("2026-11-07T12:00:30.000Z");
    vi.setSystemTime(new Date("2026-11-07T12:01:01Z"));
    await touchCallbackReceived(OWN_A);
    expect(account(OWN_A).last_callback_at).toBe("2026-11-07T12:01:01.000Z");
  });
});

describe("owned-ids cache", () => {
  it("generating an account's first token drops this instance's owned-ids cache", async () => {
    const NEW = "33333333-3333-4333-8333-333333333333";
    expect((await loadOwnedAccountIds()).has(NEW)).toBe(false);
    fake.db.rows("provider_accounts").push({
      id: NEW,
      owner_tenant_id: TENANT,
      callback_token_encrypted: null,
      last_callback_at: null,
    });
    expect((await loadOwnedAccountIds()).has(NEW)).toBe(false); // cached
    await ensureCallbackToken(NEW);
    expect((await loadOwnedAccountIds()).has(NEW)).toBe(true);
  });
});
