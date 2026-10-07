import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json } from "@/integrations/supabase/types";
import { resolveCurrentTenantId } from "@/lib/tenant-access.server";
import { dbUuid } from "@/lib/zod-helpers";

const channelSchema = z.enum(["sms", "email", "voice"]);
const draftPayloadSchema = z.object({
  channel: channelSchema,
  name: z.string().max(160).default(""),
  audienceId: z.string().max(160).nullable().optional(),
  audienceCriteria: z.record(z.string(), z.unknown()).nullable().optional(),
  assetId: z.string().max(200).nullable().optional(),
  assetKind: z.string().max(40).nullable().optional(),
  assetSnapshot: z.record(z.string(), z.unknown()).nullable().optional(),
  content: z.string().max(200_000).default(""),
  scheduledAt: z.string().datetime().nullable().optional(),
  trackLinks: z.boolean().default(true),
  payload: z.record(z.string(), z.unknown()).default({}),
});

const saveSchema = draftPayloadSchema.extend({
  id: dbUuid().nullable().optional(),
  version: z.number().int().positive().nullable().optional(),
  idempotencyKey: z.string().uuid(),
});

type ParsedCampaignDraftPayload = z.infer<typeof draftPayloadSchema>;
export type CampaignDraftPayload = Omit<
  ParsedCampaignDraftPayload,
  "audienceCriteria" | "assetSnapshot" | "payload"
> & {
  audienceCriteria?: Record<string, Json> | null;
  assetSnapshot?: Record<string, Json> | null;
  payload: Record<string, Json>;
};

export type CampaignDraft = CampaignDraftPayload & {
  id: string;
  status: "draft" | "submitted";
  version: number;
  updatedAt: string;
};

function toDraft(row: Record<string, unknown>): CampaignDraft {
  return {
    id: row.id as string,
    channel: row.channel as z.infer<typeof channelSchema>,
    name: String(row.name ?? ""),
    audienceId: (row.audience_id as string | null) ?? null,
    audienceCriteria: (row.audience_criteria as Record<string, Json> | null) ?? null,
    assetId: (row.asset_id as string | null) ?? null,
    assetKind: (row.asset_kind as string | null) ?? null,
    assetSnapshot: (row.asset_snapshot as Record<string, Json> | null) ?? null,
    content: String(row.content ?? ""),
    scheduledAt: (row.scheduled_at as string | null) ?? null,
    trackLinks: row.track_links !== false,
    payload: (row.payload as Record<string, Json>) ?? {},
    status: row.status as "draft" | "submitted",
    version: Number(row.version ?? 1),
    updatedAt: String(row.updated_at),
  };
}

export const listCampaignDrafts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    const { data, error } = await (context.supabase as any)
      .from("campaign_drafts")
      .select("id,channel,name,audience_id,asset_id,status,version,updated_at")
      .eq("tenant_id", tenantId)
      .eq("status", "draft")
      .order("updated_at", { ascending: false });
    if (error) throw new Error("Não foi possível carregar os rascunhos.");
    return { items: (data ?? []).map((row: Record<string, unknown>) => toDraft(row)) };
  });

export const getCampaignDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    const { data: row, error } = await (context.supabase as any)
      .from("campaign_drafts")
      .select("*")
      .eq("id", data.id)
      .eq("tenant_id", tenantId)
      .eq("status", "draft")
      .maybeSingle();
    if (error || !row) throw new Error("Rascunho não encontrado ou não editável.");
    return toDraft(row as Record<string, unknown>);
  });

export const saveCampaignDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => saveSchema.parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    const payload = {
      tenant_id: tenantId,
      created_by: context.userId,
      channel: data.channel,
      name: data.name,
      audience_id: data.audienceId ?? null,
      audience_criteria: data.audienceCriteria ?? null,
      asset_id: data.assetId ?? null,
      asset_kind: data.assetKind ?? null,
      asset_snapshot: data.assetSnapshot ?? null,
      content: data.content,
      scheduled_at: data.scheduledAt ?? null,
      track_links: data.trackLinks,
      payload: data.payload,
      idempotency_key: data.idempotencyKey,
    };

    if (!data.id) {
      const { data: created, error } = await (context.supabase as any)
        .from("campaign_drafts")
        .upsert(payload, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: false })
        .select("*")
        .single();
      if (error) throw new Error("Não foi possível criar o rascunho.");
      return toDraft(created as Record<string, unknown>);
    }

    if (!data.version) throw new Error("Versão do rascunho ausente.");
    const { data: updated, error } = await (context.supabase as any)
      .from("campaign_drafts")
      .update({ ...payload, version: data.version + 1 })
      .eq("id", data.id)
      .eq("tenant_id", tenantId)
      .eq("status", "draft")
      .eq("version", data.version)
      .select("*")
      .maybeSingle();
    if (error) throw new Error("Não foi possível salvar o rascunho.");
    if (!updated)
      throw new Error("Este rascunho foi alterado em outra sessão. Reabra para continuar.");
    return toDraft(updated as Record<string, unknown>);
  });

export const deleteCampaignDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    const { error } = await (context.supabase as any)
      .from("campaign_drafts")
      .delete()
      .eq("id", data.id)
      .eq("tenant_id", tenantId)
      .eq("status", "draft");
    if (error) throw new Error("Não foi possível excluir o rascunho.");
    return { ok: true };
  });

export const submitCampaignDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveCurrentTenantId(context.supabase);
    const { data: updated, error } = await (context.supabase as any)
      .from("campaign_drafts")
      .update({ status: "submitted", submitted_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("tenant_id", tenantId)
      .eq("status", "draft")
      .select("id")
      .maybeSingle();
    if (error || !updated) throw new Error("O rascunho já não pode ser enviado.");
    return { ok: true };
  });
