// Fix round 1 (PG1 Task 8): `setPricing`/`getPricing` regressions.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("@/integrations/supabase/client.server", async () => {
  const { createFakeDb } = await import("@/lib/sms-bulk.test-support");
  fake.admin = createFakeDb();
  return { supabaseAdmin: fake.admin.client };
});

import { createFakeDb } from "@/lib/sms-bulk.test-support";
import {
  adminAssignUserToTenantFor,
  adminRemoveUserFromTenantFor,
  getPricingFor,
  setPricingFor,
} from "./admin.functions";

const SUPER_ADMIN = "00000000-0000-4000-8000-0000000000aa";
const HOUSE_ADMIN = "00000000-0000-4000-8000-0000000000bb";

/**
 * `admin_set_price` checks `is_super_admin()` with no service_role bypass:
 * calling it through `supabaseAdmin` (auth.uid() is null there) always fails
 * with `forbidden`, even for a real super admin. The `supabaseAdmin` fake
 * registers `admin_set_price` to fail exactly that way, so a test that
 * (wrongly) called it would fail; `userDb` is a separate fake wired to
 * `ctx.supabase`, registering a real, succeeding handler.
 */
let userDb: ReturnType<typeof createFakeDb>;

beforeEach(async () => {
  // `admin.functions.ts` only ever imports `client.server` dynamically
  // (`await import(...)` inside each function body), so nothing triggers
  // the mocked module's factory until a function actually runs. Force that
  // here so `fake.admin` is assigned before this `beforeEach` uses it.
  await import("@/integrations/supabase/client.server");
  fake.admin.reset();
  fake.admin.onRpc("is_super_admin", (args) => ({
    data: args._user_id === SUPER_ADMIN,
    error: null,
  }));
  fake.admin.onRpc("admin_set_price", () => ({ data: null, error: { message: "forbidden" } }));

  userDb = createFakeDb();
  userDb.onRpc("admin_set_price", () => ({ data: {}, error: null }));
});

describe("setPricingFor", () => {
  it("rejects a caller who is not super admin", async () => {
    await expect(
      setPricingFor(
        { userId: HOUSE_ADMIN, supabase: userDb.client },
        { item: "sms", unit_price: 0.07 },
      ),
    ).rejects.toThrow(/super admin/i);
  });

  it("calls admin_set_price through the caller's own client, not supabaseAdmin", async () => {
    // Regression guard for the `forbidden` bug.
    await expect(
      setPricingFor(
        { userId: SUPER_ADMIN, supabase: userDb.client },
        { item: "sms", unit_price: 0.07 },
      ),
    ).resolves.toEqual({ ok: true });
  });
});

describe("setPricingFor: charge_unanswered_blocks (PG3)", () => {
  it("sends the unanswered rule for voice_30s", async () => {
    let sent: Record<string, unknown> = {};
    userDb.onRpc("admin_set_price", (args) => {
      sent = args;
      return { data: {}, error: null };
    });
    await setPricingFor(
      { userId: SUPER_ADMIN, supabase: userDb.client },
      { item: "voice_30s", unit_price: 0.09, charge_unanswered_blocks: 1 },
    );
    expect(sent._charge_unanswered_blocks).toBe(1);
  });

  it("never sends it for other items (the SQL keeps the current value)", async () => {
    let sent: Record<string, unknown> = {};
    userDb.onRpc("admin_set_price", (args) => {
      sent = args;
      return { data: {}, error: null };
    });
    await setPricingFor(
      { userId: SUPER_ADMIN, supabase: userDb.client },
      { item: "email", unit_price: 0.002, charge_unanswered_blocks: 3 },
    );
    expect(sent).not.toHaveProperty("_charge_unanswered_blocks");
  });
});

describe("getPricingFor", () => {
  it("picks the latest valid_from that is not in the future, per item", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    fake.admin.rows("billing_price_book").push(
      {
        item: "sms",
        unit_price: 0.08,
        provider_unit_cost: 0.059,
        free_monthly_units: 0,
        valid_from: past,
      },
      // Inserted later (would sort first by valid_from desc if not filtered), but not in effect yet.
      {
        item: "sms",
        unit_price: 0.5,
        provider_unit_cost: 0.059,
        free_monthly_units: 0,
        valid_from: future,
      },
    );

    const result = await getPricingFor(SUPER_ADMIN);
    const sms = result.pricing.find((row) => row.item === "sms");
    expect(sms).toMatchObject({ unit_price: 0.08 });
  });
});

