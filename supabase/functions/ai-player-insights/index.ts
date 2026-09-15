import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `Você é a Inteligência IA da BETLEADS. Você é uma API JSON.
NUNCA responda em texto livre, markdown ou code fences. Responda APENAS com um objeto JSON neste schema:
{
  "summary": "frase curta",
  "criterio": "frase curta do critério",
  "players": [ { "id","nome","telefone","depositado_hoje","qtd_depositos_hoje","sacado_hoje","qtd_saques_hoje","total_depositado","total_sacado","lucro","saldo_atual","expert","origem","ultimo_login","ultimo_deposito","ultimo_jogo","status","vip","motivo","classificacao","score" } ],
  "insights": [ { "titulo","descricao","tipo": "info|alerta|sucesso|atencao" } ],
  "metrics":  [ { "label","valor","tipo": "neutro|positivo|negativo" } ]
}
Os players já vêm pré-filtrados pelo backend; use-os COMO ESTÃO, sem inventar nem alterar números.
IMPORTANTE — separar HOJE x HISTÓRICO:
- "depositado_hoje" / "sacado_hoje" / "qtd_depositos_hoje" = atividade SOMENTE de hoje (timezone America/Sao_Paulo).
- "total_depositado" / "total_sacado" / "lucro" = histórico acumulado do player.
- Quando a pergunta for sobre "hoje", o summary e metrics devem refletir os totais de HOJE (use "hoje_totais" do contexto). Nunca misture os dois.
REGRAS DE NEGÓCIO (já calculadas pelo backend em cada player):
- classificacao: "vip" (depositou >=R$1000), "lead_quente" (7d seguidos depositando + média >R$200),
  "lead_frio" (>15d sem login + <R$150), "em_risco" (>5d sem login OU queda de depósitos 30d),
  "alto_potencial" (alta frequência + depósitos crescentes), "neutro".
- score 0-100: combina frequência, retenção, depósitos, crescimento e consistência.
- alertas: lista de alertas detectados (vip_inativo, queda_depositos, lead_esfriando, possivel_abandono,
  proximo_vip, saque_alto, ativo_sem_deposito) com prioridade alta/media/baixa.
Use classificacao/score/alertas nos insights e no motivo dos players quando relevantes.
Gere 1-3 insights curtos e 2-4 metrics resumindo o conjunto.
IMPORTANTE — RESPEITAR o objeto "parsed" do contexto (intent, limit, period, sort, filters):
- Se "limit" = N, o summary deve mencionar "top N" / "N players", e NÃO listar mais que N.
- Se "period" = today/week/month, refira-se ao período correspondente no summary.
- Se "sort" indicar ordenação (ex.: deposit_amount_desc), explicite isso no "criterio".
- Se "filters" tiver vip, min_deposit, inactivity_days etc, mencione no "criterio".`;
// Intent "players_with_balance": pergunta sobre banca/saldo. Os players já vêm com
// saldo_atual (saldo_carteira > 0). NUNCA confunda saldo_atual com total_depositado
// ou lucro. O summary deve ser: "Encontrei X players com saldo disponível na banca,
// totalizando R$ Y." e o criterio deve citar "saldo atual da banca (saldo_carteira)".
// (audiência - expert/origem detectado - vem em parsed.audience; quando presente,
//  os players já foram filtrados por esse expert/origem; cite isso no criterio e
//  diga "nenhum lead do <expert> ..." quando players=[].)

const LIMIT = 20;
const PLAYER_COLS =
  "id,nome,telefone,status,vip,total_depositado,total_sacado,saldo_carteira,saldo_bloqueado,saldo_bonus,ultimo_login,ultimo_deposito,ultimo_jogo,ftd_em,created_at,expert,origem,utm_source,utm_campaign,tags";

type Intent =
  | "deposito_hoje" | "saque_hoje" | "ftd_hoje" | "top_depositantes"
  | "sem_jogar_7d" | "cadastrou_sem_depositar" | "vip" | "risco_abandono"
  | "maiores_perdas_hoje" | "novos_cadastros_7d"
  | "virando_vip" | "lead_quente" | "lead_frio" | "alto_potencial"
  | "vip_inativo" | "cresceu_semana" | "melhores_players"
  | "players_with_balance" | "generico";

type Period = "today" | "yesterday" | "week" | "month" | "all";
type SortKey =
  | "deposit_amount_desc" | "deposit_amount_asc"
  | "withdraw_amount_desc" | "profit_desc" | "profit_asc"
  | "last_login_desc" | "last_login_asc"
  | "score_desc" | "created_desc" | "default";

type ParsedQuery = {
  intent: Intent;
  limit: number;
  period: Period;
  sort: SortKey;
  filters: {
    vip?: boolean;
    min_deposit?: number;
    max_deposit?: number;
    min_withdraw?: number;
    inactivity_days?: number;
    never_deposited?: boolean;
  };
  audience?: {
    term: string;        // termo bruto detectado na pergunta (ex.: "queiroz")
    matched_expert?: string; // nome canônico do expert se bateu na tabela experts
    player_ids: string[]; // ids do público alvo (se vazio = nenhum, se null = sem filtro)
    fields: string[];    // campos usados no match (auditoria)
  } | null;
};

