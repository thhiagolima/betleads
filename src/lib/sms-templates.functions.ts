import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { dbUuid } from "@/lib/zod-helpers";
import { resolveOperationalTenantId } from "@/lib/tenant-access.server";

const TemplateSchema = z.object({
  id: dbUuid().optional(),
  name: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(480),
  category: z.string().trim().min(1).max(80).default("Geral"),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  isActive: z.boolean().default(true),
});

type TemplateRow = {
  id: string;
  name: string;
  content: string;
  category: string;
  tags: string[] | null;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
};

function present(row: TemplateRow) {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    category: row.category,
    tags: row.tags ?? [],
    isActive: row.is_active,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const listSmsTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const { data, error } = await db
      .from("sms_templates")
      .select("id,name,content,category,tags,is_active,version,created_at,updated_at")
      .eq("tenant_id", tenantId)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { items: (data as TemplateRow[] ?? []).map(present) };
  });

export const saveSmsTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => TemplateSchema.parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const payload = {
      name: data.name,
      content: data.content,
      category: data.category,
      tags: [...new Set(data.tags.map((tag) => tag.trim()).filter(Boolean))],
      is_active: data.isActive,
    };
    if (data.id) {
      const { data: updated, error } = await db
        .from("sms_templates")
        .update(payload)
        .eq("id", data.id)
        .eq("tenant_id", tenantId)
        .select("id,name,content,category,tags,is_active,version,created_at,updated_at")
        .single();
      if (error) throw new Error(error.message);
      return { item: present(updated as TemplateRow) };
    }
    const { data: created, error } = await db
      .from("sms_templates")
      .insert({ ...payload, tenant_id: tenantId, created_by: context.userId })
      .select("id,name,content,category,tags,is_active,version,created_at,updated_at")
      .single();
    if (error) throw new Error(error.message);
    return { item: present(created as TemplateRow) };
  });

export const archiveSmsTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: dbUuid(), isActive: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const { error } = await db
      .from("sms_templates")
      .update({ is_active: data.isActive })
      .eq("id", data.id)
      .eq("tenant_id", tenantId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const duplicateSmsTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: dbUuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const tenantId = await resolveOperationalTenantId(context.supabase);
    const db = context.supabase as any;
    const { data: original, error: readError } = await db
      .from("sms_templates")
      .select("name,content,category,tags")
      .eq("id", data.id)
      .eq("tenant_id", tenantId)
      .single();
    if (readError) throw new Error(readError.message);
    const { data: created, error } = await db
      .from("sms_templates")
      .insert({ ...original, name: `${original.name} (cópia)`, tenant_id: tenantId, created_by: context.userId })
      .select("id,name,content,category,tags,is_active,version,created_at,updated_at")
      .single();
    if (error) throw new Error(error.message);
    return { item: present(created as TemplateRow) };
  });
