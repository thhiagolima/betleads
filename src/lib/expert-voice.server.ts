// Área do Expert §8 — voz. A voz em massa da casa não guarda campanha; a do
// expert fica em expert_voice_campaigns até a aprovação e, ao aprovar (ou no
// modo livre), vira itens de call_queue com expert_id +
// expert_voice_campaign_id (tenant_id explícito, client service_role).
//
// No worker (runVoiceQueueDispatcher), cada item de expert passa por
// `ExpertVoiceGate.admit` antes de discar: expert desativado → itens dele
// cancelados; jogador fora do escopo atual → item cancelado; teto atingido
// neste tick → item fica para depois. A recusa por teto pausa só os itens
// desse expert (status 'paused', provider_status 'teto_expert') — nunca o
// empurrão de 15 min de todos os itens da casa nem o aviso "sem saldo".

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { notifyExpertCapReached } from "./billing/expert-cap-alerts.server";
import {
  EXPERT_OUT_OF_SCOPE_MESSAGE,
  EXPERT_SCOPE_INACTIVE,
  filterPlayerIdsToExpert,
  loadExpertScope,
  type ExpertScope,
} from "./expert-campaign-scope.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- call_queue.expert_* and expert_voice_campaigns are not in the generated types yet. */
type Db = { from: (table: string) => any };
const admin = () => supabaseAdmin as unknown as Db;

export const VOICE_EXPERT_CAP_STATUS = "teto_expert";
export const VOICE_EXPERT_CAP_MESSAGE = "Teto mensal do expert atingido";

export type ExpertQueueOwner = { expertId: string; campaignId: string | null };

/** expert_id / expert_voice_campaign_id of the given queue items (only expert ones). */
export async function loadExpertQueueOwners(
  ids: string[],
  db: Db = admin(),
): Promise<Map<string, ExpertQueueOwner>> {
  const out = new Map<string, ExpertQueueOwner>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await db
      .from("call_queue")
      .select("id,expert_id,expert_voice_campaign_id")
      .in("id", ids.slice(i, i + 300))
      .not("expert_id", "is", null);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{
      id: string;
      expert_id: string | null;
      expert_voice_campaign_id: string | null;
    }>) {
      if (row.expert_id)
        out.set(row.id, { expertId: row.expert_id, campaignId: row.expert_voice_campaign_id });
    }
  }
  return out;
}

export type ExpertVoiceGateIo = {
  loadScope: (expertId: string, tenantId: string) => Promise<ExpertScope | null>;
  filterVisible: (scope: ExpertScope, playerIds: string[]) => Promise<string[]>;
  notifyCap: (tenantId: string, expertId: string) => Promise<unknown>;
  db: Db;
};

/** Per-tick gate for expert queue items. */
export class ExpertVoiceGate {
  private readonly scopes = new Map<string, ExpertScope | null>();
  private readonly capped = new Set<string>();
  private readonly io: ExpertVoiceGateIo;

  constructor(io: Partial<ExpertVoiceGateIo> = {}) {
    this.io = {
      loadScope: io.loadScope ?? ((id, tenantId) => loadExpertScope(id, tenantId)),
      filterVisible: io.filterVisible ?? ((scope, ids) => filterPlayerIdsToExpert(scope, ids)),
      notifyCap: io.notifyCap ?? ((tenantId, id) => notifyExpertCapReached(tenantId, id)),
      db: io.db ?? admin(),
    };
  }

  /**
   * "dial": go ahead (pass `expertId` to the call). "skip": leave the item
   * untouched for a later tick. "cancelled": the item was cancelled here.
   */
  async admit(
    item: { id: string; tenant_id: string; lead_id: string | null },
    owner: ExpertQueueOwner,
  ): Promise<"dial" | "skip" | "cancelled"> {
    if (this.capped.has(owner.expertId)) return "skip";
    let scope = this.scopes.get(owner.expertId);
    if (scope === undefined) {
      scope = await this.io.loadScope(owner.expertId, item.tenant_id);
      this.scopes.set(owner.expertId, scope);
    }
    if (!scope || !scope.ativo) {
      await this.cancelExpertItems(item.tenant_id, owner.expertId, EXPERT_SCOPE_INACTIVE, "expert_inactive");
      return "cancelled";
    }
    const visible = item.lead_id ? await this.io.filterVisible(scope, [item.lead_id]) : [];
    if (visible.length === 0) {
      const { error } = await this.io.db
        .from("call_queue")
        .update({
          status: "cancelled",
          provider_status: "fora_do_escopo",
          provider_response: { error: EXPERT_OUT_OF_SCOPE_MESSAGE },
        })
        .eq("id", item.id)
        .eq("tenant_id", item.tenant_id);
      if (error) throw new Error(error.message);
      return "cancelled";
    }
    return "dial";
  }

  /** The expert's cap refused a call: pause only his items and campaigns; tell the admin once a month. */
  async onCapReached(tenantId: string, expertId: string): Promise<void> {
    this.capped.add(expertId);
    const { error } = await this.io.db
      .from("call_queue")
      .update({ status: "paused", provider_status: VOICE_EXPERT_CAP_STATUS })
      .eq("tenant_id", tenantId)
      .eq("expert_id", expertId)
      .eq("status", "audio_ready");
    if (error)
      console.error("[expert-voice] could not pause the expert's items", { expertId, error: error.message });
    const { error: campaignError } = await this.io.db
      .from("expert_voice_campaigns")
      .update({ status: "pausada", last_error: VOICE_EXPERT_CAP_MESSAGE })
      .eq("tenant_id", tenantId)
      .eq("expert_id", expertId)
      .eq("status", "enfileirada");
    if (campaignError)
      console.error("[expert-voice] could not pause the expert's campaigns", {
        expertId,
        error: campaignError.message,
      });
    await this.io.notifyCap(tenantId, expertId);
  }

  /** The expert was deactivated: nothing of his is dialed any more. */
  async cancelExpertItems(
    tenantId: string,
    expertId: string,
    message: string,
    providerStatus: string,
  ): Promise<void> {
    this.capped.add(expertId);
    const { error } = await this.io.db
      .from("call_queue")
      .update({ status: "cancelled", provider_status: providerStatus, provider_response: { error: message } })
      .eq("tenant_id", tenantId)
      .eq("expert_id", expertId)
      .in("status", ["audio_ready", "pending_audio", "paused"]);
    if (error) throw new Error(error.message);
    await this.io.db
      .from("expert_voice_campaigns")
      .update({ status: "cancelada", last_error: message })
      .eq("tenant_id", tenantId)
      .eq("expert_id", expertId)
      .in("status", ["enfileirada", "pausada"]);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