// ===== INTENT PARSER =====
// Extrai limite, período, filtros, ordenação ANTES da consulta.
function parseQuery(q: string): Omit<ParsedQuery, "audience"> {
  const s = q.toLowerCase();
  const intent = detectIntent(q);

  // ---- limit ----
  let limit = LIMIT;
  // "top 3", "top10", "3 maiores", "primeiros 5", "5 melhores"
  const numWords: Record<string, number> = {
    um: 1, dois: 2, tres: 3, três: 3, quatro: 4, cinco: 5,
    seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, quinze: 15, vinte: 20, cinquenta: 50, cem: 100,
  };
  const mTop = s.match(/\b(?:top|primeiros?|melhores|maiores|pior(?:es)?|últim[oa]s?|ultim[oa]s?)\s*(\d{1,4})\b/);
  const mNumPre = s.match(/\b(\d{1,4})\s*(?:players?|leads?|usu[áa]rios?|maiores|melhores|piores|depositantes?|vips?)\b/);
  const mNumWord = s.match(/\b(?:top|primeiros?|melhores|maiores|últim[oa]s?|ultim[oa]s?)\s+(um|dois|tr[êe]s|quatro|cinco|seis|sete|oito|nove|dez|quinze|vinte|cinquenta|cem)\b/);
  let explicitNumber = false;
  if (mTop) { limit = Math.max(1, Math.min(100, parseInt(mTop[1], 10))); explicitNumber = true; }
  else if (mNumPre) { limit = Math.max(1, Math.min(100, parseInt(mNumPre[1], 10))); explicitNumber = true; }
  else if (mNumWord) { limit = numWords[mNumWord[1]] ?? limit; explicitNumber = true; }

  // ---- cardinalidade (singular x plural) ----
  // Quando NÃO há número explícito, perguntas no singular ("o maior depositante",
  // "melhor player", "VIP mais forte", "quem foi o maior", "player mais ativo")
  // devem retornar APENAS 1 resultado.
  if (!explicitNumber) {
    const singularPatterns = [
      /\bo\s+maior\b/, /\ba\s+maior\b/, /\bo\s+melhor\b/, /\ba\s+melhor\b/,
      /\bo\s+mais\b/, /\ba\s+mais\b/, /\bo\s+pior\b/, /\ba\s+pior\b/,
      /\bmaior\s+(?:dep[oó]sito|depositante|saque|saldo|banca|lucro|perda|player|lead|vip|cliente|jogador|aposta(?:dor)?)\b/,
      /\bmelhor\s+(?:player|lead|vip|cliente|depositante|jogador|aposta(?:dor)?)\b/,
      /\bpior\s+(?:player|lead|vip|cliente|depositante|jogador)\b/,
      /\b(?:jogador|player|lead|cliente|vip)\s+com\s+(?:o\s+)?maior\b/,
      /\bquem\s+(?:foi\s+)?(?:o|a)\s+(?:jogador|player|lead|cliente|vip|depositante)\b/,
      /\bplayer\s+mais\s+(?:ativo|forte|valioso|lucrativo|engajado)\b/,
      /\b(?:vip|lead|cliente)\s+mais\s+(?:forte|ativo|valioso|lucrativo|engajado)\b/,
      /\bquem\s+(?:é|foi|tem)\s+o\s+(?:maior|melhor|pior|mais)\b/,
      /\bme\s+(?:mande|manda|diga|diz|fala|d[êe])\s+o\s+(?:maior|melhor|pior)\b/,
      /\bquero\s+(?:saber\s+)?o\s+(?:maior|melhor|pior)\b/,
    ];
    const pluralPatterns = [
      /\bmaiores\b/, /\bmelhores\b/, /\bpiores\b/, /\btop\b/, /\branking\b/,
      /\bprimeiros\b/, /\b[uú]ltimos\b/, /\blista\b/, /\bdepositantes\b/,
    ];
    const isSingular = singularPatterns.some((r) => r.test(s));
    const isPlural = pluralPatterns.some((r) => r.test(s));
    if (isSingular && !isPlural) limit = 1;
  }

  // ---- period ----
  let period: Period = "all";
  if (/\bhoje\b/.test(s)) period = "today";
  else if (/\bontem\b/.test(s)) period = "yesterday";
  else if (/(\bsemana\b|7 ?dias|últimos? 7|ultimos? 7)/.test(s)) period = "week";
  else if (/(\bm[êe]s\b|30 ?dias|últimos? 30|ultimos? 30)/.test(s)) period = "month";

  // intents que implicam período "today"
  if (intent === "deposito_hoje" || intent === "saque_hoje" || intent === "ftd_hoje" || intent === "maiores_perdas_hoje") {
    period = "today";
  }
  if (intent === "cresceu_semana" || intent === "novos_cadastros_7d") period = "week";

  // ---- sort ----
  let sort: SortKey = "default";
  if (/(top|maiores?|mais)\s+deposit/.test(s) || /melhores? depositant/.test(s)) sort = "deposit_amount_desc";
  else if (/menores? deposit|menos deposit/.test(s)) sort = "deposit_amount_asc";
  else if (/maiores? saqu|mais saqu/.test(s)) sort = "withdraw_amount_desc";
  else if (/(maior|mais) lucro|melhores? lucro/.test(s)) sort = "profit_desc";
  else if (/(menor|pior) lucro|maiores? perdas|maior perda/.test(s)) sort = "profit_asc";
  else if (/recentement|últim.*login|ultim.*login/.test(s)) sort = "last_login_desc";
  else if (/melhores? (players?|leads?)|top (players?|leads?)|maior score/.test(s)) sort = "score_desc";
  else if (/novos? cadastr|recém|recem cadastr/.test(s)) sort = "created_desc";

  // ---- filters ----
  const filters: ParsedQuery["filters"] = {};
  if (/\bvip\b/.test(s)) filters.vip = true;
  if (/nunca deposit|sem deposit|n[ãa]o deposit/.test(s)) filters.never_deposited = true;

  // "acima de 500", "maior que 500", "mais de 1.000", "depositou >500"
  const mMin = s.match(/(?:acima de|maior(?:es)? que|mais de|>=?|superior(?:es)? a)\s*r?\$?\s*([\d.,]+)/);
  if (mMin) {
    const v = parseFloat(mMin[1].replace(/\./g, "").replace(",", "."));
    if (!Number.isNaN(v)) {
      if (/saqu/.test(s)) filters.min_withdraw = v;
      else filters.min_deposit = v;
    }
  }
  const mMax = s.match(/(?:abaixo de|menor(?:es)? que|menos de|<=?|inferior(?:es)? a)\s*r?\$?\s*([\d.,]+)/);
  if (mMax) {
    const v = parseFloat(mMax[1].replace(/\./g, "").replace(",", "."));
    if (!Number.isNaN(v)) filters.max_deposit = v;
  }

  // "7 dias sem jogar/login", "15 dias inativos"
  const mInact = s.match(/(\d{1,3})\s*dias?\s*(?:sem|inativ|sem jogar|sem login|sem depositar)/);
  if (mInact) filters.inactivity_days = Math.max(1, Math.min(365, parseInt(mInact[1], 10)));
  else if (intent === "sem_jogar_7d") filters.inactivity_days = 7;

  return { intent, limit, period, sort, filters };
}

