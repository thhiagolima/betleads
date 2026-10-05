import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const changeInitialPasswordInput = z.object({
  password: z.string().min(8).max(200),
});

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
    const { data: current, error: currentError } = await supabaseAdmin.auth.admin.getUserById(
      context.userId,
    );
    if (currentError) throw new Error(currentError.message);
    if (!current.user) throw new Error("Usuário não encontrado");

    const { error } = await supabaseAdmin.auth.admin.updateUserById(context.userId, {
      password: data.password,
      app_metadata: {
        ...current.user.app_metadata,
        force_password_change: false,
      },
    });
    if (error) throw new Error(error.message);

    return { ok: true };
  });
