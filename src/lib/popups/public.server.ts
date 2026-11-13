// Popups nas casas — lado público. Cada visualização de página de cada casa
// chama o endpoint, então a casa (token → tenant + origens) e a lista de
// popups ativos ficam 60 s em memória; a única consulta por visitante é a do
// público filtro (jogador → membros da geração corrente), e só quando a casa
// tem popup ativo com filtro.
//
// Segurança: o token só vale nas origens que a casa já cadastrou no push
// (tenant_webpush_apps, menos desativado). Origem desconhecida recebe [] e
// eventos dela são ignorados. A resposta nunca leva dado do jogador.
import { popupsEnabledForTenant } from "@/lib/popups/feature.server";
import { cleanPlayerId, normalizeOrigin } from "@/lib/webpush/shared";
import type { PublicPopup } from "@/lib/popups/shared";
import type { PopupRow, PopupsDb } from "@/lib/popups/popups.server";

const CACHE_TTL_MS = 60_000;
const MAX_CACHED_TENANTS = 2_000;

const PUBLIC_POPUP_COLUMNS =
  "id,tenant_id,status,prioridade,starts_at,ends_at,formato,image_url,titulo,texto,botao_label,botao_url," +
  "audience_kind,audience_generation,paginas_modo,paginas,atraso_segundos,frequencia,frequencia_dias";

type ActivePopup = Pick<
  PopupRow,
  | "id"
  | "tenant_id"
  | "prioridade"
  | "starts_at"
  | "ends_at"
  | "formato"
  | "image_url"
  | "titulo"
  | "texto"
  | "botao_label"
  | "botao_url"
  | "audience_kind"
  | "audience_generation"
  | "paginas_modo"
  | "paginas"
  | "atraso_segundos"
  | "frequencia"
  | "frequencia_dias"
>;

type TenantEntry = {
  tenantId: string;
  origins: Set<string>;
  popups: ActivePopup[];
  playerSeen: boolean;
  expiresAt: number;
};

export type PopupEventKind = "exibicao" | "clique" | "fechamento";

export function toPublicPopup(row: ActivePopup): PublicPopup {
  return {
    id: row.id,
    formato: row.formato,
    imageUrl: row.image_url,
    titulo: row.titulo,
    texto: row.texto,
    botaoLabel: row.botao_label,
    botaoUrl: row.botao_url,
    paginasModo: row.paginas_modo,
    paginas: row.paginas ?? [],
    atrasoSegundos: row.atraso_segundos,
    frequencia: row.frequencia,
    frequenciaDias: row.frequencia_dias,
    prioridade: row.prioridade,
  };
}

function inPeriod(row: ActivePopup, nowMs: number): boolean {
  if (row.starts_at && Date.parse(row.starts_at) > nowMs) return false;
  if (row.ends_at && Date.parse(row.ends_at) <= nowMs) return false;
  return true;
}

