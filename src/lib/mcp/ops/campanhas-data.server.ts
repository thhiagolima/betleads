// MCP do grupo, área de operação: the campaign and CRM-result reads shared by
// `campanhas`, `jornadas` and `alertas` (spec
// docs/superpowers/specs/2026-11-17-mcp-grupo-design.md §5.7–§5.9). Pure
// readers over supabaseAdmin: callers pass only house ids that
// `resolverEscopoOps` returned; nothing here checks permission.
//
// Verified facts (supabase/migrations):
// - sms_campaigns: name, status (agendada|enviando|enviado|falhou|cancelada|
//   pausada|aguardando_aprovacao|recusada), total_count/sent_count/
//   failed_count, created_at, scheduled_at, expert_id (20261126100000).
// - email_campaigns: name, status (rascunho|agendada|enviando|enviado|
//   pausada|cancelada|aguardando_aprovacao|recusada…), counts in the `stats`
//   jsonb (total, enviados, falhas — older rows: destinatarios/sent/failed),
//   created_at, scheduled_at, expert_id.
// - voice_campaigns (20261226100000): name, status (draft|scheduled|sending|
//   paused|cancelled|finished), recipient_count, created_at, scheduled_at, no
//   expert_id; per-item counts via `voice_campaign_item_counts` over
//   call_queue, summarized by the hub's own `summarizeVoiceCampaignCounts`.
// - webpush_campaigns (20261210100000): name, status (agendada|enviando|
//   enviado|falhou|cancelada|pausada), target_count/sent_count/failed_count,
//   created_at, scheduled_at, no expert_id.
// - None has a "sent at" column: `agendada_em` is scheduled_at.
// - crm_results_daily (refresh_crm_results_day, last body 20261231100300):
//   source_type 'campaign' rows carry source_id = the campaign id. Sends,
//   failures and cost come only from sms_send_logs (campaign_id), so only
//   SMS has sends/cost there; clicks and direct conversions come from
//   link_dispatches (source_type 'campaign', source_id = SMS, e-mail or
//   web push campaign id; expert campaigns track links as 'expert', not
//   'campaign'). Voice has no link: its results are null. cost = billed
//   units × the Betleads SMS report price (BRL) or the house's own-account
//   unit cost; direct_revenue is in the house currency.
//   source_type 'journey' rows carry source_id = journey id (SMS sends of
//   "journey:<id>" + tracked-link clicks).
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { summarizeVoiceCampaignCounts, type VoiceItemCount } from "@/lib/channel-operation-state";

/* eslint-disable @typescript-eslint/no-explicit-any -- loose client typing, same pattern as scope.server.ts's db(); crm_results_daily and expert columns precede the generated types. */
export const opsDb = () => supabaseAdmin as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export const CANAIS = ["sms", "email", "voz", "webpush"] as const;
export type Canal = (typeof CANAIS)[number];

/** Campaign statuses that mean "the dispatch failed" (sms/webpush 'falhou'). */
export const STATUS_FALHA = new Set(["falhou", "failed", "error", "erro"]);

/** One campaign, normalized across the four channel tables. */
export type CampanhaBase = {
  tenant_id: string;
  canal: Canal;
  id: string;
  nome: string;
  status: string;
  criada_em: string;
  /** scheduled_at — no channel table stores a separate "sent at". */
  agendada_em: string | null;
  total: number | null;
  enviados: number | null;
  falhas: number | null;
  /** Only sms_campaigns and email_campaigns have expert_id; null elsewhere. */
  expert_id: string | null;
};

const IN_CHUNK = 100;
const PAGE = 1000;
/** Rows per channel table per call; above it the list is marked `limite_atingido`. */
export const CAMPANHAS_MAX_POR_CANAL = 1000;
const CRM_MAX_PAGES = 50;

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Row = Record<string, unknown>;

const CHANNEL_TABLE: Record<Canal, { table: string; columns: string }> = {
  sms: {
    table: "sms_campaigns",
    columns:
      "id,tenant_id,name,status,created_at,scheduled_at,total_count,sent_count,failed_count,expert_id",
  },
  email: {
    table: "email_campaigns",
    columns: "id,tenant_id,name,status,created_at,scheduled_at,stats,expert_id",
  },
  voz: {
    table: "voice_campaigns",
    columns: "id,tenant_id,name,status,created_at,scheduled_at,recipient_count",
  },
  webpush: {
    table: "webpush_campaigns",
    columns:
      "id,tenant_id,name,status,created_at,scheduled_at,target_count,sent_count,failed_count",
  },
};

function toBase(canal: Canal, row: Row): CampanhaBase {
  const base = {
    tenant_id: String(row.tenant_id),
    canal,
    id: String(row.id),
    nome: String(row.name ?? "").trim(),
    status: String(row.status ?? ""),
    criada_em: String(row.created_at ?? ""),
    agendada_em: row.scheduled_at ? String(row.scheduled_at) : null,
    expert_id: null as string | null,
  };
  switch (canal) {
    case "sms":
      return {
        ...base,
        total: numOrNull(row.total_count),
        enviados: numOrNull(row.sent_count),
        falhas: numOrNull(row.failed_count),
        expert_id: row.expert_id ? String(row.expert_id) : null,
      };
    case "email": {
      const stats = (row.stats && typeof row.stats === "object" ? row.stats : {}) as Row;
      return {
        ...base,
        total: numOrNull(stats.total ?? stats.destinatarios),
        enviados: numOrNull(stats.enviados ?? stats.sent),
        falhas: numOrNull(stats.falhas ?? stats.failed),
        expert_id: row.expert_id ? String(row.expert_id) : null,
      };
    }
    case "webpush":
      return {
        ...base,
        total: numOrNull(row.target_count),
        enviados: numOrNull(row.sent_count),
        falhas: numOrNull(row.failed_count),
      };
    case "voz":
      // Filled from call_queue by withVoiceCounts; recipient_count until then.
      return { ...base, total: numOrNull(row.recipient_count), enviados: null, falhas: null };
  }
}

