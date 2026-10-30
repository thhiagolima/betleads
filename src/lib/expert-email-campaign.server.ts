// Área do Expert §8 — partes de expert do envio de campanha de e-mail
// (runCampaignSend em email.functions.ts). Mantidas aqui para a mudança
// naquele arquivo ficar pequena: lá só entram o desvio para o expert, o
// remetente/encurtador padrão da casa e a pausa por teto.
//
// Destinatários: SEMPRE resolvidos aqui, no servidor, do critério gravado
// (`audience_filter.audience_criteria`) com o escopo ATUAL do expert, e
// opcionalmente intersectados com o subconjunto `audience_filter.player_ids`.
// Nunca e-mails avulsos, nunca uma lista vinda do navegador.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  audienceScopeOf,
  EXPERT_SCOPE_INACTIVE,
  filterPlayerIdsToExpert,
  loadExpertScope,
  type ExpertScope,
} from "./expert-campaign-scope.server";
import { resolveAudienceForTenant, type SelectionDb } from "./sms-audience-selection.server";

/** blocked_reason of an expert e-mail campaign paused at the expert's monthly cap. */
export const EMAIL_CAMPAIGN_EXPERT_CAP_MESSAGE =
  "Teto mensal do expert atingido: a campanha foi pausada até o mês virar ou o admin aumentar o teto.";
export const EMAIL_CAMPAIGN_AWAITING_APPROVAL = "Esta campanha aguarda a aprovação do admin.";
export { EXPERT_SCOPE_INACTIVE };

export type ExpertEmailAudienceFilter = {
  audience_mode?: string;
  audience_criteria?: unknown;
  player_ids?: unknown;
};

const CHUNK = 300;

/**
 * The owner of an expert campaign as of now. Throws for a pending/rejected
 * approval (never sent); returns `{ inactive: true }` when the owner was
 * deactivated or removed (the caller pauses the campaign).
 */
export async function loadExpertEmailOwner(camp: {
  tenant_id: string;
  expert_id?: string | null;
  approval_status?: string | null;
}): Promise<{ inactive: true } | { inactive: false; scope: ExpertScope } | null> {
  if (!camp.expert_id) return null;
  if (camp.approval_status === "pendente" || camp.approval_status === "recusada")
    throw new Error(EMAIL_CAMPAIGN_AWAITING_APPROVAL);
  const scope = await loadExpertScope(camp.expert_id, camp.tenant_id);
  if (!scope || !scope.ativo) return { inactive: true };
  return { inactive: false, scope };
}

/** Players (full rows, with e-mail) of an expert e-mail campaign, re-scoped now. */
export async function loadExpertEmailRecipients(
  tenantId: string,
  audienceFilter: ExpertEmailAudienceFilter,
  scope: ExpertScope,
  db: SelectionDb = supabaseAdmin as unknown as SelectionDb,
): Promise<Array<Record<string, unknown> & { id: string; email: string | null }>> {
  const resolved = await resolveAudienceForTenant(
    db,
    tenantId,
    audienceFilter.audience_criteria ?? {},
    audienceScopeOf(scope),
  );
  let ids = (resolved.emailPlayerIds ?? []).filter((id): id is string => typeof id === "string");
  if (Array.isArray(audienceFilter.player_ids)) {
    const subset = new Set(audienceFilter.player_ids.map((id) => String(id)));
    ids = ids.filter((id) => subset.has(id));
  }
  // Belt and braces: the resolver already applied the scope.
  ids = await filterPlayerIdsToExpert(scope, ids, db);
  const rows: Array<Record<string, unknown> & { id: string; email: string | null }> = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await (db as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (c: string, v: unknown) => {
            in: (c: string, v: unknown[]) => PromiseLike<{
              data: unknown[] | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    })
      .from("players")
      .select("*")
      .eq("tenant_id", tenantId)
      .in("id", ids.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<Record<string, unknown> & { id: string; email: string | null }>)
      if (String(row.email ?? "").trim()) rows.push(row);
  }
  return rows;
}

export const EXPERT_CAMPAIGN_HOUSE_REFUSED =
  "Campanha de expert: envie, aprove ou pause pela área de aprovação de campanhas de experts.";

/** House functions never send an expert's campaign (the admin uses the approval screen). */
export async function assertNotExpertEmailCampaign(campaignId: string): Promise<void> {
  const { data, error } = await (supabaseAdmin as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (c: string, v: unknown) => {
          maybeSingle: () => PromiseLike<{
            data: { expert_id?: string | null } | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  })
    .from("email_campaigns")
    .select("expert_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data?.expert_id) throw new Error(EXPERT_CAMPAIGN_HOUSE_REFUSED);
}
