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
        tags: z.array(z.string().trim().min(1).max(40)).max(12).optional().default([]),
        language: z.string().trim().min(2).max(20).optional().default("pt-BR"),
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
        tags: [...new Set(data.tags)],
        language: data.language,
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
      .select("id,name,storage_path,content_type,size_bytes,duration_seconds,tags,language,source,is_archived,created_at,updated_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { assets: data ?? [] };
  });

export const getJourneyVoiceAssetPreview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => z.object({ id: z.string().uuid() }).parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const { data: asset, error } = await db.from("journey_voice_assets").select("storage_path").eq("id", data.id).eq("tenant_id", tenantId).single();
    if (error) throw new Error(error.message);
    const { data: signed, error: signedError } = await supabaseAdmin.storage.from("call-audios").createSignedUrl(asset.storage_path, 900);
    if (signedError) throw new Error(signedError.message);
    return { url: signed.signedUrl };
  });

export const updateJourneyVoiceAsset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(160), tags: z.array(z.string().trim().min(1).max(40)).max(12), language: z.string().trim().min(2).max(20), isArchived: z.boolean() }).parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const { error } = await db.from("journey_voice_assets").update({ name: data.name, tags: [...new Set(data.tags)], language: data.language, is_archived: data.isArchived }).eq("id", data.id).eq("tenant_id", tenantId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteJourneyVoiceAsset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) => z.object({ id: z.string().uuid() }).parse(value))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const { data: asset, error } = await db.from("journey_voice_assets").select("storage_path").eq("id", data.id).eq("tenant_id", tenantId).single();
    if (error) throw new Error(error.message);
    const { count, error: refError } = await db.from("journey_steps").select("id", { count: "exact", head: true }).contains("config", { asset_id: data.id });
    if (refError) throw new Error(refError.message);
    if ((count ?? 0) > 0) throw new Error("Este áudio está em uso por uma jornada; arquive-o em vez de excluir.");
    const { error: storageError } = await supabaseAdmin.storage.from("call-audios").remove([asset.storage_path]);
    if (storageError) throw new Error(storageError.message);
    const { error: deleteError } = await db.from("journey_voice_assets").delete().eq("id", data.id).eq("tenant_id", tenantId);
    if (deleteError) throw new Error(deleteError.message);
    return { ok: true };
  });
