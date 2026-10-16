// F0-02 / SEC-10 — the ai-player-insights edge function (Deno, service role)
// must answer only with rows of the caller's active tenant, and only to an
// admin/gestor of THAT tenant (or a super admin).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  requestedTenantFrom,
  resolveAiDemoBlock,
  resolveInsightsTenant,
  tenantScopedReader,
} from "../../supabase/functions/ai-player-insights/tenant-scope";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

describe("resolveInsightsTenant", () => {
  const adminOfAMemberOfB = [
    { role: "admin", tenant_id: A },
    { role: "member", tenant_id: B },
  ];

  it("refuses an admin of A asking about B", () => {
    expect(resolveInsightsTenant(adminOfAMemberOfB, B)).toEqual({
      ok: false,
      status: 403,
      error: "Forbidden",
    });
  });

  it("accepts an admin of A asking about A", () => {
    expect(resolveInsightsTenant(adminOfAMemberOfB, A)).toEqual({ ok: true, tenantId: A });
  });

  it("accepts a gestor of the tenant", () => {
    expect(resolveInsightsTenant([{ role: "gestor", tenant_id: B }], B)).toEqual({
      ok: true,
      tenantId: B,
    });
  });

  it("without an explicit tenant, falls back like current_tenant_id (first membership)", () => {
    // Ids sort as ...0a < ...0b, so A is the implicit tenant.
    expect(resolveInsightsTenant(adminOfAMemberOfB, null)).toEqual({ ok: true, tenantId: A });
    expect(resolveInsightsTenant([{ role: "member", tenant_id: A }], null)).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("lets a super admin into any tenant, but only a named one", () => {
    const sa = [{ role: "super_admin", tenant_id: null }];
    expect(resolveInsightsTenant(sa, B)).toEqual({ ok: true, tenantId: B });
    expect(resolveInsightsTenant(sa, null)).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses a user with no role at all and a malformed tenant id", () => {
    expect(resolveInsightsTenant([], A)).toMatchObject({ ok: false, status: 403 });
    expect(resolveInsightsTenant(adminOfAMemberOfB, "A' or 1=1")).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe("resolveAiDemoBlock", () => {
  it("blocks when the tenant is flagged demo", () => {
    expect(resolveAiDemoBlock({ isDemo: true })).toEqual({
      ok: false,
      status: 403,
      error: "DEMO_SEND_BLOCKED",
    });
  });

  it("blocks fail-closed when the lookup found no row or errored (null)", () => {
    expect(resolveAiDemoBlock(null)).toEqual({ ok: false, status: 403, error: "DEMO_SEND_BLOCKED" });
  });

  it("allows a confirmed non-demo tenant", () => {
    expect(resolveAiDemoBlock({ isDemo: false })).toEqual({ ok: true });
  });
});

describe("requestedTenantFrom", () => {
  it("prefers the body, then the X-Active-Tenant header", () => {
    expect(requestedTenantFrom({ tenant_id: A }, B)).toBe(A);
    expect(requestedTenantFrom({ question: "x" }, B)).toBe(B);
    expect(requestedTenantFrom({}, " ")).toBeNull();
    expect(requestedTenantFrom(null, null)).toBeNull();
  });
});

describe("tenantScopedReader", () => {
  it("adds tenant_id to every select, whatever the table", () => {
    const calls: string[] = [];
    const sb = {
      from: (table: string) => ({
        select: (cols: string) => ({
          eq: (col: string, val: string) => {
            calls.push(`${table}:${cols}:${col}=${val}`);
            return "builder";
          },
        }),
      }),
    };
    const db = tenantScopedReader(sb, A);
    for (const t of ["players", "deposits", "withdrawals", "experts", "ai_synonyms"]) {
      expect(db.from(t).select("id")).toBe("builder");
    }
    expect(calls).toEqual([
      `players:id:tenant_id=${A}`,
      `deposits:id:tenant_id=${A}`,
      `withdrawals:id:tenant_id=${A}`,
      `experts:id:tenant_id=${A}`,
      `ai_synonyms:id:tenant_id=${A}`,
    ]);
  });

  it("refuses an empty tenant", () => {
    expect(() => tenantScopedReader({ from: () => null }, "")).toThrow(/tenant/);
  });
});

describe("ai-player-insights/index.ts wiring", () => {
  const src = readFileSync(
    resolve(__dirname, "../../supabase/functions/ai-player-insights/index.ts"),
    "utf8",
  );

  it("no longer authorizes with the tenant-blind has_role", () => {
    expect(src).not.toMatch(/rpc\(\s*["']has_role["']/);
  });

  it("only touches the raw service-role client for ai_logs, user_roles and the demo check", () => {
    const rawTables = [...src.matchAll(/\bsb\s*\.from\(\s*["'`]?([\w$]+)/g)].map((m) => m[1]);
    expect(rawTables.length).toBeGreaterThan(0);
    expect(new Set(rawTables)).toEqual(new Set(["ai_logs", "user_roles", "tenants"]));
  });

  it("checks the demo flag right after the tenant is resolved and before any OpenAI call", () => {
    const tenantCheckIdx = src.indexOf('.from("tenants")');
    const openAiCallIdx = src.indexOf("api.openai.com");
    const tenantResolvedIdx = src.indexOf("const tenantId = decision.tenantId;");
    expect(tenantCheckIdx).toBeGreaterThan(-1);
    expect(tenantCheckIdx).toBeGreaterThan(tenantResolvedIdx);
    expect(tenantCheckIdx).toBeLessThan(openAiCallIdx);
  });

  it("writes tenant_id on every ai_logs insert", () => {
    const inserts = [...src.matchAll(/from\("ai_logs"\)\.insert\(\{([\s\S]*?)\}\)/g)];
    expect(inserts.length).toBeGreaterThan(0);
    for (const m of inserts) expect(m[1]).toMatch(/tenant_id/);
  });
});
