// Contato, retorno e "assumir lead" da Área do Expert (Fase 2, Task 5).
//
// Fluxo comum a todas as funções: requireExpertContext -> loadVisibleLead
// (guard de alcance) antes de qualquer leitura/escrita sobre o lead.
// `expert_lead_contacts`, `expert_lead_followups` e as RPCs
// `claim_expert_lead`/`release_expert_lead` (migration 20261027100000) ainda
// não estão nos tipos gerados do Supabase, por isso `(supabaseAdmin as any)`.
//
// "Assumir lead": só expert de acesso total. Se outro expert já assumiu e o
// prazo não venceu, `claim_expert_lead` devolve `claimed=false` com quem e
// até quando — virando aqui o erro "Lead já assumido por {nome} até
// {dd/mm}.", na data de São Paulo (tz.ts).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ExpertAccessError, requireExpertContext } from "@/lib/expert-access.server";
import { isExpertAffiliate, loadVisibleLead } from "@/lib/expert-lead-access.server";
import { CONTATO_RESULTADOS, type ContatoResultado } from "@/lib/expert-lead-labels";
import { brtDayKey } from "@/lib/tz";
import { dbUuid } from "@/lib/zod-helpers";

type ServerContext = {
  userId: string;
  activeTenantId?: string | null;
};

const NOT_FOUND_FOLLOWUP = "Retorno não encontrado.";
const PAST_DUE_DATE = "Escolha hoje ou uma data futura.";
const RESTRICTED_CANNOT_CLAIM = "Só experts com acesso total podem assumir leads.";
const CLAIM_FAILED = "Não foi possível assumir o lead agora. Tente de novo.";

function db() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- expert_lead_contacts/followups/claims are not in the generated types yet
  return supabaseAdmin as any;
}

/** dd/mm (fuso America/Sao_Paulo) de um instante ISO. */
function formatBrtDdMm(iso: string): string {
  const [, mm, dd] = brtDayKey(new Date(iso)).split("-");
  return `${dd}/${mm}`;
}

// ------------------------------------------------------------- log contact

export type LogExpertContactInput = {
  playerId: string;
  resultado: ContatoResultado;
  nota?: string;
};

const logContactInput = z.object({
  playerId: dbUuid(),
  resultado: z.enum(CONTATO_RESULTADOS),
  nota: z.string().max(1000).optional(),
});

export const logExpertContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => logContactInput.parse(data))
  .handler(async ({ data, context }) =>
    logExpertContactFor(context as unknown as ServerContext, data),
  );

export async function logExpertContactFor(
  ctx: ServerContext,
  data: LogExpertContactInput,
): Promise<{ id: string }> {
  const input = logContactInput.parse(data);
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);
  const lead = await loadVisibleLead(expert, input.playerId);

  const id = crypto.randomUUID();
  const { error } = await db()
    .from("expert_lead_contacts")
    .insert({
      id,
      tenant_id: expert.tenantId,
      expert_id: expert.expertId,
      player_id: lead.id,
      resultado: input.resultado,
      nota: input.nota ?? null,
    });
  if (error) throw new Error(error.message);
  return { id };
}

// ------------------------------------------------------------- schedule follow-up

export type ScheduleExpertFollowupInput = {
  playerId: string;
  dueDate: string;
  nota?: string;
};

/** "aaaa-mm-dd" que existe no calendário (recusa 2026-02-31, 2026-13-01). */
function isCalendarDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const scheduleFollowupInput = z.object({
  playerId: dbUuid(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida.")
    .refine(isCalendarDate, "Data inválida."),
  nota: z.string().max(1000).optional(),
});

export const scheduleExpertFollowup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => scheduleFollowupInput.parse(data))
  .handler(async ({ data, context }) =>
    scheduleExpertFollowupFor(context as unknown as ServerContext, data),
  );

export async function scheduleExpertFollowupFor(
  ctx: ServerContext,
  data: ScheduleExpertFollowupInput,
): Promise<{ id: string }> {
  const input = scheduleFollowupInput.parse(data);
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);
  const lead = await loadVisibleLead(expert, input.playerId);

  const today = brtDayKey(new Date());
  if (input.dueDate < today) throw new Error(PAST_DUE_DATE);

  const id = crypto.randomUUID();
  const { error } = await db()
    .from("expert_lead_followups")
    .insert({
      id,
      tenant_id: expert.tenantId,
      expert_id: expert.expertId,
      player_id: lead.id,
      due_date: input.dueDate,
      nota: input.nota ?? null,
    });
  if (error) throw new Error(error.message);
  return { id };
}

// ------------------------------------------------------------- complete follow-up

const completeFollowupInput = z.object({
  id: dbUuid(),
});

export const completeExpertFollowup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => completeFollowupInput.parse(data))
  .handler(async ({ data, context }) =>
    completeExpertFollowupFor(context as unknown as ServerContext, data),
  );

