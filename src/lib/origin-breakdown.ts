// U1 de ESCOPO_ORIGEM_UTM_2026-11-14: aba Origem de Aquisição e LTV.
// Números de public.origin_breakdown (20261231101000_origem_utm_u1.sql); aqui só
// tipos, nomes legíveis, o caminho do drill-down e o CSV.
import { neutralizeCsvFormula } from "./csv-safe";

export const ORIGIN_GROUPS = [
  "channel",
  "source",
  "medium",
  "campaign",
  "term",
  "content",
  "affiliate",
] as const;
export type OriginGroup = (typeof ORIGIN_GROUPS)[number];

export const GROUP_LABELS: Record<OriginGroup, string> = {
  channel: "Canal",
  source: "Fonte",
  medium: "Meio",
  campaign: "Campanha",
  term: "Conjunto",
  content: "Anúncio",
  affiliate: "Afiliado",
};

/** Nome da coluna UTM de cada nível, para a casa reconhecer o que mandou. */
export const GROUP_PARAM: Partial<Record<OriginGroup, string>> = {
  source: "utm_source",
  medium: "utm_medium",
  campaign: "utm_campaign",
  term: "utm_term",
  content: "utm_content",
};

const EMPTY_VALUE: Record<OriginGroup, string> = {
  channel: "(sem canal)",
  source: "(sem fonte)",
  medium: "(sem meio)",
  campaign: "(sem campanha)",
  term: "(sem conjunto)",
  content: "(sem anúncio)",
  affiliate: "(sem afiliado)",
};

export const CHANNEL_LABELS: Record<string, string> = {
  meta: "Meta (Facebook e Instagram)",
  meta_sem_campanha: "Meta, sem campanha informada",
  live: "Lives",
  google: "Google",
  tiktok: "TikTok",
  kwai: "Kwai",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  mensagens: "SMS e mensagens de terceiros",
  busca: "Busca e IA (ChatGPT, Bing…)",
  afiliados: "Afiliados e indicação",
  influencer: "Influenciadores",
  outros: "Outras fontes",
  sem_origem: "Sem origem informada",
  crm: "Mensagens do CRM",
};

export const CHANNEL_HINTS: Record<string, string> = {
  meta: "fonte ig, fb, instagram, an…",
  meta_sem_campanha: "só o fbclid da Meta, sem UTM",
  live: "meio (utm_medium) começando com live",
  afiliados: "código de afiliado ou de indicação, sem UTM",
  outros: "fontes que ainda não reconhecemos",
};

export const channelLabel = (key: string | null) =>
  key == null ? EMPTY_VALUE.channel : (CHANNEL_LABELS[key] ?? key);

export type OriginFilters = Partial<Record<OriginGroup, string | null>> & {
  search?: string;
  onlyFtd?: boolean;
};

export type OriginMetrics = {
  signups: number;
  ftd: number;
  ftdValue: number;
  deposits: number;
  withdrawals: number;
};

export type OriginRow = OriginMetrics & {
  key: string | null;
  raw: string | null;
  channel: string;
  /** Nome da Meta para um ID, ou o nome do expert ligado ao código de afiliado. */
  metaName: string | null;
};

export type OriginBreakdown = {
  period: { from: string; to: string };
  group: OriginGroup;
  totals: OriginMetrics & { net: number };
  coverage: {
    signups: number;
    withUtm: number;
    affiliateOnly: number;
    clickOnly: number;
    noOrigin: number;
  };
  noOrigin: OriginMetrics;
  crm: { signups: number; byLink: number };
  totalRows: number;
  rows: OriginRow[];
  others: OriginMetrics & { count: number };
  daily: Array<{ date: string; signups: number; withOrigin: number; ftd: number }>;
};

const n = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const str = (value: unknown) => (value == null ? null : String(value));

