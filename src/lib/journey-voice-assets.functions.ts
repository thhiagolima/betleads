/* eslint-disable @typescript-eslint/no-explicit-any -- table is introduced by the current migration before generated DB types refresh. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveOperationalTenantId } from "./tenant-access.server";

const db = supabaseAdmin as unknown as { from: (table: string) => any };
const audioSchema = z.object({
  name: z.string().trim().min(1).max(160),
  filename: z.string().min(1).max(200),
  contentType: z.enum(["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/ogg"]),
  sizeBytes: z.number().int().positive().max(52_428_800),
});

export const createJourneyVoiceUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => audioSchema.parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const safe = data.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${tenantId}/journeys/${crypto.randomUUID()}-${safe}`;
    const { data: signed, error } = await context.supabase.storage
      .from("call-audios")
      .createSignedUploadUrl(path);
    if (error) throw new Error(error.message);
    return { path, token: signed.token, signedUrl: signed.signedUrl };
  });

export const finalizeJourneyVoiceUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    z
      .object({
        path: z.string().min(1).max(500),
        name: z.string().trim().min(1).max(160),
        contentType: audioSchema.shape.contentType,
        sizeBytes: z.number().int().positive().max(52_428_800),
        durationSeconds: z.number().int().positive().max(7200).optional(),
      })
      .parse(value),
  )
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    if (!data.path.startsWith(`${tenantId}/journeys/`))
      throw new Error("Arquivo de áudio inválido");
    const { data: object, error: listError } = await supabaseAdmin.storage
      .from("call-audios")
      .list(data.path.split("/").slice(0, -1).join("/"), { search: data.path.split("/").at(-1) });
    if (listError || !object?.some((item) => item.name === data.path.split("/").at(-1)))
      throw new Error("O upload do áudio não foi concluído");
    const { data: asset, error } = await db
      .from("journey_voice_assets")
      .insert({
        tenant_id: tenantId,
        name: data.name,
        storage_path: data.path,
        content_type: data.contentType,
        size_bytes: data.sizeBytes,
        duration_seconds: data.durationSeconds ?? null,
      })
      .select("id,name,storage_path")
      .single();
    if (error) throw new Error(error.message);
    return { asset };
  });

export const listJourneyVoiceAssets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const { data, error } = await db
      .from("journey_voice_assets")
      .select("id,name,content_type,size_bytes,duration_seconds,created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { assets: data ?? [] };
  });