export async function completeExpertFollowupFor(
  ctx: ServerContext,
  data: z.input<typeof completeFollowupInput>,
): Promise<{ ok: true }> {
  const input = completeFollowupInput.parse(data);
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);

  const { data: existing, error: readError } = await db()
    .from("expert_lead_followups")
    .select("id")
    .eq("id", input.id)
    .eq("expert_id", expert.expertId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!existing) throw new ExpertAccessError(NOT_FOUND_FOLLOWUP);

  const { error } = await db()
    .from("expert_lead_followups")
    .update({ done_at: new Date().toISOString() })
    .eq("id", input.id)
    .eq("expert_id", expert.expertId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

// ------------------------------------------------------------- list due follow-ups

export type ExpertFollowupDue = {
  id: string;
  playerId: string;
  nome: string;
  dueDate: string;
  nota: string | null;
  atrasado: boolean;
};

type FollowupRow = {
  id: string;
  player_id: string;
  due_date: string;
  nota: string | null;
};

type PlayerRow = {
  id: string;
  nome: string;
  affiliate_id: string | null;
};

export const listExpertFollowupsDue = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => listExpertFollowupsDueFor(context as unknown as ServerContext));

export async function listExpertFollowupsDueFor(ctx: ServerContext): Promise<ExpertFollowupDue[]> {
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);
  const today = brtDayKey(new Date());

  const { data: rows, error } = await db()
    .from("expert_lead_followups")
    .select("id,player_id,due_date,nota")
    .eq("tenant_id", expert.tenantId)
    .eq("expert_id", expert.expertId)
    .is("done_at", null)
    .lte("due_date", today)
    .order("due_date", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);

  const followups = (rows ?? []) as FollowupRow[];
  if (followups.length === 0) return [];

  const playerIds = Array.from(new Set(followups.map((f) => f.player_id)));
  const { data: playerRows, error: playerError } = await db()
    .from("players")
    .select("id,nome,affiliate_id")
    .eq("tenant_id", expert.tenantId)
    .in("id", playerIds);
  if (playerError) throw new Error(playerError.message);

  const playersById = new Map(((playerRows ?? []) as PlayerRow[]).map((p) => [p.id, p] as const));

  return followups
    .filter((f) => {
      const player = playersById.get(f.player_id);
      if (!player) return false;
      // Para restrito, refiltra pelo affiliate_id atual do lead: o lead pode
      // ter deixado de ser dele desde que o retorno foi agendado.
      if (expert.tipo === "restrito" && !isExpertAffiliate(expert, player.affiliate_id)) {
        return false;
      }
      return true;
    })
    .map((f) => ({
      id: f.id,
      playerId: f.player_id,
      nome: playersById.get(f.player_id)!.nome,
      dueDate: f.due_date,
      nota: f.nota ?? null,
      atrasado: f.due_date < today,
    }));
}

// ------------------------------------------------------------- claim / release lead

type ClaimLeadRow = {
  expert_id: string;
  expert_nome: string;
  expires_at: string;
  claimed: boolean;
};

const claimLeadInput = z.object({
  playerId: dbUuid(),
});

export type ClaimExpertLeadInput = z.input<typeof claimLeadInput>;

export const claimExpertLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => claimLeadInput.parse(data))
  .handler(async ({ data, context }) =>
    claimExpertLeadFor(context as unknown as ServerContext, data),
  );

export async function claimExpertLeadFor(
  ctx: ServerContext,
  data: ClaimExpertLeadInput,
): Promise<{ claimed: true; expertNome: string; expiresAt: string }> {
  const input = claimLeadInput.parse(data);
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);
  const lead = await loadVisibleLead(expert, input.playerId);

  if (expert.tipo !== "total") throw new ExpertAccessError(RESTRICTED_CANNOT_CLAIM);

  const { data: rpcRows, error } = await db().rpc("claim_expert_lead", {
    _tenant: expert.tenantId,
    _expert_id: expert.expertId,
    _player_id: lead.id,
  });
  if (error) throw new Error(error.message);

  const row = ((rpcRows ?? []) as ClaimLeadRow[])[0];
  if (!row) throw new Error(CLAIM_FAILED);
  if (!row.claimed) {
    throw new Error(
      `Lead já assumido por ${row.expert_nome} até ${formatBrtDdMm(row.expires_at)}.`,
    );
  }

  return { claimed: true, expertNome: row.expert_nome, expiresAt: row.expires_at };
}

const releaseLeadInput = z.object({
  playerId: dbUuid(),
});

export type ReleaseExpertLeadInput = z.input<typeof releaseLeadInput>;

export const releaseExpertLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => releaseLeadInput.parse(data))
  .handler(async ({ data, context }) =>
    releaseExpertLeadFor(context as unknown as ServerContext, data),
  );

export async function releaseExpertLeadFor(
  ctx: ServerContext,
  data: ReleaseExpertLeadInput,
): Promise<{ ok: true }> {
  const input = releaseLeadInput.parse(data);
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);
  const lead = await loadVisibleLead(expert, input.playerId);

  const { error } = await db().rpc("release_expert_lead", {
    _tenant: expert.tenantId,
    _expert_id: expert.expertId,
    _player_id: lead.id,
  });
  if (error) throw new Error(error.message);

  return { ok: true };
}
