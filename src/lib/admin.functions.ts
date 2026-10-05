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

async function auditAdminAction(args: {
  actorUserId: string;
  action: string;
  targetUserId?: string | null;
  tenantId?: string | null;
  before?: unknown;
  after?: unknown;
}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("admin_audit_logs").insert({
    actor_user_id: args.actorUserId,
    action: args.action,
    target_user_id: args.targetUserId ?? null,
    tenant_id: args.tenantId ?? null,
    before_data: args.before ?? null,
    after_data: args.after ?? null,
  });
  if (error) console.warn("[admin] audit failed", error.message);
}

export const adminGetSmsProviderConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertSuperAdmin(context.userId);
    const webhookSecret = process.env.SHORT_BRASIL_WEBHOOK_SECRET ?? "SEU_WEBHOOK_SECRET";
    const appUrl = (process.env.PUBLIC_APP_URL ?? "https://betleads.io").replace(/\/$/, "");
    return {
      configured: Boolean(
        process.env.SHORT_BRASIL_SMS_USUARIO && process.env.SHORT_BRASIL_SMS_CHAVE,
      ),
      provider: "Short Brasil",
      endpoint:
        process.env.SHORT_BRASIL_SMS_SINGLE_URL ??
        "http://lp01-short.painelsms.com/bot/single-sms.php",
      callbackUrl: `${appUrl}/api/public/sms-webhook?token=${encodeURIComponent(webhookSecret)}`,
      credentials: {
        usuario: Boolean(process.env.SHORT_BRASIL_SMS_USUARIO),
        chave: Boolean(process.env.SHORT_BRASIL_SMS_CHAVE),
        webhookSecret: Boolean(process.env.SHORT_BRASIL_WEBHOOK_SECRET),
      },
    };
  });

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

    // The account directory is the source of truth for this screen.  Do not make
    // the presence of users depend on the usage aggregation RPC: an error (or a
    // stale version) of that RPC used to make the UI show "0 usuários".
    const [authResult, membershipsResult, tenantsResult, usageResult] = await Promise.all([
      supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      supabaseAdmin.from("user_roles").select("user_id,tenant_id,role"),
      supabaseAdmin.from("tenants").select("id,nome"),
      // This RPC checks auth.uid(); it must run with the requesting super
      // admin's JWT, not with the elevated client (which has no auth.uid()).
      context.supabase.rpc("admin_list_users_with_usage", args),
    ]);
    if (authResult.error) throw new Error(authResult.error.message);
    if (membershipsResult.error) throw new Error(membershipsResult.error.message);
    if (tenantsResult.error) throw new Error(tenantsResult.error.message);

    const memberships = membershipsResult.data ?? [];
    const tenantNameById = new Map(
      (tenantsResult.data ?? []).map((tenant) => [tenant.id, tenant.nome]),
    );
    const superAdminIds = new Set(
      memberships
        .filter((membership) => membership.role === "super_admin")
        .map((membership) => membership.user_id),
    );
    const membershipsByUser = new Map<string, typeof memberships>();
    for (const membership of memberships) {
      const userMemberships = membershipsByUser.get(membership.user_id) ?? [];
      userMemberships.push(membership);
      membershipsByUser.set(membership.user_id, userMemberships);
    }
    const usageByUser = new Map((usageResult.data ?? []).map((row) => [row.user_id, row]));

    const users = authResult.data.users
      .filter((user) => !superAdminIds.has(user.id))
      .map((user) => {
        const userMemberships = membershipsByUser.get(user.id) ?? [];
        const usage = usageByUser.get(user.id);
        const tenantIds = userMemberships
          .map((membership) => membership.tenant_id)
          .filter((tenantId): tenantId is string => Boolean(tenantId));
        const tenantNames = [
          ...new Set(tenantIds.map((tenantId) => tenantNameById.get(tenantId)).filter(Boolean)),
        ];
        const roles = [
          ...new Set(userMemberships.map((membership) => membership.role).filter(Boolean)),
        ];

        return {
          user_id: user.id,
          email: user.email ?? null,
          created_at: user.created_at ?? null,
          last_sign_in_at: user.last_sign_in_at ?? null,
          banned_until: user.banned_until ?? null,
          tenant_id: usage?.tenant_id ?? tenantIds[0] ?? null,
          tenant_nome: usage?.tenant_nome ?? (tenantNames.join(", ") || null),
          role: usage?.role ?? (roles.join(", ") || null),
          sms_count: usage?.sms_count ?? 0,
          sms_cost: usage?.sms_cost ?? 0,
          call_minutes: usage?.call_minutes ?? 0,
          call_cost: usage?.call_cost ?? 0,
          email_count: usage?.email_count ?? 0,
          email_cost: usage?.email_cost ?? 0,
          total_cost: usage?.total_cost ?? 0,
        };
      })
      .sort((a, b) => (a.email ?? "").localeCompare(b.email ?? "", "pt-BR"));

    return { users, usageUnavailable: Boolean(usageResult.error) };
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
    const { data: metrics, error } = await context.supabase.rpc("admin_platform_metrics", args);
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
      app_metadata: { force_password_change: true },
    });
    if (createErr) throw new Error(createErr.message);
    const newUser = created.user;
    if (!newUser) throw new Error("Falha ao criar usuário");

    // 2. Cria um tenant para esse usuário

    // 3. Liga o usuário ao tenant com role 'user'
    await auditAdminAction({
      actorUserId: context.userId,
      action: "user.created",
      targetUserId: newUser.id,
      after: { email: newUser.email },
    });
    return { ok: true, user_id: newUser.id };
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
    await auditAdminAction({
      actorUserId: context.userId,
      action: data.active ? "user.activated" : "user.deactivated",
      targetUserId: data.user_id,
      after: { active: data.active },
    });
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

    await auditAdminAction({
      actorUserId: context.userId,
      action: "user.deleted",
      targetUserId: data.user_id,
      before: { tenant_ids: tenantIds },
    });

    // Remove roles primeiro (FK protege)
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.user_id);

    // Exclui usuário do auth (cascade nas tabelas que referenciam auth.users)
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.user_id);
    if (error) throw new Error(error.message);

    // Opcional: marcar o tenant órfão como desativado. Como pode ter dados
    // que o super admin queira inspecionar, NÃO apagamos automaticamente.
    return { ok: true, removed_tenants: tenantIds };
  });

