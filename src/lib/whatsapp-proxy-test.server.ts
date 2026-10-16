// Server-only logic behind testWhatsappProxy (SEC-17).
// The test opens a raw TCP socket, so it is a platform operation (super admin
// only) and the proxy host must resolve to a public address. The socket is
// pinned to the validated address to avoid a second DNS resolution.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertSuperAdmin } from "./provider-governance.server";
import { assertSafeOutboundHost, UnsafeOutboundUrlError } from "./ssrf-guard.server";
import { testProxyHandshake } from "./whatsapp-proxy.server";

export type ProxyTestInput = {
  id?: string;
  inline?: {
    protocol: "http" | "https" | "socks4" | "socks5";
    host: string;
    port: number;
    username?: string | null;
    password?: string | null;
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user-scoped Supabase client (RLS) or a test double.
type UserDb = { from: (table: string) => any };

export async function runWhatsappProxyTest(
  supabase: UserDb,
  userId: string,
  input: ProxyTestInput,
) {
  await assertSuperAdmin(userId);

  let target: {
    protocol: string;
    host: string;
    port: number;
    username?: string | null;
    password?: string | null;
  };
  if (input.id) {
    const { data: allowed } = await supabase
      .from("whatsapp_proxies")
      .select("id")
      .eq("id", input.id)
      .maybeSingle();
    if (!allowed) throw new Error("Proxy não encontrado nesta tenant");
    const { data: row, error } = await supabaseAdmin
      .from("whatsapp_proxies")
      .select("protocol, host, port, username, password_encrypted")
      .eq("id", input.id)
      .single();
    if (error || !row) throw new Error("Proxy não encontrado");
    target = {
      protocol: row.protocol,
      host: row.host,
      port: row.port,
      username: row.username,
      password: row.password_encrypted,
    };
  } else if (input.inline) {
    target = input.inline;
  } else {
    throw new Error("id ou inline é obrigatório");
  }

  let addresses: string[];
  try {
    addresses = await assertSafeOutboundHost(target.host);
  } catch (e) {
    const reason = e instanceof UnsafeOutboundUrlError ? e.message : "host inválido";
    throw new Error(`Host do proxy bloqueado: ${reason}`);
  }

  const started = Date.now();
  const result = await testProxyHandshake({ ...target, host: addresses[0] });
  const latency_ms = Date.now() - started;

  if (input.id) {
    await supabaseAdmin
      .from("whatsapp_proxies")
      .update({
        last_tested_at: new Date().toISOString(),
        last_test_ok: result.ok,
        last_test_error: result.ok ? null : (result.error ?? null),
      })
      .eq("id", input.id);
    await supabaseAdmin.from("whatsapp_proxy_logs").insert({
      proxy_id: input.id,
      event: result.ok ? "test_ok" : "test_failed",
      detail: { latency_ms, stage: result.stage, error: result.error ?? null },
    });
  }
  return { ok: result.ok, latency_ms, stage: result.stage, error: result.error ?? null };
}