// ===== AUDIENCE PARSER =====
// Detecta expert/origem mencionado na pergunta e resolve para uma lista de player_ids.
// Tenta primeiro casar com a tabela `experts` (mais confiável), depois cai pra
// padrões "do/da/de <NOME>" buscando em expert/origem/utm_source/utm_campaign/tags.
function stripAccents(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function escRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function extractAudienceTerm(question: string, knownExperts: string[]): { term: string; matched_expert?: string } | null {
  const norm = stripAccents(question.toLowerCase());
  // 1) tenta casar com algum expert cadastrado
  for (const nome of knownExperts) {
    const n = stripAccents(nome.toLowerCase()).trim();
    if (!n) continue;
    const re = new RegExp(`\\b${escRe(n)}\\b`, "i");
    if (re.test(norm)) return { term: nome, matched_expert: nome };
  }
  // 2) padrão "do/da/de/dos/das <Nome>" - pega 1 ou 2 palavras seguintes capitalizadas no original
  const m = question.match(/\b(?:do|da|de|dos|das)\s+([A-ZÀ-Ý][\wÀ-ÿ]+(?:\s+[A-ZÀ-Ý][\wÀ-ÿ]+)?)\b/);
  if (m) {
    const term = m[1].trim();
    // ignora palavras-chave comuns que não são nomes
    if (!/^(hoje|ontem|semana|m[êe]s|banco|sistema)$/i.test(term)) return { term };
  }
  return null;
}

async function resolveAudience(
  sb: any,
  question: string,
): Promise<ParsedQuery["audience"]> {
  // carrega experts cadastrados
  let knownExperts: string[] = [];
  try {
    const { data } = await sb.from("experts").select("nome");
    knownExperts = [...new Set((data ?? []).map((e: any) => String(e.nome).trim()).filter(Boolean))];
  } catch (e) { console.warn("[ai] experts load falhou", e); }

  const det = extractAudienceTerm(question, knownExperts);
  if (!det) return null;

  const term = det.term;
  const like = `%${term}%`;
  // Busca player_ids em qualquer campo de origem/expert
  const orFilter = [
    `expert.ilike.${like}`,
    `origem.ilike.${like}`,
    `utm_source.ilike.${like}`,
    `utm_campaign.ilike.${like}`,
    `tags.cs.{${term}}`,
  ].join(",");

  const ids: string[] = [];
  const fields = ["expert", "origem", "utm_source", "utm_campaign", "tags"];
  try {
    // pagina pra suportar muitos players (cap em 20k)
    const pageSize = 1000;
    for (let from = 0; from < 20000; from += pageSize) {
      const { data, error } = await sb
        .from("players")
        .select("id")
        .or(orFilter)
        .range(from, from + pageSize - 1);
      if (error) { console.warn("[ai] audience query err", error.message); break; }
      if (!data || data.length === 0) break;
      for (const r of data) ids.push(r.id);
      if (data.length < pageSize) break;
    }
  } catch (e) { console.warn("[ai] audience exception", e); }

  console.log(`[ai][audience] term="${term}" matched_expert="${det.matched_expert ?? ""}" player_ids=${ids.length} fields=${fields.join("|")}`);
  return { term, matched_expert: det.matched_expert, player_ids: ids, fields };
}

function periodStartIso(period: Period): string | null {
  const now = Date.now();
  if (period === "today") {
    const spOffsetMs = 3 * 60 * 60 * 1000;
    const spNow = new Date(now - spOffsetMs);
    const spStart = new Date(Date.UTC(spNow.getUTCFullYear(), spNow.getUTCMonth(), spNow.getUTCDate()));
    return new Date(spStart.getTime() + spOffsetMs).toISOString();
  }
  if (period === "yesterday") {
    const spOffsetMs = 3 * 60 * 60 * 1000;
    const spNow = new Date(now - spOffsetMs);
    const spStart = new Date(Date.UTC(spNow.getUTCFullYear(), spNow.getUTCMonth(), spNow.getUTCDate() - 1));
    return new Date(spStart.getTime() + spOffsetMs).toISOString();
  }
  if (period === "week") return new Date(now - 7 * 86400000).toISOString();
  if (period === "month") return new Date(now - 30 * 86400000).toISOString();
  return null;
}

function detectIntent(q: string): Intent {
  const s = q.toLowerCase();
  // banca / saldo disponível na conta
  if (/\bbanca\b|saldo (?:atual|dispon|na (?:banca|conta|casa))|dinheiro (?:parado|na conta)|tem saldo|com saldo|saldos? da casa|saldo hoje/.test(s))
    return "players_with_balance";
  if (/virando vip|quase vip|pr[oó]xim.*vip/.test(s)) return "virando_vip";
  if (/vip.*(inativ|sem jogar|sem login)/.test(s)) return "vip_inativo";
  if (/lead.*quente|leads quentes/.test(s)) return "lead_quente";
  if (/lead.*frio|leads frios/.test(s)) return "lead_frio";
  if (/alto.*potencial|maior.*potencial/.test(s)) return "alto_potencial";
  if (/melhores players|top players|melhor.*player/.test(s)) return "melhores_players";
  if (/cresce[ru]|crescimento|cresc.*semana/.test(s)) return "cresceu_semana";
  if (/ftd|primeiro dep/.test(s) && /hoje/.test(s)) return "ftd_hoje";
  if (/(deposit).*(hoje)|hoje.*(deposit)/.test(s)) return "deposito_hoje";
  if (/(saque|saqu|withdraw).*(hoje)|hoje.*(saque|withdraw)/.test(s)) return "saque_hoje";
  if (/top.*deposit|maiores deposit|mais deposit/.test(s)) return "top_depositantes";
  if (/(sem jogar|nao jogou|não jogou|inativ).*(7|sete)|7.*sem jogar/.test(s)) return "sem_jogar_7d";
  if (/cadastr.*(n[ãa]o|sem).*deposit|sem deposit/.test(s)) return "cadastrou_sem_depositar";
  if (/\bvip\b/.test(s)) return "vip";
  if (/risco|abandono|churn/.test(s)) return "risco_abandono";
  if (/perd|perdeu/.test(s)) return "maiores_perdas_hoje";
  if (/novos? cadastr|cadastr.*(semana|7)/.test(s)) return "novos_cadastros_7d";
  return "generico";
}

function mapPlayer(p: any, motivo: string) {
  const dep = Number(p.total_depositado ?? 0);
  const saq = Number(p.total_sacado ?? 0);
  const saldo = Number(p.saldo_carteira ?? 0);
  const saldoBloq = Number(p.saldo_bloqueado ?? 0);
  const saldoBonus = Number(p.saldo_bonus ?? 0);
  return {
    id: p.id, nome: p.nome, telefone: p.telefone ?? null,
    total_depositado: dep, total_sacado: saq, lucro: dep - saq,
    saldo_atual: saldo,
    saldo_bloqueado: saldoBloq,
    saldo_bonus: saldoBonus,
    expert: p.expert ?? null, origem: p.origem ?? null,
    ultimo_login: p.ultimo_login ?? null,
    ultimo_deposito: p.ultimo_deposito ?? null,
    ultimo_jogo: p.ultimo_jogo ?? null,
    status: p.status ?? "ativo", vip: !!p.vip, motivo,
  };
}

// ===== Regras de negócio (espelho de src/lib/player-rules.ts) =====
function daysSince(iso?: string | null): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return Math.max(0, (Date.now() - t) / 86400000);
}
function classify(p: any): string {
  const dep = Number(p.total_depositado ?? 0);
  const diasLogin = daysSince(p.ultimo_login);
  const diasSeg = p.dias_seguidos_depositando ?? 0;
  const media = p.media_deposito ?? 0;
  const dep30 = p.dep_30d ?? 0;
  const dep3060 = p.dep_30_60d ?? 0;
  const logins30 = p.qtd_logins_30d ?? 0;
  if (dep >= 1000) return "vip";
  if (diasSeg >= 7 && media >= 200) return "lead_quente";
  if (diasLogin > 15 && dep < 150) return "lead_frio";
  if (diasLogin > 5 || (dep3060 > 0 && dep30 < dep3060 * 0.5)) return "em_risco";
  if (logins30 >= 10 && dep30 > dep3060 && diasLogin <= 2) return "alto_potencial";
  return "neutro";
}
function playerScore(p: any): number {
  const dep = Number(p.total_depositado ?? 0);
  const diasLogin = daysSince(p.ultimo_login);
  const diasJogo = daysSince(p.ultimo_jogo);
  const diasDep = daysSince(p.ultimo_deposito);
  const dep30 = p.dep_30d ?? 0;
  const dep3060 = p.dep_30_60d ?? 0;
  const logins30 = p.qtd_logins_30d ?? 0;
  const seg = p.dias_seguidos_depositando ?? 0;
  const freq = Math.min(25, logins30 * 1.5);
  const ret = diasLogin <= 1 ? 20 : diasLogin <= 3 ? 16 : diasLogin <= 7 ? 12 : diasLogin <= 15 ? 6 : 0;
  const depScore = Math.min(20, Math.log10(Math.max(1, dep)) * 6);
  let cresc = 0;
  if (dep3060 > 0) { const r = dep30 / dep3060; cresc = Math.max(0, Math.min(20, (r - 0.5) * 20)); }
  else if (dep30 > 0) cresc = 12;
  const cons = Math.min(15, seg * 1.5 + (diasJogo <= 3 ? 5 : 0));
  const total = freq + ret + depScore + cresc + cons;
  const penalty = diasDep > 30 ? 10 : 0;
  return Math.max(0, Math.min(100, Math.round(total - penalty)));
}
function detectAlerts(p: any): any[] {
  const out: any[] = [];
  const dep = Number(p.total_depositado ?? 0);
  const diasLogin = daysSince(p.ultimo_login);
  const diasJogo = daysSince(p.ultimo_jogo);
  const dep30 = p.dep_30d ?? 0;
  const dep3060 = p.dep_30_60d ?? 0;
  if (p.vip && diasJogo >= 2) out.push({ tipo: "vip_inativo", titulo: "VIP sem jogar", prioridade: "alta" });
  if (dep3060 > 0 && dep30 < dep3060 * 0.5 && dep3060 >= 200)
    out.push({ tipo: "queda_depositos", titulo: "Queda de depósitos", prioridade: "alta" });
  if (dep >= 800 && dep < 1000 && !p.vip)
    out.push({ tipo: "proximo_vip", titulo: "Próximo de VIP", prioridade: "media" });
  if (diasLogin > 15 && dep > 0) out.push({ tipo: "possivel_abandono", titulo: "Possível abandono", prioridade: "alta" });
  else if (diasLogin > 5 && dep > 0) out.push({ tipo: "lead_esfriando", titulo: "Lead esfriando", prioridade: "media" });
  return out;
}