describe("super admin membership changes refuse an expert's role", () => {
  const TENANT = "00000000-0000-4000-8000-00000000a0a0";
  const EXPERT_USER = "00000000-0000-4000-8000-0000000000e1";
  const GUARD = "Esta pessoa é expert desta casa. Gerencie o acesso dela em Experts.";

  beforeEach(() => {
    fake.admin.rows("user_roles").push({
      id: "expert-role",
      user_id: EXPERT_USER,
      tenant_id: TENANT,
      role: "expert",
    });
  });

  it("adminAssignUserToTenantFor does not change an expert's role", async () => {
    await expect(
      adminAssignUserToTenantFor(
        { userId: SUPER_ADMIN },
        { user_id: EXPERT_USER, tenant_id: TENANT, role: "member" },
      ),
    ).rejects.toThrow(GUARD);
    expect(fake.admin.rows("user_roles")).toEqual([
      expect.objectContaining({ id: "expert-role", role: "expert" }),
    ]);
  });

  it("adminRemoveUserFromTenantFor does not delete an expert's role", async () => {
    await expect(
      adminRemoveUserFromTenantFor(
        { userId: SUPER_ADMIN },
        { user_id: EXPERT_USER, tenant_id: TENANT },
      ),
    ).rejects.toThrow(GUARD);
    expect(fake.admin.rows("user_roles")).toHaveLength(1);
  });

  it("still assigns a non-expert user normally", async () => {
    const OTHER = "00000000-0000-4000-8000-0000000000e2";
    await expect(
      adminAssignUserToTenantFor(
        { userId: SUPER_ADMIN },
        { user_id: OTHER, tenant_id: TENANT, role: "member" },
      ),
    ).resolves.toEqual({ ok: true });
    expect(fake.admin.rows("user_roles")).toHaveLength(2);
  });
});

describe("super admin membership changes allow several admins per tenant", () => {
  const TENANT = "00000000-0000-4000-8000-00000000b0b0";
  const ADMIN_A = "00000000-0000-4000-8000-0000000000a1";
  const ADMIN_B = "00000000-0000-4000-8000-0000000000a2";
  const LAST_ADMIN = "Esta casa precisa de pelo menos um admin. Defina outro admin antes.";

  beforeEach(() => {
    fake.admin.rows("user_roles").push({
      id: "admin-a",
      user_id: ADMIN_A,
      tenant_id: TENANT,
      role: "admin",
    });
  });

  it("promotes a second admin while one already exists", async () => {
    await expect(
      adminAssignUserToTenantFor(
        { userId: SUPER_ADMIN },
        { user_id: ADMIN_B, tenant_id: TENANT, role: "admin" },
      ),
    ).resolves.toEqual({ ok: true });
    expect(fake.admin.rows("user_roles").filter((r) => r.role === "admin")).toHaveLength(2);
  });

  it("refuses to demote the only admin", async () => {
    await expect(
      adminAssignUserToTenantFor(
        { userId: SUPER_ADMIN },
        { user_id: ADMIN_A, tenant_id: TENANT, role: "gestor" },
      ),
    ).rejects.toThrow(LAST_ADMIN);
  });

  it("refuses to remove the only admin", async () => {
    await expect(
      adminRemoveUserFromTenantFor({ userId: SUPER_ADMIN }, { user_id: ADMIN_A, tenant_id: TENANT }),
    ).rejects.toThrow(LAST_ADMIN);
    expect(fake.admin.rows("user_roles")).toHaveLength(1);
  });

  it("demotes or removes an admin when another admin remains", async () => {
    fake.admin.rows("user_roles").push({
      id: "admin-b",
      user_id: ADMIN_B,
      tenant_id: TENANT,
      role: "admin",
    });
    await expect(
      adminAssignUserToTenantFor(
        { userId: SUPER_ADMIN },
        { user_id: ADMIN_A, tenant_id: TENANT, role: "gestor" },
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      adminAssignUserToTenantFor(
        { userId: SUPER_ADMIN },
        { user_id: ADMIN_A, tenant_id: TENANT, role: "admin" },
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      adminRemoveUserFromTenantFor({ userId: SUPER_ADMIN }, { user_id: ADMIN_B, tenant_id: TENANT }),
    ).resolves.toEqual({ ok: true });
    expect(fake.admin.rows("user_roles")).toEqual([
      expect.objectContaining({ user_id: ADMIN_A, role: "admin" }),
    ]);
  });
});
