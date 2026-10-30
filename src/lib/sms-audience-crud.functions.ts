import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  isSelectionAudience,
  MAX_SELECTION_PLAYER_IDS,
  normalizeSmsAudienceCriteria,
  toSelectionReference,
} from "@/lib/sms-audience-criteria";
import {
  createSelectionAudienceRecord,
  filterPlayerIdsToTenant,
  type SelectionDb,
} from "@/lib/sms-audience-selection.server";
import { resolveCurrentTenantId } from "@/lib/tenant-access.server";

const input = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(2).max(120),
  description: z.string().max(300).optional(),
  criteria: z.record(z.string(), z.unknown()),
});
/** The caller's active house; refused while it is locked for the monthly fee. Exported for tests. */
export async function resolveSmsAudienceTenant(s: any) {
  return resolveCurrentTenantId(s);
}
export const listSmsAudiences = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const s: any = context.supabase;
    const t = await resolveSmsAudienceTenant(s);
    return listTenantAudiences(s, t);
  });

const AUDIENCE_COLUMNS = "id,name,description,created_at,updated_at";

/**
 * Públicos da casa para o navegador, em duas leituras: por regras com o
 * critério completo; de seleção só com a contagem gravada (sem ler a lista de
 * até 50 mil ids), na forma de referência. Uma linha inválida é registrada e
 * pulada, sem derrubar a listagem. Exportado para testes.
 *
 * Área do Expert: sem `owner`, só os públicos da CASA (expert_id nulo; as
 * telas da casa nunca listam públicos de expert). Com `owner`, só os do
 * expert informado.
 */
export async function listTenantAudiences(
  s: any,
  tenantId: string,
  owner: { expertId: string } | null = null,
) {
  const byOwner = (q: any) =>
    owner ? q.eq("expert_id", owner.expertId) : q.is("expert_id", null);
  const [rules, selections] = await Promise.all([
    byOwner(
      s
        .from("sms_audiences")
        .select(`${AUDIENCE_COLUMNS},criteria`)
        .eq("tenant_id", tenantId),
    )
      // `neq` sozinho descartaria critérios sem `timing` (null).
      .or("criteria->>timing.is.null,criteria->>timing.neq.selection"),
    byOwner(
      s
        .from("sms_audiences")
        .select(`${AUDIENCE_COLUMNS},selection_count:criteria->selectionCount`)
        .eq("tenant_id", tenantId),
    ).eq("criteria->>timing", "selection"),
  ]);
  if (rules.error) throw new Error(rules.error.message);
  if (selections.error) throw new Error(selections.error.message);
  const out: any[] = [];
  for (const row of rules.data ?? []) {
    const client = safeClientRow(row, () => toClientAudience(row));
    if (client) out.push(client);
  }
  for (const row of selections.data ?? []) {
    const { selection_count, ...rest } = row;
    const client = safeClientRow(row, () => {
      const count = Number(selection_count ?? 0);
      return {
        ...rest,
        criteria: toSelectionReference(
          normalizeSmsAudienceCriteria({
            timing: "selection",
            audienceId: row.id,
            selectionCount: Number.isInteger(count) && count >= 0 ? count : 0,
          }),
          row.id,
        ),
      };
    });
    if (client) out.push(client);
  }
  return out.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
}

function safeClientRow<T>(row: any, build: () => T): T | null {
  try {
    return build();
  } catch (error) {
    console.warn("[sms-audiences] público inválido ignorado na listagem", {
      id: row?.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Linha de público para o navegador. Seleção vai na forma de referência (sem
 * a lista de até 50 mil ids): o servidor recarrega a lista pelo id + casa.
 * Exportado para testes.
 */
export function toClientAudience(row: any) {
  const criteria = normalizeSmsAudienceCriteria(row.criteria);
  return {
    ...row,
    criteria: isSelectionAudience(criteria) ? toSelectionReference(criteria, row.id) : criteria,
  };
}
/**
 * Critério a gravar. Público de seleção não tem regras editáveis: ao salvar um
 * já existente (renomear), fica a lista gravada; uma lista nova só guarda os
 * jogadores desta casa. Exportado para testes.
 */
export async function resolveCriteriaToSave(
  s: any,
  tenantId: string,
  id: string | undefined,
  incoming: unknown,
) {
  if (id) {
    const { data: existing, error } = await s
      .from("sms_audiences")
      .select("criteria")
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .is("expert_id", null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (existing) {
      const stored = normalizeSmsAudienceCriteria(existing.criteria);
      if (isSelectionAudience(stored)) return stored;
    }
  }
  const criteria = normalizeSmsAudienceCriteria(incoming);
  if (!isSelectionAudience(criteria)) return criteria;
  if (!criteria.playerIds)
    throw new Error("Um público de seleção só pode ser criado a partir de Jogadores.");
  const playerIds = await filterPlayerIdsToTenant(s as SelectionDb, tenantId, criteria.playerIds);
  if (playerIds.length === 0) throw new Error("Nenhum jogador desta casa na seleção");
  const { audienceId: _audienceId, ...rest } = criteria;
  return { ...rest, playerIds, selectionCount: playerIds.length };
}
export const saveSmsAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => input.parse(v))
  .handler(async ({ data, context }) => {
    const s: any = context.supabase;
    const tenantId = await resolveSmsAudienceTenant(s);
    const payload = {
      tenant_id: tenantId,
      name: data.name.trim(),
      description: data.description?.trim() || null,
      criteria: await resolveCriteriaToSave(s, tenantId, data.id, data.criteria),
      updated_at: new Date().toISOString(),
    };
    const q = data.id
      ? s
          .from("sms_audiences")
          .update(payload)
          .eq("id", data.id)
          .eq("tenant_id", tenantId)
          // Públicos de expert não são editados pela casa.
          .is("expert_id", null)
          .select()
          .single()
      : s.from("sms_audiences").insert(payload).select().single();
    const { data: row, error } = await q;
    if (error) throw new Error(error.message);
    return toClientAudience(row);
  });
export const deleteSmsAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => z.object({ id: z.string().uuid() }).parse(v))
  .handler(async ({ data, context }) => {
    const s: any = context.supabase;
    const t = await resolveSmsAudienceTenant(s);
    const { error } = await s
      .from("sms_audiences")
      .delete()
      .eq("id", data.id)
      .eq("tenant_id", t)
      .is("expert_id", null);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const selectionInput = z.object({
  playerIds: z
    .array(z.string().uuid())
    .min(1, "Nenhum jogador selecionado.")
    .max(
      MAX_SELECTION_PLAYER_IDS,
      `A seleção passa de ${MAX_SELECTION_PLAYER_IDS.toLocaleString("pt-BR")} jogadores.`,
    ),
  label: z.string().max(120).optional(),
});
/**
 * Público temporário a partir de jogadores escolhidos em Jogadores. Ids de
 * outra casa são descartados; sem nenhum desta casa, recusa.
 */
export const createSelectionAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((v: unknown) => selectionInput.parse(v))
  .handler(async ({ data, context }) => {
    const s = context.supabase as unknown as SelectionDb;
    const tenantId = await resolveSmsAudienceTenant(s);
    return createSelectionAudienceRecord(s, tenantId, {
      playerIds: data.playerIds,
      label: data.label,
    });
  });