// Enriquece players com dep_30d/dep_30_60d para classificação mais precisa,
// roda classify/playerScore/detectAlerts e devolve novo array.
async function enrichPlayers(sb: any, players: any[]): Promise<any[]> {
  if (!players.length) return players;
  const ids = players.map((p) => p.id).filter(Boolean);
  const iso30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const iso60 = new Date(Date.now() - 60 * 86400000).toISOString();
  const dep30 = new Map<string, number>();
  const dep3060 = new Map<string, number>();
  try {
    const { data } = await sb
      .from("deposits")
      .select("player_id,valor,created_at")
      .in("player_id", ids)
      .gte("created_at", iso60)
      .eq("status", "aprovado");
    for (const d of data ?? []) {
      const k = d.player_id as string;
      if ((d.created_at as string) >= iso30) {
        dep30.set(k, (dep30.get(k) ?? 0) + Number(d.valor ?? 0));
      } else {
        dep3060.set(k, (dep3060.get(k) ?? 0) + Number(d.valor ?? 0));
      }
    }
  } catch (e) { console.warn("[ai] enrich deposits err", e); }
  return players.map((p) => {
    const enriched = {
      ...p,
      dep_30d: dep30.get(p.id) ?? 0,
      dep_30_60d: dep3060.get(p.id) ?? 0,
    };
    const classificacao = classify(enriched);
    const score = playerScore(enriched);
    const alertas = detectAlerts(enriched);
    return { ...enriched, classificacao, score, alertas };
  });
}

async function playersByIds(sb: any, ids: string[]) {
  if (!ids.length) return new Map<string, any>();
  const { data, error } = await sb.from("players").select(PLAYER_COLS).in("id", ids);
  if (error) console.error("[players in ids] error", error);
  return new Map((data ?? []).map((p: any) => [p.id, p]));
}

