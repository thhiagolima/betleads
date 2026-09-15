// Camada única de envio para o motor de automações.
// Detecta o tipo de bloco e chama a Evolution API adequada.
import { evolutionFetch } from "./evolution.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type FlowBlock = {
  id: string;
  block_type: "text" | "image" | "video" | "audio" | "document" | "delay";
  content: string | null;
  caption: string | null;
  media_url: string | null; // storage path no bucket whatsapp-media
  media_mimetype: string | null;
  media_filename: string | null;
  delay_seconds: number;
};

export type SessionRow = {
  id: string;
  instance_name: string;
  name: string;
  status: string;
};

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) throw new Error("Telefone inválido");
  // Se não tem código do país, assume Brasil (55).
  return digits.length <= 11 ? `55${digits}` : digits;
}

async function signedMediaUrl(path: string): Promise<string> {
  const { data, error } = await supabaseAdmin.storage
    .from("whatsapp-media")
    .createSignedUrl(path, 60 * 60);
  if (error || !data?.signedUrl) {
    throw new Error(`Falha ao gerar URL assinada: ${error?.message ?? "sem detalhes"}`);
  }
  return data.signedUrl;
}

/**
 * Envia um bloco do fluxo para o lead via Evolution.
 * Retorna `{ skipDispatch: true }` para blocos do tipo delay (não envia, apenas agenda).
 */
export async function sendFlowBlock(
  block: FlowBlock,
  lead: { phone_e164: string; player_id?: string | null },
  session: SessionRow,
): Promise<{ messageId: string | null; skipDispatch?: boolean }> {
  const number = normalizePhone(lead.phone_e164);
  const instance = session.instance_name;

  if (block.block_type === "delay") {
    return { messageId: null, skipDispatch: true };
  }

  if (block.block_type === "text") {
    const text = (block.content ?? "").trim();
    if (!text) throw new Error("Bloco de texto vazio");
    const resp: any = await evolutionFetch(
      `/message/sendText/${encodeURIComponent(instance)}`,
      { method: "POST", body: { number, text } },
    );
    return { messageId: resp?.key?.id ?? resp?.messageId ?? null };
  }

  // Mídias precisam de storage path + mimetype
  if (!block.media_url || !block.media_mimetype) {
    throw new Error(`Bloco ${block.block_type} sem mídia configurada`);
  }
  const signed = await signedMediaUrl(block.media_url);
  const caption = (block.caption ?? "").trim();
  const filename = block.media_filename ?? "arquivo";

  if (block.block_type === "audio") {
    // Áudio precisa ser base64 — baixa e converte.
    const bin = await fetch(signed).then((r) => r.arrayBuffer());
    const base64 = Buffer.from(bin).toString("base64");
    const resp: any = await evolutionFetch(
      `/message/sendWhatsAppAudio/${encodeURIComponent(instance)}`,
      { method: "POST", body: { number, audio: base64, encoding: true } },
    );
    return { messageId: resp?.key?.id ?? null };
  }

  const mediatype = block.block_type === "document" ? "document" : block.block_type;
  const payload: Record<string, unknown> = {
    number,
    mediatype,
    mimetype: block.media_mimetype,
    media: signed,
    fileName: filename,
  };
  if (caption) payload.caption = caption;

  const resp: any = await evolutionFetch(
    `/message/sendMedia/${encodeURIComponent(instance)}`,
    { method: "POST", body: payload },
  );
  return { messageId: resp?.key?.id ?? null };
}
