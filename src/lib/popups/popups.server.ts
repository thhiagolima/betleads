// Popups nas casas — cadastro no CRM: listar, salvar, mudar status,
// duplicar, apagar rascunho, contadores e estado da instalação do script.
// `db` é sempre o supabaseAdmin (tabelas só service_role) ou o fake de teste;
// toda leitura e escrita filtra por tenant_id.
import type { Json } from "@/integrations/supabase/types";
import { buildLoaderSnippet, WEBPUSH_PLAYER_SNIPPET } from "@/lib/webpush/apps.server";
import {
  validatePopupDraft,
  type PopupAudienceKind,
  type PopupDraft,
  type PopupFormat,
  type PopupFrequency,
  type PopupPageMode,
  type PopupStatus,
} from "@/lib/popups/shared";

/* eslint-disable @typescript-eslint/no-explicit-any -- structural db boundary (supabaseAdmin or the test fake). */
export type PopupsDb = { from: (table: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export const POPUP_COLUMNS =
  "id,tenant_id,nome,status,prioridade,starts_at,ends_at,formato,image_url,titulo,texto,botao_label,botao_url," +
  "audience_kind,audience_label,audience_criteria,audience_generation,audience_count,audience_refreshed_at," +
  "paginas_modo,paginas,atraso_segundos,frequencia,frequencia_dias,created_at,updated_at";

export type PopupRow = {
  id: string;
  tenant_id: string;
  nome: string;
  status: PopupStatus;
  prioridade: number;
  starts_at: string | null;
  ends_at: string | null;
  formato: PopupFormat;
  image_url: string | null;
  titulo: string | null;
  texto: string | null;
  botao_label: string | null;
  botao_url: string | null;
  audience_kind: PopupAudienceKind;
  audience_label: string | null;
  audience_criteria: Json | null;
  audience_generation: number;
  audience_count: number | null;
  audience_refreshed_at: string | null;
  paginas_modo: PopupPageMode;
  paginas: string[];
  atraso_segundos: number;
  frequencia: PopupFrequency;
  frequencia_dias: number | null;
  created_at: string;
  updated_at: string;
};

export type PopupTotals = { exibicoes: number; cliques: number; fechamentos: number };

export type PopupListItem = {
  id: string;
  nome: string;
  status: PopupStatus;
  /** Ativo, mas fora do período agora (ainda não começou). */
  aguardandoInicio: boolean;
  prioridade: number;
  startsAt: string | null;
  endsAt: string | null;
  formato: PopupFormat;
  audienceKind: PopupAudienceKind;
  audienceLabel: string | null;
  audienceCount: number | null;
  audienceRefreshedAt: string | null;
  paginasModo: PopupPageMode;
  updatedAt: string;
  ultimos7Dias: PopupTotals;
};

export type PopupDetail = PopupDraft & {
  id: string;
  status: PopupStatus;
  audienceCount: number | null;
  audienceRefreshedAt: string | null;
  updatedAt: string;
};

export function rowToDetail(row: PopupRow): PopupDetail {
  return {
    id: row.id,
    status: row.status,
    nome: row.nome,
    prioridade: row.prioridade,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    formato: row.formato,
    imageUrl: row.image_url,
    titulo: row.titulo,
    texto: row.texto,
    botaoLabel: row.botao_label,
    botaoUrl: row.botao_url,
    audienceKind: row.audience_kind,
    audienceLabel: row.audience_label,
    audienceCriteria: row.audience_criteria,
    paginasModo: row.paginas_modo,
    paginas: row.paginas ?? [],
    atrasoSegundos: row.atraso_segundos,
    frequencia: row.frequencia,
    frequenciaDias: row.frequencia_dias,
    audienceCount: row.audience_count,
    audienceRefreshedAt: row.audience_refreshed_at,
    updatedAt: row.updated_at,
  };
}

function draftToColumns(draft: PopupDraft) {
  return {
    nome: draft.nome,
    prioridade: draft.prioridade,
    starts_at: draft.startsAt,
    ends_at: draft.endsAt,
    formato: draft.formato,
    image_url: draft.imageUrl,
    titulo: draft.titulo,
    texto: draft.texto,
    botao_label: draft.botaoLabel,
    botao_url: draft.botaoUrl,
    audience_kind: draft.audienceKind,
    audience_label: draft.audienceLabel,
    audience_criteria: draft.audienceCriteria ?? null,
    paginas_modo: draft.paginasModo,
    paginas: draft.paginas,
    atraso_segundos: draft.atrasoSegundos,
    frequencia: draft.frequencia,
    frequencia_dias: draft.frequenciaDias,
  };
}

/** `YYYY-MM-DD` in America/Sao_Paulo, `daysAgo` days before `now`. */
export function brtDay(now: Date, daysAgo = 0): string {
  const shifted = new Date(now.getTime() - daysAgo * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(shifted);
}

type StatsRow = { popup_id: string; dia: string; exibicoes: number | string; cliques: number | string; fechamentos: number | string };

async function loadPopupRow(db: PopupsDb, tenantId: string, id: string): Promise<PopupRow> {
  const { data, error } = await db
    .from("site_popups")
    .select(POPUP_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Popup não encontrado.");
  return data as PopupRow;
}

export async function listPopups(db: PopupsDb, tenantId: string, now: Date): Promise<PopupListItem[]> {
  const { data, error } = await db
    .from("site_popups")
    .select(POPUP_COLUMNS)
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as PopupRow[];

  const { data: statsData, error: statsErr } = await db
    .from("site_popup_daily_stats")
    .select("popup_id,dia,exibicoes,cliques,fechamentos")
    .eq("tenant_id", tenantId)
    .gte("dia", brtDay(now, 6));
  if (statsErr) throw new Error(statsErr.message);
  const totals = new Map<string, PopupTotals>();
  for (const stat of (statsData ?? []) as StatsRow[]) {
    const current = totals.get(stat.popup_id) ?? { exibicoes: 0, cliques: 0, fechamentos: 0 };
    current.exibicoes += Number(stat.exibicoes);
    current.cliques += Number(stat.cliques);
    current.fechamentos += Number(stat.fechamentos);
    totals.set(stat.popup_id, current);
  }

  const order: Record<PopupStatus, number> = { ativo: 0, pausado: 1, rascunho: 2, encerrado: 3 };
  return rows
    .map((row) => ({
      id: row.id,
      nome: row.nome,
      status: row.status,
      aguardandoInicio:
        row.status === "ativo" && row.starts_at !== null && Date.parse(row.starts_at) > now.getTime(),
      prioridade: row.prioridade,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      formato: row.formato,
      audienceKind: row.audience_kind,
      audienceLabel: row.audience_label,
      audienceCount: row.audience_count,
      audienceRefreshedAt: row.audience_refreshed_at,
      paginasModo: row.paginas_modo,
      updatedAt: row.updated_at,
      ultimos7Dias: totals.get(row.id) ?? { exibicoes: 0, cliques: 0, fechamentos: 0 },
    }))
    .sort((a, b) => order[a.status] - order[b.status] || b.prioridade - a.prioridade);
}

export async function getPopup(db: PopupsDb, tenantId: string, id: string): Promise<PopupDetail> {
  return rowToDetail(await loadPopupRow(db, tenantId, id));
}

export type SavePopupResult = { id: string; audienceChanged: boolean; status: PopupStatus };

/**
 * Creates (no `id`, as rascunho) or updates a popup. The status never changes
 * here. `audienceChanged` tells the caller to re-resolve a filtro audience
 * of an active popup right away instead of waiting for the hourly cron.
 */
export async function savePopup(
  db: PopupsDb,
  input: { tenantId: string; id: string | null; draft: PopupDraft; userId: string; now: Date },
): Promise<SavePopupResult> {
  const validation = validatePopupDraft(input.draft);
  if (!validation.ok) throw new Error(validation.error);
  const columns = draftToColumns(validation.draft);

  if (!input.id) {
    const { data, error } = await db
      .from("site_popups")
      .insert({ ...columns, tenant_id: input.tenantId, status: "rascunho", created_by: input.userId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: (data as { id: string }).id, audienceChanged: columns.audience_kind === "filtro", status: "rascunho" };
  }

  const before = await loadPopupRow(db, input.tenantId, input.id);
  if (before.status === "encerrado") throw new Error("Popup encerrado não pode ser alterado. Duplique para usar de novo.");
  const audienceChanged =
    columns.audience_kind === "filtro" &&
    (before.audience_kind !== "filtro" ||
      JSON.stringify(before.audience_criteria) !== JSON.stringify(columns.audience_criteria));
  const { error } = await db
    .from("site_popups")
    .update({ ...columns, updated_at: input.now.toISOString() })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.id);
  if (error) throw new Error(error.message);
  return { id: input.id, audienceChanged, status: before.status };
}

const ALLOWED_TRANSITIONS: Record<PopupStatus, PopupStatus[]> = {
  rascunho: ["ativo", "encerrado"],
  ativo: ["pausado", "encerrado"],
  pausado: ["ativo", "encerrado"],
  encerrado: [],
};

export async function setPopupStatus(
  db: PopupsDb,
  input: { tenantId: string; id: string; status: PopupStatus; now: Date },
): Promise<{ status: PopupStatus; needsAudience: boolean }> {
  const row = await loadPopupRow(db, input.tenantId, input.id);
  if (row.status === input.status) return { status: row.status, needsAudience: false };
  if (!ALLOWED_TRANSITIONS[row.status].includes(input.status))
    throw new Error("Essa mudança de situação não é permitida.");
  if (input.status === "ativo" && row.ends_at && Date.parse(row.ends_at) <= input.now.getTime())
    throw new Error("A data de fim já passou. Ajuste o período antes de ativar.");
  const { error } = await db
    .from("site_popups")
    .update({ status: input.status, updated_at: input.now.toISOString() })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.id);
  if (error) throw new Error(error.message);
  return {
    status: input.status,
    needsAudience: input.status === "ativo" && row.audience_kind === "filtro",
  };
}

export async function duplicatePopup(
  db: PopupsDb,
  input: { tenantId: string; id: string; userId: string },
): Promise<{ id: string }> {
  const detail = await getPopup(db, input.tenantId, input.id);
  const nome = `${detail.nome} (cópia)`.slice(0, 120);
  const { data, error } = await db
    .from("site_popups")
    .insert({
      ...draftToColumns({ ...detail, nome }),
      tenant_id: input.tenantId,
      status: "rascunho",
      created_by: input.userId,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: (data as { id: string }).id };
}

/** Only drafts can be deleted; anything that ran keeps its numbers (encerrar instead). */
export async function deletePopupDraft(db: PopupsDb, input: { tenantId: string; id: string }): Promise<void> {
  const row = await loadPopupRow(db, input.tenantId, input.id);
  if (row.status !== "rascunho") throw new Error("Só rascunhos podem ser apagados. Encerre o popup.");
  const { error } = await db.from("site_popups").delete().eq("tenant_id", input.tenantId).eq("id", input.id);
  if (error) throw new Error(error.message);
}

export type PopupDailyPoint = { dia: string } & PopupTotals;

export async function getPopupDailyStats(
  db: PopupsDb,
  input: { tenantId: string; id: string; days: number; now: Date },
): Promise<PopupDailyPoint[]> {
  await loadPopupRow(db, input.tenantId, input.id);
  const { data, error } = await db
    .from("site_popup_daily_stats")
    .select("popup_id,dia,exibicoes,cliques,fechamentos")
    .eq("tenant_id", input.tenantId)
    .eq("popup_id", input.id)
    .gte("dia", brtDay(input.now, input.days - 1));
  if (error) throw new Error(error.message);
  const byDay = new Map<string, StatsRow>();
  for (const row of (data ?? []) as StatsRow[]) byDay.set(row.dia, row);
  const points: PopupDailyPoint[] = [];
  for (let i = input.days - 1; i >= 0; i--) {
    const dia = brtDay(input.now, i);
    const row = byDay.get(dia);
    points.push({
      dia,
      exibicoes: Number(row?.exibicoes ?? 0),
      cliques: Number(row?.cliques ?? 0),
      fechamentos: Number(row?.fechamentos ?? 0),
    });
  }
  return points;
}

export type PopupInstallState = {
  /** The house has the loader (push settings row + at least one usable app). */
  installed: boolean;
  /** Last origin where the script was ever seen. */
  scriptSeenAt: string | null;
  /** The site sends `window.betleads.playerId` (a push subscription got linked). */
  playerIdSeen: boolean;
  origins: string[];
  loaderSnippet: string;
  playerSnippet: string;
};

/** Popups ride on the push loader: same token, same registered origins. */
export async function getPopupInstallState(db: PopupsDb, tenantId: string): Promise<PopupInstallState> {
  const { data: settings, error: settingsErr } = await db
    .from("tenant_webpush_settings")
    .select("public_token,popup_player_seen_at")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (settingsErr) throw new Error(settingsErr.message);
  const { data: apps, error: appsErr } = await db
    .from("tenant_webpush_apps")
    .select("origin,status,script_seen_at,player_linked_at")
    .eq("tenant_id", tenantId)
    .neq("status", "desativado");
  if (appsErr) throw new Error(appsErr.message);
  const appRows = (apps ?? []) as Array<{
    origin: string;
    status: string;
    script_seen_at: string | null;
    player_linked_at: string | null;
  }>;
  const seen = appRows
    .map((app) => app.script_seen_at)
    .filter((value): value is string => Boolean(value))
    .sort();
  const settingsRow = settings as { public_token: string; popup_player_seen_at: string | null } | null;
  const token = settingsRow?.public_token ?? null;
  return {
    installed: Boolean(token) && appRows.length > 0,
    scriptSeenAt: seen.length ? seen[seen.length - 1]! : null,
    playerIdSeen:
      Boolean(settingsRow?.popup_player_seen_at) || appRows.some((app) => Boolean(app.player_linked_at)),
    origins: appRows.map((app) => app.origin),
    loaderSnippet: token ? buildLoaderSnippet(token) : "",
    playerSnippet: WEBPUSH_PLAYER_SNIPPET,
  };
}
