import { supabase } from "@/integrations/supabase/client";
import { activeTenantFilter } from "@/lib/active-tenant-filter";

export const EMAIL_IMAGE_BUCKET = "email-images";
export const EMAIL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Uploads an e-mail template image and returns its public URL. Files go under
 * `<tenant id>/` because the bucket's write policies only accept the active
 * house's folder (super admins upload into the house picked in the header).
 */
export async function uploadEmailImage(file: File): Promise<string> {
  const tenantId = await activeTenantFilter(supabase);
  if (!tenantId) throw new Error("Nenhuma casa ativa para salvar a imagem");
  const ext = file.name.split(".").pop()?.toLowerCase() || "png";
  const path = `${tenantId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage
    .from(EMAIL_IMAGE_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return supabase.storage.from(EMAIL_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
}
