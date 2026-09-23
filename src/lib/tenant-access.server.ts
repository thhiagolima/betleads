import { supabaseAdmin } from "@/integrations/supabase/client.server";

type DbError = { message: string };
type DbResult<T = unknown> = { data: T | null; error: DbError | null };
type RpcClient = {
  rpc: <T = unknown>(fn: string, args?: Record<string, unknown>) => Promise<DbResult<T>>;
};

type TenantStatusRow = {
  id: string;
  status: string | null;
};

const blockedOperationalStatuses = new Set(["suspended", "canceled"]);

export async function resolveCurrentTenantId(supabase: RpcClient) {
  const { data, error } = await supabase.rpc<string>("current_tenant_id");
  if (error) throw new Error(error.message);
  const tenantId = data ?? null;
  if (!tenantId) throw new Error("tenant nao encontrado para o usuario");
  return tenantId;
}

export async function getTenantStatus(tenantId: string) {
  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("id,status")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Tenant nao encontrado");
  return data as TenantStatusRow;
}

export async function assertTenantCanOperate(tenantId: string) {
  const tenant = await getTenantStatus(tenantId);
  if (tenant.status && blockedOperationalStatuses.has(tenant.status)) {
    throw new Error("Tenant bloqueado para operacoes. Regularize a conta antes de continuar.");
  }
  return tenant;
}

export async function assertTenantCanOpenBilling(tenantId: string) {
  const tenant = await getTenantStatus(tenantId);
  if (tenant.status === "canceled") {
    throw new Error("Tenant cancelado nao pode iniciar novas compras de credito.");
  }
  return tenant;
}

export async function resolveOperationalTenantId(supabase: RpcClient) {
  const tenantId = await resolveCurrentTenantId(supabase);
  await assertTenantCanOperate(tenantId);
  return tenantId;
}
