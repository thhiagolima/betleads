import { createServerFn } from "@tanstack/react-start";
import { dbUuid } from "@/lib/zod-helpers";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { evolutionFetch, isEvolutionConnectionClosed, mapEvolutionState, setEvolutionProxy } from "./evolution.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function fingerprintKey(key: string): Promise<string> {
  try {
    const buf = new TextEncoder().encode(key);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash))
      .slice(0, 4)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "n/a";
  }
}

// Diagnostic — hits Evolution directly with the SAME wrapper the rest of the
// app uses and returns the raw HTTP status + body. Used by the WhatsApp page
// to compare the BETLEADS request vs. the working VPS curl.
export const diagnoseEvolution = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const url = process.env.EVOLUTION_API_URL?.trim().replace(/\/$/, "");
    const rawKey = process.env.EVOLUTION_API_KEY ?? "";
    const key = rawKey.trim().replace(/^['"]|['"]$/g, "");
    if (!url || !key) {
      return { ok: false, error: "EVOLUTION_API_URL / EVOLUTION_API_KEY not configured" };
    }
    const target = `${url}/instance/fetchInstances`;
    const apikeyFingerprint = await fingerprintKey(key);
    try {
      const data = await evolutionFetch("/instance/fetchInstances");
      return {
        ok: true,
        url: target,
        method: "GET",
        apikeyFingerprint,
        apikeyLength: key.length,
        responseStatus: 200,
        responseBody: JSON.stringify(data).slice(0, 1000),
      };
    } catch (e: any) {
      return {
        ok: false,
        url: target,
        method: "GET",
        apikeyFingerprint,
        apikeyLength: key.length,
        responseStatus: e?.status ?? 0,
        responseBody: (e?.rawBody ?? e?.message ?? String(e)).slice(0, 1000),
      };
    }
  });

// Returns the Evolution base URL + apikey to the authenticated browser session
// so the frontend can open a socket.io connection and receive `qrcode.updated`
// / `connection.update` events in real time (Evolution API v2.x).
// Only authenticated users get this — gated by requireSupabaseAuth.
export const getEvolutionRealtimeConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Restrito a super admin — o apikey global do Evolution dá controle
    // sobre TODAS as instâncias WhatsApp, então jamais expor a tenants.
    const { data: isSuper, error: roleErr } = await supabaseAdmin.rpc(
      "is_super_admin",
      { _user_id: context.userId },
    );
    if (roleErr) throw new Error(roleErr.message);
    if (!isSuper) throw new Error("Apenas o super admin pode acessar esta configuração");
    const url = process.env.EVOLUTION_API_URL;
    const key = process.env.EVOLUTION_API_KEY;
    if (!url || !key) throw new Error("Evolution não configurada");
    return {
      url: url.trim().replace(/\/$/, ""),
      apikey: key.trim().replace(/^['"]|['"]$/g, ""),
    };
  });

export const listWhatsappSessions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("whatsapp_sessions")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return { sessions: data ?? [] };
  });

export const createWhatsappSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      name: z.string().min(1).max(100),
      instance_name: z
        .string()
        .min(2)
        .max(60)
        .regex(/^[a-z0-9_-]+$/, "Use apenas letras minúsculas, números, _ ou -"),
      phone_number: z.string().max(30).optional().nullable(),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    // SOURCE OF TRUTH = Evolution. Any non-2xx is a hard failure — never
    // mask it as "maybe already exists" and never save locally.
    let createResp: any;
    try {
      createResp = await evolutionFetch("/instance/create", {
        method: "POST",
        body: {
          instanceName: data.instance_name,
          qrcode: true,
          integration: "WHATSAPP-BAILEYS",
        },
      });
    } catch (e: any) {
      throw new Error(
        `Evolution recusou a criação: ${e?.message ?? "erro desconhecido"}. Nada foi salvo no BETLEADS.`,
      );
    }

    // Evolution v2 returns the QR code directly in the create response.
    const createBase64 =
      createResp?.qrcode?.base64 ??
      createResp?.qrcode?.code ??
      createResp?.base64 ??
      null;
    const createdQr = createBase64
      ? createBase64.startsWith("data:")
        ? createBase64
        : `data:image/png;base64,${createBase64}`
      : null;

    // 2) Only now persist locally.
    const { data: inserted, error } = await context.supabase
      .from("whatsapp_sessions")
      .insert({
        name: data.name,
        instance_name: data.instance_name,
        phone_number: data.phone_number ?? null,
        status: createdQr ? "qrcode" : "disconnected",
        qr_code: createdQr,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    // 3) Registra webhook na Evolution para essa instância (não-fatal).
    try {
      await evolutionFetch(`/webhook/set/${encodeURIComponent(data.instance_name)}`, {
        method: "POST",
        body: {
          webhook: {
            enabled: true,
            url: webhookUrl(),
            byEvents: false,
            base64: false,
            events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "SEND_MESSAGE", "CONNECTION_UPDATE"],
          },
          enabled: true,
          url: webhookUrl(),
          events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "SEND_MESSAGE", "CONNECTION_UPDATE"],
        },
      });
    } catch (e: any) {
      console.warn("[whatsapp] webhook/set after create failed (ignored):", e?.message);
    }

    return { session: inserted };
  });

