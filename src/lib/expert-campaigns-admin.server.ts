// Área do Expert §8 — leituras do admin da casa sobre as campanhas dos
// experts (complementa expert-campaigns.server.ts sem reestruturá-lo):
// - getExpertCampaignForAdminCore: o conteúdo de uma campanha para o admin
//   conferir antes de aprovar (texto do SMS, assunto + HTML do e-mail,
//   roteiro ou áudio da voz), com público, destinatários e custo estimado.
// - listExpertUsageForAdminCore: uso do mês × teto de cada expert da casa,
//   mais as campanhas aguardando aprovação.
// Tudo com o client service_role e filtro explícito de casa.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { expertCapMonth } from "@/lib/billing/expert-cap-alerts.server";
import { expertNamesById } from "@/lib/expert-names.server";
import { describeSmsAudience, normalizeSmsAudienceCriteria } from "@/lib/sms-audience-criteria";
import { countSmsSegments, toGsm7Text } from "@/lib/sms-segments";

/* eslint-disable @typescript-eslint/no-explicit-any -- expert tables/columns are not in the generated Supabase types yet. */
const db = () => supabaseAdmin as any;

export type ExpertAdminChannel = "sms" | "email" | "voice";

const TABLE: Record<ExpertAdminChannel, string> = {
  sms: "sms_campaigns",
  email: "email_campaigns",
  voice: "expert_voice_campaigns",
};

export const EXPERT_ADMIN_CAMPAIGN_NOT_FOUND = "Campanha não encontrada.";

export type ExpertCampaignAdminContent =
  | { kind: "sms"; text: string; segments: number }
  | { kind: "email"; subject: string; preheader: string | null; html: string }
  | {
      kind: "voice";
      source: "script" | "asset";
      /** Nome do roteiro TTS ou do áudio da biblioteca ("" se sumiu). */
      name: string;
      /** Texto do roteiro TTS (null para áudio fixo). */
      text: string | null;
      durationSeconds: number | null;
    };

export type ExpertCampaignAdminDetail = {
  id: string;
  channel: ExpertAdminChannel;
  name: string;
  status: string;
  approvalStatus: "pendente" | "aprovada" | "recusada" | null;
  rejectionReason: string | null;
  lastError: string | null;
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string | null;
  totalCount: number;
  estimatedCost: number | null;
  expertId: string;
  expertNome: string;
  /** Resumo legível do público (regras ou seleção). */
  audienceDescription: string;
  content: ExpertCampaignAdminContent;
};

function describeAudience(raw: unknown): string {
  try {
    const text = describeSmsAudience(normalizeSmsAudienceCriteria(raw));
    return text === "Todos os jogadores com telefone válido" ? "Toda a carteira do expert" : text;
  } catch {
    return "Público do expert";
  }
}