function metrics(raw: Record<string, unknown> | null | undefined): OriginMetrics {
  const r = raw ?? {};
  return {
    signups: n(r.signups),
    ftd: n(r.ftd),
    ftdValue: n(r.ftdValue),
    deposits: n(r.deposits),
    withdrawals: n(r.withdrawals),
  };
}

const obj = (value: unknown) =>
  value != null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const list = (value: unknown) => (Array.isArray(value) ? value.map(obj) : []);

/** A RPC devolve numeric como string em alguns caminhos; tudo vira number aqui. */
export function buildOriginBreakdown(raw: unknown): OriginBreakdown {
  const r = obj(raw);
  const coverage = obj(r.coverage);
  const period = obj(r.period);
  const others = obj(r.others);
  const crm = obj(r.crm);
  const group = (ORIGIN_GROUPS as readonly unknown[]).includes(r.group)
    ? (r.group as OriginGroup)
    : "channel";
  return {
    period: { from: String(period.from ?? ""), to: String(period.to ?? "") },
    group,
    totals: { ...metrics(obj(r.totals)), net: n(obj(r.totals).net) },
    coverage: {
      signups: n(coverage.signups),
      withUtm: n(coverage.withUtm),
      affiliateOnly: n(coverage.affiliateOnly),
      clickOnly: n(coverage.clickOnly),
      noOrigin: n(coverage.noOrigin),
    },
    noOrigin: metrics(obj(r.noOrigin)),
    crm: { signups: n(crm.signups), byLink: n(crm.byLink) },
    totalRows: n(r.totalRows),
    rows: list(r.rows).map((row) => ({
      ...metrics(row),
      key: str(row.key),
      raw: str(row.raw),
      channel: String(row.channel ?? "outros"),
      metaName: str(row.metaName),
    })),
    others: { ...metrics(others), count: n(others.count) },
    daily: list(r.daily).map((d) => ({
      date: String(d.date),
      signups: n(d.signups),
      withOrigin: n(d.withOrigin),
      ftd: n(d.ftd),
    })),
  };
}

const LONG_ID = /^\d{8,25}$/;

export const isNumericId = (value: string | null) => value != null && LONG_ID.test(value);