async function fetchByIntent(sb: any, parsed: ParsedQuery) {
  const { intent, limit, period, sort, filters } = parsed;
  const isoToday = periodStartIso("today")!;
  const iso7d = new Date(Date.now() - 7 * 86400000).toISOString();
  const periodIso = periodStartIso(period);
  const inactDays = filters.inactivity_days;
  const inactIso = inactDays ? new Date(Date.now() - inactDays * 86400000).toISOString() : null;
  const audIds = parsed.audience?.player_ids ?? null;
  // Se há audiência detectada mas nenhum player bateu, retorna vazio cedo.
  if (parsed.audience && (audIds == null || audIds.length === 0)) return [];
  const audSet = audIds ? new Set(audIds) : null;
  // PostgREST limita tamanho da URL: usar .in() só quando a lista é pequena (<= 300).
  // Caso contrário filtrar via audSet no JS após a query.
  const SMALL = audIds && audIds.length <= 300;
  const applyAudPlayers = (q: any) => (SMALL ? q.in("id", audIds!) : q);
  const applyAudByPlayerId = (q: any) => (SMALL ? q.in("player_id", audIds!) : q);
  const inAud = (id: string) => !audSet || audSet.has(id);

  switch (intent) {
    case "deposito_hoje":
    case "saque_hoje": {
      const table = intent === "deposito_hoje" ? "deposits" : "withdrawals";
      const sinceIso = periodIso ?? isoToday;
      let q = sb.from(table).select("player_id,valor,created_at")
        .gte("created_at", sinceIso).order("valor", { ascending: false }).limit(5000);
      if (table === "deposits") q.eq("status", "aprovado");
      q = applyAudByPlayerId(q);
      const { data, error } = await q;
      if (error) throw new Error(`${table}: ${error.message}`);
      const agg = new Map<string, { sum: number; count: number; last: string | null }>();
      for (const d of data ?? []) {
        if (!inAud(d.player_id)) continue;
        if (filters.min_deposit && Number(d.valor) < filters.min_deposit) continue;
        const cur = agg.get(d.player_id) ?? { sum: 0, count: 0, last: null };
        cur.sum += Number(d.valor || 0);
        cur.count += 1;
        if (!cur.last || d.created_at > cur.last) cur.last = d.created_at;
        agg.set(d.player_id, cur);
      }
      const asc = sort === "deposit_amount_asc";
      const ranked = [...agg.entries()].sort((a, b) => asc ? a[1].sum - b[1].sum : b[1].sum - a[1].sum);
      const filteredRanked = filters.min_deposit
        ? ranked.filter(([, v]) => v.sum >= filters.min_deposit!)
        : ranked;
      const ids = filteredRanked.slice(0, limit).map(([id]) => id);
      const pmap = await playersByIds(sb, ids);
      const verb = table === "deposits" ? "Depositou" : "Sacou";
      return ids.filter((id) => pmap.has(id)).map((id) => {
        const a = agg.get(id)!;
        const base = mapPlayer(pmap.get(id), `${verb} R$ ${a.sum.toFixed(2)} hoje (${a.count}x)`);
        if (table === "deposits") {
          return { ...base, depositado_hoje: a.sum, qtd_depositos_hoje: a.count, ultimo_deposito: a.last ?? base.ultimo_deposito };
        }
        return { ...base, sacado_hoje: a.sum, qtd_saques_hoje: a.count };
      });
    }
    case "ftd_hoje": {
      const { data, error } = await applyAudPlayers(
        sb.from("players").select(PLAYER_COLS).gte("ftd_em", isoToday)
      ).order("ftd_em", { ascending: false }).limit(limit);
      if (error) throw new Error(`players: ${error.message}`);
      return (data ?? []).map((p: any) => mapPlayer(p, "FTD hoje"));
    }
    case "top_depositantes": {
      let q = sb.from("players").select(PLAYER_COLS);
      if (filters.vip) q = q.eq("vip", true);
      if (filters.min_deposit) q = q.gte("total_depositado", filters.min_deposit);
      if (audIds) q = q.in("id", audIds);
      const asc = sort === "deposit_amount_asc";
      const { data, error } = await q
        .order("total_depositado", { ascending: asc }).limit(limit);
      if (error) throw new Error(`players: ${error.message}`);
      return (data ?? []).map((p: any) => mapPlayer(p, "Top depositante"));
    }
    case "sem_jogar_7d": {
      const sinceIso = inactIso ?? iso7d;
      const { data, error } = await applyAudPlayers(
        sb.from("players").select(PLAYER_COLS)
          .lt("ultimo_jogo", sinceIso).gt("total_depositado", 0)
      ).order("total_depositado", { ascending: false }).limit(limit);
      if (error) throw new Error(`players: ${error.message}`);
      return (data ?? []).map((p: any) => mapPlayer(p, `Sem jogar há ${inactDays ?? 7}+ dias`));
    }
    case "cadastrou_sem_depositar": {
      const { data, error } = await applyAudPlayers(
        sb.from("players").select(PLAYER_COLS).is("ftd_em", null)
      ).order("created_at", { ascending: false }).limit(limit);
      if (error) throw new Error(`players: ${error.message}`);
      return (data ?? []).map((p: any) => mapPlayer(p, "Cadastrou e não depositou"));
    }
    case "vip": {
      let q = sb.from("players").select(PLAYER_COLS).eq("vip", true);
      if (filters.min_deposit) q = q.gte("total_depositado", filters.min_deposit);
      if (audIds) q = q.in("id", audIds);
      const { data, error } = await q.order("total_depositado", { ascending: false }).limit(limit);
      if (error) throw new Error(`players: ${error.message}`);
      return (data ?? []).map((p: any) => mapPlayer(p, "VIP"));
    }
    case "risco_abandono": {
      const sinceIso = inactIso ?? iso7d;
      const { data, error } = await applyAudPlayers(
        sb.from("players").select(PLAYER_COLS)
          .gt("total_depositado", 0).lt("ultimo_login", sinceIso)
      ).order("total_depositado", { ascending: false }).limit(limit);
      if (error) throw new Error(`players: ${error.message}`);
      return (data ?? []).map((p: any) => mapPlayer(p, "Risco de abandono"));
    }
    case "maiores_perdas_hoje": {
      const sinceIso = periodIso ?? isoToday;
      const depQ = sb.from("deposits").select("player_id,valor")
        .gte("created_at", sinceIso).eq("status", "aprovado").limit(5000);
      const wdQ = sb.from("withdrawals").select("player_id,valor")
        .gte("created_at", sinceIso).limit(5000);
      if (SMALL) { depQ.in("player_id", audIds!); wdQ.in("player_id", audIds!); }
      const [dep, wd] = await Promise.all([
        depQ, wdQ,
      ]);
      if (dep.error) throw new Error(`deposits: ${dep.error.message}`);
      if (wd.error) throw new Error(`withdrawals: ${wd.error.message}`);
      const m = new Map<string, { dep: number; wd: number }>();
      for (const d of dep.data ?? []) {
        if (!inAud(d.player_id)) continue;
        const c = m.get(d.player_id) ?? { dep: 0, wd: 0 };
        c.dep += Number(d.valor || 0); m.set(d.player_id, c);
      }
      for (const w of wd.data ?? []) {
        if (!inAud(w.player_id)) continue;
        const c = m.get(w.player_id) ?? { dep: 0, wd: 0 };
        c.wd += Number(w.valor || 0); m.set(w.player_id, c);
      }
      const ranked = [...m.entries()]
        .map(([id, v]) => ({ id, perda: v.dep - v.wd }))
        .sort((a, b) => b.perda - a.perda).slice(0, limit);
      const pmap = await playersByIds(sb, ranked.map((r) => r.id));
      return ranked.filter((r) => pmap.has(r.id))
        .map((r) => mapPlayer(pmap.get(r.id), `Perdeu R$ ${r.perda.toFixed(2)} hoje`));
    }
    case "novos_cadastros_7d": {
      const sinceIso = periodIso ?? iso7d;
      const { data, error } = await applyAudPlayers(
        sb.from("players").select(PLAYER_COLS).gte("created_at", sinceIso)
      ).order("created_at", { ascending: false }).limit(limit);
      if (error) throw new Error(`players: ${error.message}`);
      return (data ?? []).map((p: any) => mapPlayer(p, "Cadastrado nos últimos 7 dias"));
    }
    case "virando_vip": {
      const { data, error } = await applyAudPlayers(
        sb.from("players").select(PLAYER_COLS)
          .eq("vip", false).gte("total_depositado", 800).lt("total_depositado", 1000)
      ).order("total_depositado", { ascending: false }).limit(limit);
      if (error) throw new Error(`players: ${error.message}`);
      return (data ?? []).map((p: any) => mapPlayer(p, "Próximo de virar VIP"));
    }
    case "vip_inativo": {
      const iso2d = inactIso ?? new Date(Date.now() - 2 * 86400000).toISOString();
      const { data, error } = await applyAudPlayers(
        sb.from("players").select(PLAYER_COLS)
          .eq("vip", true).lt("ultimo_jogo", iso2d)
      ).order("total_depositado", { ascending: false }).limit(limit);
      if (error) throw new Error(`players: ${error.message}`);
      return (data ?? []).map((p: any) => mapPlayer(p, `VIP inativo`));
    }
    case "lead_quente": {
      const iso3d = new Date(Date.now() - 3 * 86400000).toISOString();
      const { data, error } = await applyAudPlayers(
        sb.from("players").select(PLAYER_COLS)
          .gte("ultimo_login", iso3d).gt("total_depositado", 0).lt("total_depositado", 1000)
      ).order("ultimo_deposito", { ascending: false }).limit(limit);
      if (error) throw new Error(`players: ${error.message}`);
      return (data ?? []).map((p: any) => mapPlayer(p, "Lead quente"));
    }
    case "lead_frio": {
      const iso15d = new Date(Date.now() - 15 * 86400000).toISOString();
      const { data, error } = await applyAudPlayers(
        sb.from("players").select(PLAYER_COLS)
          .lt("ultimo_login", iso15d).lt("total_depositado", 150)
      ).order("created_at", { ascending: false }).limit(limit);
      if (error) throw new Error(`players: ${error.message}`);
      return (data ?? []).map((p: any) => mapPlayer(p, "Lead frio"));
    }
    case "alto_potencial":
    case "melhores_players": {
      const iso3d = new Date(Date.now() - 3 * 86400000).toISOString();
      const { data, error } = await applyAudPlayers(
        sb.from("players").select(PLAYER_COLS)
          .gte("ultimo_login", iso3d).gt("total_depositado", 100)
      ).order("total_depositado", { ascending: false }).limit(limit);
      if (error) throw new Error(`players: ${error.message}`);
      const label = intent === "alto_potencial" ? "Alto potencial" : "Melhor player";
      return (data ?? []).map((p: any) => mapPlayer(p, label));
    }
    case "cresceu_semana": {
      const iso7 = periodIso ?? new Date(Date.now() - 7 * 86400000).toISOString();
      let q2 = sb.from("deposits").select("player_id,valor,created_at")
        .gte("created_at", iso7).eq("status", "aprovado").limit(5000);
      q2 = applyAudByPlayerId(q2);
      const { data, error } = await q2;
      if (error) throw new Error(`deposits: ${error.message}`);
      const agg = new Map<string, number>();
      for (const d of data ?? []) {
        if (!d.player_id) continue;
        if (!inAud(d.player_id)) continue;
        agg.set(d.player_id, (agg.get(d.player_id) ?? 0) + Number(d.valor ?? 0));
      }
      const ids = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
      const pmap = await playersByIds(sb, ids);
      return ids.filter((id) => pmap.has(id)).map((id) =>
        mapPlayer(pmap.get(id), `Depositou ${(agg.get(id) ?? 0).toFixed(2)} nos últimos 7 dias`));
    }
    case "players_with_balance": {
      let q = sb.from("players").select(PLAYER_COLS).gt("saldo_carteira", 0);
      if (filters.vip) q = q.eq("vip", true);
      if (audIds) q = q.in("id", audIds);
      const { data, error } = await q
        .order("saldo_carteira", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`players: ${error.message}`);
      return (data ?? []).map((p: any) =>
        mapPlayer(p, `Saldo atual ${brl(Number(p.saldo_carteira ?? 0))}`));
    }
    default: {
      let q = sb.from("players").select(PLAYER_COLS);
      if (filters.vip) q = q.eq("vip", true);
      if (filters.never_deposited) q = q.is("ftd_em", null);
      if (filters.min_deposit) q = q.gte("total_depositado", filters.min_deposit);
      if (filters.max_deposit) q = q.lte("total_depositado", filters.max_deposit);
      if (inactIso) q = q.lt("ultimo_login", inactIso);
      if (audIds) q = q.in("id", audIds);
      const orderCol =
        sort === "last_login_desc" || sort === "last_login_asc" ? "ultimo_login"
        : sort === "created_desc" ? "created_at"
        : "total_depositado";
      const asc = sort === "deposit_amount_asc" || sort === "last_login_asc";
      const { data, error } = await q.order(orderCol, { ascending: asc }).limit(limit);
      if (error) throw new Error(`players: ${error.message}`);
      return (data ?? []).map((p: any) => mapPlayer(p, "Amostra de players"));
    }
  }
}

