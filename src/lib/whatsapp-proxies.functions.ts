import { createServerFn } from "@tanstack/react-start";
import { dbUuid } from "@/lib/zod-helpers";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { testProxyHandshake } from "./whatsapp-proxy.server";

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
  .inputValidator((input) =>
    baseSchema.partial().extend({ id: dbUuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
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
  .inputValidator((input) =>
    z.object({ id: dbUuid(), force: z.boolean().optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
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
    const { error } = await context.supabase
      .from("whatsapp_proxies")
      .delete()
      .eq("id", data.id);
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
    let target: {
      protocol: string;
      host: string;
      port: number;
      username?: string | null;
      password?: string | null;
    };
    if (data.id) {
      const { data: row, error } = await supabaseAdmin
        .from("whatsapp_proxies")
        .select("protocol, host, port, username, password_encrypted")
        .eq("id", data.id)
        .single();
      if (error || !row) throw new Error("Proxy não encontrado");
      target = {
        protocol: row.protocol,
        host: row.host,
        port: row.port,
        username: row.username,
        password: row.password_encrypted,
      };
    } else {
      target = data.inline!;
    }

    const started = Date.now();
    const result = await testProxyHandshake(target);
    const latency_ms = Date.now() - started;

    if (data.id) {
      await supabaseAdmin
        .from("whatsapp_proxies")
        .update({
          last_tested_at: new Date().toISOString(),
          last_test_ok: result.ok,
          last_test_error: result.ok ? null : result.error ?? null,
        })
        .eq("id", data.id);
      await supabaseAdmin.from("whatsapp_proxy_logs").insert({
        proxy_id: data.id,
        event: result.ok ? "test_ok" : "test_failed",
        detail: { latency_ms, stage: result.stage, error: result.error ?? null },
      });
    }
    void context;
    return { ok: result.ok, latency_ms, stage: result.stage, error: result.error ?? null };
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