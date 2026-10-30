// Área do Expert §8 — campanhas de SMS, e-mail e voz do expert (núcleo das
// server functions de expert-campaigns.functions.ts).
//
// Regras (decisões do produto, ver o relatório do PR):
// - Toda campanha de expert é uma linha persistida enviada pelo worker/fila
//   (nunca envio inline). No modo 'aprovacao' fica pendente
//   (status 'aguardando_aprovacao' + approval_status 'pendente') até o admin
//   aprovar; editar uma campanha pendente/aprovada a devolve a pendente.
// - Público só do lado do servidor: critério (público próprio, da casa para o
//   expert de acesso total, ou regras) + subconjunto opcional de jogadores,
//   sempre intersectado com o escopo do expert. Nunca telefones/e-mails/
//   listas externas vindas do navegador. As prévias devolvem só contagens.
// - Conteúdo livre, mas todo link passa por assertDestinationAllowed
//   (strict). Remetente e encurtador: sempre os padrões da casa.
// - Teto mensal: checado de verdade, de forma atômica, na reserva da
//   carteira (expert_wallet_reserve). Aqui só a pré-checagem da estimativa.
// - Tudo com o client service_role e filtros explícitos de casa/expert.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { expertCapMonth } from "@/lib/billing/expert-cap-alerts.server";
import { expertNamesById } from "@/lib/expert-names.server";
import { brl } from "@/lib/format";
import { buildQuickLinkUrl } from "@/lib/house-config";
import { requireExpertContext, type ExpertContext } from "@/lib/expert-access.server";
import {
  audienceScopeOf,
  filterPlayerIdsToExpert,
  loadExpertScope,
  normalizeAffiliateIds,
  type ExpertScope,
} from "@/lib/expert-campaign-scope.server";
import { assertExpertContentLinksAllowed } from "@/lib/expert-content-policy.server";
import { conversionFunnelSnapshot } from "@/lib/conversion-funnel";
import { resolveCampaignRecipients, type CampaignDb } from "@/lib/campaign-recipients.server";
import {
  isSelectionAudience,
  MAX_SELECTION_PLAYER_IDS,
  normalizeSmsAudienceCriteria,
  selectionAudienceLabel,
  type SmsAudienceCriteria,
} from "@/lib/sms-audience-criteria";
import {
  resolveAudienceForTenant,
  selectionAudienceName,
  type SelectionDb,
} from "@/lib/sms-audience-selection.server";
import type { ResolvedSmsAudience } from "@/lib/sms-audiences.functions";
import { listTenantAudiences, toClientAudience } from "@/lib/sms-audience-crud.functions";
import { countSmsSegments, toGsm7Text } from "@/lib/sms-segments";
import { voiceReservationUnits } from "@/lib/infobip-voice.server";
import { assertTenantNotDemoForSend } from "@/lib/tenant-access.server";
import type { BlockReason } from "@/lib/channel-eligibility.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- new tables/columns are not in the generated Supabase types yet. */
const db = () => supabaseAdmin as any;

export type ExpertServerContext = { userId: string; activeTenantId?: string | null };

export type ExpertChannel = "sms" | "email" | "voice";
export type ExpertApprovalStatus = "pendente" | "aprovada" | "recusada" | null;

// ─── Mensagens ──────────────────────────────────────────────────────────────

export const EXPERT_CAMPAIGN_NOT_FOUND = "Campanha não encontrada.";
export const EXPERT_AUDIENCE_NOT_FOUND = "Público não encontrado.";
export const EXPERT_AUDIENCE_DUPLICATE = "Você já tem um público com esse nome.";
export const EXPERT_AUDIENCE_EMPTY_SELECTION = "Nenhum dos jogadores selecionados está na sua carteira.";
export const EXPERT_NO_RECIPIENTS = "Nenhum jogador do seu público pode receber esta campanha.";
export const EXPERT_CAMPAIGN_NOT_EDITABLE =
  "Esta campanha não pode mais ser editada: o envio já começou ou ela foi encerrada.";
export const EXPERT_CAMPAIGN_NOT_PENDING = "Esta campanha não está aguardando aprovação.";
export const EXPERT_CAMPAIGN_CHANGED =
  "A campanha mudou depois que você abriu. Recarregue e confira antes de aprovar.";
export const EXPERT_CAMPAIGN_NOT_PAUSABLE = "Esta campanha não está em andamento ou agendada.";
export const EXPERT_CAMPAIGN_NOT_PAUSED = "Esta campanha não está pausada.";
export const EXPERT_INACTIVE_CANNOT_APPROVE = "O expert está desativado: a campanha não pode ser aprovada.";
export const EXPERT_INACTIVE_CANNOT_RESUME = "O expert está desativado: a campanha não pode ser retomada.";
export const EXPERT_CAP_STILL_REACHED =
  "O expert continua no teto mensal. Aumente o teto na tela Experts ou aguarde a virada do mês.";
export const EXPERT_EMAIL_CONTENT_REQUIRED = "Escreva o assunto e o conteúdo do e-mail.";
export const EXPERT_EMAIL_TEMPLATE_UNAVAILABLE = "Template de e-mail indisponível para esta campanha.";
export const EXPERT_VOICE_SOURCE_UNAVAILABLE = "Roteiro ou áudio da casa indisponível.";
export const EXPERT_SCHEDULE_TOO_SOON = "O horário agendado precisa estar pelo menos 1 minuto no futuro";
export const EXPERT_SCHEDULE_INVALID = "Data/hora inválida";
export const EXPERT_REJECT_REASON_REQUIRED = "Informe o motivo da recusa.";
/** Voz: mesmo limite da voz em massa da casa. */
export const EXPERT_VOICE_MAX_RECIPIENTS = 200;
export const EXPERT_VOICE_TOO_MANY = `Voz aceita até ${EXPERT_VOICE_MAX_RECIPIENTS} destinatários por campanha.`;
export const EXPERT_CAP_BLOCKED =
  "Seu teto mensal de envios é R$ 0,00: os envios estão bloqueados. Fale com o admin da casa.";

const money = (value: number) => brl(value).replace(new RegExp(String.fromCharCode(160), "g"), " ");

export function expertCapExceededMessage(estimated: number, remaining: number, teto: number) {
  return (
    `Esta campanha custaria cerca de ${money(estimated)}, mas restam ${money(Math.max(0, remaining))} ` +
    `do seu teto mensal de ${money(teto)}. Reduza o público ou peça ao admin para aumentar o teto.`
  );
}

// ─── Escopo ─────────────────────────────────────────────────────────────────

/** Escopo do expert logado, a partir do contexto (já validado como ativo). */
export function scopeFromContext(ctx: ExpertContext): ExpertScope {
  return {
    expertId: ctx.expertId,
    tenantId: ctx.tenantId,
    nome: ctx.nome,
    tipo: ctx.tipo,
    ativo: true,
    envioModo: ctx.envioModo,
    tetoMensal: ctx.tetoMensal,
    affiliateIds: normalizeAffiliateIds(ctx.affiliateIds),
  };
}

async function requireExpert(ctx: ExpertServerContext) {
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);
  return { expert, scope: scopeFromContext(expert) };
}

// ─── Preço, uso e teto ──────────────────────────────────────────────────────

type PriceItem = "sms" | "email" | "voice_30s";

