// Uses the in-memory createFakeDb stand-in for supabaseAdmin, same pattern as
// finance.functions.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("../sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { assertArea, getMcpAccess, getMcpLevel, parseAreas, resolveBearer } from "./access.server";
import { isMcpEnabled } from "./config.server";
import { sha256Hex } from "./crypto.server";
import { createFakeDb } from "../sms-bulk.test-support";

const USER = "00000000-0000-4000-8000-000000000001";
const CONNECTION = "00000000-0000-4000-8000-000000000002";
const CLIENT = "client-abc";
const HOUR_MS = 3_600_000;

beforeEach(() => {
  fake.admin.reset();
});

describe("isMcpEnabled", () => {
  const original = process.env.MCP_ENABLED;

  it("is true for exactly \"true\"", () => {
    process.env.MCP_ENABLED = "true";
    expect(isMcpEnabled()).toBe(true);
    process.env.MCP_ENABLED = original;
  });

  it("is true for \" TRUE \" (trim + lowercase)", () => {
    process.env.MCP_ENABLED = " TRUE ";
    expect(isMcpEnabled()).toBe(true);
    process.env.MCP_ENABLED = original;
  });

  it("is false when unset", () => {
    delete process.env.MCP_ENABLED;
    expect(isMcpEnabled()).toBe(false);
    process.env.MCP_ENABLED = original;
  });

  it("is false for an empty string", () => {
    process.env.MCP_ENABLED = "";
    expect(isMcpEnabled()).toBe(false);
    process.env.MCP_ENABLED = original;
  });

  it("is false for \"1\"", () => {
    process.env.MCP_ENABLED = "1";
    expect(isMcpEnabled()).toBe(false);
    process.env.MCP_ENABLED = original;
  });

  it("is false for \"yes\"", () => {
    process.env.MCP_ENABLED = "yes";
    expect(isMcpEnabled()).toBe(false);
    process.env.MCP_ENABLED = original;
  });
});

describe("areas", () => {
  it("getMcpAccess returns level and areas, defaulting areas to financeiro", async () => {
    expect(await getMcpAccess(USER)).toEqual({ level: "none", areas: ["financeiro"] });
    fake.admin.rows("mcp_access").push({ user_id: USER, level: "read" });
    expect(await getMcpAccess(USER)).toEqual({ level: "read", areas: ["financeiro"] });
  });

  it("parseAreas keeps only known areas, in canonical order, never empty", () => {
    expect(parseAreas(["operacao", "financeiro", "x"])).toEqual(["financeiro", "operacao"]);
    expect(parseAreas([])).toEqual(["financeiro"]);
    expect(parseAreas(null)).toEqual(["financeiro"]);
  });

  it("assertArea throws the pt-BR message for a missing area", () => {
    expect(() => assertArea({ areas: ["financeiro"] }, "operacao")).toThrow(
      "Seu acesso ao MCP não inclui operação.",
    );
    expect(() => assertArea({ areas: ["operacao"] }, "financeiro")).toThrow(
      "Seu acesso ao MCP não inclui financeiro.",
    );
    expect(() => assertArea({ areas: ["operacao"] }, "operacao")).not.toThrow();
  });
});

describe("getMcpLevel", () => {
  it("returns \"none\" when there is no mcp_access row", async () => {
    expect(await getMcpLevel(USER)).toBe("none");
  });

  it("returns the stored level", async () => {
    fake.admin.rows("mcp_access").push({ user_id: USER, level: "write" });
    expect(await getMcpLevel(USER)).toBe("write");
  });
});

async function seedConnection(overrides: Record<string, unknown> = {}) {
  fake.admin.rows("mcp_connections").push({
    id: CONNECTION,
    user_id: USER,
    client_id: CLIENT,
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  });
}

async function seedToken(token: string, overrides: Record<string, unknown> = {}) {
  fake.admin.rows("mcp_tokens").push({
    token_hash: await sha256Hex(token),
    connection_id: CONNECTION,
    kind: "access",
    expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
    used_at: null,
    ...overrides,
  });
}

describe("resolveBearer", () => {
  beforeEach(async () => {
    await seedConnection();
    fake.admin.rows("mcp_access").push({ user_id: USER, level: "write" });
  });

  it("returns the identity for a valid access token", async () => {
    await seedToken("tok-valid");
    const identity = await resolveBearer("tok-valid");
    expect(identity).toEqual({
      userId: USER,
      connectionId: CONNECTION,
      clientId: CLIENT,
      level: "write",
      areas: ["financeiro"],
    });
  });

  it("reads the areas from mcp_access on every call (operacao turned on, then off)", async () => {
    const access = fake.admin.rows("mcp_access").find((r) => r.user_id === USER)!;
    access.areas = ["financeiro", "operacao"];
    await seedToken("tok-areas");
    expect((await resolveBearer("tok-areas"))?.areas).toEqual(["financeiro", "operacao"]);
    access.areas = ["operacao"];
    expect((await resolveBearer("tok-areas"))?.areas).toEqual(["operacao"]);
  });

  it("bumps mcp_connections.last_used_at on success", async () => {
    await seedToken("tok-valid");
    await resolveBearer("tok-valid");
    const conn = fake.admin.rows("mcp_connections").find((r) => r.id === CONNECTION);
    expect(conn?.last_used_at).not.toBeNull();
  });

  it("returns null for an unknown token", async () => {
    expect(await resolveBearer("never-issued")).toBeNull();
  });

  it("returns null for an expired access token", async () => {
    await seedToken("tok-expired", { expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(await resolveBearer("tok-expired")).toBeNull();
  });

  it("returns null when the connection is revoked", async () => {
    fake.admin.rows("mcp_connections").find((r) => r.id === CONNECTION)!.revoked_at =
      new Date().toISOString();
    await seedToken("tok-revoked-conn");
    expect(await resolveBearer("tok-revoked-conn")).toBeNull();
  });

  it("returns null when the mcp_access row was deleted", async () => {
    fake.admin.rows("mcp_access").length = 0;
    await seedToken("tok-no-access");
    expect(await resolveBearer("tok-no-access")).toBeNull();
  });

  it("reflects a level change from write to read", async () => {
    fake.admin.rows("mcp_access").find((r) => r.user_id === USER)!.level = "read";
    await seedToken("tok-downgraded");
    const identity = await resolveBearer("tok-downgraded");
    expect(identity?.level).toBe("read");
  });

  it("returns null when a refresh token is presented as a bearer token", async () => {
    await seedToken("tok-refresh", { kind: "refresh" });
    expect(await resolveBearer("tok-refresh")).toBeNull();
  });
});
