import { createServerFn } from "@tanstack/react-start";
import { dbUuid } from "@/lib/zod-helpers";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertTenantNotDemo } from "./tenant-access.server";

/**
 * `whatsapp_proxies` is a global, admin-role-gated table with no `tenant_id`
 * column, so these actions can only guard the caller's OWN current tenant.
 * R10: a super admin with no resolvable current tenant must still be allowed
 * through (never newly blocked) — a demo user always resolves to the demo
 * tenant, so that case stays blocked regardless.
 */
export async function guardCallerTenantNotDemo(supabase: {
  // Supabase generates a literal union of RPC names; this structural
  // boundary intentionally accepts both that generated client and
  // lightweight test doubles (same pattern as tenant-access.server.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: (...args: any[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}) {
  const { data: tenantId, error } = await supabase.rpc("current_tenant_id");
  if (error) throw new Error(error.message);
  if (!tenantId) return;
  await assertTenantNotDemo(String(tenantId));
}

const protocolEnum = z.enum(["http", "https", "socks4", "socks5"]);

const baseSchema = z.object({
  name: z.string().trim().min(1).max(80),
  protocol: protocolEnum,
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().max(120).optional().nullable(),
  password: z.string().max(255).optional().nullable(),
  provider: z.string().trim().max(80).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  status: z.enum(["active", "inactive"]).optional(),
});

function shapePublic(row: any) {
  if (!row) return row;
  const { password_encrypted, ...rest } = row;
  return { ...rest, has_password: Boolean(password_encrypted) };
}

export const listWhatsappProxies = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("whatsapp_proxies")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { proxies: (data ?? []).map(shapePublic) };
  });

export const createWhatsappProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => baseSchema.parse(input))
  .handler(async ({ data, context }) => {
    await guardCallerTenantNotDemo(context.supabase);
    const { data: row, error } = await context.supabase
      .from("whatsapp_proxies")
      .insert({
        name: data.name,
        protocol: data.protocol,
        host: data.host,
        port: data.port,
        username: data.username || null,
        password_encrypted: data.password ? data.password : null,
        provider: data.provider || null,
        notes: data.notes || null,
        status: data.status ?? "active",
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { proxy: shapePublic(row) };
  });

export const updateWhatsappProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => baseSchema.partial().extend({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await guardCallerTenantNotDemo(context.supabase);
    const patch: {
      name?: string;
      protocol?: "http" | "https" | "socks4" | "socks5";
      host?: string;
      port?: number;
      username?: string | null;
      provider?: string | null;
      notes?: string | null;
      status?: "active" | "inactive";
      password_encrypted?: string;
    } = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.protocol !== undefined) patch.protocol = data.protocol;
    if (data.host !== undefined) patch.host = data.host;
    if (data.port !== undefined) patch.port = data.port;
    if (data.username !== undefined) patch.username = data.username || null;
    if (data.provider !== undefined) patch.provider = data.provider || null;
    if (data.notes !== undefined) patch.notes = data.notes || null;
    if (data.status !== undefined) patch.status = data.status;
    if (typeof data.password === "string" && data.password.length > 0) {
      patch.password_encrypted = data.password;
    }
    const { data: row, error } = await context.supabase
      .from("whatsapp_proxies")
      .update(patch)
      .eq("id", data.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return { proxy: shapePublic(row) };
  });

export const deleteWhatsappProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid(), force: z.boolean().optional() }).parse(input))
  .handler(async ({ data, context }) => {
    await guardCallerTenantNotDemo(context.supabase);
    const { count } = await context.supabase
      .from("whatsapp_sessions")
      .select("id", { count: "exact", head: true })
      .eq("proxy_id", data.id);
    if ((count ?? 0) > 0 && !data.force) {
      throw new Error(
        `Este proxy está vinculado a ${count} sessão(ões). Desvincule antes ou use force.`,
      );
    }
    if ((count ?? 0) > 0 && data.force) {
      await context.supabase
        .from("whatsapp_sessions")
        .update({ proxy_id: null })
        .eq("proxy_id", data.id);
    }
    const { error } = await context.supabase.from("whatsapp_proxies").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const testWhatsappProxy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: dbUuid().optional(),
        inline: z
          .object({
            protocol: protocolEnum,
            host: z.string().min(1),
            port: z.number().int().min(1).max(65535),
            username: z.string().optional().nullable(),
            password: z.string().optional().nullable(),
          })
          .optional(),
      })
      .refine((v) => v.id || v.inline, "id ou inline é obrigatório")
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await guardCallerTenantNotDemo(context.supabase);
    // Opens a raw TCP socket: super admin only, public hosts only (SEC-17).
    const { runWhatsappProxyTest } = await import("./whatsapp-proxy-test.server");
    return runWhatsappProxyTest(context.supabase, context.userId, data);
  });

export const assignProxyToSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        session_id: dbUuid(),
        proxy_id: dbUuid().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const [{ data: session }, { data: proxy }] = await Promise.all([
      context.supabase
        .from("whatsapp_sessions")
        .select("id, tenant_id")
        .eq("id", data.session_id)
        .maybeSingle(),
      data.proxy_id
        ? context.supabase
            .from("whatsapp_proxies")
            .select("id")
            .eq("id", data.proxy_id)
            .maybeSingle()
        : Promise.resolve({ data: { id: null } }),
    ]);
    if (!session || !proxy) throw new Error("Sessão ou proxy não encontrado nesta tenant");
    await assertTenantNotDemo((session as any).tenant_id);
    const { error } = await context.supabase
      .from("whatsapp_sessions")
      .update({ proxy_id: data.proxy_id })
      .eq("id", data.session_id);
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("whatsapp_proxy_logs").insert({
      session_id: data.session_id,
      proxy_id: data.proxy_id,
      event: "linked",
      detail: { proxy_id: data.proxy_id },
    });
    return { ok: true };
  });