function brl(n: number) {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function buildFallback(question: string, players: any[], parsed?: ParsedQuery | null) {
  const aud = parsed?.audience?.matched_expert ?? parsed?.audience?.term ?? null;
  if (aud && players.length === 0) {
    return {
      summary: `Não encontrei players do ${aud} para "${question}".`,
      criterio: `Filtrado por expert/origem contendo "${aud}".`,
      players: [], insights: [], metrics: [],
    };
  }
  if (parsed?.intent === "players_with_balance") {
    const totalSaldo = players.reduce((s, p) => s + (Number(p.saldo_atual) || 0), 0);
    return {
      summary: players.length
        ? `Encontrei ${players.length} player(s) com saldo disponível na banca, totalizando ${brl(totalSaldo)}.`
        : `Nenhum player com saldo disponível na banca.`,
      criterio: "Players com saldo_carteira > 0, ordenados do maior saldo para o menor.",
      players,
      insights: players.length
        ? [{ titulo: "Saldo parado", descricao: `${brl(totalSaldo)} parados em ${players.length} contas.`, tipo: "info" }]
        : [],
      metrics: players.length ? [
        { label: "Players com saldo", valor: String(players.length), tipo: "neutro" },
        { label: "Saldo total na banca", valor: brl(totalSaldo), tipo: "positivo" },
      ] : [],
    };
  }
  const hasToday = players.some((p) => p.depositado_hoje != null || p.sacado_hoje != null);
  const depHoje = players.reduce((s, p) => s + (Number(p.depositado_hoje) || 0), 0);
  const saqHoje = players.reduce((s, p) => s + (Number(p.sacado_hoje) || 0), 0);
  const qtdDepHoje = players.reduce((s, p) => s + (Number(p.qtd_depositos_hoje) || 0), 0);
  const totalDep = players.reduce((s, p) => s + (Number(p.total_depositado) || 0), 0);
  const totalSaq = players.reduce((s, p) => s + (Number(p.total_sacado) || 0), 0);
  return {
    summary: players.length
      ? (hasToday && depHoje > 0
          ? `${players.length} player(s)${aud ? ` do ${aud}` : ""} depositaram hoje, totalizando ${brl(depHoje)} em ${qtdDepHoje} depósito(s).`
          : hasToday && saqHoje > 0
            ? `${players.length} player(s)${aud ? ` do ${aud}` : ""} sacaram hoje, totalizando ${brl(saqHoje)}.`
            : `Encontrei ${players.length} player(s)${aud ? ` do ${aud}` : ""} relacionado(s) a "${question}".`)
      : `Não encontrei players${aud ? ` do ${aud}` : ""} para "${question}".`,
    criterio: aud
      ? `Filtrado por expert/origem contendo "${aud}".`
      : "Consulta direta ao banco (fallback sem IA).",
    players,
    insights: players.length
      ? [{ titulo: "Resultado direto", descricao: "Resposta gerada sem IA porque o modelo não respondeu a tempo.", tipo: "info" }]
      : [],
    metrics: players.length ? (hasToday ? [
      { label: "Players", valor: String(players.length), tipo: "neutro" },
      { label: "Depositado hoje", valor: brl(depHoje), tipo: "positivo" },
      { label: "Depósitos hoje", valor: String(qtdDepHoje), tipo: "neutro" },
      { label: "Sacado hoje", valor: brl(saqHoje), tipo: "negativo" },
    ] : [
      { label: "Players", valor: String(players.length), tipo: "neutro" },
      { label: "Total depositado", valor: brl(totalDep), tipo: "positivo" },
      { label: "Total sacado", valor: brl(totalSaq), tipo: "negativo" },
    ]) : [],
  };
}

function auditLog(question: string, intent: string, players: any[]) {
  const depHoje = players.reduce((s, p) => s + (Number(p.depositado_hoje) || 0), 0);
  const saqHoje = players.reduce((s, p) => s + (Number(p.sacado_hoje) || 0), 0);
  const totalDep = players.reduce((s, p) => s + (Number(p.total_depositado) || 0), 0);
  const totalSaldo = players.reduce((s, p) => s + (Number(p.saldo_atual) || 0), 0);
  console.log("[ai][audit]", JSON.stringify({
    pergunta: question, intent, registros: players.length,
    soma_depositado_hoje: depHoje, soma_sacado_hoje: saqHoje, soma_total_depositado: totalDep,
    soma_saldo_atual: totalSaldo,
    campo_saldo: intent === "players_with_balance" ? "saldo_carteira" : null,
    primeiros: players.slice(0, 5).map((p) => ({
      id: p.id, nome: p.nome,
      depositado_hoje: p.depositado_hoje, qtd_depositos_hoje: p.qtd_depositos_hoje,
      total_depositado: p.total_depositado, saldo_atual: p.saldo_atual,
    })),
  }));
}

// ===================== TRAINING PIPELINE =====================

function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(norm(s).split(" ").filter((t) => t.length > 2));
}