const membershipInput = z.object({
  user_id: dbUuid(),
  tenant_id: dbUuid(),
  role: z.enum(["admin", "gestor", "member"]),
});

const userAccessInput = z.object({ user_id: dbUuid() });

export const adminGetUserAccesses = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => userAccessInput.parse(data))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: memberships, error: membershipErr }, { data: tenants, error: tenantErr }] =
      await Promise.all([
        supabaseAdmin
          .from("user_roles")
          .select("id,tenant_id,role,created_at")
          .eq("user_id", data.user_id)
          .not("tenant_id", "is", null),
        supabaseAdmin.from("tenants").select("id,nome,slug").order("nome"),
      ]);
    if (membershipErr) throw new Error(membershipErr.message);
    if (tenantErr) throw new Error(tenantErr.message);
    const tenantById = new Map((tenants ?? []).map((tenant) => [tenant.id, tenant]));
    return {
      tenants: tenants ?? [],
      memberships: (memberships ?? []).map((membership) => ({
        ...membership,
        tenant: tenantById.get(membership.tenant_id),
      })),
    };
  });

export const adminAssignUserToTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => membershipInput.parse(data))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: before, error: beforeErr } = await supabaseAdmin
      .from("user_roles")
      .select("id,user_id,tenant_id,role")
      .eq("user_id", data.user_id)
      .eq("tenant_id", data.tenant_id)
      .maybeSingle();
    if (beforeErr) throw new Error(beforeErr.message);
    if (before?.role === "admin" && data.role !== "admin") {
      throw new Error("Transfira a administração para outro usuário antes de rebaixar o admin atual");
    }
    if (data.role === "admin" && before?.role !== "admin") {
      const { data: currentAdmin, error: adminErr } = await supabaseAdmin
        .from("user_roles")
        .select("id,user_id")
        .eq("tenant_id", data.tenant_id)
        .eq("role", "admin")
        .maybeSingle();
      if (adminErr) throw new Error(adminErr.message);
      if (currentAdmin) {
        throw new Error("Este tenant já possui um admin. Use a transferência de administração.");
      }
    }

    const request = before
      ? supabaseAdmin.from("user_roles").update({ role: data.role }).eq("id", before.id)
      : supabaseAdmin.from("user_roles").insert({ user_id: data.user_id, tenant_id: data.tenant_id, role: data.role });
    const { error } = await request;
    if (error) throw new Error(error.message);
    await auditAdminAction({
      actorUserId: context.userId,
      action: before ? "user_membership.updated" : "user_membership.created",
      targetUserId: data.user_id,
      tenantId: data.tenant_id,
      before,
      after: data,
    });
    return { ok: true };
  });

const removeMembershipInput = z.object({ user_id: dbUuid(), tenant_id: dbUuid() });

export const adminRemoveUserFromTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => removeMembershipInput.parse(data))
  .handler(async ({ data, context }) => {
    await assertSuperAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: before, error: beforeErr } = await supabaseAdmin
      .from("user_roles")
      .select("id,user_id,tenant_id,role")
      .eq("user_id", data.user_id)
      .eq("tenant_id", data.tenant_id)
      .maybeSingle();
    if (beforeErr) throw new Error(beforeErr.message);
    if (!before) throw new Error("Vínculo não encontrado");
    if (before.role === "admin")
      throw new Error("Defina outro admin antes de remover este vínculo");
    const { error } = await supabaseAdmin.from("user_roles").delete().eq("id", before.id);
    if (error) throw new Error(error.message);
    await auditAdminAction({ actorUserId: context.userId, action: "user_membership.removed", targetUserId: data.user_id, tenantId: data.tenant_id, before });
    return { ok: true };
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
    const { data: target, error: getErr } = await supabaseAdmin.auth.admin.getUserById(
      data.user_id,
    );
    if (getErr) throw new Error(getErr.message);
    if (!target.user?.email) throw new Error("Usuário sem email");

    // Do not rely on Supabase's project Site URL here: it may still point to
    // localhost and would send an impersonation link to the wrong host.
    const redirectTo = (process.env.PUBLIC_APP_URL ?? "https://betleads.io").replace(/\/$/, "");
    const { data: link, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: target.user.email,
      options: { redirectTo },
    });
    if (error) throw new Error(error.message);

    return { action_link: link.properties?.action_link ?? null, email: target.user.email };
  });
