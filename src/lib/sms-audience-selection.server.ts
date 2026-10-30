// Públicos de seleção (jogadores escolhidos em Jogadores). O resolver SQL
// `resolve_sms_audience_v2` não conhece seleção, então a lista é aplicada aqui,
// sempre junto do filtro da casa: um id de outra casa nunca entra.
//
// Formas do critério de seleção (sempre `timing: "selection"`, sem regras):
// - gravada em `sms_audiences.criteria`: `playerIds` (a lista);
// - de referência (navegador, rascunho, `sms_campaigns.audience_criteria`):
//   `audienceId` (+ `selectionCount`). O servidor carrega a lista do público
//   pelo id + casa. Público apagado → erro permanente (não envia).
import { RESOLUTION_CHUNK_SIZE } from "@/lib/campaign-recipients.server";
import {
  isSelectionAudience,
  MAX_SELECTION_PLAYER_IDS,
  normalizeSmsAudienceCriteria,
  selectionAudienceLabel,
  type SmsAudienceCriteria,
} from "@/lib/sms-audience-criteria";
import type { ResolvedSmsAudience } from "@/lib/sms-audiences.functions";

/* eslint-disable @typescript-eslint/no-explicit-any -- aceita o client do Supabase (usuário ou admin) ou um dublê de teste. */
export type SelectionDb = {
  from: (table: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => any;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Ids por filtro `in(...)`: o mesmo lote da resolução de destinatários de campanha. */
export const SELECTION_ID_CHUNK = RESOLUTION_CHUNK_SIZE;
const SELECTION_PARALLELISM = 4;

/**
 * Erro que não se resolve tentando de novo (ex.: o público de seleção foi
 * excluído). O worker de campanha marca a campanha como falha em vez de
 * reagendar o recálculo.
 */
export class PermanentAudienceError extends Error {
  readonly permanentAudienceError = true;
  constructor(message: string) {
    super(message);
    this.name = "PermanentAudienceError";
  }
}

/**
 * Critério que não passa na normalização não melhora tentando de novo:
 * `PermanentAudienceError` (no worker, a campanha falha sem reenvio).
 */
function normalizeOrPermanent(raw: unknown, context: string): SmsAudienceCriteria {
  try {
    return normalizeSmsAudienceCriteria(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PermanentAudienceError(`${context}: ${detail.slice(0, 200)}`);
  }
}

export const SELECTION_AUDIENCE_MISSING =
  "O público de seleção desta campanha foi excluído; nada será enviado.";

type SelectedPlayer = { id: string; telefone: string | null; email: string | null };

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Lê `players` da casa restrita aos ids informados, em lotes. Cada lote leva
 * `tenant_id = casa` E `id in (lote)`: jogadores de outra casa nunca voltam.
 */
export async function loadTenantPlayersByIds<Row = SelectedPlayer>(
  db: SelectionDb,
  tenantId: string,
  playerIds: readonly string[],
  columns = "id,telefone,email",
): Promise<Row[]> {
  if (!tenantId) throw new Error("Casa não identificada.");
  const unique = Array.from(new Set(playerIds));
  const parts = chunks(unique, SELECTION_ID_CHUNK);
  const results: Row[][] = new Array(parts.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(SELECTION_PARALLELISM, parts.length) },
    async () => {
      while (next < parts.length) {
        const index = next++;
        const { data, error } = await db
          .from("players")
          .select(columns)
          .eq("tenant_id", tenantId)
          .in("id", parts[index]);
        if (error) throw new Error(error.message ?? "Falha ao ler os jogadores da seleção.");
        results[index] = (data ?? []) as Row[];
      }
    },
  );
  await Promise.all(workers);
  return results.flat();
}

/** Mantém só os ids que pertencem à casa, na ordem recebida, sem repetição. */
export async function filterPlayerIdsToTenant(
  db: SelectionDb,
  tenantId: string,
  playerIds: readonly string[],
): Promise<string[]> {
  const rows = await loadTenantPlayersByIds<{ id: string }>(db, tenantId, playerIds, "id");
  const owned = new Set(rows.map((row) => row.id));
  return Array.from(new Set(playerIds)).filter((id) => owned.has(id));
}

/**
 * Lista gravada de um público de seleção da casa. Público inexistente (ou de
 * outra casa) → `PermanentAudienceError`.
 */
export async function loadSelectionPlayerIds(
  db: SelectionDb,
  tenantId: string,
  audienceId: string,
): Promise<string[]> {
  if (!tenantId) throw new Error("Casa não identificada.");
  const { data, error } = await db
    .from("sms_audiences")
    .select("criteria")
    .eq("id", audienceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message ?? "Falha ao ler o público de seleção.");
  if (!data) throw new PermanentAudienceError(SELECTION_AUDIENCE_MISSING);
  const stored = normalizeOrPermanent(
    (data as { criteria: unknown }).criteria,
    "A seleção de jogadores gravada neste público está inválida",
  );
  if (!isSelectionAudience(stored) || !Array.isArray(stored.playerIds))
    throw new PermanentAudienceError(
      "O público desta campanha não é mais uma seleção de jogadores.",
    );
  return stored.playerIds;
}

const EMPTY_FACETS: ResolvedSmsAudience["facets"] = {
  activity: {
    depositNever: 0,
    depositYes: 0,
    pixUnpaid: 0,
    withdrawalYes: 0,
    withdrawalNever: 0,
    withdrawalPending: 0,
    cashback: 0,
  },
  levels: { bronze: 0, silver: 0, gold: 0, diamond: 0, black: 0 },
  timings: { cooling: 0, sleeping: 0, inactive30: 0, inactive90: 0 },
};

const DEFAULT_SETTINGS: ResolvedSmsAudience["settings"] = {
  thresholds: { bronze: 10, silver: 200, gold: 500, diamond: 1000, black: 3000 },
  cooling: 2,
  sleeping: 7,
};

const phoneDigits = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "");

/** Público por regras: o RPC de sempre. Nunca recebe marcador nem lista de seleção. */
async function rpcAudience(
  db: SelectionDb,
  tenantId: string,
  criteria: SmsAudienceCriteria,
): Promise<ResolvedSmsAudience> {
  if (
    isSelectionAudience(criteria) ||
    criteria.playerIds !== undefined ||
    criteria.audienceId !== undefined ||
    criteria.selectionCount !== undefined
  )
    throw new Error("Público de seleção não pode ser calculado por regras.");
  const { data, error } = await db.rpc("resolve_sms_audience_v2", {
    _tenant: tenantId,
    _criteria: criteria,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Sem acesso aos jogadores desta conta.");
  // Leads mortos: um RPC anterior à migration 20261117100000 ignora o critério
  // e devolveria a casa inteira. Falha fechado em vez de enviar para todos.
  if (criteria.deadLeads && (data as { deadLeadsFilter?: unknown }).deadLeadsFilter !== true)
    throw new Error("O público Leads mortos ainda não está disponível nesta conta.");
  return data as ResolvedSmsAudience;
}

/**
 * Resolve uma lista de jogadores com o mesmo formato do RPC: telefones só com
 * dígitos (10+), distintos e ordenados; e-mails pelo id do jogador.
 */
export async function resolvePlayerIdsAudience(
  db: SelectionDb,
  tenantId: string,
  playerIds: readonly string[],
): Promise<ResolvedSmsAudience> {
  const players = await loadTenantPlayersByIds<SelectedPlayer>(db, tenantId, playerIds);
  const phones = Array.from(
    new Set(players.map((p) => phoneDigits(p.telefone)).filter((phone) => phone.length >= 10)),
  ).sort();
  const emailPlayerIds = players.filter((p) => (p.email ?? "").trim() !== "").map((p) => p.id);
  return {
    phones,
    total: players.length,
    recipientTotal: phones.length,
    emailPlayerIds,
    emailRecipientTotal: emailPlayerIds.length,
    facets: EMPTY_FACETS,
    settings: DEFAULT_SETTINGS,
  };
}

/**
 * Ponto único de avaliação de um critério de público (contagens em Públicos,
 * compositor de campanha e recálculo da campanha agendada). Sem seleção, é
 * exatamente a chamada ao RPC de sempre.
 */
export async function resolveAudienceForTenant(
  db: SelectionDb,
  tenantId: string,
  rawCriteria: unknown,
): Promise<ResolvedSmsAudience> {
  const criteria = normalizeOrPermanent(rawCriteria, "O público desta campanha está inválido");
  if (!isSelectionAudience(criteria)) return rpcAudience(db, tenantId, criteria);
  const playerIds =
    criteria.playerIds ?? (await loadSelectionPlayerIds(db, tenantId, criteria.audienceId!));
  return resolvePlayerIdsAudience(db, tenantId, playerIds);
}

/** "Seleção de Jogadores · dd/mm hh:mm" no horário de Brasília. */
export function selectionAudienceName(now: Date) {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `Seleção de Jogadores · ${part("day")}/${part("month")} ${part("hour")}:${part("minute")}`;
}

/**
 * Grava o público de seleção da casa. Descarta ids que não são da casa; sem
 * nenhum jogador da casa, recusa.
 */
export async function createSelectionAudienceRecord(
  db: SelectionDb,
  tenantId: string,
  input: { playerIds: readonly string[]; label?: string | null; now?: Date },
): Promise<{ id: string; name: string; playerCount: number; discarded: number }> {
  const requested = Array.from(new Set(input.playerIds.map((id) => id.toLowerCase())));
  if (requested.length > MAX_SELECTION_PLAYER_IDS)
    throw new Error(
      `A seleção passa de ${MAX_SELECTION_PLAYER_IDS.toLocaleString("pt-BR")} jogadores.`,
    );
  const owned = await filterPlayerIdsToTenant(db, tenantId, requested);
  if (owned.length === 0) throw new Error("Nenhum jogador desta casa na seleção");
  const now = input.now ?? new Date();
  const name = (input.label ?? "").trim().slice(0, 120) || selectionAudienceName(now);
  const criteria = normalizeSmsAudienceCriteria({
    timing: "selection",
    playerIds: owned,
    selectionCount: owned.length,
  });
  const { data, error } = await db
    .from("sms_audiences")
    .insert({
      tenant_id: tenantId,
      name,
      description: `${selectionAudienceLabel(owned.length)} em Jogadores`,
      criteria,
      updated_at: now.toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Não foi possível criar o público.");
  return {
    id: (data as { id: string }).id,
    name,
    playerCount: owned.length,
    discarded: requested.length - owned.length,
  };
}