export type JanelaCampanhas = { fromInstant: string; toInstant: string };

/**
 * Campaigns of `canal` created OR scheduled in [fromInstant, toInstant), of
 * the given houses (`tenant_id in ids`), newest first. `status` filters the
 * stored status exactly. Returns at most CAMPANHAS_MAX_POR_CANAL rows and
 * whether that cap was hit.
 */
export async function loadCampanhasCanal(
  canal: Canal,
  tenantIds: string[],
  janela: JanelaCampanhas,
  status?: string,
): Promise<{ campanhas: CampanhaBase[]; limite_atingido: boolean }> {
  if (!tenantIds.length) return { campanhas: [], limite_atingido: false };
  const { table, columns } = CHANNEL_TABLE[canal];
  const { fromInstant: from, toInstant: to } = janela;
  const rows: Row[] = [];
  for (const ids of chunks(tenantIds)) {
    let query = opsDb()
      .from(table)
      .select(columns)
      .in("tenant_id", ids)
      .or(
        `and(created_at.gte.${from},created_at.lt.${to}),and(scheduled_at.gte.${from},scheduled_at.lt.${to})`,
      );
    if (status) query = query.eq("status", status);
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(CAMPANHAS_MAX_POR_CANAL + 1);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
  }
  const campanhas = rows.map((row) => toBase(canal, row));
  const limite_atingido = campanhas.length > CAMPANHAS_MAX_POR_CANAL;
  const fixed = canal === "voz" ? await withVoiceCounts(campanhas) : campanhas;
  return { campanhas: fixed.slice(0, CAMPANHAS_MAX_POR_CANAL), limite_atingido };
}

/**
 * Voice counts from call_queue (`voice_campaign_item_counts`), summarized
 * exactly like the voice hub (total, handed to the provider, failed). A
 * campaign with no item keeps recipient_count as total and null counts.
 */
async function withVoiceCounts(campanhas: CampanhaBase[]): Promise<CampanhaBase[]> {
  if (!campanhas.length) return campanhas;
  const byCampaign = new Map<string, VoiceItemCount[]>();
  for (const ids of chunks(campanhas.map((c) => c.id))) {
    const { data, error } = await opsDb().rpc("voice_campaign_item_counts", {
      p_campaign_ids: ids,
    });
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as VoiceItemCount[]) {
      const key = String(row.voice_campaign_id);
      byCampaign.set(key, [...(byCampaign.get(key) ?? []), row]);
    }
  }
  return campanhas.map((campanha) => {
    const counts = byCampaign.get(campanha.id);
    if (!counts?.length) return campanha;
    const summary = summarizeVoiceCampaignCounts(
      {
        id: campanha.id,
        name: campanha.nome,
        status: campanha.status,
        scheduled_at: campanha.agendada_em,
        created_at: campanha.criada_em,
        recipient_count: campanha.total ?? 0,
      },
      counts,
    );
    return { ...campanha, total: summary.total, enviados: summary.sent, falhas: summary.failed };
  });
}

// ─── crm_results_daily ──────────────────────────────────────────────────────

export type ResultadoCrm = {
  /** SMS sends counted by the Central (sms_send_logs). */
  enviados: number;
  falhas: number;
  /** BRL: billed SMS units × Betleads report price (or own-account unit cost). */
  custo_brl: number;
  cliques: number;
  conversoes_diretas: number;
  /** House currency: deposits after a click (direct attribution). */
  receita_direta: number;
};

const CRM_COLUMNS =
  "source_id,metric_date,source_key,step_position,player_state,sent,failed,cost,human_clicks,direct_conversions,direct_revenue";

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * crm_results_daily summed per source_id, for one house, one source_type and
 * the given source ids, between two São Paulo dates (inclusive). A source id
 * with no row is absent from the map (callers turn that into null).
 */
export async function loadResultadosCrm(
  tenantId: string,
  sourceType: "campaign" | "journey",
  sourceIds: string[],
  inicio: string,
  fim: string,
): Promise<Map<string, ResultadoCrm>> {
  const out = new Map<string, ResultadoCrm>();
  for (const ids of chunks(Array.from(new Set(sourceIds)))) {
    for (let page = 0; page < CRM_MAX_PAGES; page += 1) {
      const { data, error } = await opsDb()
        .from("crm_results_daily")
        .select(CRM_COLUMNS)
        .eq("tenant_id", tenantId)
        .eq("source_type", sourceType)
        .in("source_id", ids)
        .gte("metric_date", inicio)
        .lte("metric_date", fim)
        .order("metric_date")
        .order("source_key")
        .order("step_position")
        .order("player_state")
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Row[];
      for (const row of rows) {
        const key = String(row.source_id);
        const acc = out.get(key) ?? {
          enviados: 0,
          falhas: 0,
          custo_brl: 0,
          cliques: 0,
          conversoes_diretas: 0,
          receita_direta: 0,
        };
        acc.enviados += num(row.sent);
        acc.falhas += num(row.failed);
        acc.custo_brl += num(row.cost);
        acc.cliques += num(row.human_clicks);
        acc.conversoes_diretas += num(row.direct_conversions);
        acc.receita_direta += num(row.direct_revenue);
        out.set(key, acc);
      }
      if (rows.length < PAGE) break;
    }
  }
  for (const value of out.values()) {
    value.custo_brl = round2(value.custo_brl);
    value.receita_direta = round2(value.receita_direta);
  }
  return out;
}
