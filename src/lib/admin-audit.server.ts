import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

/** Writes one row to admin_audit_logs (super-admin actions). Failures are logged, never thrown. */
export async function auditAdminAction(args: {
  actorUserId: string;
  action: string;
  targetUserId?: string | null;
  tenantId?: string | null;
  before?: unknown;
  after?: unknown;
}) {
  const { error } = await supabaseAdmin.from("admin_audit_logs").insert({
    actor_user_id: args.actorUserId,
    action: args.action,
    target_user_id: args.targetUserId ?? null,
    tenant_id: args.tenantId ?? null,
    before_data: (args.before ?? null) as Json,
    after_data: (args.after ?? null) as Json,
  });
  if (error) console.warn("[admin] audit failed", error.message);
}