export function createPopupPublicService(db: PopupsDb, opts: { clock?: () => number; ttlMs?: number } = {}) {
  const clock = opts.clock ?? Date.now;
  const ttl = opts.ttlMs ?? CACHE_TTL_MS;
  const cache = new Map<string, TenantEntry | null>();
  const expiry = new Map<string, number>();

  async function loadTenant(token: string): Promise<TenantEntry | null> {
    const { data: settings, error: settingsErr } = await db
      .from("tenant_webpush_settings")
      .select("tenant_id,popup_player_seen_at")
      .eq("public_token", token)
      .maybeSingle();
    if (settingsErr) throw new Error(settingsErr.message);
    if (!settings) return null;
    const { tenant_id: tenantId, popup_player_seen_at: playerSeenAt } = settings as {
      tenant_id: string;
      popup_player_seen_at: string | null;
    };
    if (!(await popupsEnabledForTenant(tenantId))) return null;

    const { data: apps, error: appsErr } = await db
      .from("tenant_webpush_apps")
      .select("origin")
      .eq("tenant_id", tenantId)
      .neq("status", "desativado");
    if (appsErr) throw new Error(appsErr.message);

    const { data: popups, error: popupsErr } = await db
      .from("site_popups")
      .select(PUBLIC_POPUP_COLUMNS)
      .eq("tenant_id", tenantId)
      .eq("status", "ativo")
      .order("prioridade", { ascending: false });
    if (popupsErr) throw new Error(popupsErr.message);

    return {
      tenantId,
      origins: new Set(((apps ?? []) as Array<{ origin: string }>).map((app) => app.origin)),
      popups: (popups ?? []) as ActivePopup[],
      playerSeen: Boolean(playerSeenAt),
      expiresAt: clock() + ttl,
    };
  }

  async function tenantFor(token: string): Promise<TenantEntry | null> {
    const now = clock();
    const until = expiry.get(token);
    if (until !== undefined && until > now) return cache.get(token) ?? null;
    const entry = await loadTenant(token);
    if (cache.size >= MAX_CACHED_TENANTS) {
      for (const [key, exp] of expiry) {
        if (exp > now) continue;
        cache.delete(key);
        expiry.delete(key);
      }
      if (cache.size >= MAX_CACHED_TENANTS) {
        cache.clear();
        expiry.clear();
      }
    }
    cache.set(token, entry);
    expiry.set(token, now + ttl);
    return entry;
  }

  async function resolvePlayer(tenantId: string, externalId: string): Promise<string | null> {
    const { data, error } = await db
      .from("players")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("player_external_id", externalId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? (data as { id: string }).id : null;
  }

  async function markPlayerSeen(entry: TenantEntry): Promise<void> {
    entry.playerSeen = true;
    const { error } = await db
      .from("tenant_webpush_settings")
      .update({ popup_player_seen_at: new Date(clock()).toISOString() })
      .eq("tenant_id", entry.tenantId)
      .is("popup_player_seen_at", null);
    if (error) console.error("[popup] popup_player_seen_at update failed:", error.message);
  }

  /** Popups this visitor may see now, highest priority first (page/frequency rules run in the browser). */
  async function eligiblePopups(input: {
    token: string;
    origin: string | null;
    playerId: unknown;
  }): Promise<PublicPopup[]> {
    if (!input.token || !input.origin) return [];
    const entry = await tenantFor(input.token);
    if (!entry) return [];
    const origin = normalizeOrigin(input.origin);
    if (!origin || !entry.origins.has(origin)) return [];

    const nowMs = clock();
    const current = entry.popups.filter((row) => inPeriod(row, nowMs));
    if (current.length === 0) return [];

    const externalId = cleanPlayerId(input.playerId);
    const logged = Boolean(externalId);
    const filtro = current.filter((row) => row.audience_kind === "filtro");

    let playerUuid: string | null = null;
    if (externalId && (filtro.length > 0 || !entry.playerSeen)) {
      playerUuid = await resolvePlayer(entry.tenantId, externalId);
      if (playerUuid && !entry.playerSeen) await markPlayerSeen(entry);
    }

    const members = new Set<string>();
    if (playerUuid && filtro.length > 0) {
      const { data, error } = await db
        .from("site_popup_audience_members")
        .select("popup_id,generation")
        .eq("player_id", playerUuid)
        .in(
          "popup_id",
          filtro.map((row) => row.id),
        );
      if (error) throw new Error(error.message);
      const generationOf = new Map(filtro.map((row) => [row.id, row.audience_generation]));
      for (const row of (data ?? []) as Array<{ popup_id: string; generation: number }>) {
        if (generationOf.get(row.popup_id) === row.generation) members.add(row.popup_id);
      }
    }

    return current
      .filter((row) => {
        switch (row.audience_kind) {
          case "todos":
            return true;
          case "logados":
            return logged;
          case "deslogados":
            return !logged;
          case "filtro":
            return members.has(row.id);
        }
      })
      .map(toPublicPopup);
  }

  /** Counts an event only for a popup of this house seen from one of its origins. */
  async function recordEvent(input: {
    token: string;
    origin: string | null;
    popupId: unknown;
    kind: unknown;
  }): Promise<boolean> {
    if (input.kind !== "exibicao" && input.kind !== "clique" && input.kind !== "fechamento") return false;
    if (typeof input.popupId !== "string" || !input.token || !input.origin) return false;
    const entry = await tenantFor(input.token);
    if (!entry) return false;
    const origin = normalizeOrigin(input.origin);
    if (!origin || !entry.origins.has(origin)) return false;
    if (!entry.popups.some((row) => row.id === input.popupId)) return false;
    const { error } = await db.rpc("site_popup_record_event", { p_popup_id: input.popupId, p_kind: input.kind });
    if (error) throw new Error(error.message);
    return true;
  }

  return { eligiblePopups, recordEvent };
}
