import { supabaseAdmin } from "@/integrations/supabase/client.server";

type AuditDb = {
  from: (table: string) => {
    insert: (values: unknown) => PromiseLike<{ error: { message: string } | null }>;
  };
};

/** Writes one row to tenant_audit_logs. Failures are logged, never thrown. */
export async function auditTenant(args: {
  tenantId: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}) {
  const { error } = await (supabaseAdmin as unknown as AuditDb).from("tenant_audit_logs").insert({
    tenant_id: args.tenantId,
    actor_user_id: args.actorUserId,
    action: args.action,
    entity_type: args.entityType,
    entity_id: args.entityId ?? null,
    before_data: args.before ?? null,
    after_data: args.after ?? null,
    metadata: args.metadata ?? {},
  });
  if (error) {
    console.warn("[tenants] failed writing audit log", error.message);
  }
}
