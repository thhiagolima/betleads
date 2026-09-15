// Server functions de Super Admin: gerenciamento de usuários, preços e impersonação.
import { createServerFn } from "@tanstack/react-start";
import { dbUuid } from "@/lib/zod-helpers";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function assertSuperAdmin(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("is_super_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Apenas o super admin pode realizar esta ação");
}

// ─── Listagem com uso ────────────────────────────────────────────────────────
const listInput = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .default({});

export const adminListUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => listInput.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const args: Record<string, string> = {};
    if (data.from) args._from = data.from;
    if (data.to) args._to = data.to;
    const { data: rows, error } = await supabaseAdmin.rpc("admin_list_users_with_usage", args);
    if (error) throw new Error(error.message);
    return { users: rows ?? [] };
  });

export const adminPlatformMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => listInput.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const args: Record<string, string> = {};
    if (data.from) args._from = data.from;
    if (data.to) args._to = data.to;
    const { data: metrics, error } = await supabaseAdmin.rpc("admin_platform_metrics", args);
    if (error) throw new Error(error.message);
    return { metrics: metrics ?? {} };
  });

// ─── Preços ─────────────────────────────────────────────────────────────────
export const getPricing = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("platform_pricing")
      .select("channel, price_per_unit, unit_label, updated_at")
      .order("channel");
    if (error) throw new Error(error.message);
    return { pricing: data ?? [] };
  });

const pricingInput = z.object({
  channel: z.enum(["sms", "call", "email"]),
  price_per_unit: z.number().min(0).max(1000),
});

export const setPricing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => pricingInput.parse(data))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("platform_pricing")
      .update({ price_per_unit: data.price_per_unit, updated_at: new Date().toISOString() })
      .eq("channel", data.channel);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ─── Criar novo usuário (com tenant próprio) ────────────────────────────────
const createUserInput = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
  display_name: z.string().min(1).max(200),
});

export const adminCreateUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => createUserInput.parse(data))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 1. Cria o usuário em auth.users (email já confirmado)
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
    });
    if (createErr) throw new Error(createErr.message);
    const newUser = created.user;
    if (!newUser) throw new Error("Falha ao criar usuário");

    // 2. Cria um tenant para esse usuário
    const slug = `${data.email
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")}-${newUser.id.slice(0, 8)}`;
    const { data: tenant, error: tenantErr } = await supabaseAdmin
      .from("tenants")
      .insert({ nome: data.display_name, slug })
      .select("id")
      .single();
    if (tenantErr) {
      await supabaseAdmin.auth.admin.deleteUser(newUser.id).catch(() => {});
      throw new Error(tenantErr.message);
    }

    // 3. Liga o usuário ao tenant com role 'user'
    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: newUser.id, tenant_id: tenant.id, role: "user" });
    if (roleErr) {
      try { await supabaseAdmin.from("tenants").delete().eq("id", tenant.id); } catch {}
      try { await supabaseAdmin.auth.admin.deleteUser(newUser.id); } catch {}
      throw new Error(roleErr.message);
    }

    return { ok: true, user_id: newUser.id, tenant_id: tenant.id };
  });

// ─── Ativar / desativar usuário ─────────────────────────────────────────────
const setActiveInput = z.object({
  user_id: dbUuid(),
  active: z.boolean(),
});

export const adminSetUserActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => setActiveInput.parse(data))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    if (data.user_id === context.userId) {
      throw new Error("Você não pode desativar sua própria conta");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
      ban_duration: data.active ? "none" : "876000h", // 100 anos
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ─── Excluir usuário ────────────────────────────────────────────────────────
const deleteInput = z.object({ user_id: dbUuid() });

export const adminDeleteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => deleteInput.parse(data))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    if (data.user_id === context.userId) {
      throw new Error("Você não pode excluir sua própria conta");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Descobre o tenant para também limpar
    const { data: roles } = await supabaseAdmin
      .from("user_roles")
      .select("tenant_id")
      .eq("user_id", data.user_id);
    const tenantIds = (roles ?? []).map((r) => r.tenant_id).filter(Boolean) as string[];

    // Remove roles primeiro (FK protege)
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.user_id);

    // Exclui usuário do auth (cascade nas tabelas que referenciam auth.users)
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.user_id);
    if (error) throw new Error(error.message);

    // Opcional: marcar o tenant órfão como desativado. Como pode ter dados
    // que o super admin queira inspecionar, NÃO apagamos automaticamente.
    return { ok: true, removed_tenants: tenantIds };
  });

// ─── Gerar link de "Entrar como" ────────────────────────────────────────────
const impersonateInput = z.object({ user_id: dbUuid() });

export const adminGenerateLoginLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => impersonateInput.parse(data))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Pega o email do alvo
    const { data: target, error: getErr } = await supabaseAdmin.auth.admin.getUserById(data.user_id);
    if (getErr) throw new Error(getErr.message);
    if (!target.user?.email) throw new Error("Usuário sem email");

    const { data: link, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: target.user.email,
    });
    if (error) throw new Error(error.message);

    return { action_link: link.properties?.action_link ?? null, email: target.user.email };
  });