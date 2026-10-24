// Task 13 — demo login generator/revoker, driven against a mocked Supabase
// admin client (ruling R3: no live database connection here; the live run
// happens later in Task 14 with the user's authorization).
import { describe, expect, it } from "vitest";

import {
  createDemoLogin,
  createDemoLogins,
  demoEmail,
  randomPassword,
  revokeDemoLogin,
} from "./create-demo-login.core.mjs";

const DEMO_TENANT_ID = "11111111-2222-4333-8444-555555555555";

type FakeUser = {
  id: string;
  email: string;
  app_metadata: Record<string, unknown>;
  banned_until?: string;
};

const DEMO_GROUP_ID = "99999999-8888-4777-8666-555555555555";

function makeFakeClient(
  opts: {
    tenant?: { id: string; slug: string; is_demo: boolean } | null;
    groupId?: string | null;
  } = {},
) {
  const tenant = "tenant" in opts ? opts.tenant : { id: DEMO_TENANT_ID, slug: "demo", is_demo: true };
  const groupId = "groupId" in opts ? opts.groupId : null;
  const users = new Map<string, FakeUser>();
  const roles: { user_id: string; tenant_id: string; role: string }[] = [];
  const managers: { group_id: string; user_id: string }[] = [];
  let nextId = 1;

  const client = {
    _users: users,
    _roles: roles,
    _managers: managers,
    from(table: string) {
      if (table === "tenants") {
        return {
          select: () => ({
            eq: (_col: string, value: string) => ({
              maybeSingle: async () => {
                if (!tenant || tenant.slug !== value) return { data: null, error: null };
                return { data: tenant, error: null };
              },
            }),
          }),
        };
      }
      if (table === "user_roles") {
        return {
          insert: async (row: { user_id: string; tenant_id: string; role: string }) => {
            roles.push(row);
            return { data: row, error: null };
          },
          delete: () => ({
            eq: async (col: "user_id", value: string) => {
              for (let i = roles.length - 1; i >= 0; i -= 1) if (roles[i][col] === value) roles.splice(i, 1);
              return { data: null, error: null };
            },
          }),
        };
      }
      if (table === "tenant_group_tenants") {
        return {
          select: () => ({
            eq: (_col: string, _value: string) => ({
              maybeSingle: async () => ({ data: groupId ? { group_id: groupId } : null, error: null }),
            }),
          }),
        };
      }
      if (table === "tenant_group_managers") {
        return {
          insert: async (row: { group_id: string; user_id: string }) => {
            managers.push(row);
            return { data: row, error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    auth: {
      admin: {
        createUser: async ({
          email,
          app_metadata,
        }: {
          email: string;
          password: string;
          email_confirm: boolean;
          app_metadata: Record<string, unknown>;
        }) => {
          const id = `user-${nextId++}`;
          const user: FakeUser = { id, email, app_metadata };
          users.set(id, user);
          return { data: { user }, error: null };
        },
        deleteUser: async (id: string) => {
          users.delete(id);
          return { data: null, error: null };
        },
        updateUserById: async (id: string, patch: Record<string, unknown>) => {
          const user = users.get(id);
          if (!user) return { data: null, error: { message: "user not found" } };
          Object.assign(user, patch);
          return { data: { user }, error: null };
        },
        listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
          const all = [...users.values()];
          const start = (page - 1) * perPage;
          return { data: { users: all.slice(start, start + perPage) }, error: null };
        },
      },
    },
  };
  return client;
}

describe("demoEmail / randomPassword", () => {
  it("builds a demo+<label>-<hex>@betleads.io address", () => {
    const email = demoEmail("Prospect X");
    expect(email).toMatch(/^demo\+prospect-x-[0-9a-f]{8}@betleads\.io$/);
  });

  it("falls back to demo+<hex>@betleads.io without a label", () => {
    const email = demoEmail(undefined);
    expect(email).toMatch(/^demo\+[0-9a-f]{8}@betleads\.io$/);
  });

  it("generates distinct 24-char passwords", () => {
    const a = randomPassword();
    const b = randomPassword();
    expect(a).toHaveLength(24);
    expect(b).toHaveLength(24);
    expect(a).not.toBe(b);
  });
});

describe("createDemoLogin", () => {
  it("refuses when the demo tenant does not exist", async () => {
    const client = makeFakeClient({ tenant: null });
    await expect(createDemoLogin(client as never, { label: "x" })).rejects.toThrow(/not found/);
  });

  it("refuses when the demo tenant is not flagged is_demo", async () => {
    const client = makeFakeClient({ tenant: { id: DEMO_TENANT_ID, slug: "demo", is_demo: false } });
    await expect(createDemoLogin(client as never, { label: "x" })).rejects.toThrow(/not flagged is_demo/);
  });

  it("creates an Auth user with is_demo_user=true and a gestor role in the demo tenant", async () => {
    const client = makeFakeClient();
    const result = await createDemoLogin(client as never, { label: "prospect x" });

    expect(result.email).toMatch(/^demo\+prospect-x-[0-9a-f]{8}@betleads\.io$/);
    expect(result.password).toHaveLength(24);
    expect(result.tenantId).toBe(DEMO_TENANT_ID);

    const user = client._users.get(result.userId);
    expect(user?.app_metadata).toMatchObject({ is_demo_user: true });
    expect(client._roles).toEqual([{ user_id: result.userId, tenant_id: DEMO_TENANT_ID, role: "gestor" }]);
  });

  it("stores no expiry field (nothing would enforce it)", async () => {
    const client = makeFakeClient();
    const result = await createDemoLogin(client as never, { label: "x" });
    const user = client._users.get(result.userId);
    expect(user?.app_metadata).toEqual({ is_demo_user: true });
    expect(result).not.toHaveProperty("expiresAt");
  });

  it("never grants admin/super_admin or another tenant's role", async () => {
    const client = makeFakeClient();
    await createDemoLogin(client as never, { label: "x" });
    for (const role of client._roles) {
      expect(role.tenant_id).toBe(DEMO_TENANT_ID);
      expect(role.role).toBe("gestor");
    }
  });

  it("adds the login as a manager of the demo group when one holds the demo tenant", async () => {
    const client = makeFakeClient({ groupId: DEMO_GROUP_ID });
    const result = await createDemoLogin(client as never, { label: "x" });
    expect(client._managers).toEqual([{ group_id: DEMO_GROUP_ID, user_id: result.userId }]);
  });

  it("creates the login normally when no demo group exists yet", async () => {
    const client = makeFakeClient({ groupId: null });
    const result = await createDemoLogin(client as never, { label: "x" });
    expect(client._managers).toEqual([]);
    expect(result.userId).toBeTruthy();
  });
});

describe("createDemoLogins", () => {
  it("creates `count` distinct logins sharing label", async () => {
    const client = makeFakeClient();
    const results = await createDemoLogins(client as never, { count: 3, label: "lote" });
    expect(results).toHaveLength(3);
    const emails = new Set(results.map((r) => r.email));
    expect(emails.size).toBe(3);
    expect(client._roles).toHaveLength(3);
  });

  it("rejects a non-positive count", async () => {
    const client = makeFakeClient();
    await expect(createDemoLogins(client as never, { count: 0 })).rejects.toThrow(/positive integer/);
  });
});

describe("revokeDemoLogin", () => {
  it("bans the user and removes its user_roles row", async () => {
    const client = makeFakeClient();
    const created = await createDemoLogin(client as never, { label: "x" });

    const revoked = await revokeDemoLogin(client as never, { email: created.email });
    expect(revoked.userId).toBe(created.userId);

    const user = client._users.get(created.userId);
    expect(user?.banned_until ?? (user as unknown as { ban_duration?: string })?.ban_duration).toBeTruthy();
    expect(client._roles).toEqual([]);
  });

  it("throws when the e-mail is not found", async () => {
    const client = makeFakeClient();
    await expect(revokeDemoLogin(client as never, { email: "nobody@betleads.io" })).rejects.toThrow(/no user found/);
  });

  it("refuses to revoke a user that is not a demo user", async () => {
    const client = makeFakeClient();
    const { data } = await client.auth.admin.createUser({
      email: "real@betleads.io",
      password: "x",
      email_confirm: true,
      app_metadata: {},
    });
    await expect(revokeDemoLogin(client as never, { email: data.user.email })).rejects.toThrow(/not a demo user/);
  });
});