/** "120250280510370075" → "1202…0075" (o ID inteiro fica no title e no CSV). */
export function shortId(value: string) {
  return value.length > 10 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

/**
 * Nome exibido de uma linha: o canal tem nome nosso; os outros níveis mostram o
 * nome da Meta (ou do expert) quando há, senão o valor que a casa mandou.
 * `detail` é o valor bruto, mostrado embaixo quando o nome não é ele.
 */
export function rowDisplay(group: OriginGroup, row: Pick<OriginRow, "key" | "raw" | "metaName">) {
  if (group === "channel") {
    return { name: channelLabel(row.key), detail: null, unnamedId: false };
  }
  const raw = row.raw ?? row.key;
  if (raw == null) return { name: EMPTY_VALUE[group], detail: null, unnamedId: false };
  if (row.metaName) return { name: row.metaName, detail: raw, unnamedId: false };
  if (isNumericId(raw)) return { name: shortId(raw), detail: raw, unnamedId: true };
  return { name: raw, detail: null, unnamedId: false };
}

/** Próximo nível ao clicar numa linha; null quando não há mais o que abrir. */
export function nextGroup(group: OriginGroup, key: string | null): OriginGroup | null {
  if (group === "channel") {
    if (key === "afiliados") return "affiliate";
    if (key === "meta_sem_campanha") return null;
    return "source";
  }
  if (group === "source") return "medium";
  if (group === "medium") return "campaign";
  if (group === "campaign") return "term";
  if (group === "term") return "content";
  return null;
}

export type OriginStep = { group: OriginGroup; key: string | null; name: string };

/** Filtros do caminho: cada passo fixa o valor do seu nível (null = vazio). */
export function pathFilters(path: OriginStep[]): Partial<Record<OriginGroup, string | null>> {
  const filters: Partial<Record<OriginGroup, string | null>> = {};
  for (const step of path) filters[step.group] = step.key;
  return filters;
}

export const net = (m: OriginMetrics) => m.deposits - m.withdrawals;
export const conversion = (m: OriginMetrics) => (m.signups > 0 ? m.ftd / m.signups : null);

/** Com menos de 30 cadastros com origem, a % vira "poucos dados". */
export const FEW_SIGNUPS = 30;

export function coverageLevel(c: OriginBreakdown["coverage"]) {
  const known = c.signups - c.noOrigin;
  const share = c.signups > 0 ? known / c.signups : 0;
  if (c.signups === 0) return { share, level: "empty" as const };
  if (known === 0) return { share, level: "none" as const };
  if (share < 0.2) return { share, level: "low" as const };
  if (share < 0.7) return { share, level: "partial" as const };
  return { share, level: "good" as const };
}

const csvCell = (value: unknown) => `"${neutralizeCsvFormula(value ?? "").replaceAll('"', '""')}"`;
const amount = (value: number) => value.toFixed(2);

/** Uma linha por valor do nível aberto, mais "outros" e "sem origem", com o caminho. */
export function originCsv(data: OriginBreakdown, path: OriginStep[], currency: string) {
  const house = currency.toLowerCase();
  const header = [
    "periodo_inicio",
    "periodo_fim",
    "caminho",
    "nivel",
    "valor_recebido",
    "nome_exibido",
    "canal",
    "cadastros",
    "primeiro_deposito",
    "conversao",
    `valor_primeiro_deposito_${house}`,
    `depositos_${house}`,
    `saques_${house}`,
    `deposito_liquido_${house}`,
  ];
  const where = path.map((step) => `${GROUP_LABELS[step.group]}: ${step.name}`).join(" > ");
  const line = (value: string | null, name: string, channel: string, m: OriginMetrics) => {
    const rate = conversion(m);
    return [
      data.period.from,
      data.period.to,
      where,
      GROUP_LABELS[data.group],
      value ?? "",
      name,
      channel,
      m.signups,
      m.ftd,
      rate == null ? "" : rate.toFixed(4),
      amount(m.ftdValue),
      amount(m.deposits),
      amount(m.withdrawals),
      amount(net(m)),
    ];
  };
  const lines: unknown[][] = [header];
  for (const row of data.rows) {
    lines.push(
      line(row.raw ?? row.key, rowDisplay(data.group, row).name, channelLabel(row.channel), row),
    );
  }
  if (data.others.count > 0) {
    lines.push(line(null, `Outros ${data.others.count}`, "", data.others));
  }
  if (data.noOrigin.signups > 0) {
    lines.push(line(null, CHANNEL_LABELS.sem_origem, CHANNEL_LABELS.sem_origem, data.noOrigin));
  }
  return lines.map((cells) => cells.map(csvCell).join(",")).join("\n");
}

/** Monta o link com UTM do estado vazio. Devolve null se a URL não for válida. */
export function buildUtmLink(
  base: string,
  params: { source: string; medium: string; campaign: string; content?: string; term?: string },
) {
  let url: URL;
  try {
    url = new URL(base.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const entries: Array<[string, string | undefined]> = [
    ["utm_source", params.source],
    ["utm_medium", params.medium],
    ["utm_campaign", params.campaign],
    ["utm_content", params.content],
    ["utm_term", params.term],
  ];
  for (const [key, value] of entries) {
    const v = value?.trim();
    if (v) url.searchParams.set(key, v);
  }
  // As macros da Meta ({{campaign.id}}) precisam chegar como estão.
  return url
    .toString()
    .replace(/%7B%7B/gi, "{{")
    .replace(/%7D%7D/gi, "}}");
}

/** Parâmetros que a Meta preenche sozinha em "Parâmetros de URL" do anúncio. */
export const META_UTM_PRESET = {
  source: "{{site_source_name}}",
  medium: "paid",
  campaign: "{{campaign.id}}",
  term: "{{adset.id}}",
  content: "{{ad.id}}",
};
