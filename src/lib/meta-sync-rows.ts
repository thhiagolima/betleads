// Montagem das linhas que o sync da Meta grava (AL1-02, AL1-03, AL1-07 e AL1-08).
// Sem chamadas de rede, para ser testável.

export type MetaInsight = {
  date_start?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  account_currency?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  inline_link_clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  reach?: string;
  frequency?: string;
};

export type MetaAd = {
  id: string;
  name?: string;
  status?: string;
  effective_status?: string;
  campaign?: { id?: string; name?: string; status?: string; effective_status?: string };
  adset?: { id?: string; name?: string; status?: string; effective_status?: string };
  creative?: {
    id?: string;
    name?: string;
    thumbnail_url?: string;
    image_url?: string;
    effective_object_story_id?: string;
  };
};

export const INSIGHT_FIELDS = [
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "account_currency",
  "spend",
  "impressions",
  "clicks",
  "inline_link_clicks",
  "ctr",
  "cpc",
  "cpm",
].join(",");

function toNumber(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Data de hoje (YYYY-MM-DD) no fuso da conta de anúncio, que é o fuso em que a Meta reporta. */
export function accountToday(timezone: string | null | undefined, now: Date = new Date()) {
  const zone = timezone || "America/Sao_Paulo";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    // Fuso desconhecido: Brasília, o padrão do produto.
    return accountToday("America/Sao_Paulo", now);
  }
}

/** Janela de `days` dias terminando hoje, no fuso da conta. */
export function syncWindow(
  timezone: string | null | undefined,
  days: number,
  now: Date = new Date(),
) {
  const until = accountToday(timezone, now);
  const start = new Date(`${until}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (Math.max(1, days) - 1));
  return { since: start.toISOString().slice(0, 10), until };
}

/** Tamanho máximo de cada leitura de insights (D4: backfill de 90 dias em blocos de 30). */
export const META_SYNC_CHUNK_DAYS = 30;

/**
 * A mesma janela de `syncWindow`, partida em blocos consecutivos de até `chunkDays`
 * dias, do mais antigo para o mais recente. Uma janela de até `chunkDays` dias vira
 * um bloco só, igual ao `syncWindow`.
 */
export function syncWindows(
  timezone: string | null | undefined,
  days: number,
  now: Date = new Date(),
  chunkDays: number = META_SYNC_CHUNK_DAYS,
) {
  const window = syncWindow(timezone, days, now);
  const size = Math.max(1, Math.floor(chunkDays));
  const end = new Date(`${window.until}T00:00:00Z`);
  const chunks: Array<{ since: string; until: string }> = [];
  const cursor = new Date(`${window.since}T00:00:00Z`);
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + size - 1);
    const until = chunkEnd < end ? chunkEnd : end;
    chunks.push({
      since: cursor.toISOString().slice(0, 10),
      until: until.toISOString().slice(0, 10),
    });
    cursor.setTime(until.getTime());
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

/** Linha para replace_meta_ad_metrics. A moeda vem da Meta e, na falta, da conta. */
export function insightRow(row: MetaInsight, accountCurrency: string | null | undefined) {
  return {
    campaign_id: row.campaign_id ?? null,
    campaign_name: row.campaign_name ?? null,
    adset_id: row.adset_id ?? null,
    adset_name: row.adset_name ?? null,
    ad_id: row.ad_id ?? null,
    ad_name: row.ad_name ?? null,
    creative_name: row.ad_name ?? null,
    metric_date: row.date_start ?? null,
    spend: toNumber(row.spend),
    impressions: Math.round(toNumber(row.impressions)),
    clicks: Math.round(toNumber(row.clicks)),
    link_clicks: Math.round(toNumber(row.inline_link_clicks)),
    ctr: toNumber(row.ctr),
    cpc: toNumber(row.cpc),
    cpm: toNumber(row.cpm),
    currency: (row.account_currency || accountCurrency || "BRL").toUpperCase(),
    raw: row,
  };
}

/** Linha do catálogo meta_ads. */
export function catalogRow(tenantId: string, adAccountId: string, ad: MetaAd, seenAt: string) {
  return {
    tenant_id: tenantId,
    ad_account_id: adAccountId,
    ad_id: ad.id,
    ad_name: ad.name ?? null,
    campaign_id: ad.campaign?.id ?? null,
    campaign_name: ad.campaign?.name ?? null,
    adset_id: ad.adset?.id ?? null,
    adset_name: ad.adset?.name ?? null,
    status: ad.status ?? null,
    effective_status: ad.effective_status ?? null,
    creative_id: ad.creative?.id ?? null,
    thumbnail_url: ad.creative?.thumbnail_url ?? null,
    image_url: ad.creative?.image_url ?? null,
    raw: ad,
    last_seen_at: seenAt,
    updated_at: seenAt,
  };
}

/** Anúncios que tiveram entrega mas não vieram na lista de ativos entram no catálogo pelo insight. */
export function catalogRowsFromInsights(
  tenantId: string,
  adAccountId: string,
  insights: MetaInsight[],
  knownAdIds: Set<string>,
  seenAt: string,
) {
  const rows = new Map<string, ReturnType<typeof catalogRow>>();
  for (const row of insights) {
    if (!row.ad_id || knownAdIds.has(row.ad_id) || rows.has(row.ad_id)) continue;
    rows.set(
      row.ad_id,
      catalogRow(
        tenantId,
        adAccountId,
        {
          id: row.ad_id,
          name: row.ad_name,
          campaign: { id: row.campaign_id, name: row.campaign_name },
          adset: { id: row.adset_id, name: row.adset_name },
        },
        seenAt,
      ),
    );
  }
  return [...rows.values()];
}
