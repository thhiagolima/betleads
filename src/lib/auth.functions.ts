import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DemoTenantBlockedError } from "@/lib/demo-tenant";

const changeInitialPasswordInput = z.object({
  password: z.string().min(8).max(200),
});

type AdminAuthClient = {
  auth: {
    admin: {
      getUserById: (id: string) => Promise<{
        data: { user: { app_metadata?: Record<string, unknown> | null } | null };
        error: { message: string } | null;
      }>;
      updateUserById: (
        id: string,
        attrs: { password: string; app_metadata: Record<string, unknown> },
      ) => Promise<{ error: { message: string } | null }>;
    };
  };
};

/**
 * Body of `changeInitialPassword` (the `*For` convention keeps it unit
 * testable). Demo logins (`app_metadata.is_demo_user`) never change their
 * password (spec §7/§11): they are refused with DEMO_ACTION_BLOCKED before
 * anything is written.
 */
export async function changeInitialPasswordFor(
  admin: AdminAuthClient,
  userId: string,
  password: string,
) {
  const { data: current, error: currentError } = await admin.auth.admin.getUserById(userId);
  if (currentError) throw new Error(currentError.message);
  if (!current.user) throw new Error("Usuário não encontrado");
  if (current.user.app_metadata?.is_demo_user === true) {
    throw new DemoTenantBlockedError("DEMO_ACTION_BLOCKED");
  }

  const { error } = await admin.auth.admin.updateUserById(userId, {
    password,
    app_metadata: {
      ...current.user.app_metadata,
      force_password_change: false,
    },
  });
  if (error) throw new Error(error.message);

  return { ok: true };
}

/**
 * Finaliza a ativação de contas que receberam uma senha temporária.
 * A atualização é feita com a chave administrativa para que o marcador em
 * app_metadata não possa ser removido diretamente pelo navegador.
 */
export const changeInitialPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => changeInitialPasswordInput.parse(data))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return changeInitialPasswordFor(
      supabaseAdmin as unknown as AdminAuthClient,
      context.userId,
      data.password,
    );
  });
