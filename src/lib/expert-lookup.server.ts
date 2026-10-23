// Narrow structural boundary for the chain `sb.from("expert_affiliates")
// .select("experts(nome)").eq(...).eq(...).maybeSingle()`. Mirrors the
// pattern used by other *.server.ts/.functions.ts files (see
// players-list.functions.ts's SettingsClient) so lightweight test doubles
// can stand in for the real Supabase client.
export type SupabaseLike = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: unknown,
      ) => {
        eq: (
          column: string,
          value: unknown,
        ) => {
          maybeSingle: () => PromiseLike<{
            data: ExpertAffiliateRow | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
};

type ExpertAffiliateRow = {
  experts: { nome: string | null } | { nome: string | null }[] | null;
};

function expertNomeFrom(row: ExpertAffiliateRow | null): string | null {
  if (!row) return null;
  const experts = row.experts;
  if (!experts) return null;
  const expert = Array.isArray(experts) ? experts[0] : experts;
  return expert?.nome ?? null;
}

/**
 * Resolves the expert's display name for a webhook-provided affiliate id,
 * scoped to the tenant that owns it. The id is per-house (Task 1 moved it
 * from `experts.affiliate_id` to `expert_affiliates`), so the lookup is
 * always scoped by `tenant_id` + `affiliate_id`. The label applies even if
 * the expert has since been deactivated. Query failures never bubble up —
 * the webhook must not fail just because the lead couldn't be labeled.
 */
export async function lookupExpertName(
  sb: SupabaseLike,
  tenantId: string,
  affiliateId: string | null,
): Promise<string | null> {
  const trimmedId = affiliateId?.trim();
  if (!trimmedId) return null;

  const { data, error } = await sb
    .from("expert_affiliates")
    .select("experts(nome)")
    .eq("tenant_id", tenantId)
    .eq("affiliate_id", trimmedId)
    .maybeSingle();

  if (error) {
    console.warn("lookupExpertName: falha ao consultar expert_affiliates", error.message);
    return null;
  }

  return expertNomeFrom(data);
}
