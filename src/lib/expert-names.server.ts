// Nome do expert dono, para as listas de campanha da casa mostrarem de quem é
// cada campanha de expert (Área do Expert §8). Client service_role, filtrado
// pela casa.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export async function expertNamesById(
  tenantId: string,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
  if (unique.length === 0) return new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- experts is not fully in the generated types.
  const { data, error } = await (supabaseAdmin as any)
    .from("experts")
    .select("id,nome")
    .eq("tenant_id", tenantId)
    .in("id", unique);
  if (error) throw new Error(error.message);
  return new Map(
    ((data ?? []) as Array<{ id: string; nome: string | null }>).map((r) => [r.id, r.nome ?? ""]),
  );
}