export const connectWhatsappSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: session, error: selErr } = await context.supabase
      .from("whatsapp_sessions")
      .select("*")
      .eq("id", data.id)
      .single();
    if (selErr || !session) throw new Error("Sessão não encontrada");

    // Aplica proxy vinculado (se houver) ANTES de iniciar o connect. A senha
    // é lida via supabaseAdmin (server-only) e nunca trafega pelo browser.
    if ((session as any).proxy_id) {
      try {
        const { data: proxy } = await supabaseAdmin
          .from("whatsapp_proxies")
          .select("protocol, host, port, username, password_encrypted, status")
          .eq("id", (session as any).proxy_id)
          .single();
        if (proxy && proxy.status === "active") {
          await setEvolutionProxy(session.instance_name, {
            protocol: proxy.protocol,
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password_encrypted,
          });
          await supabaseAdmin.from("whatsapp_proxy_logs").insert({
            proxy_id: (session as any).proxy_id,
            session_id: session.id,
            event: "sent_to_evolution",
            detail: { instance: session.instance_name },
          });
        } else if (proxy && proxy.status !== "active") {
          // Proxy inativo — desabilita na Evolution para evitar usar config velha.
          await setEvolutionProxy(session.instance_name, null).catch(() => {});
        }
      } catch (e: any) {
        await supabaseAdmin.from("whatsapp_proxy_logs").insert({
          proxy_id: (session as any).proxy_id,
          session_id: session.id,
          event: "connect_failed",
          detail: { error: e?.message ?? String(e) },
        });
        throw new Error(
          `Falha ao aplicar proxy na sessão: ${e?.message ?? "erro desconhecido"}`,
        );
      }
    } else {
      // Sem proxy vinculado — garante que a Evolution não use proxy antigo.
      await setEvolutionProxy(session.instance_name, null).catch(() => {});
    }

    // Evolution API v2.2.3 — multi-endpoint strategy for QR / connect.
    // Tries the endpoints that are known to exist in this version, in order:
    //   1) GET  /instance/connect/{name}        (returns { base64, code, pairingCode })
    //   2) POST /instance/restart/{name}        (forces a fresh QR cycle)
    //   3) GET  /instance/fetchInstances?instanceName={name}  (some builds embed qrcode here)
    // If none of them produce a base64, we fall back to connectionState only.
    let qrImage: string | null = null;
    let state: string | undefined;

    const extractQr = (r: any): string | null => {
      const b64 =
        r?.qrcode?.base64 ??
        r?.qrcode?.code ??
        r?.base64 ??
        r?.instance?.qrcode?.base64 ??
        (typeof r?.code === "string" ? r.code : null);
      if (!b64) return null;
      return b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`;
    };

    const name = encodeURIComponent(session.instance_name);

    // 0) Ensure websocket is enabled for this instance — Evolution v2 only emits
    // qrcode.updated / connection.update over socket.io when the instance has
    // websocket explicitly enabled. Non-fatal: some builds auto-enable it.
    try {
      await evolutionFetch(`/websocket/set/${name}`, {
        method: "POST",
        body: {
          enabled: true,
          events: [
            "QRCODE_UPDATED",
            "CONNECTION_UPDATE",
            "qrcode.updated",
            "connection.update",
          ],
        },
      });
    } catch (e: any) {
      console.warn("[whatsapp] /websocket/set failed (ignored):", e?.message);
    }

    // 1) /instance/connect/{name}
    try {
      const r = await evolutionFetch(`/instance/connect/${name}`);
      qrImage = extractQr(r);
      state = mapEvolutionState(r?.instance?.state);
    } catch (e: any) {
      console.warn("[whatsapp] /instance/connect failed:", e?.message);
    }

    // 2) /instance/restart/{name}
    if (!qrImage) {
      try {
        const r = await evolutionFetch(`/instance/restart/${name}`, { method: "POST" });
        qrImage = extractQr(r);
      } catch (e: any) {
        console.warn("[whatsapp] /instance/restart failed:", e?.message);
      }
    }

    // 3) /instance/fetchInstances?instanceName={name}
    if (!qrImage) {
      try {
        const r: any = await evolutionFetch(
          `/instance/fetchInstances?instanceName=${name}`,
        );
        const item = Array.isArray(r) ? r[0] : Array.isArray(r?.instances) ? r.instances[0] : r;
        qrImage = extractQr(item);
        if (!state) state = mapEvolutionState(item?.instance?.state ?? item?.connectionStatus);
      } catch (e: any) {
        console.warn("[whatsapp] /instance/fetchInstances failed:", e?.message);
      }
    }

    // 4) Fallback: just read connectionState
    if (!state) {
      try {
        const r = await evolutionFetch(`/instance/connectionState/${name}`);
        state = mapEvolutionState(r?.instance?.state);
      } catch (e: any) {
        console.warn("[whatsapp] /instance/connectionState failed:", e?.message);
      }
    }

    const newStatus =
      state === "connected" ? "connected" : qrImage ? "qrcode" : state ?? "connecting";

    await context.supabase
      .from("whatsapp_sessions")
      .update({
        qr_code: qrImage ?? session.qr_code,
        status: newStatus,
        last_connected_at: newStatus === "connected" ? new Date().toISOString() : session.last_connected_at,
      })
      .eq("id", data.id);

    return { qr_code: qrImage ?? session.qr_code, status: newStatus };
  });

export const getWhatsappSessionStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: session, error: selErr } = await context.supabase
      .from("whatsapp_sessions")
      .select("*")
      .eq("id", data.id)
      .single();
    if (selErr || !session) throw new Error("Sessão não encontrada");

    let status = session.status;
    try {
      const resp = await evolutionFetch(
        `/instance/connectionState/${encodeURIComponent(session.instance_name)}`,
      );
      status = mapEvolutionState(resp?.instance?.state);
    } catch (e) {
      // Keep previous status if Evolution unreachable
    }

    const updates: {
      status: string;
      last_connected_at?: string;
      last_disconnected_at?: string;
      qr_code?: string | null;
    } = { status };
    if (status === "connected") {
      updates.last_connected_at = new Date().toISOString();
      updates.qr_code = null;
    } else if (status === "disconnected" && session.status === "connected") {
      updates.last_disconnected_at = new Date().toISOString();
    }

    await context.supabase.from("whatsapp_sessions").update(updates).eq("id", data.id);

    return { status, qr_code: status === "connected" ? null : session.qr_code };
  });

export const disconnectWhatsappSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: session, error: selErr } = await context.supabase
      .from("whatsapp_sessions")
      .select("instance_name")
      .eq("id", data.id)
      .single();
    if (selErr || !session) throw new Error("Sessão não encontrada");

    try {
      await evolutionFetch(`/instance/logout/${encodeURIComponent(session.instance_name)}`, {
        method: "DELETE",
      });
    } catch (e: any) {
      // Continue even if already logged out
      console.warn("[whatsapp] logout failed:", e.message);
    }

    await context.supabase
      .from("whatsapp_sessions")
      .update({
        status: "disconnected",
        qr_code: null,
        last_disconnected_at: new Date().toISOString(),
      })
      .eq("id", data.id);

    // Marca todos os leads vinculados como órfãos para realocação manual.
    await context.supabase
      .from("lead_whatsapp_assignments")
      .update({ status: "orphaned" })
      .eq("session_id", data.id)
      .eq("status", "active");

    return { ok: true };
  });

export const deleteWhatsappSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({ id: dbUuid(), force: z.boolean().optional() })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: session } = await context.supabase
      .from("whatsapp_sessions")
      .select("instance_name")
      .eq("id", data.id)
      .single();

    if (!data.force) {
      // Bloqueia exclusão se ainda houver leads vinculados — força realocação primeiro.
      // Conta via admin para enxergar registros com tenant_id legado (não filtrados por RLS).
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { count: assignedCount } = await supabaseAdmin
        .from("lead_whatsapp_assignments")
        .select("id", { count: "exact", head: true })
        .eq("session_id", data.id);
      if ((assignedCount ?? 0) > 0) {
        throw new Error(
          `Esta sessão tem ${assignedCount} lead(s) vinculado(s). Realoque para outra sessão antes de excluir.`,
        );
      }
    } else {
      // Force: remove vínculos de leads e limpa histórico antes de excluir.
      // Usa admin para limpar TAMBÉM linhas com tenant_id legado (00000000…),
      // que o RLS do usuário esconde e que deixam a FK
      // lead_whatsapp_assignments_session_id_fkey segurando o DELETE da sessão.
      // Escopo: session_id = data.id — o usuário já provou ser dono dela ao
      // conseguir lê-la via context.supabase logo acima.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error: assignErr } = await supabaseAdmin
        .from("lead_whatsapp_assignments")
        .delete()
        .eq("session_id", data.id);
      if (assignErr) throw new Error(assignErr.message);
      await supabaseAdmin
        .from("whatsapp_messages")
        .delete()
        .eq("session_id", data.id);
      await supabaseAdmin
        .from("whatsapp_chats")
        .delete()
        .eq("session_id", data.id);
    }

    if (session) {
      try {
        await evolutionFetch(`/instance/delete/${encodeURIComponent(session.instance_name)}`, {
          method: "DELETE",
        });
      } catch (e: any) {
        console.warn("[whatsapp] delete instance failed:", e.message);
      }
    }

    const { error } = await context.supabase
      .from("whatsapp_sessions")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);

    return { ok: true };
  });

export const renameWhatsappSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: dbUuid(),
        name: z.string().trim().min(1).max(60),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: updated, error } = await context.supabase
      .from("whatsapp_sessions")
      .update({ name: data.name })
      .eq("id", data.id)
      .select("id, name")
      .single();
    if (error) throw new Error(error.message);
    return { id: updated.id, name: updated.name };
  });

export const clearWhatsappSessionHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error: msgErr } = await context.supabase
      .from("whatsapp_messages")
      .delete()
      .eq("session_id", data.id);
    if (msgErr) throw new Error(msgErr.message);
    const { error: chatErr } = await context.supabase
      .from("whatsapp_chats")
      .delete()
      .eq("session_id", data.id);
    if (chatErr) throw new Error(chatErr.message);
    return { ok: true };
  });

export const syncWhatsappSessions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // NOTE: /instance/fetchInstances is unreliable in current Evolution
    // versions (returns [] even when instances exist). We MUST NOT depend on
    // it as the source of truth. Strategy:
    //   1) Try fetchInstances ONLY to discover instances we don't know about locally (additive).
    //   2) Probe each local session via /instance/connectionState/{name} to refresh its real state.
    //   3) Never mark a local session as orphan based on fetchInstances being empty.
    //   4) Empty array or any error from fetchInstances is non-fatal — keep going.
    const evolutionNames = new Set<string>();
    try {
      const raw: any = await evolutionFetch("/instance/fetchInstances");
      const list: any[] = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.instances)
          ? raw.instances
          : Array.isArray(raw?.data)
            ? raw.data
            : [];
      for (const it of list) {
        const n =
          it?.instance?.instanceName ??
          it?.instanceName ??
          it?.name ??
          it?.instance?.name;
        if (typeof n === "string" && n.length > 0) evolutionNames.add(n);
      }
    } catch (e: any) {
      // Non-fatal: API inconsistent. Continue with per-instance probing.
      console.warn("[whatsapp] fetchInstances failed (ignored):", e?.message);
    }

    const { data: locals, error: selErr } = await context.supabase
      .from("whatsapp_sessions")
      .select("id, instance_name, status");
    if (selErr) throw new Error(selErr.message);

    // Probe each local session for its real state. Keep local row regardless.
    let refreshed = 0;
    for (const s of locals ?? []) {
      try {
        const resp: any = await evolutionFetch(
          `/instance/connectionState/${encodeURIComponent(s.instance_name)}`,
        );
        const status = mapEvolutionState(resp?.instance?.state);
        const updates: {
          status: string;
          last_connected_at?: string;
          qr_code?: string | null;
        } = { status };
        if (status === "connected") {
          updates.last_connected_at = new Date().toISOString();
          updates.qr_code = null;
        }
        await context.supabase.from("whatsapp_sessions").update(updates).eq("id", s.id);
        refreshed++;
      } catch (e: any) {
        // Instance may not exist on Evolution OR endpoint flaky — do not mark as orphan,
        // just leave the local row untouched.
        console.warn(`[whatsapp] connectionState failed for ${s.instance_name} (ignored):`, e?.message);
      }
    }

    // IMPORTANT: never insert sessions from Evolution's fetchInstances.
    // Evolution is shared across tenants and has no tenant scoping, so an
    // additive insert here would (a) resurrect sessions deleted locally and
    // (b) leak instances from other tenants into the current tenant_id.
    // The DB is the source of truth for tenant ownership; createWhatsappSession
    // is the only path that may create a row.
    return { evolution_count: evolutionNames.size, added: 0, refreshed, marked: 0, removed: 0 };
  });

// ============================================================
// INBOX (chats + messages)
// ============================================================

function projectPublicUrl(): string {
  const url = process.env.PUBLIC_APP_URL ?? process.env.APP_URL;
  if (!url) {
    throw new Error("PUBLIC_APP_URL is required to register Evolution webhooks");
  }
  return url.replace(/\/+$/, "");
}

function webhookUrl(): string {
  const token = process.env.EVOLUTION_WEBHOOK_SECRET ?? process.env.EVOLUTION_API_KEY ?? "";
  return `${projectPublicUrl()}/api/public/evolution-webhook?token=${encodeURIComponent(token)}`;
}

function evolutionNumber(remoteJid: string): string {
  if (remoteJid.endsWith("@g.us")) return remoteJid;
  const bare = remoteJid.split("@")[0] ?? remoteJid;
  const digits = bare.replace(/\D/g, "");
  return digits || remoteJid;
}

async function ensureEvolutionConnected(instance: string) {
  // Pré-checagem tolerante: alguns builds da Evolution exigem apikey global
  // em /instance/connectionState e retornam 403 mesmo quando a instância
  // está OK. Nunca bloqueamos o envio aqui — deixamos o endpoint de envio
  // ser a fonte de verdade do erro.
  try {
    const endpoint = `/instance/connectionState/${encodeURIComponent(instance)}`;
    const resp = await evolutionFetch(endpoint);
    const state = mapEvolutionState(resp?.instance?.state);
    if (state && state !== "connected" && state !== "unknown") {
      console.warn(`[whatsapp] instância ${instance} estado=${state} (seguindo envio mesmo assim)`);
    }
  } catch (err) {
    console.warn(`[whatsapp] connectionState check falhou (ignorado):`, (err as Error)?.message);
  }
}

function logWhatsappSend(details: Record<string, unknown>) {
  console.info("[whatsapp-send]", JSON.stringify(details));
}

async function markWhatsappSessionDisconnected(
  supabase: any,
  sessionId: string,
  reason: string,
) {
  await supabase
    .from("whatsapp_sessions")
    .update({
      status: "disconnected",
      qr_code: null,
      last_disconnected_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  console.warn("[whatsapp] session marked disconnected", JSON.stringify({ sessionId, reason }));
}

/**
 * Gera variações de um telefone brasileiro com/sem o 9º dígito.
 * Para números BR de 13 dígitos (55 + DDD + 9XXXXXXXX), também tenta sem o 9.
 * Para números BR de 12 dígitos (55 + DDD + XXXXXXXX), também tenta com o 9.
 * Outros países retornam só o original.
 */
function brazilianPhoneVariants(rawDigits: string): string[] {
  let digits = rawDigits.replace(/\D/g, "");
  if (!digits) return [];
  // Assume Brasil quando vier sem DDI (10 ou 11 dígitos: DDD + número).
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  const variants = new Set<string>([digits]);
  if (digits.startsWith("55")) {
    const rest = digits.slice(2);
    if (rest.length === 11 && rest[2] === "9") {
      // 13 dígitos → tira o 9
      variants.add(`55${rest.slice(0, 2)}${rest.slice(3)}`);
    } else if (rest.length === 10) {
      // 12 dígitos → adiciona o 9
      variants.add(`55${rest.slice(0, 2)}9${rest.slice(2)}`);
    }
  }
  return [...variants];
}

/**
 * Pergunta à Evolution qual variante do número existe no WhatsApp.
 * Retorna o `number` confirmado pela própria Evolution (a ser usado no envio),
 * ou null se nenhuma variante existir.
 */
async function resolveWhatsappNumber(
  instance: string,
  rawDigits: string,
): Promise<{ number: string; jid: string; tried: string[] } | null> {
  const tried = brazilianPhoneVariants(rawDigits);
  if (tried.length === 0) return null;
  try {
    const resp: any = await evolutionFetch(
      `/chat/whatsappNumbers/${encodeURIComponent(instance)}`,
      { method: "POST", body: { numbers: tried } },
    );
    const arr: any[] = Array.isArray(resp) ? resp : Array.isArray(resp?.response?.message) ? resp.response.message : [];
    const hit = arr.find((r) => r?.exists === true);
    console.info(
      "[whatsapp] number-resolve",
      JSON.stringify({ original: rawDigits, tried, picked: hit?.number ?? null }),
    );
    if (!hit) return null;
    const number = String(hit.number ?? hit.jid?.split("@")[0] ?? "").replace(/\D/g, "");
    const jid = String(hit.jid ?? `${number}@s.whatsapp.net`);
    return { number, jid, tried };
  } catch (e: any) {
    console.warn("[whatsapp] number-resolve falhou:", e?.message);
    if (isEvolutionConnectionClosed(e)) throw e;
    // Em caso de falha de checagem, segue tentando com o original.
    return { number: tried[0], jid: `${tried[0]}@s.whatsapp.net`, tried };
  }
}

// Registra (ou re-registra) o webhook desta instância na Evolution.
export const configureEvolutionWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ instance_name: z.string().min(1) }).parse(input))
  .handler(async ({ data }) => {
    const url = webhookUrl();
    const events = [
      "MESSAGES_UPSERT",
      "MESSAGES_UPDATE",
      "SEND_MESSAGE",
      "CONNECTION_UPDATE",
      "CHATS_UPSERT",
      "CONTACTS_UPSERT",
    ];
    // Evolution v2: POST /webhook/set/{instance}
    try {
      await evolutionFetch(`/webhook/set/${encodeURIComponent(data.instance_name)}`, {
        method: "POST",
        body: {
          webhook: { enabled: true, url, byEvents: false, base64: false, events },
          // Alguns builds aceitam o formato "flat":
          enabled: true,
          url,
          events,
        },
      });
    } catch (e: any) {
      console.warn("[whatsapp] webhook/set failed:", e?.message);
      throw new Error(`Falha ao configurar webhook: ${e?.message}`);
    }
    return { ok: true, url };
  });

export const listInboxChats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("whatsapp_chats")
      .select("id, session_id, remote_jid, phone, name, is_group, unread_count, last_message, last_message_at, profile_pic_url, whatsapp_sessions:session_id(name)")
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(200);
    if (error) throw new Error(error.message);
    // Busca os assignments para sobrescrever a sessão "ativa" do lead
    const phones = Array.from(
      new Set(
        (data ?? [])
          .filter((c: any) => !c.is_group && c.phone)
          .map((c: any) => c.phone as string),
      ),
    );
    type Assign = {
      phone_e164: string;
      session_id: string;
      status: string;
      session_name: string | null;
    };
    const assignByPhone = new Map<string, Assign>();
    if (phones.length > 0) {
      const { data: assigns } = await context.supabase
        .from("lead_whatsapp_assignments")
        .select("phone_e164, session_id, status, whatsapp_sessions:session_id(name)")
        .in("phone_e164", phones);
      for (const a of assigns ?? []) {
        assignByPhone.set(a.phone_e164 as string, {
          phone_e164: a.phone_e164 as string,
          session_id: a.session_id as string,
          status: a.status as string,
          session_name: ((a as any).whatsapp_sessions?.name as string) ?? null,
        });
      }
    }

    // Agrupa 1:1 por telefone (mantém somente o chat mais recente da sessão ATIVA do assignment)
    const groupedById = new Map<string, any>();
    const seenPhones = new Set<string>();
    for (const c of data ?? []) {
      if (c.is_group) {
        groupedById.set(c.id, c);
        continue;
      }
      if (!c.phone) {
        groupedById.set(c.id, c);
        continue;
      }
      if (seenPhones.has(c.phone)) continue;
      const assign = assignByPhone.get(c.phone);
      // Se há assignment, prioriza o chat da sessão ativa do assignment; se não
      // achar nesta iteração, mantém o primeiro encontrado (último ts).
      if (assign) {
        // Procura entre os chats deste phone o que pertence à sessão ativa.
        const same = (data ?? []).find(
          (x: any) =>
            !x.is_group && x.phone === c.phone && x.session_id === assign.session_id,
        );
        const chosen = same ?? c;
        seenPhones.add(c.phone);
        groupedById.set(chosen.id, chosen);
      } else {
        seenPhones.add(c.phone);
        groupedById.set(c.id, c);
      }
    }

    const chats = Array.from(groupedById.values()).map((c: any) => {
      const assign = !c.is_group && c.phone ? assignByPhone.get(c.phone) : null;
      return {
        id: c.id,
        session_id: assign?.session_id ?? c.session_id,
        remote_jid: c.remote_jid,
        phone: c.phone,
        name: c.name,
        is_group: c.is_group,
        unread_count: c.unread_count,
        last_message: c.last_message,
        last_message_at: c.last_message_at,
        profile_pic_url: c.profile_pic_url,
        session_name: assign?.session_name ?? c.whatsapp_sessions?.name ?? null,
        orphaned: assign?.status === "orphaned",
        last_message_from_me: false as boolean,
        pending_count: 0 as number,
      };
    });
    // Reordena por last_message_at desc (o Map pode embaralhar)
    chats.sort((a, b) => {
      const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return tb - ta;
    });
    // Marca cada chat com a direção da última mensagem (pendente = inbound).
    const chatIds = chats.map((c) => c.id);
    if (chatIds.length > 0) {
      const { data: msgs } = await context.supabase
        .from("whatsapp_messages")
        .select("chat_id, from_me, created_at")
        .in("chat_id", chatIds)
        .order("created_at", { ascending: false })
        .limit(5000);
      const lastByChat = new Map<string, boolean>();
      const pendingByChat = new Map<string, number>();
      const stopped = new Set<string>();
      for (const m of msgs ?? []) {
        const cid = (m as any).chat_id as string;
        const fromMe = !!(m as any).from_me;
        if (!lastByChat.has(cid)) lastByChat.set(cid, fromMe);
        if (stopped.has(cid)) continue;
        if (fromMe) {
          stopped.add(cid);
          continue;
        }
        pendingByChat.set(cid, (pendingByChat.get(cid) ?? 0) + 1);
      }
      for (const c of chats) {
        c.last_message_from_me = lastByChat.get(c.id) ?? true;
        c.pending_count = pendingByChat.get(c.id) ?? 0;
        // Fallback: se a dedup por telefone escolheu um id sem mensagens,
        // usa o unread_count nativo do WhatsApp.
        if (c.pending_count === 0 && (c.unread_count ?? 0) > 0) {
          c.pending_count = c.unread_count;
        }
      }
    }
    return { chats };
  });

// Conta conversas com pendência real: a última mensagem é do contato
// (from_me = false) e ainda não houve resposta nossa depois.
export const getWhatsappPendingTotal = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Soma `unread_count` de todos os chats — mesma fonte da bolinha por
    // conversa no inbox (estilo WhatsApp: zera quando o chat é aberto).
    const { data, error } = await context.supabase
      .from("whatsapp_chats")
      .select("unread_count")
      .gt("unread_count", 0);
    if (error) return { pending: 0 };
    let pending = 0;
    for (const c of data ?? []) pending += (c as any).unread_count ?? 0;
    return { pending };
  });

// Retorna o perfil resumido do lead pelo telefone (já normalizado em dígitos):
// dados do player + último gatilho disparado para exibir no painel lateral
// do Inbox. Devolve null se não houver player vinculado.
export const getLeadProfileByPhone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ phone: z.string().min(8).max(20) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const phone = data.phone.replace(/\D/g, "");
    if (!phone) return { player: null, lastTrigger: null };

    // Gera variantes para celular BR: com e sem o 9 após o DDD. Evolution às
    // vezes entrega o número sem o 9; no banco o player costuma estar com 9
    // (ou vice-versa). Sem isso, o match exato falha e o painel mostra
    // "não vinculado" mesmo existindo player.
    const variants = new Set<string>([phone]);
    if (phone.startsWith("55") && phone.length >= 12) {
      const ddd = phone.slice(2, 4);
      const rest = phone.slice(4);
      if (rest.length === 8) variants.add(`55${ddd}9${rest}`);
      if (rest.length === 9 && rest.startsWith("9"))
        variants.add(`55${ddd}${rest.slice(1)}`);
    }

    // Player: tenta match por telefone normalizado. A coluna `telefone` em
    // `players` é texto livre, então normaliza no lado servidor.
    const { data: candidates } = await context.supabase
      .from("players")
      .select(
        "id, nome, telefone, vip, status, saldo_carteira, total_depositado, total_sacado, ultimo_login, ultimo_jogo, ultimo_deposito, expert, risco, tags",
      )
      .ilike("telefone", `%${phone.slice(-8)}%`)
      .limit(20);
    const player =
      (candidates ?? []).find(
        (p) => variants.has((p.telefone ?? "").replace(/\D/g, "")),
      ) ?? null;

    let lastTrigger: { trigger_type: string; rule_name: string | null; fired_at: string } | null = null;
    if (player) {
      const { data: alerts } = await context.supabase
        .from("lead_alerts")
        .select("trigger_type, fired_at, rule_id")
        .eq("player_id", player.id)
        .order("fired_at", { ascending: false })
        .limit(1);
      const a = alerts?.[0];
      if (a) {
        let rule_name: string | null = null;
        if (a.rule_id) {
          const { data: rule } = await context.supabase
            .from("rules")
            .select("name")
            .eq("id", a.rule_id)
            .maybeSingle();
          rule_name = rule?.name ?? null;
        }
        lastTrigger = {
          trigger_type: a.trigger_type as string,
          rule_name,
          fired_at: a.fired_at as string,
        };
      }
    }

    return { player, lastTrigger };
  });

export const listChatMessages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ chat_id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    // Zera o unread ao abrir
    await context.supabase
      .from("whatsapp_chats")
      .update({ unread_count: 0 })
      .eq("id", data.chat_id);
    // Descobre o lead deste chat. Se for 1:1, agrega o histórico de TODAS as
    // sessões que esse telefone já usou (mantém histórico após reconexão/realocação).
    const { data: thisChat } = await context.supabase
      .from("whatsapp_chats")
      .select("id, is_group, phone, remote_jid")
      .eq("id", data.chat_id)
      .single();
    let chatIds: string[] = [data.chat_id];
    if (thisChat && !thisChat.is_group && thisChat.phone) {
      const { data: siblings } = await context.supabase
        .from("whatsapp_chats")
        .select("id")
        .eq("phone", thisChat.phone)
        .eq("is_group", false);
      chatIds = (siblings ?? []).map((s) => s.id);
      if (chatIds.length === 0) chatIds = [data.chat_id];
    }
    const { data: messages, error } = await context.supabase
      .from("whatsapp_messages")
      .select("id, from_me, message_type, text, media_url, media_mimetype, media_filename, media_size, media_duration, message_timestamp, status, sender_name, session_id")
      .in("chat_id", chatIds)
      .order("message_timestamp", { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    // Bucket é privado: gera signed URL (1h) para cada mídia.
    // Backward-compat: rows antigas guardavam URL pública completa — extrai o path se necessário.
    const list = messages ?? [];
    const extractPath = (val: string): string | null => {
      if (!val) return null;
      if (!val.startsWith("http")) return val; // já é um path
      const marker = "/whatsapp-media/";
      const idx = val.indexOf(marker);
      return idx >= 0 ? val.substring(idx + marker.length).split("?")[0] : null;
    };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const signed = await Promise.all(
      list.map(async (m) => {
        if (!m.media_url) return m;
        const path = extractPath(m.media_url);
        if (!path) return m;
        const { data: sig } = await supabaseAdmin.storage
          .from("whatsapp-media")
          .createSignedUrl(path, 60 * 60);
        return { ...m, media_url: sig?.signedUrl ?? null };
      }),
    );
    return { messages: signed };
  });

export const sendWhatsappMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      chat_id: dbUuid(),
      text: z.string().min(1).max(4000),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: chat, error } = await context.supabase
      .from("whatsapp_chats")
      .select("id, session_id, remote_jid, phone, is_group")
      .eq("id", data.chat_id)
      .single();
    if (error || !chat) throw new Error("Conversa não encontrada");

    // Para 1:1, usa a sessão do assignment ativo (não a sessão original do chat).
    let sessionId = chat.session_id as string;
    if (!chat.is_group && chat.phone) {
      const { data: assignment } = await context.supabase
        .from("lead_whatsapp_assignments")
        .select("session_id, status")
        .eq("phone_e164", chat.phone)
        .maybeSingle();
      if (assignment) {
        if (assignment.status === "orphaned") {
          throw new Error(
            "Esta conversa está sem sessão ativa — realoque o lead em WhatsApp → Sessões antes de enviar.",
          );
        }
        sessionId = assignment.session_id;
      }
    }

    const { data: session, error: sErr } = await context.supabase
      .from("whatsapp_sessions")
      .select("id, instance_name, status, name")
      .eq("id", sessionId)
      .single();
    if (sErr || !session) throw new Error("Sessão não encontrada");
    if (session.status !== "connected") {
      throw new Error(`Sessão "${session.name}" não está conectada`);
    }
    const instance = session.instance_name;

    // Se a sessão de envio é diferente da sessão original do chat, cria/usa
    // chat dentro da nova sessão para preservar o histórico antigo intacto.
    let chatId = chat.id as string;
    if (sessionId !== chat.session_id) {
      const { data: existing } = await context.supabase
        .from("whatsapp_chats")
        .select("id")
        .eq("session_id", sessionId)
        .eq("remote_jid", chat.remote_jid)
        .maybeSingle();
      if (existing) {
        chatId = existing.id;
      } else {
        const ins = await context.supabase
          .from("whatsapp_chats")
          .insert({
            session_id: sessionId,
            remote_jid: chat.remote_jid,
            phone: chat.phone,
            is_group: chat.is_group,
            name: null,
            last_message_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (ins.error || !ins.data) throw new Error(ins.error?.message ?? "Falha ao criar conversa");
        chatId = ins.data.id;
      }
    }

    const number = evolutionNumber(chat.remote_jid);
    const endpoint = `/message/sendText/${encodeURIComponent(instance)}`;
    // Payload oficial Evolution v2: { number, text } — único formato aceito.
    // NÃO enviar message/body/content/caption/mensagem/textMessage.
    const payload = { number, text: data.text };
    logWhatsappSend({ endpoint, instance, number, kind: "text", payload });
    let resp: any;
    try {
      resp = await evolutionFetch(endpoint, { method: "POST", body: payload });
    } catch (e: any) {
      if (isEvolutionConnectionClosed(e)) {
        await markWhatsappSessionDisconnected(context.supabase, session.id, "send_text_connection_closed");
        throw new Error(`Sessão "${session.name}" caiu na Evolution. Reconecte em WhatsApp → Sessões antes de enviar.`);
      }
      const raw = (e?.rawBody ?? e?.message ?? "").toString().slice(0, 300);
      throw new Error(
        `Evolution recusou envio de texto (status=${e?.status ?? 0}, instance=${instance}, number=${number}). raw=${raw}`,
      );
    }

    // Aceita múltiplos formatos de retorno da Evolution (v1, v2, builds custom).
    const msgId =
      resp?.key?.id ??
      resp?.message?.key?.id ??
      resp?.data?.key?.id ??
      resp?.response?.key?.id ??
      resp?.messageId ??
      null;
    const ts = new Date().toISOString();
    await context.supabase.from("whatsapp_messages").insert({
      chat_id: chatId,
      session_id: sessionId,
      evolution_message_id: msgId,
      remote_jid: chat.remote_jid,
      from_me: true,
      message_type: "text",
      text: data.text,
      raw: resp,
      message_timestamp: ts,
    });
    await context.supabase
      .from("whatsapp_chats")
      .update({ last_message: data.text, last_message_at: ts })
      .eq("id", chatId);

    return { ok: true };
  });

// ============================================================
// ENVIO DE MÍDIA
// ============================================================
const mediaInputSchema = z.object({
  chat_id: dbUuid(),
  kind: z.enum(["image", "video", "audio", "document"]),
  base64: z.string().min(1),
  mimetype: z.string().min(1).max(150),
  filename: z.string().min(1).max(255),
  caption: z.string().max(2000).optional().nullable(),
});

async function sendWhatsappMediaInternal(
  data: z.infer<typeof mediaInputSchema>,
  context: any,
  forcedKind?: "image" | "video" | "audio" | "document",
) {
    const kind = forcedKind ?? data.kind;
    if (kind !== data.kind) throw new Error(`Tipo de mídia inválido: esperado ${forcedKind}.`);
    const cleanBase64 = data.base64.replace(/^data:[^,]*base64,/i, "").replace(/\s+/g, "");
    const cleanMimetype = data.mimetype.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
    const filename = data.filename;
    const { data: chat, error } = await context.supabase
      .from("whatsapp_chats")
      .select("id, session_id, remote_jid, phone, is_group")
      .eq("id", data.chat_id)
      .single();
    if (error || !chat) throw new Error("Conversa não encontrada");

    // Resolve sessão ativa via assignment (1:1)
    let sessionId = chat.session_id as string;
    if (!chat.is_group && chat.phone) {
      const { data: assignment } = await context.supabase
        .from("lead_whatsapp_assignments")
        .select("session_id, status")
        .eq("phone_e164", chat.phone)
        .maybeSingle();
      if (assignment) {
        if (assignment.status === "orphaned") {
          throw new Error(
            "Esta conversa está sem sessão ativa — realoque o lead em WhatsApp → Sessões antes de enviar.",
          );
        }
        sessionId = assignment.session_id;
      }
    }
    const { data: session, error: sErr } = await context.supabase
      .from("whatsapp_sessions")
      .select("id, instance_name, status, name")
      .eq("id", sessionId)
      .single();
    if (sErr || !session) throw new Error("Sessão não encontrada");
    if (session.status !== "connected") {
      throw new Error(`Sessão "${session.name}" não está conectada`);
    }
    const instance = session.instance_name;

    // Se mudou de sessão, garante chat correspondente
    let chatId = chat.id as string;
    if (sessionId !== chat.session_id) {
      const { data: existing } = await context.supabase
        .from("whatsapp_chats")
        .select("id")
        .eq("session_id", sessionId)
        .eq("remote_jid", chat.remote_jid)
        .maybeSingle();
      if (existing) chatId = existing.id;
      else {
        const ins = await context.supabase
          .from("whatsapp_chats")
          .insert({
            session_id: sessionId,
            remote_jid: chat.remote_jid,
            phone: chat.phone,
            is_group: chat.is_group,
            last_message_at: new Date().toISOString(),
          })
          .select("id").single();
        if (ins.error || !ins.data) throw new Error(ins.error?.message ?? "Falha ao criar conversa");
        chatId = ins.data.id;
      }
    }

    const number = evolutionNumber(chat.remote_jid);

    const bin = Uint8Array.from(atob(cleanBase64), (c) => c.charCodeAt(0));
    const ext = filename.includes(".") ? filename.split(".").pop() : "bin";
    const path = `outgoing/${instance}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await context.supabase.storage
      .from("whatsapp-media")
      .upload(path, bin, { contentType: cleanMimetype, upsert: false });
    if (upErr) {
      throw new Error(`Falha ao subir mídia: ${upErr.message}`);
    }
    // Bucket é privado: geramos uma URL assinada de curta duração só para a Evolution baixar.
    const { data: signed, error: signErr } = await context.supabase.storage
      .from("whatsapp-media")
      .createSignedUrl(path, 60 * 60); // 1h
    if (signErr || !signed?.signedUrl) {
      throw new Error(`Falha ao gerar URL assinada: ${signErr?.message ?? "sem detalhes"}`);
    }
    const evolutionMediaUrl = signed.signedUrl;

    // VÍDEO: WhatsApp só renderiza nativamente mp4 (H.264 + AAC). webm/quicktime/etc
    // chegam na Evolution, retornam 200, mas o WhatsApp descarta silenciosamente.
    // Também enviamos como base64 inline (não signed URL) porque o downloader da
    // Evolution falha esporadicamente em URLs assinadas longas para vídeo.
    if (kind === "video") {
      if (cleanMimetype !== "video/mp4") {
        throw new Error(
          `Formato de vídeo não suportado pelo WhatsApp: ${cleanMimetype}. ` +
            `Envie um arquivo .mp4 (H.264 + AAC).`,
        );
      }
      const MAX_VIDEO_BYTES = 16 * 1024 * 1024; // limite prático do WhatsApp
      if (bin.byteLength > MAX_VIDEO_BYTES) {
        throw new Error(
          `Vídeo muito grande (${(bin.byteLength / 1024 / 1024).toFixed(1)}MB). ` +
            `Limite do WhatsApp: 16MB.`,
        );
      }
    }

    const endpoint = kind === "audio"
      ? `/message/sendWhatsAppAudio/${encodeURIComponent(instance)}`
      : `/message/sendMedia/${encodeURIComponent(instance)}`;
    const trimmedCaption = (data.caption ?? "").trim();
    let payload: Record<string, unknown>;
    if (kind === "audio") {
      payload = { number, audio: cleanBase64, encoding: true };
    } else if (kind === "video") {
      // base64 inline — comprovadamente entrega no WhatsApp; signed URL falha em parte dos casos.
      payload = {
        number,
        mediatype: "video",
        mimetype: "video/mp4",
        media: cleanBase64,
        fileName: filename.toLowerCase().endsWith(".mp4") ? filename : `${filename}.mp4`,
      };
      if (trimmedCaption) (payload as any).caption = trimmedCaption;
    } else {
      payload = {
        number,
        mediatype: kind,
        mimetype: cleanMimetype,
        media: evolutionMediaUrl,
        fileName: filename,
      };
      if (trimmedCaption) (payload as any).caption = trimmedCaption;
    }
    logWhatsappSend({
      endpoint,
      instance,
      number,
      kind,
      mimetype: cleanMimetype,
      size: bin.byteLength,
      filename,
      payload:
        kind === "audio"
          ? { number, audio: `[base64 length=${cleanBase64.length}]`, encoding: true }
          : kind === "video"
            ? { ...payload, media: `[base64 length=${cleanBase64.length}]` }
            : { ...payload, media: `[signed-url length=${evolutionMediaUrl.length}]` },
    });
    let resp: any;
    try {
      resp = await evolutionFetch(endpoint, { method: "POST", body: payload });
    } catch (e: any) {
      if (isEvolutionConnectionClosed(e)) {
        await markWhatsappSessionDisconnected(context.supabase, session.id, "send_media_connection_closed");
        throw new Error(`Sessão "${session.name}" caiu na Evolution. Reconecte em WhatsApp → Sessões antes de enviar.`);
      }
      throw e;
    }

    const msgId = resp?.key?.id ?? resp?.messageId ?? null;
    const ts = new Date().toISOString();
    await context.supabase.from("whatsapp_messages").insert({
      chat_id: chatId,
      session_id: sessionId,
      evolution_message_id: msgId,
      remote_jid: chat.remote_jid,
      from_me: true,
      message_type: kind,
      text: data.caption ?? null,
      // Armazena APENAS o storage path; URL assinada é gerada no read (listChatMessages).
      media_url: path,
      media_mimetype: cleanMimetype,
      media_filename: filename,
      media_size: bin.byteLength,
      raw: resp,
      message_timestamp: ts,
    });

    const preview =
      kind === "image" ? `🖼️ ${data.caption ?? "Imagem"}` :
      kind === "video" ? `🎬 ${data.caption ?? "Vídeo"}` :
      kind === "audio" ? "🎤 Áudio" :
      `📎 ${filename}`;
    await context.supabase
      .from("whatsapp_chats")
      .update({ last_message: preview, last_message_at: ts })
      .eq("id", chatId);

    return { ok: true };
}

