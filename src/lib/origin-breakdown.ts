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

/** Canais que uma regra da casa pode escolher (os demais são calculados). */
export const RULE_CHANNELS = [
  "meta",
  "live",
  "google",
  "tiktok",
  "kwai",
  "whatsapp",
  "telegram",
  "mensagens",
  "busca",
  "afiliados",
  "influencer",
  "outros",
] as const;
export type RuleChannel = (typeof RULE_CHANNELS)[number];

export const RULE_FIELD_LABELS = { source: "Fonte", medium: "Meio", campaign: "Campanha" } as const;
export const RULE_MATCH_LABELS = {
  exact: "é igual a",
  prefix: "começa com",
  contains: "contém",
} as const;

/** Chave da RPC para os cadastros só com código de indicação, no nível Afiliado. */
export const REFERRAL_KEY = "__indicacao__";

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
  /** Cadastros com 7/30 dias de vida e o líquido deles nessa janela (U3). */
  mature7: number;
  net7: number;
  mature30: number;
  net30: number;
};

export type OriginRow = OriginMetrics & {
  key: string | null;
  raw: string | null;
  channel: string;
  /** Nome da Meta para um ID, ou o nome do expert ligado ao código de afiliado. */
  metaName: string | null;
  /** Apelido dado pela casa (U2). */
  label: string | null;
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
  crm: { signups: number };
  /** Admin ou gestor da casa: pode dar apelido e criar regra de canal. */
  canEdit: boolean;
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
    mature7: n(r.mature7),
    net7: n(r.net7),
    mature30: n(r.mature30),
    net30: n(r.net30),
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
    crm: { signups: n(crm.signups) },
    canEdit: r.canEdit === true,
    totalRows: n(r.totalRows),
    rows: list(r.rows).map((row) => ({
      ...metrics(row),
      key: str(row.key),
      raw: str(row.raw),
      channel: String(row.channel ?? "outros"),
      metaName: str(row.metaName),
      label: str(row.label),
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
 * apelido da casa, depois o nome da Meta (ou do expert), senão o valor que a casa
 * mandou. `detail` é o valor bruto, mostrado embaixo quando o nome não é ele.
 */
export function rowDisplay(
  group: OriginGroup,
  row: Pick<OriginRow, "key" | "raw" | "metaName"> & { label?: string | null },
): {
  name: string;
  detail: string | null;
  unnamedId: boolean;
  source: "label" | "meta" | "expert" | null;
} {
  const none = { detail: null, unnamedId: false, source: null };
  if (group === "channel") return { ...none, name: channelLabel(row.key) };
  if (group === "affiliate" && row.key === REFERRAL_KEY) {
    return { ...none, name: "Indicação entre jogadores" };
  }
  const raw = row.raw ?? row.key;
  if (raw == null) return { ...none, name: EMPTY_VALUE[group] };
  if (row.label) return { name: row.label, detail: raw, unnamedId: false, source: "label" };
  if (row.metaName) {
    return {
      name: row.metaName,
      detail: raw,
      unnamedId: false,
      source: group === "affiliate" ? "expert" : "meta",
    };
  }
  if (isNumericId(raw)) return { name: shortId(raw), detail: raw, unnamedId: true, source: null };
  return { ...none, name: raw };
}

/** Pode ganhar apelido: qualquer valor real fora do nível Canal. */
export const canLabel = (group: OriginGroup, key: string | null) =>
  group !== "channel" && key != null && key !== REFERRAL_KEY;

/** Pode virar regra de canal: fonte, meio ou campanha com valor. */
export const canRule = (group: OriginGroup, key: string | null) =>
  key != null && (group === "source" || group === "medium" || group === "campaign");

/** Líquido por cadastro nos primeiros 7/30 dias, só de quem já tem essa idade. */
export function perSignupWindow(m: OriginMetrics, days: 7 | 30) {
  const mature = days === 7 ? m.mature7 : m.mature30;
  const value = days === 7 ? m.net7 : m.net30;
  return mature > 0 ? value / mature : null;
}

/** Período anterior de mesmo tamanho, colado antes do atual (datas YYYY-MM-DD). */
export function previousRange(from: string, to: string) {
  const day = 86_400_000;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const length = Math.round((end - start) / day) + 1;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { from: iso(start - length * day), to: iso(start - day) };
}

/** Variação contra o período anterior (0,1 = +10%); null sem base. */
export const delta = (current: number, previous: number | null | undefined) =>
  previous == null || previous === 0 ? null : (current - previous) / Math.abs(previous);

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
const windowCell = (m: OriginMetrics, days: 7 | 30) => {
  const value = perSignupWindow(m, days);
  return value == null ? "" : value.toFixed(2);
};

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
    `liquido_por_cadastro_7d_${house}`,
    `liquido_por_cadastro_30d_${house}`,
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
      windowCell(m, 7),
      windowCell(m, 30),
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

export type OriginPlayerRow = {
  id: string;
  nome: string | null;
  createdAt: string;
  channel: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
  affiliate: string | null;
  referral: string | null;
  expert: string | null;
  ftd: boolean;
  ftdValue: number;
  deposits: number;
  withdrawals: number;
};

/** Um jogador por linha, com todas as UTMs (U3). */
export function originPlayersCsv(rows: OriginPlayerRow[], currency: string) {
  const house = currency.toLowerCase();
  const header = [
    "jogador_id",
    "nome",
    "cadastro_em",
    "canal",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "afiliado",
    "codigo_indicacao",
    "expert",
    "fez_primeiro_deposito",
    `valor_primeiro_deposito_${house}`,
    `depositos_${house}`,
    `saques_${house}`,
    `deposito_liquido_${house}`,
  ];
  const lines: unknown[][] = [header];
  for (const r of rows) {
    lines.push([
      r.id,
      r.nome ?? "",
      r.createdAt,
      channelLabel(r.channel),
      r.source,
      r.medium,
      r.campaign,
      r.term,
      r.content,
      r.affiliate,
      r.referral,
      r.expert,
      r.ftd ? "sim" : "nao",
      amount(r.ftdValue),
      amount(r.deposits),
      amount(r.withdrawals),
      amount(r.deposits - r.withdrawals),
    ]);
  }
  return lines.map((cells) => cells.map(csvCell).join(",")).join("\n");
}
