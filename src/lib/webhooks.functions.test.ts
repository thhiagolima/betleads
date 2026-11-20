// P0-02: rotating webhook credentials must never switch HMAC enforcement off.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/tenant-access.server", () => ({
  assertTenantNotDemo: vi.fn(),
  resolveCurrentTenantId: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => {
  const chain = { middleware: () => chain, inputValidator: () => chain, handler: () => chain };
  return { createServerFn: () => chain };
});

import {
  HMAC_ENFORCED_ROTATION_ERROR,
  provisionWebhookHmacSecretFor,
  rotateWebhookCredentialsFor,
} from "./webhooks.functions";

type Call = { table: string; op: string; payload?: unknown; filters: unknown[][] };

/** Fake admin client: `tenants` holds one row; updates honour `.eq` filters. */
function fakeAdmin(row: { id: string; webhook_hmac_enforced: boolean }) {
  const calls: Call[] = [];
  const tenant: Record<string, unknown> = { ...row };
  const from = (table: string) => {
    const call: Call = { table, op: "select", filters: [] };
    calls.push(call);
    const matches = () => call.filters.every(([, col, value]) => tenant[col as string] === value);
    const run = () => {
      if (table === "tenants" && call.op === "update" && matches()) {
        Object.assign(tenant, call.payload as object);
        return { data: [{ id: tenant.id }], error: null };
      }
      return { data: [], error: null };
    };
    const builder: Record<string, unknown> = {
      update: (payload: unknown) => ((call.op = "update"), (call.payload = payload), builder),
      insert: async (payload: unknown) => {
        call.op = "insert";
        call.payload = payload;
        return { error: null };
      },
      eq: (col: string, value: unknown) => (call.filters.push(["eq", col, value]), builder),
      select: () => builder,
      then: (ok: (v: unknown) => unknown) => Promise.resolve(run()).then(ok),
    };
    return builder;
  };
  return { admin: { from }, calls, tenant };
}

describe("rotateWebhookCredentialsFor", () => {
  it.each([true, false])("keeps webhook_hmac_enforced=%s untouched", async (enforced) => {
    const { admin, calls, tenant } = fakeAdmin({ id: "t1", webhook_hmac_enforced: enforced });
    const result = await rotateWebhookCredentialsFor(admin, "t1", "u1");
    const update = calls.find((c) => c.table === "tenants" && c.op === "update");
    expect(update?.payload).not.toHaveProperty("webhook_hmac_enforced");
    expect(tenant.webhook_hmac_enforced).toBe(enforced);
    expect(tenant.webhook_token).toBe(result.token);
    expect(tenant.webhook_secret).toBe(result.secret);
    const audit = calls.find((c) => c.table === "tenant_audit_logs");
    expect(audit?.payload).toMatchObject({ action: "webhook.credentials_rotated" });
  });
});

describe("provisionWebhookHmacSecretFor", () => {
  it("generates a new secret while enforcement is off, without writing the flag", async () => {
    const { admin, calls, tenant } = fakeAdmin({ id: "t1", webhook_hmac_enforced: false });
    const { secret } = await provisionWebhookHmacSecretFor(admin, "t1", "u1");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(tenant.webhook_secret).toBe(secret);
    expect(tenant.webhook_hmac_enforced).toBe(false);
    const update = calls.find((c) => c.table === "tenants" && c.op === "update");
    expect(update?.payload).not.toHaveProperty("webhook_hmac_enforced");
  });

  it("refuses while enforcement is on and leaves secret and flag as they were", async () => {
    const { admin, calls, tenant } = fakeAdmin({ id: "t1", webhook_hmac_enforced: true });
    tenant.webhook_secret = "old";
    await expect(provisionWebhookHmacSecretFor(admin, "t1", "u1")).rejects.toThrow(
      HMAC_ENFORCED_ROTATION_ERROR,
    );
    expect(tenant.webhook_secret).toBe("old");
    expect(tenant.webhook_hmac_enforced).toBe(true);
    expect(calls.some((c) => c.table === "tenant_audit_logs")).toBe(false);
  });
});