export async function housePrice(tenantId: string, item: PriceItem): Promise<number> {
  const { data, error } = await db().rpc("billing_effective_price", { _tenant: tenantId, _item: item });
  if (error) throw new Error(error.message);
  const price = Number((data as { unit_price?: unknown } | null)?.unit_price ?? 0);
  return Number.isFinite(price) ? price : 0;
}

/** Consumo do expert no mês corrente (preço de venda, todos os canais). */
export async function expertMonthlyUsed(expertId: string, now: Date = new Date()): Promise<number> {
  const { data, error } = await db()
    .from("expert_monthly_usage")
    .select("amount")
    .eq("expert_id", expertId)
    .eq("month", expertCapMonth(now))
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Number(data?.amount ?? 0);
}

/** Pré-checagem da estimativa contra o que resta do teto (a checagem real é atômica na reserva). */
export async function assertCapAllowsEstimate(
  scope: Pick<ExpertScope, "expertId" | "tetoMensal">,
  estimated: number,
): Promise<void> {
  const teto = scope.tetoMensal;
  if (teto === null) return;
  if (teto <= 0) throw new Error(EXPERT_CAP_BLOCKED);
  const used = await expertMonthlyUsed(scope.expertId);
  const remaining = teto - used;
  if (estimated > remaining + 1e-9) throw new Error(expertCapExceededMessage(estimated, remaining, teto));
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export async function estimateCampaignCost(
  tenantId: string,
  channel: ExpertChannel,
  recipients: number,
  opts: { content?: string; voiceSeconds?: number | null } = {},
): Promise<number> {
  if (recipients <= 0) return 0;
  if (channel === "sms") {
    const segments = Math.max(1, countSmsSegments(toGsm7Text(opts.content ?? "")).segments);
    return round4(recipients * segments * (await housePrice(tenantId, "sms")));
  }
  if (channel === "email") return round4(recipients * (await housePrice(tenantId, "email")));
  return round4(
    recipients * voiceReservationUnits(opts.voiceSeconds ?? null) * (await housePrice(tenantId, "voice_30s")),
  );
}

// ─── Público ────────────────────────────────────────────────────────────────

/**
 * Critério a gravar numa campanha de expert. Com subconjunto de jogadores,
 * vira uma seleção inline só com os jogadores do escopo; senão, o critério
 * normalizado (regras, ou seleção por referência — a posse é checada na
 * resolução). `affiliateIds` do navegador é descartado pelo normalizador.
 */
export async function buildExpertCampaignCriteria(
  scope: ExpertScope,
  rawCriteria: unknown,
  playerIds?: readonly string[] | null,
): Promise<SmsAudienceCriteria> {
  if (playerIds && playerIds.length > 0) {
    const visible = await filterPlayerIdsToExpert(scope, playerIds.map((id) => id.toLowerCase()));
    return normalizeSmsAudienceCriteria({
      timing: "selection",
      playerIds: visible,
      selectionCount: visible.length,
    });
  }
  const criteria = normalizeSmsAudienceCriteria(rawCriteria);
  if (isSelectionAudience(criteria) && criteria.playerIds)
    throw new Error("Envie o público de seleção pelo id, não pela lista de jogadores.");
  return criteria;
}

export type ExpertAudienceResolution = {
  base: ResolvedSmsAudience;
  eligibleIdentifiers: string[];
  eligiblePlayerIds: string[];
  eligibleTotal: number;
  excludedTotal: number;
  exclusions: Partial<Record<BlockReason, number>>;
};

/** Resolve o critério com o escopo do expert e aplica consentimento/supressão do canal. */
export async function resolveScopedAudience(
  scope: ExpertScope,
  criteria: SmsAudienceCriteria,
  channel: ExpertChannel,
): Promise<ExpertAudienceResolution> {
  const base = await resolveAudienceForTenant(
    supabaseAdmin as unknown as SelectionDb,
    scope.tenantId,
    criteria,
    audienceScopeOf(scope),
  );
  const candidates = channel === "email" ? (base.emailPlayerIds ?? []) : (base.phones ?? []);
  const { data, error } = await db().rpc("resolve_campaign_channel_eligibility", {
    p_tenant_id: scope.tenantId,
    p_channel: channel,
    p_candidates: candidates,
  });
  if (error || !data) throw new Error("Não foi possível validar os contatos do público.");
  const eligibility = data as {
    eligibleIdentifiers?: string[];
    eligiblePlayerIds?: string[];
    invalidCount?: number;
    optOutCount?: number;
  };
  const eligibleIdentifiers = eligibility.eligibleIdentifiers ?? [];
  const eligiblePlayerIds = eligibility.eligiblePlayerIds ?? [];
  const exclusions: Partial<Record<BlockReason, number>> = {};
  const missing = Math.max(0, base.total - candidates.length);
  if (missing) exclusions[channel === "email" ? "missing_email" : "missing_phone"] = missing;
  if (eligibility.invalidCount)
    exclusions[channel === "email" ? "invalid_email" : "invalid_phone"] = eligibility.invalidCount;
  if (eligibility.optOutCount)
    exclusions[channel === "email" ? "email_opt_out" : channel === "voice" ? "voice_opt_out" : "sms_opt_out"] =
      eligibility.optOutCount;
  return {
    base,
    eligibleIdentifiers,
    eligiblePlayerIds,
    eligibleTotal: eligibleIdentifiers.length,
    excludedTotal: Math.max(0, base.total - eligibleIdentifiers.length),
    exclusions,
  };
}

export type AudienceListRow = {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  criteria: SmsAudienceCriteria;
  /** "meu": do expert (editável); "casa": da casa, só leitura (expert de acesso total). */
  owner: "meu" | "casa";
  readOnly: boolean;
};

export async function listExpertAudiencesFor(ctx: ExpertServerContext): Promise<AudienceListRow[]> {
  const { expert, scope } = await requireExpert(ctx);
  const own = (await listTenantAudiences(db(), expert.tenantId, { expertId: expert.expertId })).map(
    (row: any) => ({ ...row, owner: "meu" as const, readOnly: false }),
  );
  if (scope.tipo !== "total") return own;
  const house = (await listTenantAudiences(db(), expert.tenantId)).map((row: any) => ({
    ...row,
    owner: "casa" as const,
    readOnly: true,
  }));
  return [...own, ...house];
}

export type SaveExpertAudienceInput = {
  id?: string;
  name: string;
  description?: string;
  criteria: Record<string, unknown>;
};

export async function saveExpertAudienceFor(
  ctx: ExpertServerContext,
  data: SaveExpertAudienceInput,
): Promise<AudienceListRow> {
  const { expert, scope } = await requireExpert(ctx);
  let criteria: SmsAudienceCriteria;
  if (data.id) {
    const { data: existing, error } = await db()
      .from("sms_audiences")
      .select("criteria")
      .eq("id", data.id)
      .eq("tenant_id", expert.tenantId)
      .eq("expert_id", expert.expertId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!existing) throw new Error(EXPERT_AUDIENCE_NOT_FOUND);
    const stored = normalizeSmsAudienceCriteria(existing.criteria);
    criteria = isSelectionAudience(stored) ? stored : normalizeSmsAudienceCriteria(data.criteria);
  } else {
    criteria = normalizeSmsAudienceCriteria(data.criteria);
  }
  if (isSelectionAudience(criteria) && !data.id) {
    if (!criteria.playerIds)
      throw new Error("Um público de seleção só pode ser criado a partir dos seus leads.");
    const visible = await filterPlayerIdsToExpert(scope, criteria.playerIds);
    if (visible.length === 0) throw new Error(EXPERT_AUDIENCE_EMPTY_SELECTION);
    const { audienceId: _ignored, ...rest } = criteria;
    criteria = { ...rest, playerIds: visible, selectionCount: visible.length };
  }
  const payload = {
    tenant_id: expert.tenantId,
    expert_id: expert.expertId,
    name: data.name.trim(),
    description: data.description?.trim() || null,
    criteria,
    updated_at: new Date().toISOString(),
  };
  const q = data.id
    ? db()
        .from("sms_audiences")
        .update(payload)
        .eq("id", data.id)
        .eq("tenant_id", expert.tenantId)
        .eq("expert_id", expert.expertId)
        .select()
        .single()
    : db().from("sms_audiences").insert(payload).select().single();
  const { data: row, error } = await q;
  if (error) {
    if (error.code === "23505") throw new Error(EXPERT_AUDIENCE_DUPLICATE);
    throw new Error(error.message);
  }
  return { ...toClientAudience(row), owner: "meu", readOnly: false };
}

export async function deleteExpertAudienceFor(
  ctx: ExpertServerContext,
  data: { id: string },
): Promise<{ ok: true }> {
  const { expert } = await requireExpert(ctx);
  const { data: rows, error } = await db()
    .from("sms_audiences")
    .delete()
    .eq("id", data.id)
    .eq("tenant_id", expert.tenantId)
    .eq("expert_id", expert.expertId)
    .select("id");
  if (error) throw new Error(error.message);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(EXPERT_AUDIENCE_NOT_FOUND);
  return { ok: true };
}

export async function createExpertSelectionAudienceFor(
  ctx: ExpertServerContext,
  data: { playerIds: string[]; label?: string },
): Promise<{ id: string; name: string; playerCount: number; discarded: number }> {
  const { expert, scope } = await requireExpert(ctx);
  const requested = Array.from(new Set(data.playerIds.map((id) => id.toLowerCase())));
  if (requested.length > MAX_SELECTION_PLAYER_IDS)
    throw new Error(`A seleção passa de ${MAX_SELECTION_PLAYER_IDS.toLocaleString("pt-BR")} jogadores.`);
  const visible = await filterPlayerIdsToExpert(scope, requested);
  if (visible.length === 0) throw new Error(EXPERT_AUDIENCE_EMPTY_SELECTION);
  const now = new Date();
  const name = (data.label ?? "").trim().slice(0, 120) || selectionAudienceName(now);
  const criteria = normalizeSmsAudienceCriteria({
    timing: "selection",
    playerIds: visible,
    selectionCount: visible.length,
  });
  const { data: row, error } = await db()
    .from("sms_audiences")
    .insert({
      tenant_id: expert.tenantId,
      expert_id: expert.expertId,
      name,
      description: `${selectionAudienceLabel(visible.length)} nos seus leads`,
      criteria,
      updated_at: now.toISOString(),
    })
    .select("id")
    .single();
  if (error || !row) {
    if (error?.code === "23505") throw new Error(EXPERT_AUDIENCE_DUPLICATE);
    throw new Error(error?.message ?? "Não foi possível criar o público.");
  }
  return { id: row.id, name, playerCount: visible.length, discarded: requested.length - visible.length };
}

/** Prévia do compositor: mesma forma de ResolvedCampaignAudience, mas só contagens (listas vazias). */
export type ExpertResolvedCampaignAudience = ResolvedSmsAudience & {
  channel: ExpertChannel;
  eligibleTotal: number;
  excludedTotal: number;
  /** Sempre vazio para o expert: os destinatários são resolvidos no servidor no envio. */
  eligibleIdentifiers: string[];
  /** Sempre vazio para o expert. */
  eligiblePlayerIds: string[];
  exclusions: Partial<Record<BlockReason, number>>;
  /** Custo estimado (preço de venda da casa) para os elegíveis; e-mail/SMS/voz. */
  estimatedCost: number;
};

export async function resolveExpertCampaignAudienceFor(
  ctx: ExpertServerContext,
  data: {
    criteria: Record<string, unknown>;
    channel: ExpertChannel;
    playerIds?: string[];
    content?: string;
    voiceSeconds?: number | null;
  },
): Promise<ExpertResolvedCampaignAudience> {
  const { scope } = await requireExpert(ctx);
  const criteria = await buildExpertCampaignCriteria(scope, data.criteria, data.playerIds);
  let resolution: ExpertAudienceResolution;
  try {
    resolution = await resolveScopedAudience(scope, criteria, data.channel);
  } catch {
    throw new Error("Não foi possível calcular o público desta campanha.");
  }
  const estimatedCost = await estimateCampaignCost(scope.tenantId, data.channel, resolution.eligibleTotal, {
    content: data.content,
    voiceSeconds: data.voiceSeconds,
  });
  return {
    ...resolution.base,
    phones: [],
    emailPlayerIds: [],
    channel: data.channel,
    eligibleTotal: resolution.eligibleTotal,
    excludedTotal: resolution.excludedTotal,
    eligibleIdentifiers: [],
    eligiblePlayerIds: [],
    exclusions: resolution.exclusions,
    estimatedCost,
  };
}

// ─── Campanhas: criação / edição ────────────────────────────────────────────

export type ExpertCampaignSubmitResult = {
  id: string;
  channel: ExpertChannel;
  status: string;
  approvalStatus: ExpertApprovalStatus;
  /** Destinatários elegíveis agora (o worker recalcula no envio). */
  totalCount: number;
  estimatedCost: number;
  scheduledAt: string | null;
  /** Sempre true: campanhas de expert vão para a fila do worker. */
  queued: true;
};

function parseSchedule(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const at = new Date(raw);
  if (!Number.isFinite(at.getTime())) throw new Error(EXPERT_SCHEDULE_INVALID);
  if (at.getTime() < Date.now() + 60_000) throw new Error(EXPERT_SCHEDULE_TOO_SOON);
  return at;
}

/** Status/approval de uma campanha recém-submetida conforme o modo do expert. */
function submittedState(envioModo: ExpertScope["envioModo"]) {
  return envioModo === "aprovacao"
    ? { status: "aguardando_aprovacao", approval_status: "pendente" as const }
    : { status: "agendada", approval_status: null };
}

const CLEAR_APPROVAL = { approved_by: null, approved_at: null, rejection_reason: null };

/** Statuses an expert may still edit (nothing sent yet). */
const EDITABLE_SMS = ["aguardando_aprovacao", "recusada", "agendada"];
const EDITABLE_EMAIL = ["rascunho", "aguardando_aprovacao", "recusada", "agendada"];
const EDITABLE_VOICE = ["aguardando_aprovacao", "recusada"];

async function prepareAudience(
  scope: ExpertScope,
  channel: ExpertChannel,
  rawCriteria: unknown,
  playerIds: string[] | undefined,
  opts: { content?: string; voiceSeconds?: number | null } = {},
) {
  const criteria = await buildExpertCampaignCriteria(scope, rawCriteria, playerIds);
  const resolution = await resolveScopedAudience(scope, criteria, channel);
  if (resolution.eligibleTotal === 0) throw new Error(EXPERT_NO_RECIPIENTS);
  if (channel === "voice" && resolution.eligibleTotal > EXPERT_VOICE_MAX_RECIPIENTS)
    throw new Error(EXPERT_VOICE_TOO_MANY);
  const estimatedCost = await estimateCampaignCost(scope.tenantId, channel, resolution.eligibleTotal, opts);
  await assertCapAllowsEstimate(scope, estimatedCost);
  return { criteria, resolution, estimatedCost };
}

export type ExpertSmsCampaignInput = {
  /** Editing an existing campaign (back to pending in approval mode). */
  id?: string;
  campaignName: string;
  content: string;
  audienceCriteria: Record<string, unknown>;
  playerIds?: string[];
  /** ISO; absent = as soon as possible (after approval in approval mode). */
  scheduledAt?: string | null;
};

export async function saveExpertSmsCampaignFor(
  ctx: ExpertServerContext,
  data: ExpertSmsCampaignInput,
): Promise<ExpertCampaignSubmitResult> {
  const { expert, scope } = await requireExpert(ctx);
  await assertTenantNotDemoForSend(expert.tenantId);
  const scheduled = parseSchedule(data.scheduledAt);
  await assertExpertContentLinksAllowed(expert.tenantId, data.content);
  const { criteria, resolution, estimatedCost } = await prepareAudience(
    scope,
    "sms",
    data.audienceCriteria,
    data.playerIds,
    { content: data.content },
  );
  const state = submittedState(scope.envioModo);
  const scheduledAt = (scheduled ?? new Date()).toISOString();
  const row = {
    name: data.campaignName.trim(),
    content: data.content,
    route: "iGaming",
    recipients: [],
    total_count: resolution.eligibleTotal,
    scheduled_at: scheduledAt,
    rate_per_minute: 1000,
    track_links: true,
    template_id: null,
    template_snapshot: null,
    short_domain_id: null,
    audience_criteria: criteria,
    audience_resolved_at: null,
    expert_estimated_cost: estimatedCost,
    last_error: null,
    ...state,
    ...CLEAR_APPROVAL,
  };
  let saved: { id: string; status: string; approval_status: string | null } | null;
  if (data.id) {
    const { data: updated, error } = await db()
      .from("sms_campaigns")
      .update(row)
      .eq("id", data.id)
      .eq("tenant_id", expert.tenantId)
      .eq("expert_id", expert.expertId)
      .in("status", EDITABLE_SMS)
      .eq("sent_cursor", 0)
      .select("id,status,approval_status")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error(EXPERT_CAMPAIGN_NOT_EDITABLE);
    saved = updated;
  } else {
    const { data: inserted, error } = await db()
      .from("sms_campaigns")
      .insert({
        ...row,
        tenant_id: expert.tenantId,
        expert_id: expert.expertId,
        created_by: ctx.userId,
        sent_cursor: 0,
        conversion_objective: "conversion",
        conversion_funnel_snapshot: conversionFunnelSnapshot("conversion", "campaign"),
      })
      .select("id,status,approval_status")
      .single();
    if (error) throw new Error(error.message);
    saved = inserted;
  }
  return {
    id: saved!.id,
    channel: "sms",
    status: saved!.status,
    approvalStatus: (saved!.approval_status ?? null) as ExpertApprovalStatus,
    totalCount: resolution.eligibleTotal,
    estimatedCost,
    scheduledAt,
    queued: true,
  };
}

export type ExpertEmailCampaignInput = {
  id?: string;
  nome: string;
  /** Free content (subject + HTML)… */
  assunto?: string;
  html?: string;
  preheader?: string;
  /** …or a published house template, copied (snapshot) at save time. */
  templateId?: string | null;
  audienceCriteria: Record<string, unknown>;
  playerIds?: string[];
  agendadoPara?: string | null;
  /** "rascunho": keep editing (never sent); "agendada": submit. */
  status: "rascunho" | "agendada";
};

async function emailSnapshot(tenantId: string, data: ExpertEmailCampaignInput) {
  if (data.templateId) {
    const { data: tpl, error } = await db()
      .from("email_templates")
      .select("id,name,subject,preheader,from_name,body_html,body_text,lifecycle_status,version")
      .eq("id", data.templateId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!tpl || tpl.lifecycle_status !== "published") throw new Error(EXPERT_EMAIL_TEMPLATE_UNAVAILABLE);
    return {
      source_template_id: tpl.id,
      name: tpl.name,
      subject: data.assunto?.trim() || tpl.subject,
      preheader: data.preheader ?? tpl.preheader ?? null,
      body_html: data.html?.trim() ? data.html : tpl.body_html,
      body_text: tpl.body_text ?? null,
      version: tpl.version ?? null,
    };
  }
  if (!data.assunto?.trim() || !data.html?.trim()) throw new Error(EXPERT_EMAIL_CONTENT_REQUIRED);
  return {
    source_template_id: null,
    name: data.nome.trim(),
    subject: data.assunto.trim(),
    preheader: data.preheader ?? null,
    body_html: data.html,
    body_text: null,
    version: null,
  };
}

export async function saveExpertEmailCampaignFor(
  ctx: ExpertServerContext,
  data: ExpertEmailCampaignInput,
): Promise<ExpertCampaignSubmitResult> {
  const { expert, scope } = await requireExpert(ctx);
  await assertTenantNotDemoForSend(expert.tenantId);
  const submit = data.status === "agendada";
  const scheduled = submit ? parseSchedule(data.agendadoPara) : null;
  const snapshot = await emailSnapshot(expert.tenantId, data);
  await assertExpertContentLinksAllowed(expert.tenantId, snapshot.subject, snapshot.body_html, snapshot.preheader);
  const criteria = await buildExpertCampaignCriteria(scope, data.audienceCriteria, data.playerIds);
  let totalCount = 0;
  let estimatedCost = 0;
  if (submit) {
    const prepared = await prepareAudience(scope, "email", data.audienceCriteria, data.playerIds);
    totalCount = prepared.resolution.eligibleTotal;
    estimatedCost = prepared.estimatedCost;
  }
  const state = submit ? submittedState(scope.envioModo) : { status: "rascunho", approval_status: null };
  const scheduledAt = submit ? (scheduled ?? new Date()).toISOString() : (data.agendadoPara ?? null);
  const row = {
    name: data.nome.trim(),
    audience_filter: {
      audience_mode: "expert",
      audience_criteria: criteria,
      segmento: "Público do expert",
      template_label: snapshot.name,
      smtp_label: "Remetente padrão",
      target_player_ids: [],
      extra_emails: [],
    },
    template_id: null,
    template_snapshot: snapshot,
    smtp_id: null,
    sender_id: null,
    short_domain_id: null,
    scheduled_at: scheduledAt,
    track_links: true,
    blocked_reason: null,
    expert_estimated_cost: submit ? estimatedCost : null,
    stats: { enviados: 0, entregues: 0, abertos: 0, cliques: 0, falhas: 0, total: totalCount },
    ...state,
    ...CLEAR_APPROVAL,
  };
  let saved: { id: string; status: string; approval_status: string | null } | null;
  if (data.id) {
    // A batched send in progress goes back to 'agendada' between batches:
    // once anything was sent, the campaign is no longer editable.
    const { count, error: logsError } = await db()
      .from("email_send_logs")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", data.id);
    if (logsError) throw new Error(logsError.message);
    if ((count ?? 0) > 0) throw new Error(EXPERT_CAMPAIGN_NOT_EDITABLE);
    const { data: updated, error } = await db()
      .from("email_campaigns")
      .update(row)
      .eq("id", data.id)
      .eq("tenant_id", expert.tenantId)
      .eq("expert_id", expert.expertId)
      .in("status", EDITABLE_EMAIL)
      .select("id,status,approval_status")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error(EXPERT_CAMPAIGN_NOT_EDITABLE);
    saved = updated;
  } else {
    const { data: inserted, error } = await db()
      .from("email_campaigns")
      .insert({
        ...row,
        tenant_id: expert.tenantId,
        expert_id: expert.expertId,
        conversion_objective: "conversion",
        conversion_funnel_snapshot: conversionFunnelSnapshot("conversion", "campaign"),
      })
      .select("id,status,approval_status")
      .single();
    if (error) throw new Error(error.message);
    saved = inserted;
  }
  return {
    id: saved!.id,
    channel: "email",
    status: saved!.status,
    approvalStatus: (saved!.approval_status ?? null) as ExpertApprovalStatus,
    totalCount,
    estimatedCost,
    scheduledAt,
    queued: true,
  };
}

/** Submits a draft ('rascunho') e-mail campaign now (queued; pending in approval mode). */
export async function sendExpertEmailCampaignNowFor(
  ctx: ExpertServerContext,
  data: { campaignId: string },
): Promise<ExpertCampaignSubmitResult> {
  const { expert } = await requireExpert(ctx);
  const { data: camp, error } = await db()
    .from("email_campaigns")
    .select("id,name,status,template_snapshot,audience_filter")
    .eq("id", data.campaignId)
    .eq("tenant_id", expert.tenantId)
    .eq("expert_id", expert.expertId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!camp) throw new Error(EXPERT_CAMPAIGN_NOT_FOUND);
  if (!EDITABLE_EMAIL.includes(camp.status)) throw new Error(EXPERT_CAMPAIGN_NOT_EDITABLE);
  const snapshot = (camp.template_snapshot ?? {}) as Record<string, any>;
  const af = (camp.audience_filter ?? {}) as Record<string, any>;
  return saveExpertEmailCampaignFor(ctx, {
    id: camp.id,
    nome: camp.name,
    assunto: snapshot.subject ?? "",
    html: snapshot.body_html ?? "",
    preheader: snapshot.preheader ?? undefined,
    audienceCriteria: af.audience_criteria ?? {},
    status: "agendada",
    agendadoPara: null,
  });
}

export type ExpertVoiceCampaignInput = {
  id?: string;
  campaign_name: string;
  scheduled_at?: string | null;
  script_id?: string;
  asset_id?: string;
  audienceCriteria: Record<string, unknown>;
  playerIds?: string[];
};

async function voiceSourceSeconds(
  tenantId: string,
  data: { script_id?: string | null; asset_id?: string | null },
): Promise<number | null> {
  if (data.asset_id) {
    const { data: asset, error } = await db()
      .from("journey_voice_assets")
      .select("id,is_archived,duration_seconds")
      .eq("id", data.asset_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!asset || asset.is_archived) throw new Error(EXPERT_VOICE_SOURCE_UNAVAILABLE);
    const s = Number(asset.duration_seconds);
    return Number.isFinite(s) && s > 0 ? s : null;
  }
  const { data: script, error } = await db()
    .from("call_scripts")
    .select("id,status")
    .eq("id", data.script_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!script || script.status !== "active") throw new Error(EXPERT_VOICE_SOURCE_UNAVAILABLE);
  return null;
}

export async function saveExpertVoiceCampaignFor(
  ctx: ExpertServerContext,
  data: ExpertVoiceCampaignInput,
): Promise<ExpertCampaignSubmitResult> {
  const { expert, scope } = await requireExpert(ctx);
  await assertTenantNotDemoForSend(expert.tenantId);
  if (Boolean(data.script_id) === Boolean(data.asset_id))
    throw new Error("Selecione um script TTS ou um áudio fixo da biblioteca.");
  const scheduled = parseSchedule(data.scheduled_at);
  const voiceSeconds = await voiceSourceSeconds(expert.tenantId, data);
  const { criteria, resolution, estimatedCost } = await prepareAudience(
    scope,
    "voice",
    data.audienceCriteria,
    data.playerIds,
    { voiceSeconds },
  );
  const state =
    scope.envioModo === "aprovacao"
      ? { status: "aguardando_aprovacao", approval_status: "pendente" }
      : { status: "enfileirada", approval_status: null };
  const scheduledAt = (scheduled ?? new Date()).toISOString();
  const row = {
    name: data.campaign_name.trim(),
    script_id: data.script_id ?? null,
    voice_asset_id: data.asset_id ?? null,
    audience_criteria: criteria,
    player_ids: null,
    total_count: resolution.eligibleTotal,
    scheduled_at: scheduledAt,
    expert_estimated_cost: estimatedCost,
    last_error: null,
    // Livre: enqueued right below; until then the row is "awaiting".
    status: state.status === "enfileirada" ? "aguardando_aprovacao" : state.status,
    approval_status: state.approval_status,
    ...CLEAR_APPROVAL,
  };
  let saved: any;
  if (data.id) {
    const { data: updated, error } = await db()
      .from("expert_voice_campaigns")
      .update(row)
      .eq("id", data.id)
      .eq("tenant_id", expert.tenantId)
      .eq("expert_id", expert.expertId)
      .in("status", EDITABLE_VOICE)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error(EXPERT_CAMPAIGN_NOT_EDITABLE);
    saved = updated;
  } else {
    const { data: inserted, error } = await db()
      .from("expert_voice_campaigns")
      .insert({ ...row, tenant_id: expert.tenantId, expert_id: expert.expertId, created_by: ctx.userId })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    saved = inserted;
  }
  let status = saved.status as string;
  let totalCount = resolution.eligibleTotal;
  if (state.status === "enfileirada") {
    const queued = await enqueueExpertVoiceCampaign(saved, scope);
    status = "enfileirada";
    totalCount = queued;
  }
  return {
    id: saved.id,
    channel: "voice",
    status,
    approvalStatus: (saved.approval_status ?? null) as ExpertApprovalStatus,
    totalCount,
    estimatedCost,
    scheduledAt,
    queued: true,
  };
}

/**
 * Creates the call_queue items of an expert voice campaign (livre mode or on
 * approval): audience re-resolved with the CURRENT scope, phones tied to
 * players of the scope only, consent applied. Marks the campaign enfileirada.
 * Returns how many items were queued.
 */
export async function enqueueExpertVoiceCampaign(
  campaign: {
    id: string;
    tenant_id: string;
    expert_id: string;
    name: string;
    script_id: string | null;
    voice_asset_id: string | null;
    audience_criteria: unknown;
    scheduled_at: string | null;
  },
  scope: ExpertScope,
): Promise<number> {
  const criteria = normalizeSmsAudienceCriteria(campaign.audience_criteria);
  const resolution = await resolveScopedAudience(scope, criteria, "voice");
  const phones = resolution.eligibleIdentifiers.slice(0, EXPERT_VOICE_MAX_RECIPIENTS);
  const recipients = await resolveCampaignRecipients(
    supabaseAdmin as unknown as CampaignDb,
    scope.tenantId,
    phones.map((phone) => ({ phone })),
  );
  const visible = new Set(
    await filterPlayerIdsToExpert(
      scope,
      recipients.resolved.map((r) => r.playerId),
    ),
  );
  const scheduledAt =
    campaign.scheduled_at && Date.parse(campaign.scheduled_at) > Date.now()
      ? campaign.scheduled_at
      : new Date().toISOString();
  const items = recipients.resolved
    .filter((r) => visible.has(r.playerId))
    .map((r) => ({
      tenant_id: scope.tenantId,
      lead_id: r.playerId,
      phone_number: r.phone,
      script_id: campaign.script_id,
      voice_asset_id: campaign.voice_asset_id,
      trigger_name: campaign.name,
      scheduled_at: scheduledAt,
      status: "audio_ready",
      audio_url: null,
      audio_generation_id: null,
      expert_id: scope.expertId,
      expert_voice_campaign_id: campaign.id,
    }));
  if (items.length === 0) throw new Error(EXPERT_NO_RECIPIENTS);
  const { error } = await db().from("call_queue").insert(items);
  if (error) throw new Error(error.message);
  const { error: updateError } = await db()
    .from("expert_voice_campaigns")
    .update({ status: "enfileirada", queued_count: items.length, total_count: items.length, last_error: null })
    .eq("id", campaign.id)
    .eq("tenant_id", scope.tenantId);
  if (updateError) throw new Error(updateError.message);
  return items.length;
}

// ─── Cancelar (expert) ──────────────────────────────────────────────────────

const CANCELLABLE: Record<ExpertChannel, string[]> = {
  sms: ["aguardando_aprovacao", "recusada", "agendada", "pausada"],
  email: ["rascunho", "aguardando_aprovacao", "recusada", "agendada", "pausada"],
  voice: ["aguardando_aprovacao", "recusada", "enfileirada", "pausada"],
};

const TABLE: Record<ExpertChannel, string> = {
  sms: "sms_campaigns",
  email: "email_campaigns",
  voice: "expert_voice_campaigns",
};

/** Cancels one of the expert's own campaigns (nothing more is sent). */
export async function cancelExpertCampaignFor(
  ctx: ExpertServerContext,
  data: { channel: ExpertChannel; id: string },
): Promise<{ ok: true }> {
  const { expert } = await requireExpert(ctx);
  await cancelCampaignRow(expert.tenantId, data.channel, data.id, expert.expertId, "Cancelada pelo expert.");
  return { ok: true };
}

async function cancelCampaignRow(
  tenantId: string,
  channel: ExpertChannel,
  id: string,
  expertId: string | null,
  reason: string,
) {
  const patch =
    channel === "email"
      ? { status: "cancelada", blocked_reason: reason, locked_at: null, locked_by: null }
      : channel === "sms"
        ? { status: "cancelada", last_error: reason, locked_at: null, locked_by: null }
        : { status: "cancelada", last_error: reason };
  let q = db()
    .from(TABLE[channel])
    .update(patch)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .not("expert_id", "is", null)
    .in("status", CANCELLABLE[channel]);
  if (expertId) q = q.eq("expert_id", expertId);
  const { data: rows, error } = await q.select("id");
  if (error) throw new Error(error.message);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(EXPERT_CAMPAIGN_NOT_EDITABLE);
  if (channel === "voice") {
    const { error: itemsError } = await db()
      .from("call_queue")
      .update({ status: "cancelled", provider_status: "campanha_cancelada" })
      .eq("tenant_id", tenantId)
      .eq("expert_voice_campaign_id", id)
      .in("status", ["audio_ready", "pending_audio", "paused"]);
    if (itemsError) throw new Error(itemsError.message);
  }
}

// ─── Listas, uso e opções do compositor ─────────────────────────────────────

export type ExpertCampaignListItem = {
  id: string;
  channel: ExpertChannel;
  name: string;
  /** sms: agendada|enviando|enviado|falhou|cancelada|pausada|aguardando_aprovacao|recusada;
   *  email: rascunho|agendada|enviando|pausada|concluida|cancelada|aguardando_aprovacao|recusada;
   *  voice: aguardando_aprovacao|recusada|enfileirada|pausada|cancelada. */
  status: string;
  approvalStatus: ExpertApprovalStatus;
  rejectionReason: string | null;
  /** Why it stopped (cap, deactivated, no balance, admin pause...). */
  lastError: string | null;
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string | null;
  totalCount: number;
  sentCount: number;
  failedCount: number;
  estimatedCost: number | null;
  expertId: string;
  /** Filled in the admin list. */
  expertNome?: string;
};

function toListItem(channel: ExpertChannel, r: any): ExpertCampaignListItem {
  const stats = (r.stats ?? {}) as Record<string, number>;
  return {
    id: r.id,
    channel,
    name: r.name ?? "",
    status: r.status,
    approvalStatus: (r.approval_status ?? null) as ExpertApprovalStatus,
    rejectionReason: r.rejection_reason ?? null,
    lastError: (channel === "email" ? r.blocked_reason : r.last_error) ?? null,
    scheduledAt: r.scheduled_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
    totalCount: Number(channel === "email" ? (stats.total ?? 0) : (r.total_count ?? 0)),
    sentCount: Number(
      channel === "email" ? (stats.enviados ?? 0) : channel === "voice" ? (r.queued_count ?? 0) : (r.sent_count ?? 0),
    ),
    failedCount: Number(channel === "email" ? (stats.falhas ?? 0) : (r.failed_count ?? 0)),
    estimatedCost: r.expert_estimated_cost == null ? null : Number(r.expert_estimated_cost),
    expertId: r.expert_id,
  };
}

const LIST_COLUMNS: Record<ExpertChannel, string> = {
  sms: "id,name,status,approval_status,rejection_reason,last_error,scheduled_at,created_at,updated_at,total_count,sent_count,failed_count,expert_estimated_cost,expert_id",
  email:
    "id,name,status,approval_status,rejection_reason,blocked_reason,scheduled_at,created_at,updated_at,stats,expert_estimated_cost,expert_id",
  voice:
    "id,name,status,approval_status,rejection_reason,last_error,scheduled_at,created_at,updated_at,total_count,queued_count,expert_estimated_cost,expert_id",
};

export async function listCampaignRows(
  tenantId: string,
  filter: { expertId?: string | null; status?: string | null; approvalStatus?: string | null },
): Promise<ExpertCampaignListItem[]> {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const channels: ExpertChannel[] = ["sms", "email", "voice"];
  const results = await Promise.all(
    channels.map(async (channel) => {
      let q = db()
        .from(TABLE[channel])
        .select(LIST_COLUMNS[channel])
        .eq("tenant_id", tenantId)
        .not("expert_id", "is", null)
        .gte("created_at", since);
      if (filter.expertId) q = q.eq("expert_id", filter.expertId);
      if (filter.status) q = q.eq("status", filter.status);
      if (filter.approvalStatus) q = q.eq("approval_status", filter.approvalStatus);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(200);
      if (error) throw new Error(error.message);
      return ((data ?? []) as any[]).map((r) => toListItem(channel, r));
    }),
  );
  return results.flat().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function listExpertCampaignsFor(
  ctx: ExpertServerContext,
): Promise<{ items: ExpertCampaignListItem[] }> {
  const { expert } = await requireExpert(ctx);
  return { items: await listCampaignRows(expert.tenantId, { expertId: expert.expertId }) };
}

export type ExpertCampaignUsage = {
  /** R$/mês; null = sem teto. */
  teto: number | null;
  /** R$ consumidos no mês (preço de venda, todos os canais). */
  usado: number;
  /** R$ que restam; null = sem teto. */
  restante: number | null;
  /** Campanhas aguardando aprovação. */
  pendentes: number;
  /** Custo estimado das campanhas aguardando aprovação. */
  pendentesEstimado: number;
  /** "AAAA-MM" (America/Sao_Paulo). */
  mes: string;
};

export async function getExpertCampaignUsageFor(ctx: ExpertServerContext): Promise<ExpertCampaignUsage> {
  const { expert } = await requireExpert(ctx);
  const usado = round4(await expertMonthlyUsed(expert.expertId));
  const pending = await listCampaignRows(expert.tenantId, {
    expertId: expert.expertId,
    approvalStatus: "pendente",
  });
  const teto = expert.tetoMensal;
  return {
    teto,
    usado,
    restante: teto === null ? null : round4(Math.max(0, teto - usado)),
    pendentes: pending.length,
    pendentesEstimado: round4(pending.reduce((sum, c) => sum + (c.estimatedCost ?? 0), 0)),
    mes: expertCapMonth().slice(0, 7),
  };
}

export type ExpertComposerOptions = {
  siteUrl: string | null;
  quickLinks: Array<{ key: string; label: string; url: string }>;
  /** Experts always use the house default shortener: no choice. */
  shortDomains: [];
  shortenerPending: false;
  /** Experts always use the house default sender: no choice. */
  senders: [];
  emailTemplates: Array<{ id: string; nome: string; assunto: string }>;
  callScripts: Array<{ id: string; name: string; content: string }>;
  voiceAssets: Array<{ id: string; name: string; durationSeconds: number | null }>;
  prices: { sms: number; email: number; voice_30s: number };
  envioModo: "livre" | "aprovacao";
};

export async function getExpertComposerOptionsFor(ctx: ExpertServerContext): Promise<ExpertComposerOptions> {
  const { expert } = await requireExpert(ctx);
  const t = expert.tenantId;
  const [tenant, links, templates, scripts, assets, sms, email, voice] = await Promise.all([
    db().from("tenants").select("site_url").eq("id", t).maybeSingle(),
    db().from("tenant_quick_links").select("key,label,path").eq("tenant_id", t),
    db()
      .from("email_templates")
      .select("id,name,subject")
      .eq("tenant_id", t)
      .eq("lifecycle_status", "published")
      .order("updated_at", { ascending: false }),
    db()
      .from("call_scripts")
      .select("id,name,content")
      .eq("tenant_id", t)
      .eq("status", "active")
      .order("updated_at", { ascending: false }),
    db()
      .from("journey_voice_assets")
      .select("id,name,duration_seconds")
      .eq("tenant_id", t)
      .eq("is_archived", false),
    housePrice(t, "sms"),
    housePrice(t, "email"),
    housePrice(t, "voice_30s"),
  ]);
  for (const r of [tenant, links, templates, scripts, assets]) if (r.error) throw new Error(r.error.message);
  const siteUrl: string | null = tenant.data?.site_url || null;
  return {
    siteUrl,
    quickLinks: ((links.data ?? []) as Array<{ key: string; label: string | null; path: string }>).map((l) => ({
      key: l.key,
      label: l.label ?? l.key,
      url: siteUrl ? buildQuickLinkUrl(siteUrl, l.path) : l.path,
    })),
    shortDomains: [],
    shortenerPending: false,
    senders: [],
    emailTemplates: ((templates.data ?? []) as any[]).map((r) => ({
      id: r.id,
      nome: r.name ?? "",
      assunto: r.subject ?? "",
    })),
    callScripts: ((scripts.data ?? []) as any[]).map((r) => ({ id: r.id, name: r.name ?? "", content: r.content ?? "" })),
    voiceAssets: ((assets.data ?? []) as any[]).map((r) => ({
      id: r.id,
      name: r.name ?? "",
      durationSeconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
    })),
    prices: { sms, email, voice_30s: voice },
    envioModo: expert.envioModo,
  };
}

// ─── Admin: aprovar, recusar, pausar, retomar ───────────────────────────────

async function loadCampaignForAdmin(tenantId: string, channel: ExpertChannel, id: string) {
  const { data, error } = await db()
    .from(TABLE[channel])
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .not("expert_id", "is", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(EXPERT_CAMPAIGN_NOT_FOUND);
  return data as Record<string, any>;
}

const expertNames = (tenantId: string, ids: string[]) => expertNamesById(tenantId, ids);

export async function listExpertCampaignsForAdminCore(
  tenantId: string,
  filter: { expertId?: string | null; status?: string | null },
): Promise<{ items: ExpertCampaignListItem[] }> {
  const items = await listCampaignRows(tenantId, filter);
  const names = await expertNames(
    tenantId,
    items.map((i) => i.expertId),
  );
  return { items: items.map((i) => ({ ...i, expertNome: names.get(i.expertId) ?? "" })) };
}

/** Re-validation on approve/resume: owner active, links, audience and cap. */
async function revalidateForApproval(tenantId: string, channel: ExpertChannel, row: Record<string, any>) {
  const scope = await loadExpertScope(row.expert_id, tenantId);
  if (!scope || !scope.ativo) throw new Error(EXPERT_INACTIVE_CANNOT_APPROVE);
  const criteria = normalizeSmsAudienceCriteria(
    channel === "email" ? (row.audience_filter?.audience_criteria ?? {}) : row.audience_criteria,
  );
  if (channel === "sms") await assertExpertContentLinksAllowed(tenantId, row.content);
  if (channel === "email") {
    const snap = (row.template_snapshot ?? {}) as Record<string, any>;
    await assertExpertContentLinksAllowed(tenantId, snap.subject, snap.body_html, snap.preheader);
  }
  const resolution = await resolveScopedAudience(scope, criteria, channel);
  if (resolution.eligibleTotal === 0) throw new Error(EXPERT_NO_RECIPIENTS);
  const voiceSeconds =
    channel === "voice"
      ? await voiceSourceSeconds(tenantId, { script_id: row.script_id, asset_id: row.voice_asset_id })
      : null;
  const estimatedCost = await estimateCampaignCost(tenantId, channel, resolution.eligibleTotal, {
    content: row.content,
    voiceSeconds,
  });
  await assertCapAllowsEstimate(scope, estimatedCost);
  return { scope, resolution, estimatedCost };
}

export type ApproveExpertCampaignInput = {
  channel: ExpertChannel;
  id: string;
  /** updated_at the admin saw; when given, a campaign edited since is not approved. */
  expectedUpdatedAt?: string | null;
};

export async function approveExpertCampaignCore(
  tenantId: string,
  adminUserId: string,
  data: ApproveExpertCampaignInput,
): Promise<{ ok: true; status: string; totalCount: number; estimatedCost: number }> {
  await assertTenantNotDemoForSend(tenantId);
  const row = await loadCampaignForAdmin(tenantId, data.channel, data.id);
  if (row.approval_status !== "pendente" || row.status !== "aguardando_aprovacao")
    throw new Error(EXPERT_CAMPAIGN_NOT_PENDING);
  if (data.expectedUpdatedAt && row.updated_at && data.expectedUpdatedAt !== row.updated_at)
    throw new Error(EXPERT_CAMPAIGN_CHANGED);
  const { scope, resolution, estimatedCost } = await revalidateForApproval(tenantId, data.channel, row);
  const now = new Date();
  const scheduledAt =
    row.scheduled_at && Date.parse(row.scheduled_at) > now.getTime() ? row.scheduled_at : now.toISOString();
  const approval = {
    approval_status: "aprovada",
    approved_by: adminUserId,
    approved_at: now.toISOString(),
    rejection_reason: null,
    expert_estimated_cost: estimatedCost,
  };
  const patch =
    data.channel === "voice"
      ? { ...approval, scheduled_at: scheduledAt }
      : data.channel === "sms"
        ? { ...approval, status: "agendada", scheduled_at: scheduledAt, total_count: resolution.eligibleTotal }
        : { ...approval, status: "agendada", scheduled_at: scheduledAt };
  let q = db()
    .from(TABLE[data.channel])
    .update(patch)
    .eq("id", data.id)
    .eq("tenant_id", tenantId)
    .eq("status", "aguardando_aprovacao")
    .eq("approval_status", "pendente");
  if (row.updated_at) q = q.eq("updated_at", row.updated_at);
  const { data: rows, error } = await q.select("*");
  if (error) throw new Error(error.message);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(EXPERT_CAMPAIGN_CHANGED);
  let status = data.channel === "voice" ? "aguardando_aprovacao" : "agendada";
  let totalCount = resolution.eligibleTotal;
  if (data.channel === "voice") {
    totalCount = await enqueueExpertVoiceCampaign(rows[0], scope);
    status = "enfileirada";
  }
  await auditApproval(tenantId, adminUserId, "expert_campaign.approved", data.channel, data.id, {
    expertId: row.expert_id,
    estimatedCost,
    totalCount,
  });
  return { ok: true, status, totalCount, estimatedCost };
}

export async function rejectExpertCampaignCore(
  tenantId: string,
  adminUserId: string,
  data: { channel: ExpertChannel; id: string; reason: string },
): Promise<{ ok: true }> {
  const reason = data.reason.trim();
  if (!reason) throw new Error(EXPERT_REJECT_REASON_REQUIRED);
  const row = await loadCampaignForAdmin(tenantId, data.channel, data.id);
  if (row.approval_status !== "pendente" || row.status !== "aguardando_aprovacao")
    throw new Error(EXPERT_CAMPAIGN_NOT_PENDING);
  const { data: rows, error } = await db()
    .from(TABLE[data.channel])
    .update({
      status: "recusada",
      approval_status: "recusada",
      rejection_reason: reason.slice(0, 500),
      approved_by: adminUserId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", data.id)
    .eq("tenant_id", tenantId)
    .eq("status", "aguardando_aprovacao")
    .eq("approval_status", "pendente")
    .select("id");
  if (error) throw new Error(error.message);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(EXPERT_CAMPAIGN_NOT_PENDING);
  await auditApproval(tenantId, adminUserId, "expert_campaign.rejected", data.channel, data.id, {
    expertId: row.expert_id,
    reason,
  });
  return { ok: true };
}

export const EXPERT_ADMIN_PAUSE_MESSAGE = "Pausada pelo admin";

export async function pauseExpertCampaignCore(
  tenantId: string,
  adminUserId: string,
  data: { channel: ExpertChannel; id: string },
): Promise<{ ok: true }> {
  const row = await loadCampaignForAdmin(tenantId, data.channel, data.id);
  const pausable =
    data.channel === "voice" ? ["enfileirada"] : data.channel === "sms" ? ["agendada", "enviando"] : ["agendada", "enviando"];
  if (!pausable.includes(row.status)) throw new Error(EXPERT_CAMPAIGN_NOT_PAUSABLE);
  const patch =
    data.channel === "email"
      ? { status: "pausada", blocked_reason: EXPERT_ADMIN_PAUSE_MESSAGE, locked_at: null, locked_by: null }
      : data.channel === "sms"
        ? { status: "pausada", last_error: EXPERT_ADMIN_PAUSE_MESSAGE, locked_at: null, locked_by: null }
        : { status: "pausada", last_error: EXPERT_ADMIN_PAUSE_MESSAGE };
  const { data: rows, error } = await db()
    .from(TABLE[data.channel])
    .update(patch)
    .eq("id", data.id)
    .eq("tenant_id", tenantId)
    .in("status", pausable)
    .select("id");
  if (error) throw new Error(error.message);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(EXPERT_CAMPAIGN_NOT_PAUSABLE);
  if (data.channel === "voice") {
    const { error: itemsError } = await db()
      .from("call_queue")
      .update({ status: "paused", provider_status: "pausada_admin" })
      .eq("tenant_id", tenantId)
      .eq("expert_voice_campaign_id", data.id)
      .eq("status", "audio_ready");
    if (itemsError) throw new Error(itemsError.message);
  }
  await auditApproval(tenantId, adminUserId, "expert_campaign.paused", data.channel, data.id, {
    expertId: row.expert_id,
  });
  return { ok: true };
}

export async function resumeExpertCampaignCore(
  tenantId: string,
  adminUserId: string,
  data: { channel: ExpertChannel; id: string },
): Promise<{ ok: true }> {
  const row = await loadCampaignForAdmin(tenantId, data.channel, data.id);
  if (row.status !== "pausada") throw new Error(EXPERT_CAMPAIGN_NOT_PAUSED);
  if (row.approval_status && row.approval_status !== "aprovada") throw new Error(EXPERT_CAMPAIGN_NOT_PAUSED);
  const scope = await loadExpertScope(row.expert_id, tenantId);
  if (!scope || !scope.ativo) throw new Error(EXPERT_INACTIVE_CANNOT_RESUME);
  if (scope.tetoMensal !== null) {
    const used = await expertMonthlyUsed(scope.expertId);
    if (scope.tetoMensal <= 0 || used >= scope.tetoMensal) throw new Error(EXPERT_CAP_STILL_REACHED);
  }
  const now = new Date().toISOString();
  const patch =
    data.channel === "email"
      ? { status: "agendada", blocked_reason: null, scheduled_at: now, locked_at: null, locked_by: null }
      : data.channel === "sms"
        ? // Same as the house "Retomar": cursor and counters kept, next tick picks it.
          { status: "enviando", last_error: null, locked_at: null, locked_by: null }
        : { status: "enfileirada", last_error: null };
  const { data: rows, error } = await db()
    .from(TABLE[data.channel])
    .update(patch)
    .eq("id", data.id)
    .eq("tenant_id", tenantId)
    .eq("status", "pausada")
    .select("id");
  if (error) throw new Error(error.message);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(EXPERT_CAMPAIGN_NOT_PAUSED);
  if (data.channel === "voice") {
    const { error: itemsError } = await db()
      .from("call_queue")
      .update({ status: "audio_ready", provider_status: null, scheduled_at: now })
      .eq("tenant_id", tenantId)
      .eq("expert_voice_campaign_id", data.id)
      .eq("status", "paused");
    if (itemsError) throw new Error(itemsError.message);
  }
  await auditApproval(tenantId, adminUserId, "expert_campaign.resumed", data.channel, data.id, {
    expertId: row.expert_id,
  });
  return { ok: true };
}

async function auditApproval(
  tenantId: string,
  actorUserId: string,
  action: string,
  channel: ExpertChannel,
  id: string,
  metadata: Record<string, unknown>,
) {
  const { error } = await db().from("tenant_audit_logs").insert({
    tenant_id: tenantId,
    actor_user_id: actorUserId,
    action,
    entity_type: `${channel}_campaign`,
    entity_id: id,
    metadata,
  });
  if (error) console.warn("[expert-campaigns] audit log failed", { action, id, error: error.message });
}

/* eslint-enable @typescript-eslint/no-explicit-any */
