// Área do Expert §8 — o worker de campanhas de SMS aplicado a uma campanha de
// expert. A cada tick: recarrega o expert (desativado → campanha cancelada,
// nada enviado), recalcula o público dinâmico com o escopo ATUAL dele e, a
// cada lote, descarta quem saiu do escopo (ex.: afiliado desvinculado depois
// da criação/aprovação, ou um telefone compartilhado que resolveu para um
// jogador de outro afiliado). Sem caminho em lote (Short Brasil bulk): todo
// envio passa por sendSmsInternal com o expert dono (teto atômico na
// reserva) e o link rastreado com origem 'expert'.

import {
  audienceScopeOf,
  EXPERT_OUT_OF_SCOPE_MESSAGE,
  EXPERT_SCOPE_INACTIVE,
  filterPlayerIdsToExpert,
  loadExpertScope,
  type ExpertScope,
} from "./expert-campaign-scope.server";
import type { ExpertAudienceScope } from "./sms-audience-selection.server";
import type {
  AudienceTarget,
  CampaignDispatchDeps,
  SmsCampaignRow,
} from "./sms-campaign-dispatch.server";

export type ExpertCampaignIo = {
  loadScope: (expertId: string, tenantId: string) => Promise<ExpertScope | null>;
  filterVisible: (scope: ExpertScope, playerIds: string[]) => Promise<string[]>;
  resolveAudienceTargets: (
    tenantId: string,
    criteria: unknown,
    scope: ExpertAudienceScope,
  ) => Promise<AudienceTarget[]>;
};

/** Approval states the worker must never send. */
export function isBlockedApproval(status: string | null | undefined): boolean {
  return status === "pendente" || status === "recusada";
}

/**
 * Deps for one tick of an expert campaign, or null when nothing may be sent
 * (pending/rejected approval, owner deactivated or gone: the campaign row is
 * updated here and the lock released). A house campaign gets `base` back.
 */
export async function expertCampaignDeps(
  c: SmsCampaignRow,
  base: CampaignDispatchDeps,
  io: Partial<ExpertCampaignIo> & Pick<ExpertCampaignIo, "resolveAudienceTargets">,
): Promise<CampaignDispatchDeps | null> {
  if (!c.expert_id) return base;
  const loadScope = io.loadScope ?? ((id, tenantId) => loadExpertScope(id, tenantId));
  const filterVisible = io.filterVisible ?? ((scope, ids) => filterPlayerIdsToExpert(scope, ids));

  if (isBlockedApproval(c.approval_status)) {
    // Defensive: the approval CHECK keeps such rows out of the claim.
    await base.updateCampaign(c, { locked_at: null, locked_by: null });
    return null;
  }
  const scope = await loadScope(c.expert_id, c.tenant_id);
  if (!scope || !scope.ativo) {
    await base.updateCampaign(c, {
      status: "cancelada",
      last_error: EXPERT_SCOPE_INACTIVE,
      locked_at: null,
      locked_by: null,
    });
    return null;
  }

  // Players of the current batch that are still visible to the expert.
  const visible = new Set<string>();
  const { sendBatch: _bulk, ...rest } = base;
  return {
    ...rest,
    resolveAudienceTargets: (tenantId, criteria) =>
      io.resolveAudienceTargets(tenantId, criteria, audienceScopeOf(scope)),
    async loadPlayerVariables(playerIds, tenantId) {
      const allowed = await filterVisible(scope, playerIds);
      visible.clear();
      for (const id of allowed) visible.add(id);
      return allowed.length
        ? base.loadPlayerVariables(allowed, tenantId)
        : new Map<string, Record<string, string>>();
    },
    async send(args) {
      // External numbers never belong to an expert campaign.
      if (!args.target.playerId || !visible.has(args.target.playerId))
        return { ok: false, error: EXPERT_OUT_OF_SCOPE_MESSAGE };
      return base.send(args);
    },
  };
}
