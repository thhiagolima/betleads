import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { detectPrecallResponse } from "@/lib/precall-dispatcher.server";

// Evolution API webhook receiver.
// Prefer Authorization: Bearer <EVOLUTION_WEBHOOK_SECRET> or X-Webhook-Secret.
// The query token fallback is kept only for providers that cannot send headers.

function webhookSecret(): string {
  return (process.env.EVOLUTION_WEBHOOK_SECRET || process.env.EVOLUTION_API_KEY || "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function requestWebhookToken(request: Request, url: URL): string {
  const auth = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  return (
    bearer ||
    request.headers.get("x-webhook-secret")?.trim() ||
    url.searchParams.get("token")?.trim() ||
    ""
  );
}

function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

interface Extracted {
  text: string | null;
  type: string;
  mimetype: string | null;
  filename: string | null;
  size: number | null;
  duration: number | null;
  hasMedia: boolean;
}

function extractText(msg: any): Extracted {
  const empty: Extracted = { text: null, type: "unknown", mimetype: null, filename: null, size: null, duration: null, hasMedia: false };
  if (!msg) return empty;
  if (typeof msg.conversation === "string") return { ...empty, text: msg.conversation, type: "text" };
  if (msg.extendedTextMessage?.text) return { ...empty, text: msg.extendedTextMessage.text, type: "text" };
  if (msg.imageMessage) return {
    ...empty, hasMedia: true, type: "image",
    text: msg.imageMessage.caption ?? null,
    mimetype: msg.imageMessage.mimetype ?? "image/jpeg",
    size: Number(msg.imageMessage.fileLength) || null,
  };
  if (msg.videoMessage) return {
    ...empty, hasMedia: true, type: "video",
    text: msg.videoMessage.caption ?? null,
    mimetype: msg.videoMessage.mimetype ?? "video/mp4",
    size: Number(msg.videoMessage.fileLength) || null,
    duration: Number(msg.videoMessage.seconds) || null,
  };
  if (msg.audioMessage) return {
    ...empty, hasMedia: true, type: "audio", text: null,
    mimetype: msg.audioMessage.mimetype ?? "audio/ogg",
    size: Number(msg.audioMessage.fileLength) || null,
    duration: Number(msg.audioMessage.seconds) || null,
  };
  if (msg.documentMessage) return {
    ...empty, hasMedia: true, type: "document",
    text: msg.documentMessage.caption ?? null,
    filename: msg.documentMessage.fileName ?? null,
    mimetype: msg.documentMessage.mimetype ?? "application/octet-stream",
    size: Number(msg.documentMessage.fileLength) || null,
  };
  if (msg.stickerMessage) return {
    ...empty, hasMedia: true, type: "sticker",
    mimetype: msg.stickerMessage.mimetype ?? "image/webp",
  };
  if (msg.locationMessage) return { ...empty, text: "[localização]", type: "location" };
  return empty;
}

// Faz download da mídia via Evolution (base64) e sobe pro bucket. Retorna URL pública ou null.
async function downloadAndUploadMedia(
  instanceName: string,
  rawMessage: any,
  meta: Extracted,
  messageId: string,
): Promise<string | null> {
  const url = process.env.EVOLUTION_API_URL?.trim().replace(/\/$/, "");
  const apikey = process.env.EVOLUTION_API_KEY?.trim().replace(/^['"]|['"]$/g, "");
  if (!url || !apikey) return null;

  try {
    const res = await fetch(
      `${url}/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey },
        body: JSON.stringify({ message: rawMessage, convertToMp4: false }),
      },
    );
    if (!res.ok) {
      console.warn("[evo-webhook] media download failed", res.status, await res.text().catch(() => ""));
      return null;
    }
    const json: any = await res.json().catch(() => null);
    const b64: string | undefined = json?.base64 ?? json?.data;
    if (!b64) return null;

    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ext = guessExt(meta.mimetype, meta.filename);
    const path = `incoming/${instanceName}/${messageId}.${ext}`;
    const { error: upErr } = await supabaseAdmin.storage
      .from("whatsapp-media")
      .upload(path, bin, {
        contentType: meta.mimetype ?? "application/octet-stream",
        upsert: true,
      });
    if (upErr) {
      console.warn("[evo-webhook] storage upload failed", upErr.message);
      return null;
    }
    // Bucket is private — store the storage PATH; signed URLs are generated on read.
    return path;
  } catch (e: any) {
    console.warn("[evo-webhook] media error:", e?.message);
    return null;
  }
}

function guessExt(mimetype: string | null, filename: string | null): string {
  if (filename && filename.includes(".")) return filename.split(".").pop()!.toLowerCase();
  const m = (mimetype ?? "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mpeg")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("pdf")) return "pdf";
  return "bin";
}

function previewFor(meta: Extracted): string {
  if (meta.type === "image") return meta.text ? `🖼️ ${meta.text}` : "🖼️ Imagem";
  if (meta.type === "video") return meta.text ? `🎬 ${meta.text}` : "🎬 Vídeo";
  if (meta.type === "audio") return "🎤 Áudio";
  if (meta.type === "document") return `📎 ${meta.filename ?? "Documento"}`;
  if (meta.type === "sticker") return "💟 Sticker";
  if (meta.type === "location") return "📍 Localização";
  return meta.text ?? "";
}

function jidToPhone(jid: string | null | undefined): string | null {
  if (!jid || typeof jid !== "string") return null;
  const at = jid.indexOf("@");
  const num = at >= 0 ? jid.slice(0, at) : jid;
  return /^\d+$/.test(num) ? num : null;
}

// Atualiza/cria o vínculo lead->sessão (somente 1:1). Idempotente.
// Regra de ouro: NUNCA muda a sessão de um assignment 'active' automaticamente.
// Mudança de sessão só acontece via realocação explícita (reassignOrphanedLeads).
async function upsertLeadAssignment(phone: string, sessionId: string) {
  if (!phone) return;
  const { data: existing } = await supabaseAdmin
    .from("lead_whatsapp_assignments")
    .select("id, session_id, status, previous_session_ids")
    .eq("phone_e164", phone)
    .maybeSingle();
  if (!existing) {
    await supabaseAdmin.from("lead_whatsapp_assignments").insert({
      phone_e164: phone,
      session_id: sessionId,
      status: "active",
    });
    return;
  }
  // Já existe — só reativa se estava órfão E a sessão atual é a mesma.
  if (existing.status === "orphaned" && existing.session_id === sessionId) {
    await supabaseAdmin
      .from("lead_whatsapp_assignments")
      .update({ status: "active" })
      .eq("id", existing.id);
  }
}

// Busca o assunto (nome) do grupo via Evolution.
// Tenta GET /group/findGroupInfos/{instance}?groupJid=...; tolera erros — retorna null.
async function fetchGroupSubject(
  instanceName: string,
  groupJid: string,
): Promise<string | null> {
  const url = process.env.EVOLUTION_API_URL?.trim().replace(/\/$/, "");
  const apikey = process.env.EVOLUTION_API_KEY?.trim().replace(/^['"]|['"]$/g, "");
  if (!url || !apikey) return null;
  try {
    const res = await fetch(
      `${url}/group/findGroupInfos/${encodeURIComponent(instanceName)}?groupJid=${encodeURIComponent(groupJid)}`,
      { method: "GET", headers: { apikey } },
    );
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => null);
    // Evolution pode devolver { subject } direto ou { id, subject, ... }
    const subject: string | undefined =
      json?.subject ?? json?.data?.subject ?? json?.[0]?.subject;
    return typeof subject === "string" && subject.trim() ? subject.trim() : null;
  } catch {
    return null;
  }
}

// Busca a foto de perfil de um contato/grupo via Evolution.
// POST /chat/fetchProfilePictureUrl/{instance} body { number: remoteJid }
async function fetchProfilePicture(
  instanceName: string,
  remoteJid: string,
): Promise<string | null> {
  const url = process.env.EVOLUTION_API_URL?.trim().replace(/\/$/, "");
  const apikey = process.env.EVOLUTION_API_KEY?.trim().replace(/^['"]|['"]$/g, "");
  if (!url || !apikey) return null;
  try {
    const res = await fetch(
      `${url}/chat/fetchProfilePictureUrl/${encodeURIComponent(instanceName)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey },
        body: JSON.stringify({ number: remoteJid }),
      },
    );
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => null);
    const pic: string | undefined =
      json?.profilePictureUrl ?? json?.profile_picture_url ?? json?.url ?? json?.data?.profilePictureUrl;
    return typeof pic === "string" && pic.startsWith("http") ? pic : null;
  } catch {
    return null;
  }
}

// Busca um contato 1:1 na Evolution para pegar o nome salvo na agenda do WhatsApp.
// POST /chat/findContacts/{instance} body { where: { id: remoteJid } }
async function fetchContactName(
  instanceName: string,
  remoteJid: string,
): Promise<string | null> {
  const url = process.env.EVOLUTION_API_URL?.trim().replace(/\/$/, "");
  const apikey = process.env.EVOLUTION_API_KEY?.trim().replace(/^['"]|['"]$/g, "");
  if (!url || !apikey) return null;
  try {
    const res = await fetch(
      `${url}/chat/findContacts/${encodeURIComponent(instanceName)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey },
        body: JSON.stringify({ where: { id: remoteJid } }),
      },
    );
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => null);
    const arr: any[] = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
    const first = arr[0];
    const candidate: string | undefined =
      first?.name ?? first?.pushName ?? first?.notify ?? first?.verifiedName;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
  } catch {
    return null;
  }
}

// Heurística: o nome atual do chat "parece errado" e deve ser substituído?
function nameLooksWrong(
  current: string | null | undefined,
  phone: string | null,
  remoteJid: string,
  isGroup: boolean,
  incomingPushName: string | null,
): boolean {
  if (!current) return true;
  if (current === phone) return true;
  if (current === remoteJid) return true;
  // Para grupos: se o nome atual é o pushName de algum participante (não um subject de grupo),
  // assumimos que veio errado de uma versão anterior do webhook.
  if (isGroup && incomingPushName && current === incomingPushName) return true;
  return false;
}

async function handleMessageUpsert(payload: any, instanceName: string) {
  // Evolution v2 envia: { instance, data: { key, message, pushName, messageTimestamp, ... } }
  const data = payload?.data ?? payload;
  const items = Array.isArray(data) ? data : [data];

  const { data: session } = await supabaseAdmin
    .from("whatsapp_sessions")
    .select("id, tenant_id")
    .eq("instance_name", instanceName)
    .maybeSingle();
  if (!session) return { skipped: "session not found" };

  for (const item of items) {
    const key = item?.key ?? {};
    const remoteJid: string | undefined = key?.remoteJid;
    if (!remoteJid) continue;
    const fromMe = Boolean(key?.fromMe);
    const msgId: string | undefined = key?.id;
    const isGroup = remoteJid.endsWith("@g.us");
    const phone = jidToPhone(remoteJid);
    const pushName: string | null =
      typeof item?.pushName === "string" && item.pushName.trim()
        ? item.pushName.trim()
        : null;
    // participant só existe em grupos: é o JID de quem realmente enviou a msg
    const participantJid: string | null =
      typeof key?.participant === "string" ? key.participant : null;

    // Dedup global para mensagens enviadas (fromMe=true):
    // quando o mesmo número de WhatsApp está conectado em mais de uma
    // instância Evolution (devices vinculados), TODAS as instâncias recebem
    // o evento `messages.upsert` com `fromMe=true` e o MESMO
    // `evolution_message_id`. A unique é (session_id, evolution_message_id),
    // então sem este filtro a mesma mensagem é gravada em cada sessão e
    // aparece duplicada no inbox. Mensagens recebidas (fromMe=false) NÃO
    // são deduplicadas: cada sessão precisa da sua cópia.
    if (fromMe && msgId) {
      const { data: existingMsg } = await supabaseAdmin
        .from("whatsapp_messages")
        .select("id, session_id")
        .eq("evolution_message_id", msgId)
        .eq("from_me", true)
        .limit(1)
        .maybeSingle();
      if (existingMsg && existingMsg.session_id !== session.id) {
        continue;
      }
    }

    const meta = extractText(item?.message);
    const tsRaw = item?.messageTimestamp;
    const ts = tsRaw
      ? new Date((typeof tsRaw === "number" ? tsRaw : Number(tsRaw)) * 1000).toISOString()
      : new Date().toISOString();

    // Baixa mídia (se houver) — não-fatal
    let mediaUrl: string | null = null;
    if (meta.hasMedia && msgId) {
      mediaUrl = await downloadAndUploadMedia(instanceName, item, meta, msgId);
    }

    const rawPreview = previewFor(meta);
    // Em grupos, preview no estilo WhatsApp: "~Nome: texto" (só para mensagens recebidas)
    const preview =
      isGroup && !fromMe && pushName
        ? `~${pushName}: ${rawPreview}`
        : rawPreview;

    // 1) Procura chat existente
    const { data: existing } = await supabaseAdmin
      .from("whatsapp_chats")
      .select("id, name, profile_pic_url")
      .eq("session_id", session.id)
      .eq("remote_jid", remoteJid)
      .maybeSingle();

    // 2) Decide qual `name` gravar — regra de ouro: NUNCA sobrescrever com pushName errado
    let resolvedName: string | null = existing?.name ?? null;
    if (!existing || nameLooksWrong(existing.name, phone, remoteJid, isGroup, pushName)) {
      if (isGroup) {
        const subject = await fetchGroupSubject(instanceName, remoteJid);
        if (subject) resolvedName = subject;
        else if (!existing) resolvedName = phone ?? remoteJid; // fallback inicial
      } else {
        // 1:1 — só usa pushName quando NÃO for fromMe
        if (!fromMe && pushName) resolvedName = pushName;
        else {
          // Fallback: tenta nome salvo na agenda do WhatsApp (findContacts)
          const contactName = await fetchContactName(instanceName, remoteJid);
          if (contactName) resolvedName = contactName;
          else if (!existing) resolvedName = phone ?? remoteJid;
        }
      }
    }

    // Foto de perfil — busca quando faltar; não-fatal
    let resolvedPic: string | null = existing?.profile_pic_url ?? null;
    if (!resolvedPic) {
      resolvedPic = await fetchProfilePicture(instanceName, remoteJid);
    }

    let chatId: string | null = existing?.id ?? null;
    if (!existing) {
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from("whatsapp_chats")
        .insert({
          session_id: session.id,
          tenant_id: session.tenant_id,
          remote_jid: remoteJid,
          phone,
          name: resolvedName,
          is_group: isGroup,
          last_message: preview,
          last_message_at: ts,
          profile_pic_url: resolvedPic,
        })
        .select("id")
        .single();
      if (insErr || !inserted) {
        console.error("[evo-webhook] chat insert failed", insErr?.message);
        continue;
      }
      chatId = inserted.id;
    } else {
      // Update: name só se mudou; last_message/last_message_at sempre
      const patch: {
        last_message: string;
        last_message_at: string;
        name?: string;
        profile_pic_url?: string;
      } = {
        last_message: preview,
        last_message_at: ts,
      };
      if (resolvedName && resolvedName !== existing.name) {
        patch.name = resolvedName;
      }
      if (resolvedPic && resolvedPic !== existing.profile_pic_url) {
        patch.profile_pic_url = resolvedPic;
      }
      const { error: updErr } = await supabaseAdmin
        .from("whatsapp_chats")
        .update(patch)
        .eq("id", existing.id);
      if (updErr) {
        console.error("[evo-webhook] chat update failed", updErr.message);
        continue;
      }
    }
    const chat = { id: chatId! };

    // Incrementa não-lidas se entrada
    if (!fromMe) {
      const { data: c2 } = await supabaseAdmin
        .from("whatsapp_chats")
        .select("unread_count")
        .eq("id", chat.id)
        .single();
      await supabaseAdmin
        .from("whatsapp_chats")
        .update({ unread_count: (c2?.unread_count ?? 0) + 1 })
        .eq("id", chat.id);
    }

    // Insere mensagem (idempotente por evolution_message_id)
    await supabaseAdmin
      .from("whatsapp_messages")
      .upsert(
        {
          chat_id: chat.id,
          session_id: session.id,
          tenant_id: session.tenant_id,
          evolution_message_id: msgId ?? null,
          remote_jid: remoteJid,
          from_me: fromMe,
          message_type: meta.type,
          text: meta.text,
          media_url: mediaUrl,
          media_mimetype: meta.mimetype,
          media_filename: meta.filename,
          media_size: meta.size,
          media_duration: meta.duration,
          raw: item,
          message_timestamp: ts,
          sender_jid: participantJid,
          sender_name: fromMe ? null : pushName,
        },
        { onConflict: "session_id,evolution_message_id", ignoreDuplicates: true },
      );

    // Vínculo permanente lead->sessão (apenas 1:1)
    if (!isGroup && phone) {
      await upsertLeadAssignment(phone, session.id);
    }

    // Pré-ligação: se for resposta inbound 1:1, marca lead como "ligar_agora"
    if (!isGroup && !fromMe && phone) {
      try {
        await detectPrecallResponse(phone, meta.text);
      } catch (e: any) {
        console.warn("[evo-webhook] precall response detection failed:", e?.message);
      }
    }
  }
  return { ok: true };
}

// Marca todos os assignments ativos de uma sessão como órfãos.
// Disparado quando a sessão é desconectada/banida.
async function markSessionOrphaned(instanceName: string) {
  const { data: session } = await supabaseAdmin
    .from("whatsapp_sessions")
    .select("id")
    .eq("instance_name", instanceName)
    .maybeSingle();
  if (!session) return;
  await supabaseAdmin
    .from("lead_whatsapp_assignments")
    .update({ status: "orphaned" })
    .eq("session_id", session.id)
    .eq("status", "active");
  await supabaseAdmin
    .from("whatsapp_sessions")
    .update({ status: "disconnected", last_disconnected_at: new Date().toISOString() })
    .eq("id", session.id);
}

// Marca uma sessão como conectada quando a Evolution emite state=open.
async function markSessionConnected(instanceName: string) {
  const { data: session } = await supabaseAdmin
    .from("whatsapp_sessions")
    .select("id, status")
    .eq("instance_name", instanceName)
    .maybeSingle();
  if (!session) return;
  await supabaseAdmin
    .from("whatsapp_sessions")
    .update({
      status: "connected",
      qr_code: null,
      last_connected_at: new Date().toISOString(),
    })
    .eq("id", session.id);
}

// Marca uma sessão como "connecting" (não regride uma já conectada).
async function markSessionConnecting(instanceName: string) {
  const { data: session } = await supabaseAdmin
    .from("whatsapp_sessions")
    .select("id, status")
    .eq("instance_name", instanceName)
    .maybeSingle();
  if (!session || session.status === "connected") return;
  await supabaseAdmin
    .from("whatsapp_sessions")
    .update({ status: "connecting" })
    .eq("id", session.id);
}

export const Route = createFileRoute("/api/public/evolution-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const expected = webhookSecret();
        const token = requestWebhookToken(request, url);
        if (!safeEqual(token, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }
        let body: any;
        try {
          body = await request.json();
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }
        const event: string = body?.event ?? "";
        const instance: string =
          body?.instance ?? body?.instanceName ?? body?.data?.instance ?? "";
        console.info("[evo-webhook]", event, "instance=", instance);

        try {
          if (
            event === "messages.upsert" ||
            event === "MESSAGES_UPSERT" ||
            event === "messages.update" ||
            event === "send.message"
          ) {
            await handleMessageUpsert(body, instance);
          } else if (
            event === "connection.update" ||
            event === "CONNECTION_UPDATE"
          ) {
            const state =
              body?.data?.state ??
              body?.state ??
              body?.data?.connection ??
              body?.connection;
            if (
              state === "close" ||
              state === "closed" ||
              state === "disconnected" ||
              state === "logout"
            ) {
              await markSessionOrphaned(instance);
            } else if (state === "open" || state === "connected") {
              await markSessionConnected(instance);
            } else if (state === "connecting") {
              await markSessionConnecting(instance);
            }
          }
        } catch (e: any) {
          console.error("[evo-webhook] handler error:", e?.message);
          return new Response(JSON.stringify({ ok: false, error: e?.message }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