export const sendWhatsappMedia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => mediaInputSchema.parse(input))
  .handler(async ({ data, context }) => sendWhatsappMediaInternal(data, context));

export const sendWhatsappImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => mediaInputSchema.parse({ ...(input as Record<string, unknown>), kind: "image" }))
  .handler(async ({ data, context }) => sendWhatsappMediaInternal(data, context, "image"));

export const sendWhatsappVideo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => mediaInputSchema.parse({ ...(input as Record<string, unknown>), kind: "video" }))
  .handler(async ({ data, context }) => sendWhatsappMediaInternal(data, context, "video"));

export const sendWhatsappDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => mediaInputSchema.parse({ ...(input as Record<string, unknown>), kind: "document" }))
  .handler(async ({ data, context }) => sendWhatsappMediaInternal(data, context, "document"));

export const sendWhatsappAudio = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => mediaInputSchema.parse({ ...(input as Record<string, unknown>), kind: "audio" }))
  .handler(async ({ data, context }) => sendWhatsappMediaInternal(data, context, "audio"));

// ============================================================
// LEAD ROUTING — resolve qual sessão usar para um telefone
// ============================================================

// Se o telefone já está vinculado a uma sessão (lead_whatsapp_assignments),
// retorna esse vínculo (e seu status — active/orphaned). Senão devolve a
// lista de sessões disponíveis para escolha.
export const resolveSessionForLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ phone: z.string().min(4).max(30) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const digits = data.phone.replace(/\D/g, "");
    if (!digits) throw new Error("Telefone inválido");
    // 1) Fonte de verdade: tabela de assignments
    const { data: assignment } = await context.supabase
      .from("lead_whatsapp_assignments")
      .select("session_id, status, whatsapp_sessions:session_id(id, name, instance_name, status)")
      .eq("phone_e164", digits)
      .maybeSingle();
    if (assignment) {
      const sess: any = (assignment as any).whatsapp_sessions ?? {};
      let sessionStatus = (sess.status as string) ?? null;
      if (sessionStatus === "connected" && sess.id && sess.instance_name) {
        try {
          await resolveWhatsappNumber(sess.instance_name as string, digits);
        } catch (e: any) {
          if (isEvolutionConnectionClosed(e)) {
            await markWhatsappSessionDisconnected(context.supabase, sess.id as string, "resolve_pinned_connection_closed");
            sessionStatus = "disconnected";
          }
        }
      }
      // Encontra um chat existente para abrir o inbox direto, se houver
      const { data: chat } = await context.supabase
        .from("whatsapp_chats")
        .select("id")
        .eq("session_id", assignment.session_id)
        .eq("phone", digits)
        .eq("is_group", false)
        .maybeSingle();
      return {
        pinned: true as const,
        orphaned: assignment.status === "orphaned",
        chat_id: (chat?.id as string) ?? null,
        session_id: assignment.session_id as string,
        session_name: (sess.name as string) ?? null,
        session_status: sessionStatus,
      };
    }
    const { data: sessions } = await context.supabase
      .from("whatsapp_sessions")
      .select("id, name, instance_name, status")
      .order("created_at", { ascending: true });
    const checkedSessions = await Promise.all(
      (sessions ?? []).map(async (s) => {
        if (s.status !== "connected") return s;
        try {
          await resolveWhatsappNumber(s.instance_name, digits);
          return s;
        } catch (e: any) {
          if (isEvolutionConnectionClosed(e)) {
            await markWhatsappSessionDisconnected(context.supabase, s.id, "resolve_session_list_connection_closed");
            return { ...s, status: "disconnected" };
          }
          return s;
        }
      }),
    );
    return {
      pinned: false as const,
      orphaned: false as const,
      sessions: checkedSessions.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
      })),
    };
  });

