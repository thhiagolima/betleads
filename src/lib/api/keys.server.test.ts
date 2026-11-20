// API de leitura: chaves (spec 2026-11-20 §4). Same createFakeDb stand-in as
// the MCP access tests.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("../sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { sha256Hex } from "@/lib/mcp/crypto.server";

import {
  API_KEY_LIMIT,
  API_KEY_NOT_FOUND,
  API_NO_ACCESS,
  MAX_KEYS_PER_USER,
  createApiKey,
  listApiKeys,
  resolveApiKey,
  revokeApiKey,
} from "./keys.server";
import { createFakeDb } from "../sms-bulk.test-support";

const USER = "00000000-0000-4000-8000-0000000000bb";
const OTHER = "00000000-0000-4000-8000-0000000000cc";

const grant = (userId: string, level: string, areas = ["financeiro", "operacao"]) =>
  fake.admin.rows("mcp_access").push({ user_id: userId, level, areas });

beforeEach(() => {
  fake.admin.reset();
});

describe("createApiKey", () => {
  it("returns the key once and stores only its hash and prefix", async () => {
    grant(USER, "read");
    const { key, view } = await createApiKey(USER, "  Planilha  ");

    expect(key).toMatch(/^blk_[A-Za-z0-9_-]{43}$/);
    expect(view.nome).toBe("Planilha");
    expect(view.prefixo).toBe(key.slice(0, 10));
    const [row] = fake.admin.rows("api_keys");
    expect(row.key_hash).toBe(await sha256Hex(key));
    expect(JSON.stringify(row)).not.toContain(key);
  });

  it("refuses a user without MCP access", async () => {
    await expect(createApiKey(USER, "x")).rejects.toThrow(API_NO_ACCESS);
    grant(USER, "none");
    await expect(createApiKey(USER, "x")).rejects.toThrow(API_NO_ACCESS);
  });

  it(`allows at most ${MAX_KEYS_PER_USER} active keys; a revoked one frees a slot`, async () => {
    grant(USER, "read");
    for (let i = 0; i < MAX_KEYS_PER_USER; i++) await createApiKey(USER, `k${i}`);
    await expect(createApiKey(USER, "extra")).rejects.toThrow(API_KEY_LIMIT);

    const [first] = await listApiKeys(USER);
    await revokeApiKey(USER, first.id);
    await expect(createApiKey(USER, "extra")).resolves.toBeTruthy();
  });
});

describe("resolveApiKey", () => {
  it("resolves to the owner, always read-only, with the areas read now", async () => {
    grant(USER, "write", ["financeiro"]);
    const { key, view } = await createApiKey(USER, "BI");

    const identity = await resolveApiKey(key);
    expect(identity).toMatchObject({
      userId: USER,
      level: "read",
      areas: ["financeiro"],
      apiKeyId: view.id,
    });
    expect(fake.admin.rows("api_keys")[0].last_used_at).toBeTruthy();

    // Areas follow mcp_access at call time.
    fake.admin.rows("mcp_access")[0].areas = ["operacao"];
    expect((await resolveApiKey(key))?.areas).toEqual(["operacao"]);
  });

  it("is null for a malformed, unknown or revoked key", async () => {
    grant(USER, "read");
    const { key, view } = await createApiKey(USER, "BI");

    expect(await resolveApiKey("abc")).toBeNull();
    expect(await resolveApiKey(`blk_${"x".repeat(43)}`)).toBeNull();
    await revokeApiKey(USER, view.id);
    expect(await resolveApiKey(key)).toBeNull();
  });

  it("stops working as soon as the owner loses MCP access", async () => {
    grant(USER, "read");
    const { key } = await createApiKey(USER, "BI");
    fake.admin.rows("mcp_access").length = 0;
    expect(await resolveApiKey(key)).toBeNull();
  });
});

describe("revokeApiKey / listApiKeys", () => {
  it("lists only the caller's active keys and never revokes someone else's", async () => {
    grant(USER, "read");
    grant(OTHER, "read");
    const mine = await createApiKey(USER, "minha");
    await createApiKey(OTHER, "dele");

    expect((await listApiKeys(USER)).map((key) => key.nome)).toEqual(["minha"]);
    await expect(revokeApiKey(OTHER, mine.view.id)).rejects.toThrow(API_KEY_NOT_FOUND);
    expect(await resolveApiKey(mine.key)).not.toBeNull();
  });
});