async function voiceContent(
  tenantId: string,
  row: Record<string, any>,
): Promise<ExpertCampaignAdminContent> {
  if (row.voice_asset_id) {
    const { data, error } = await db()
      .from("journey_voice_assets")
      .select("id,name,duration_seconds")
      .eq("id", row.voice_asset_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const seconds = Number(data?.duration_seconds);
    return {
      kind: "voice",
      source: "asset",
      name: String(data?.name ?? ""),
      text: null,
      durationSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    };
  }
  const { data, error } = await db()
    .from("call_scripts")
    .select("id,name,content")
    .eq("id", row.script_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return {
    kind: "voice",
    source: "script",
    name: String(data?.name ?? ""),
    text: data?.content == null ? null : String(data.content),
    durationSeconds: null,
  };
}

/** Uma campanha de expert com o conteúdo, para o admin revisar. */
export async function getExpertCampaignForAdminCore(
  tenantId: string,
  data: { channel: ExpertAdminChannel; id: string },
): Promise<ExpertCampaignAdminDetail> {
  const { data: row, error } = await db()
    .from(TABLE[data.channel])
    .select("*")
    .eq("id", data.id)
    .eq("tenant_id", tenantId)
    .not("expert_id", "is", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error(EXPERT_ADMIN_CAMPAIGN_NOT_FOUND);
  const r = row as Record<string, any>;

  let content: ExpertCampaignAdminContent;
  let criteria: unknown;
  let totalCount: number;
  if (data.channel === "sms") {
    const text = String(r.content ?? "");
    content = {
      kind: "sms",
      text,
      segments: Math.max(1, countSmsSegments(toGsm7Text(text)).segments),
    };
    criteria = r.audience_criteria;
    totalCount = Number(r.total_count ?? 0);
  } else if (data.channel === "email") {
    const snap = (r.template_snapshot ?? {}) as Record<string, any>;
    content = {
      kind: "email",
      subject: String(snap.subject ?? ""),
      preheader: snap.preheader == null || snap.preheader === "" ? null : String(snap.preheader),
      html: String(snap.body_html ?? ""),
    };
    criteria = (r.audience_filter ?? {})?.audience_criteria;
    totalCount = Number((r.stats ?? {})?.total ?? 0);
  } else {
    content = await voiceContent(tenantId, r);
    criteria = r.audience_criteria;
    totalCount = Number(r.total_count ?? 0);
  }

  const names = await expertNamesById(tenantId, [r.expert_id]);
  return {
    id: r.id,
    channel: data.channel,
    name: String(r.name ?? ""),
    status: String(r.status ?? ""),
    approvalStatus: (r.approval_status ?? null) as ExpertCampaignAdminDetail["approvalStatus"],
    rejectionReason: r.rejection_reason ?? null,
    lastError: (data.channel === "email" ? r.blocked_reason : r.last_error) ?? null,
    scheduledAt: r.scheduled_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
    totalCount: Number.isFinite(totalCount) ? totalCount : 0,
    estimatedCost: r.expert_estimated_cost == null ? null : Number(r.expert_estimated_cost),
    expertId: r.expert_id,
    expertNome: names.get(r.expert_id) ?? "",
    audienceDescription: describeAudience(criteria),
    content,
  };
}

export type ExpertUsageRow = {
  expertId: string;
  /** R$/mês; null = sem teto; 0 = envios bloqueados. */
  teto: number | null;
  /** R$ consumidos no mês (preço cobrado da casa, todos os canais). */
  usado: number;
  /** Campanhas aguardando aprovação. */
  pendentes: number;
  /** Custo estimado das campanhas aguardando aprovação. */
  pendentesEstimado: number;
};

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const toNumber = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Uso do mês × teto de cada expert da casa (ou de um só, com `expertId`). */
export async function listExpertUsageForAdminCore(
  tenantId: string,
  filter: { expertId?: string | null } = {},
  now: Date = new Date(),
): Promise<{ mes: string; items: ExpertUsageRow[] }> {
  const month = expertCapMonth(now);
  let expertsQ = db().from("experts").select("id,teto_mensal").eq("tenant_id", tenantId);
  if (filter.expertId) expertsQ = expertsQ.eq("id", filter.expertId);
  let usageQ = db()
    .from("expert_monthly_usage")
    .select("expert_id,amount")
    .eq("tenant_id", tenantId)
    .eq("month", month);
  if (filter.expertId) usageQ = usageQ.eq("expert_id", filter.expertId);
  const pendingQs = (Object.keys(TABLE) as ExpertAdminChannel[]).map((channel) => {
    let q = db()
      .from(TABLE[channel])
      .select("expert_id,expert_estimated_cost")
      .eq("tenant_id", tenantId)
      .not("expert_id", "is", null)
      .eq("status", "aguardando_aprovacao")
      .eq("approval_status", "pendente");
    if (filter.expertId) q = q.eq("expert_id", filter.expertId);
    return q;
  });
  const [experts, usage, ...pending] = await Promise.all([expertsQ, usageQ, ...pendingQs]);
  for (const r of [experts, usage, ...pending]) if (r.error) throw new Error(r.error.message);

  const usedBy = new Map<string, number>();
  for (const u of (usage.data ?? []) as any[]) usedBy.set(u.expert_id, toNumber(u.amount));
  const pendingBy = new Map<string, { count: number; cost: number }>();
  for (const result of pending)
    for (const p of (result.data ?? []) as any[]) {
      const acc = pendingBy.get(p.expert_id) ?? { count: 0, cost: 0 };
      acc.count += 1;
      acc.cost += toNumber(p.expert_estimated_cost);
      pendingBy.set(p.expert_id, acc);
    }

  return {
    mes: month.slice(0, 7),
    items: ((experts.data ?? []) as any[]).map((e) => {
      const teto = e.teto_mensal == null ? null : Number(e.teto_mensal);
      const p = pendingBy.get(e.id);
      return {
        expertId: e.id,
        teto: teto != null && Number.isFinite(teto) ? teto : null,
        usado: round4(usedBy.get(e.id) ?? 0),
        pendentes: p?.count ?? 0,
        pendentesEstimado: round4(p?.cost ?? 0),
      };
    }),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