// Envia texto para um telefone usando uma sessão específica. Cria o chat se
// ainda não existir. Usado pelos botões "WhatsApp" em players/alertas.
export const sendToLeadFromSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        session_id: dbUuid(),
        phone: z.string().min(4).max(30),
        text: z.string().min(1).max(4000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const digits = data.phone.replace(/\D/g, "");
    if (!digits) throw new Error("Telefone inválido");
    const { data: session, error: sErr } = await context.supabase
      .from("whatsapp_sessions")
      .select("id, instance_name, status, name")
      .eq("id", data.session_id)
      .single();
    if (sErr || !session) throw new Error("Sessão não encontrada");
    if (session.status !== "connected") {
      throw new Error(`Sessão "${session.name}" não está conectada`);
    }

    // Resolve qual variante do número existe no WhatsApp (fallback do 9º dígito BR).
    let resolved: Awaited<ReturnType<typeof resolveWhatsappNumber>>;
    try {
      resolved = await resolveWhatsappNumber(session.instance_name, digits);
    } catch (e: any) {
      if (isEvolutionConnectionClosed(e)) {
        await markWhatsappSessionDisconnected(context.supabase, session.id, "resolve_number_connection_closed");
        throw new Error(`Sessão "${session.name}" caiu na Evolution. Reconecte em WhatsApp → Sessões antes de enviar.`);
      }
      throw e;
    }
    if (!resolved) {
      throw new Error(
        `Este número não tem WhatsApp ativo (testado: ${brazilianPhoneVariants(digits).join(", ")}).`,
      );
    }
    const sendNumber = resolved.number;
    const remoteJid = resolved.jid;

    // Acha ou cria o chat dentro desta sessão.
    let chatId: string;
    const { data: existing } = await context.supabase
      .from("whatsapp_chats")
      .select("id")
      .eq("session_id", session.id)
      .eq("remote_jid", remoteJid)
      .maybeSingle();
    if (existing) {
      chatId = existing.id;
    } else {
      const ins = await context.supabase
        .from("whatsapp_chats")
        .insert({
          session_id: session.id,
          remote_jid: remoteJid,
          phone: sendNumber,
          is_group: false,
          name: sendNumber,
          last_message: data.text,
          last_message_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (ins.error || !ins.data) {
        throw new Error(ins.error?.message ?? "Falha ao criar conversa");
      }
      chatId = ins.data.id;
    }

    // Envia via Evolution.
    const endpoint = `/message/sendText/${encodeURIComponent(session.instance_name)}`;
    const payload = { number: sendNumber, text: data.text };
    let resp: any;
    try {
      resp = await evolutionFetch(endpoint, { method: "POST", body: payload });
    } catch (e: any) {
      if (isEvolutionConnectionClosed(e)) {
        await markWhatsappSessionDisconnected(context.supabase, session.id, "send_to_lead_connection_closed");
        throw new Error(`Sessão "${session.name}" caiu na Evolution. Reconecte em WhatsApp → Sessões antes de enviar.`);
      }
      const raw = (e?.rawBody ?? e?.message ?? "").toString().slice(0, 300);
      if (raw.includes('"exists":false')) {
        throw new Error("Este número não tem WhatsApp ativo.");
      }
      throw new Error(
        `Evolution recusou envio (status=${e?.status ?? 0}). raw=${raw}`,
      );
    }
    const msgId =
      resp?.key?.id ??
      resp?.message?.key?.id ??
      resp?.data?.key?.id ??
      resp?.messageId ??
      null;
    const ts = new Date().toISOString();
    await context.supabase.from("whatsapp_messages").insert({
      chat_id: chatId,
      session_id: session.id,
      evolution_message_id: msgId,
      remote_jid: remoteJid,
      from_me: true,
      message_type: "text",
      text: data.text,
      raw: resp,
      message_timestamp: ts,
    });
    await context.supabase
      .from("whatsapp_chats")
      .update({ last_message: data.text, last_message_at: ts })
      .eq("id", chatId);

    // Cria/atualiza o vínculo permanente lead -> sessão
    const { data: existingAssign } = await context.supabase
      .from("lead_whatsapp_assignments")
      .select("id, session_id, previous_session_ids, status")
      .eq("phone_e164", digits)
      .maybeSingle();
    if (!existingAssign) {
      await context.supabase.from("lead_whatsapp_assignments").insert({
        phone_e164: digits,
        session_id: session.id,
        status: "active",
      });
    } else if (
      existingAssign.session_id !== session.id ||
      existingAssign.status !== "active"
    ) {
      const prev: string[] = Array.isArray(existingAssign.previous_session_ids)
        ? (existingAssign.previous_session_ids as string[])
        : [];
      if (
        existingAssign.session_id !== session.id &&
        !prev.includes(existingAssign.session_id)
      ) {
        prev.push(existingAssign.session_id);
      }
      await context.supabase
        .from("lead_whatsapp_assignments")
        .update({
          session_id: session.id,
          previous_session_ids: prev,
          status: "active",
        })
        .eq("id", existingAssign.id);
    }

    return {
      ok: true,
      chat_id: chatId,
      session_id: session.id,
      session_name: session.name,
    };
  });

// ============================================================
// LEAD ↔ SESSÃO — vínculo permanente e realocação
// ============================================================

// Lista todos os leads (assignments) órfãos de uma sessão específica.
// Usado pelo painel de Sessões para oferecer realocação após queda/banimento.
export const listOrphanedAssignments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ session_id: dbUuid().optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("lead_whatsapp_assignments")
      .select("id, phone_e164, session_id, status, updated_at")
      .eq("status", "orphaned");
    if (data.session_id) q = q.eq("session_id", data.session_id);
    const { data: rows, error } = await q.order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    // Tenta enriquecer com nome do chat
    const phones = (rows ?? []).map((r) => r.phone_e164);
    let chatNames: Record<string, string> = {};
    if (phones.length > 0) {
      const { data: chats } = await context.supabase
        .from("whatsapp_chats")
        .select("phone, name")
        .in("phone", phones)
        .eq("is_group", false);
      for (const c of chats ?? []) {
        if (c.phone && c.name && !chatNames[c.phone]) chatNames[c.phone] = c.name;
      }
    }
    return {
      assignments: (rows ?? []).map((r) => ({
        id: r.id,
        phone_e164: r.phone_e164,
        session_id: r.session_id,
        status: r.status,
        updated_at: r.updated_at,
        lead_name: chatNames[r.phone_e164] ?? null,
      })),
    };
  });

