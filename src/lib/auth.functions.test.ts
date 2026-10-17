// Fix round (Tasks 12+13, item 11): demo logins cannot change their password.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@tanstack/react-start", () => {
  const chain = { middleware: () => chain, inputValidator: () => chain, handler: () => chain };
  return { createServerFn: () => chain };
});

import { changeInitialPasswordFor } from "./auth.functions";
import { isDemoBlockedError } from "./demo-tenant";

function fakeAdmin(appMetadata: Record<string, unknown>) {
  const updateUserById = vi.fn(async () => ({ error: null }));
  return {
    updateUserById,
    client: {
      auth: {
        admin: {
          getUserById: async () => ({ data: { user: { app_metadata: appMetadata } }, error: null }),
          updateUserById,
        },
      },
    },
  };
}

describe("changeInitialPasswordFor", () => {
  it("refuses a demo user with DEMO_ACTION_BLOCKED and writes nothing", async () => {
    const { client, updateUserById } = fakeAdmin({
      is_demo_user: true,
      force_password_change: true,
    });
    const error = await changeInitialPasswordFor(client, "u1", "nova-senha-123").catch((e) => e);
    expect(isDemoBlockedError(error)).toBe(true);
    expect(error.code).toBe("DEMO_ACTION_BLOCKED");
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("changes the password and clears force_password_change for a normal user", async () => {
    const { client, updateUserById } = fakeAdmin({ force_password_change: true, role: "x" });
    await expect(changeInitialPasswordFor(client, "u1", "nova-senha-123")).resolves.toEqual({
      ok: true,
    });
    expect(updateUserById).toHaveBeenCalledWith("u1", {
      password: "nova-senha-123",
      app_metadata: { force_password_change: false, role: "x" },
    });
  });
});