function jaccard(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

async function applySynonyms(sb: any, question: string): Promise<string> {
  try {
    const { data } = await sb.from("ai_synonyms").select("termo,canonico,tipo").eq("ativo", true);
    if (!data?.length) return question;
    let out = question;
    for (const s of data) {
      const term = String(s.termo || "");
      if (!term) continue;
      const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`, "gi");
      // Substitui só para matching interno (anexa o canônico entre colchetes)
      out = out.replace(re, (m) => `${m} [${s.canonico}]`);
    }
    return out;
  } catch (e) {
    console.warn("[ai][synonyms] erro:", e);
    return question;
  }
}

async function findTrainingMatches(sb: any, question: string) {
  try {
    const { data } = await sb.from("ai_training_examples")
      .select("id,pergunta,resposta_ideal,intent,filtros,fonte,tags")
      .eq("ativo", true).limit(200);
    if (!data?.length) return { override: null, similar: [] as any[] };
    // Reinforcement: exemplos vindos de correção manual (fonte='feedback' ou tag 'reforço')
    // ganham boost de similaridade e threshold de override reduzido — assim o agente
    // aprende rápido com 👎 + resposta ideal cadastrada pelo operador.
    const scored = data.map((ex: any) => {
      const base = jaccard(question, ex.pergunta);
      const reinforced = ex.fonte === "feedback" || (ex.tags || []).includes("reforco") || (ex.tags || []).includes("correcao");
      const boost = reinforced ? 0.15 : 0;
      const threshold = reinforced ? 0.70 : 0.85;
      return { ex, score: Math.min(1, base + boost), base, threshold, reinforced };
    }).sort((a: any, b: any) => b.score - a.score);
    const best = scored[0];
    const override = best && best.score >= best.threshold ? best.ex : null;
    const similar = scored.filter((s: any) => s.score >= 0.35 && s !== best).slice(0, 3).map((s: any) => s.ex);
    return { override, similar, top_score: best?.score ?? 0, top_base: best?.base ?? 0, reinforced: !!best?.reinforced };
  } catch (e) {
    console.warn("[ai][training] erro:", e);
    return { override: null, similar: [] as any[] };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey =
    Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Require authenticated admin user. The function uses the service role key,
  // so we must validate the caller's JWT and role here to avoid exposing all
  // player data publicly.
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: userData, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: isAdmin, error: roleErr } = await sb.rpc("has_role", {
      _user_id: userData.user.id,
      _role: "admin",
    });
    if (roleErr || !isAdmin) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } catch (e) {
    console.error("[auth] erro", e);
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let question = "";
  try {
    const body = await req.json();
    question = String(body?.question ?? body?.pergunta ?? "").trim();
  } catch (e) {
    console.error("[body] invalid JSON", e);
    return new Response(JSON.stringify({ error: "JSON inválido" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!question) {
    return new Response(JSON.stringify({ error: "Pergunta vazia" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  console.log("[ai] pergunta:", question);

  // 0) normalização via sinônimos + busca de exemplos de treino
  const questionNorm = await applySynonyms(sb, question);
  if (questionNorm !== question) console.log("[ai] sinonimos aplicados:", questionNorm);
  const training = await findTrainingMatches(sb, questionNorm);
  if (training.override) {
    console.log("[ai][override] exemplo match >=0.85:", training.override.id);
  }

  // 1) busca dados
  let players: any[] = [];
  let intent: Intent = "generico";
  let parsed: ParsedQuery | null = null;
  try {
    const baseParsed = parseQuery(question);
    const audience = await resolveAudience(sb, question);
    parsed = { ...baseParsed, audience: audience ?? null };
    intent = parsed.intent;
    console.log("[ai] parsed:", JSON.stringify(parsed));
    players = await fetchByIntent(sb, parsed);
    console.log(`[ai] players encontrados: ${players.length}`);
    players = await enrichPlayers(sb, players);
    console.log("[ai] players enriquecidos com classificação/score/alertas");
    auditLog(question, intent, players);
    // pós-ordenação por score quando solicitado
    if (parsed.sort === "score_desc") {
      players = [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, parsed.limit);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ai] erro supabase:", msg);
    await sb.from("ai_logs").insert({ pergunta: question, resposta: msg, modelo: "n/a", status: "error" });
    return new Response(JSON.stringify({
      answer: { summary: "Não consegui consultar os dados agora. Tente novamente em instantes.",
                criterio: "", players: [], insights: [], metrics: [] },
      intent, warning: msg,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // 1.5) OVERRIDE determinístico: se existe exemplo quase idêntico, use a resposta_ideal
  if (training.override) {
    const ov = training.override;
    const fb = buildFallback(question, players, parsed);
    const answer = {
      summary: ov.resposta_ideal || fb.summary,
      criterio: fb.criterio || "Resposta a partir de exemplo treinado",
      players,
      insights: fb.insights,
      metrics: fb.metrics,
    };
    const ins = await sb.from("ai_logs").insert({
      pergunta: question, resposta: JSON.stringify(answer).slice(0, 4000),
      modelo: "override", status: "success",
      intent_detectada: intent, origem_resposta: "override",
      audit: { exemplo_id: ov.id, registros: players.length },
    }).select("id").single();
    return new Response(JSON.stringify({
      answer, intent, parsed, origem: "override",
      ai_log_id: ins?.data?.id ?? null,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // 2) sem chave OpenAI -> fallback direto
  if (!openaiKey) {
    console.warn("[ai] OPENAI_API_KEY ausente, retornando fallback");
    const answer = buildFallback(question, players, parsed);
    const ins = await sb.from("ai_logs").insert({
      pergunta: question, resposta: JSON.stringify(answer).slice(0, 4000),
      modelo: "fallback", status: "success",
      intent_detectada: intent, origem_resposta: "intent",
    }).select("id").single();
    return new Response(JSON.stringify({ answer, intent, fallback: true, ai_log_id: ins?.data?.id ?? null }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 3) chama OpenAI com timeout curto
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35000);

  try {
    const depHoje = players.reduce((s, p) => s + (Number(p.depositado_hoje) || 0), 0);
    const saqHoje = players.reduce((s, p) => s + (Number(p.sacado_hoje) || 0), 0);
    const qtdDepHoje = players.reduce((s, p) => s + (Number(p.qtd_depositos_hoje) || 0), 0);
    const totalDep = players.reduce((s, p) => s + (Number(p.total_depositado) || 0), 0);
    const totalSaq = players.reduce((s, p) => s + (Number(p.total_sacado) || 0), 0);
    const context = {
      intent,
      parsed,
      hoje: new Date().toISOString(),
      timezone: "America/Sao_Paulo",
      total_players: players.length,
      hoje_totais: { depositado: depHoje, sacado: saqHoje, qtd_depositos: qtdDepHoje },
      historico_totais: { depositado: totalDep, sacado: totalSaq, lucro: totalDep - totalSaq },
      players,
    };

    // few-shot dinâmico a partir dos exemplos de treino similares
    const fewShot: Array<{ role: string; content: string }> = [];
    for (const ex of training.similar) {
      fewShot.push({ role: "user", content: `Exemplo de pergunta: ${ex.pergunta}` });
      fewShot.push({ role: "assistant", content: JSON.stringify({
        summary: ex.resposta_ideal, criterio: "exemplo treinado", players: [], insights: [], metrics: [],
      }) });
    }
    if (fewShot.length) console.log(`[ai][few-shot] injetando ${fewShot.length / 2} exemplos`);

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...fewShot,
          { role: "user", content: `Pergunta: ${question}\n\nDados pré-filtrados (use-os exatamente):\n${JSON.stringify(context)}` },
        ],
      }),
    });

    clearTimeout(timer);

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error("[ai] OpenAI status", openaiRes.status, errText.slice(0, 500));
      const answer = buildFallback(question, players, parsed);
      await sb.from("ai_logs").insert({
        pergunta: question, resposta: `OpenAI ${openaiRes.status}: ${errText.slice(0, 1500)}`,
        modelo: "gpt-4o-mini", status: "error",
      });
      return new Response(JSON.stringify({ answer, intent, fallback: true,
        warning: `OpenAI ${openaiRes.status}` }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await openaiRes.json();
    const raw = data?.choices?.[0]?.message?.content ?? "{}";
    console.log("[ai] raw OpenAI len:", raw.length);

    let answer: any;
    try {
      answer = JSON.parse(raw);
    } catch (e) {
      console.error("[ai] JSON parse falhou:", e, "raw:", raw.slice(0, 500));
      answer = buildFallback(question, players, parsed);
      answer.summary = raw.slice(0, 400) || answer.summary;
    }

    // Sempre força os players reais do banco (não confiar em invenções da IA).
    answer.players = players;
    answer.summary = answer.summary || buildFallback(question, players, parsed).summary;
    answer.insights = Array.isArray(answer.insights) ? answer.insights : [];
    answer.metrics = Array.isArray(answer.metrics) ? answer.metrics : [];

    const ins = await sb.from("ai_logs").insert({
      pergunta: question, resposta: JSON.stringify(answer).slice(0, 4000),
      modelo: "gpt-4o-mini", status: "success",
      intent_detectada: intent, origem_resposta: "llm",
      audit: { few_shot: training.similar.length, top_score: training.top_score ?? 0 },
    }).select("id").single();

    return new Response(JSON.stringify({ answer, intent, parsed, ai_log_id: ins?.data?.id ?? null }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ai] exceção OpenAI:", msg);
    const answer = buildFallback(question, players, parsed);
    await sb.from("ai_logs").insert({
      pergunta: question, resposta: msg, modelo: "gpt-4o-mini", status: "error",
    });
    return new Response(JSON.stringify({ answer, intent, fallback: true, warning: msg }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