// Realoca leads de uma sessão para outra.
// - Se assignment_ids vier preenchido, realoca só esses; senão realoca todos
//   os assignments órfãos da from_session_id.
// - A sessão antiga é empurrada para previous_session_ids.
// - Histórico em whatsapp_messages/whatsapp_chats NÃO é apagado.
export const reassignOrphanedLeads = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        from_session_id: dbUuid(),
        to_session_id: dbUuid(),
        assignment_ids: z.array(dbUuid()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    if (data.from_session_id === data.to_session_id) {
      throw new Error("Sessão de destino igual à origem");
    }
    // Garante que destino está conectado
    const { data: dest, error: dErr } = await context.supabase
      .from("whatsapp_sessions")
      .select("id, name, status")
      .eq("id", data.to_session_id)
      .single();
    if (dErr || !dest) throw new Error("Sessão de destino não encontrada");
    if (dest.status !== "connected") {
      throw new Error(`Sessão "${dest.name}" não está conectada`);
    }

    const baseQ = context.supabase
      .from("lead_whatsapp_assignments")
      .select("id, session_id, previous_session_ids")
      .eq("session_id", data.from_session_id);
    const targetQ = data.assignment_ids && data.assignment_ids.length > 0
      ? baseQ.in("id", data.assignment_ids)
      : baseQ;
    const { data: rows, error } = await targetQ;
    if (error) throw new Error(error.message);
    let moved = 0;
    for (const r of rows ?? []) {
      const prev: string[] = Array.isArray(r.previous_session_ids)
        ? (r.previous_session_ids as string[])
        : [];
      if (!prev.includes(r.session_id)) prev.push(r.session_id);
      const { error: uErr } = await context.supabase
        .from("lead_whatsapp_assignments")
        .update({
          session_id: data.to_session_id,
          previous_session_ids: prev,
          status: "active",
        })
        .eq("id", r.id);
      if (!uErr) moved++;
    }
    return { moved };
  });

// Para automações: garante que existe um assignment ativo pro telefone.
// - Se já existe assignment 'active', retorna a sessão dele.
// - Se assignment está 'orphaned', tenta promover automaticamente para uma
//   sessão conectada (a com menor messages_sent_today).
// - Se não existe, escolhe a melhor sessão conectada e cria.
// - Se não houver nenhuma sessão conectada, retorna { ok: false }.
export const getOrAssignSessionForLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        phone: z.string().min(4).max(30),
        player_id: dbUuid().optional().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const digits = data.phone.replace(/\D/g, "");
    if (!digits) throw new Error("Telefone inválido");

    const { data: existing } = await context.supabase
      .from("lead_whatsapp_assignments")
      .select("id, session_id, status, previous_session_ids, whatsapp_sessions:session_id(id, name, status)")
      .eq("phone_e164", digits)
      .maybeSingle();

    // Helper: pega a melhor sessão conectada (menor uso hoje).
    const pickBestSession = async () => {
      const { data: ss } = await context.supabase
        .from("whatsapp_sessions")
        .select("id, name, status, messages_sent_today, daily_limit")
        .eq("status", "connected")
        .order("messages_sent_today", { ascending: true, nullsFirst: true });
      const candidate = (ss ?? []).find(
        (s) => (s.messages_sent_today ?? 0) < (s.daily_limit ?? 999999),
      );
      return candidate ?? null;
    };

    if (existing) {
      const sess: any = (existing as any).whatsapp_sessions ?? {};
      if (existing.status === "active" && sess.status === "connected") {
        return {
          ok: true as const,
          session_id: existing.session_id,
          session_name: sess.name ?? null,
          reused: true as const,
          reassigned: false as const,
        };
      }
      // Órfão ou sessão caiu — realoca automaticamente.
      const best = await pickBestSession();
      if (!best) {
        return {
          ok: false as const,
          reason: "no-connected-session" as const,
        };
      }
      const prev: string[] = Array.isArray(existing.previous_session_ids)
        ? (existing.previous_session_ids as string[])
        : [];
      if (!prev.includes(existing.session_id)) prev.push(existing.session_id);
      await context.supabase
        .from("lead_whatsapp_assignments")
        .update({
          session_id: best.id,
          previous_session_ids: prev,
          status: "active",
          player_id: data.player_id ?? null,
        })
        .eq("id", existing.id);
      return {
        ok: true as const,
        session_id: best.id,
        session_name: best.name,
        reused: false as const,
        reassigned: true as const,
      };
    }

    const best = await pickBestSession();
    if (!best) {
      return { ok: false as const, reason: "no-connected-session" as const };
    }
    await context.supabase.from("lead_whatsapp_assignments").insert({
      phone_e164: digits,
      session_id: best.id,
      status: "active",
      player_id: data.player_id ?? null,
    });
    return {
      ok: true as const,
      session_id: best.id,
      session_name: best.name,
      reused: false as const,
      reassigned: false as const,
    };
  });

// "Cura" chats de grupo que ficaram com o nome errado (ex.: nome do participante
// que mandou a última mensagem, em vez do assunto do grupo). Idempotente — só
// atualiza quando o Evolution devolve um subject válido e diferente.
export const refreshGroupNames = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: sessions, error: sErr } = await context.supabase
      .from("whatsapp_sessions")
      .select("id, instance_name");
    if (sErr) throw new Error(sErr.message);
    const url = process.env.EVOLUTION_API_URL?.trim().replace(/\/$/, "");
    const apikey = process.env.EVOLUTION_API_KEY?.trim().replace(/^['"]|['"]$/g, "");
    if (!url || !apikey) return { updated: 0 };

    let updated = 0;
    for (const s of sessions ?? []) {
      const { data: groups } = await context.supabase
        .from("whatsapp_chats")
        .select("id, remote_jid, name, profile_pic_url")
        .eq("session_id", s.id)
        .eq("is_group", true);
      for (const g of groups ?? []) {
        const patch: { name?: string; profile_pic_url?: string } = {};
        try {
          const res = await fetch(
            `${url}/group/findGroupInfos/${encodeURIComponent(s.instance_name)}?groupJid=${encodeURIComponent(g.remote_jid)}`,
            { method: "GET", headers: { apikey } },
          );
          if (res.ok) {
            const json: any = await res.json().catch(() => null);
            const subject: string | undefined =
              json?.subject ?? json?.data?.subject ?? json?.[0]?.subject;
            const pic: string | undefined =
              json?.pictureUrl ?? json?.profilePictureUrl ?? json?.data?.pictureUrl;
            if (typeof subject === "string" && subject.trim() && subject.trim() !== g.name) {
              patch.name = subject.trim();
            }
            if (typeof pic === "string" && pic.startsWith("http") && pic !== g.profile_pic_url) {
              patch.profile_pic_url = pic;
            }
          }
        } catch {}
        // Fallback foto: fetchProfilePictureUrl
        if (!patch.profile_pic_url && !g.profile_pic_url) {
          try {
            const r = await fetch(
              `${url}/chat/fetchProfilePictureUrl/${encodeURIComponent(s.instance_name)}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey },
                body: JSON.stringify({ number: g.remote_jid }),
              },
            );
            if (r.ok) {
              const j: any = await r.json().catch(() => null);
              const pic: string | undefined = j?.profilePictureUrl ?? j?.url;
              if (typeof pic === "string" && pic.startsWith("http")) {
                patch.profile_pic_url = pic;
              }
            }
          } catch {}
        }
        if (Object.keys(patch).length > 0) {
          await context.supabase.from("whatsapp_chats").update(patch).eq("id", g.id);
          updated++;
        }
      }
    }
    return { updated };
  });

// "Cura" chats 1:1 que ficaram com nome igual ao número e/ou sem foto de perfil.
// Idempotente — só atualiza quando a Evolution devolve dado válido e diferente.
export const refreshContactNames = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: sessions, error: sErr } = await context.supabase
      .from("whatsapp_sessions")
      .select("id, instance_name");
    if (sErr) throw new Error(sErr.message);
    const url = process.env.EVOLUTION_API_URL?.trim().replace(/\/$/, "");
    const apikey = process.env.EVOLUTION_API_KEY?.trim().replace(/^['"]|['"]$/g, "");
    if (!url || !apikey) return { updated: 0 };

    let updated = 0;
    for (const s of sessions ?? []) {
      const { data: chats } = await context.supabase
        .from("whatsapp_chats")
        .select("id, remote_jid, phone, name, profile_pic_url")
        .eq("session_id", s.id)
        .eq("is_group", false);
      for (const c of chats ?? []) {
        const patch: { name?: string; profile_pic_url?: string } = {};
        const nameLooksWrong =
          !c.name || c.name === c.phone || c.name === c.remote_jid;
        // Nome via findContacts
        if (nameLooksWrong) {
          try {
            const r = await fetch(
              `${url}/chat/findContacts/${encodeURIComponent(s.instance_name)}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey },
                body: JSON.stringify({ where: { id: c.remote_jid } }),
              },
            );
            if (r.ok) {
              const j: any = await r.json().catch(() => null);
              const arr: any[] = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [];
              const first = arr[0];
              const cand: string | undefined =
                first?.name ?? first?.pushName ?? first?.notify ?? first?.verifiedName;
              if (typeof cand === "string" && cand.trim() && cand.trim() !== c.name) {
                patch.name = cand.trim();
              }
            }
          } catch {}
        }
        // Foto de perfil
        if (!c.profile_pic_url) {
          try {
            const r = await fetch(
              `${url}/chat/fetchProfilePictureUrl/${encodeURIComponent(s.instance_name)}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json", apikey },
                body: JSON.stringify({ number: c.remote_jid }),
              },
            );
            if (r.ok) {
              const j: any = await r.json().catch(() => null);
              const pic: string | undefined = j?.profilePictureUrl ?? j?.url;
              if (typeof pic === "string" && pic.startsWith("http")) {
                patch.profile_pic_url = pic;
              }
          }
          } catch {}
        }
        if (Object.keys(patch).length > 0) {
          await context.supabase.from("whatsapp_chats").update(patch).eq("id", c.id);
          updated++;
        }
      }
    }
    return { updated };
  });

// ============================================================
// FILA DE DISPARO — diagnóstico + destravamento + backfill de alertas
// ============================================================

// Resumo da fila de WhatsApp: contagens por estado, atrasados, falhas e
// últimos 20 leads problemáticos com motivo do último log.
export const getWhatsappQueueStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const nowIso = new Date().toISOString();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [pending, running, cooldown, overdue, failedAll, sentToday] = await Promise.all([
      supabaseAdmin.from("flow_leads").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabaseAdmin.from("flow_leads").select("id", { count: "exact", head: true }).eq("status", "running"),
      supabaseAdmin.from("flow_leads").select("id", { count: "exact", head: true }).eq("status", "cooldown"),
      supabaseAdmin
        .from("flow_leads")
        .select("id", { count: "exact", head: true })
        .in("status", ["pending", "running", "cooldown"])
        .lte("next_run_at", nowIso),
      supabaseAdmin.from("flow_leads").select("id", { count: "exact", head: true }).eq("status", "failed"),
      supabaseAdmin
        .from("flow_logs")
        .select("id", { count: "exact", head: true })
        .eq("event", "sent")
        .gte("created_at", startOfDay.toISOString()),
    ]);

    // Lista de leads "atrasados" / problemáticos para mostrar na UI
    const { data: problemRows } = await supabaseAdmin
      .from("flow_leads")
      .select("id, flow_id, player_id, phone_e164, status, next_run_at, attempt_count, last_error")
      .or(
        `and(status.in.(pending,running,cooldown),next_run_at.lte.${nowIso}),status.eq.failed`,
      )
      .order("next_run_at", { ascending: true })
      .limit(20);

    const flowIds = Array.from(new Set((problemRows ?? []).map((r) => r.flow_id)));
    const playerIds = Array.from(
      new Set((problemRows ?? []).map((r) => r.player_id).filter((v): v is string => !!v)),
    );
    const leadIds = (problemRows ?? []).map((r) => r.id);

    const [{ data: flows }, { data: players }, { data: lastLogs }] = await Promise.all([
      flowIds.length
        ? supabaseAdmin.from("flows").select("id, name").in("id", flowIds)
        : Promise.resolve({ data: [] as any[] }),
      playerIds.length
        ? supabaseAdmin.from("players").select("id, nome").in("id", playerIds)
        : Promise.resolve({ data: [] as any[] }),
      leadIds.length
        ? supabaseAdmin
            .from("flow_logs")
            .select("flow_lead_id, event, detail, created_at")
            .in("flow_lead_id", leadIds)
            .order("created_at", { ascending: false })
            .limit(200)
        : Promise.resolve({ data: [] as any[] }),
    ]);

    const flowMap = new Map((flows ?? []).map((f: any) => [f.id, f.name]));
    const playerMap = new Map((players ?? []).map((p: any) => [p.id, p.nome]));
    const lastLogByLead = new Map<string, { event: string; detail: any; created_at: string }>();
    for (const log of lastLogs ?? []) {
      if (!log.flow_lead_id) continue;
      if (!lastLogByLead.has(log.flow_lead_id)) {
        lastLogByLead.set(log.flow_lead_id, {
          event: log.event,
          detail: log.detail,
          created_at: log.created_at,
        });
      }
    }

    const problems = (problemRows ?? []).map((r) => {
      const log = lastLogByLead.get(r.id);
      const reason =
        r.last_error ??
        (log?.detail && typeof log.detail === "object"
          ? (log.detail as any).reason ?? (log.detail as any).error ?? null
          : null);
      return {
        id: r.id,
        flow_name: flowMap.get(r.flow_id) ?? "—",
        player_name: r.player_id ? (playerMap.get(r.player_id) ?? "—") : "(sem player)",
        phone: r.phone_e164,
        status: r.status,
        next_run_at: r.next_run_at,
        attempts: r.attempt_count ?? 0,
        last_event: log?.event ?? null,
        reason,
      };
    });

    return {
      counts: {
        pending: pending.count ?? 0,
        running: running.count ?? 0,
        cooldown: cooldown.count ?? 0,
        overdue: overdue.count ?? 0,
        failed: failedAll.count ?? 0,
        sent_today: sentToday.count ?? 0,
      },
      problems,
    };
  });

// Destrava leads atrasados e roda o dispatcher imediatamente (bypass janela
// opcional). Idempotente — pode chamar várias vezes sem efeito colateral.
export const resumeWhatsappQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({ bypassWindow: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const nowIso = new Date().toISOString();
    // 1) destrava cooldown atrasado → pending agora
    const { data: updated } = await supabaseAdmin
      .from("flow_leads")
      .update({ status: "pending", next_run_at: nowIso })
      .eq("status", "cooldown")
      .lte("next_run_at", nowIso)
      .select("id");
    // 2) reagenda failed antigos (>15min) para nova tentativa
    const fifteenMinAgo = new Date(Date.now() - 15 * 60_000).toISOString();
    const { data: retried } = await supabaseAdmin
      .from("flow_leads")
      .update({ status: "pending", next_run_at: nowIso, last_error: null })
      .eq("status", "failed")
      .lt("next_run_at", fifteenMinAgo)
      .select("id");
    // 3) dispara
    const { runDispatcher } = await import("@/lib/automation.server");
    const result = await runDispatcher({
      limit: data.limit ?? 100,
      bypassWindow: !!data.bypassWindow,
    });
    return {
      resumed: updated?.length ?? 0,
      retried: retried?.length ?? 0,
      dispatched: result,
    };
  });

// Backfill: para cada lead_alert sem flow_lead associado (ou cujo fluxo já
// terminou), tenta enfileirar nos fluxos WhatsApp ativos cujo trigger casa,
// respeitando duplicidade. Não toca SMS/Email/Call.
export const backfillWhatsappFromAlerts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    // Carrega fluxos WhatsApp ativos com trigger
    const { data: flows } = await supabaseAdmin
      .from("flows")
      .select("id, trigger_type")
      .eq("active", true)
      .not("trigger_type", "is", null);
    if (!flows || flows.length === 0) {
      return { enqueued: 0, scanned: 0, skipped: 0, reason: "no-active-whatsapp-flows" };
    }
    const flowsByTrigger = new Map<string, string[]>();
    for (const f of flows) {
      const arr = flowsByTrigger.get(f.trigger_type as string) ?? [];
      arr.push(f.id);
      flowsByTrigger.set(f.trigger_type as string, arr);
    }

    // Alertas recentes (últimos 30 dias) — limita p/ não fazer scan enorme
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: alerts } = await supabaseAdmin
      .from("lead_alerts")
      .select("id, player_id, trigger_type, flow_lead_id, fired_at")
      .gte("fired_at", since)
      .order("fired_at", { ascending: false })
      .limit(2000);

    let enqueued = 0;
    let skipped = 0;
    const scanned = alerts?.length ?? 0;

    for (const a of alerts ?? []) {
      if (!a.player_id || !a.trigger_type) {
        skipped++;
        continue;
      }
      const candidateFlowIds = flowsByTrigger.get(a.trigger_type as string);
      if (!candidateFlowIds || candidateFlowIds.length === 0) {
        skipped++;
        continue;
      }
      const { data: player } = await supabaseAdmin
        .from("players")
        .select("id, telefone, status")
        .eq("id", a.player_id)
        .maybeSingle();
      if (!player || player.status !== "ativo") {
        skipped++;
        continue;
      }
      const phone = (player.telefone ?? "").replace(/\D/g, "");
      if (phone.length < 8) {
        skipped++;
        continue;
      }
      for (const flowId of candidateFlowIds) {
        // Já enrolled? (qualquer status — flow é one-shot por player)
        const { count } = await supabaseAdmin
          .from("flow_leads")
          .select("id", { count: "exact", head: true })
          .eq("flow_id", flowId)
          .eq("player_id", a.player_id);
        if ((count ?? 0) > 0) {
          skipped++;
          continue;
        }
        const { data: inserted, error } = await supabaseAdmin
          .from("flow_leads")
          .insert({
            flow_id: flowId,
            player_id: a.player_id,
            phone_e164: phone,
            status: "pending",
            current_block_index: 0,
            next_run_at: new Date().toISOString(),
          })
          .select("id")
          .maybeSingle();
        if (error) {
          skipped++;
          continue;
        }
        await supabaseAdmin.from("flow_logs").insert({
          flow_id: flowId,
          flow_lead_id: inserted?.id ?? null,
          player_id: a.player_id,
          event: "enqueued",
          detail: { trigger: a.trigger_type, via: "backfill_alerts", alert_id: a.id },
        });
        enqueued++;
      }
    }
    return { enqueued, skipped, scanned };
  });
