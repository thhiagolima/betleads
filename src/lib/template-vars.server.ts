// Renderiza variáveis {token} em mensagens de fluxo usando dados do player.
// Espelha a lógica de `components/ligacoes/shared.ts` no lado servidor.
import type { HouseLinks } from "@/lib/house-links.server";

export type PlayerVarsInput = {
  nome?: string | null;
  telefone?: string | null;
  saldo_carteira?: number | null;
  ultimo_login?: string | null;
  ultimo_jogo?: string | null;
  ultimo_deposito?: string | null;
  total_depositado?: number | null;
  total_sacado?: number | null;
  vip?: boolean | null;
  status?: string | null;
  expert?: string | null;
  risco?: string | null;
  player_external_id?: string | null;
  email?: string | null;
  last_cashback_paid_at?: string | null;
  last_cashback_amount?: number | null;
};

function brl(v: number | null | undefined) {
  if (v == null || Number.isNaN(Number(v))) return "R$ 0,00";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(v));
}

function firstName(full?: string | null) {
  if (!full) return "amigo";
  return full.trim().split(/\s+/)[0] ?? "amigo";
}

function daysSince(iso?: string | null) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function safe(v: string | number | null | undefined, fb: string) {
  if (v === null || v === undefined || v === "") return fb;
  return String(v);
}

/** `{link}`, `{link_login}` and `{link_deposito}`: house config only, no player data. */
export function houseLinkVariables(house?: HouseLinks | null): Record<string, string> {
  // Legacy defaults, unchanged for a house with no site URL.
  const siteUrl = house?.siteUrl ?? null;
  const quickLinks = house?.quickLinks ?? {};
  return {
    link: siteUrl ?? "https://betleads.app/depositar",
    link_login: quickLinks.login ?? siteUrl ?? "https://betleads.app",
    link_deposito: quickLinks.deposito ?? siteUrl ?? "https://betleads.app/depositar",
  };
}

export function buildPlayerVariables(
  p: PlayerVarsInput,
  house?: HouseLinks | null,
): Record<string, string> {
  const dl = daysSince(p.ultimo_login);
  const dj = daysSince(p.ultimo_jogo);
  const dd = daysSince(p.ultimo_deposito);
  const dep = Number(p.total_depositado ?? 0);
  const saq = Number(p.total_sacado ?? 0);
  const cashback = p.last_cashback_amount != null ? Number(p.last_cashback_amount) : null;
  const cashbackPaidAt = p.last_cashback_paid_at ? new Date(p.last_cashback_paid_at) : null;
  const links = houseLinkVariables(house);
  return {
    primeiro_nome: firstName(p.nome),
    nome: safe(p.nome, "amigo"),
    telefone: safe(p.telefone, ""),
    email: safe(p.email, ""),
    saldo: brl(p.saldo_carteira ?? 0),
    saldo_atual: brl(p.saldo_carteira ?? 0),
    ultimo_login: p.ultimo_login
      ? new Date(p.ultimo_login).toLocaleDateString("pt-BR")
      : "há algum tempo",
    dias_sem_login: dl == null ? "alguns dias" : String(dl),
    ultimo_jogo: p.ultimo_jogo
      ? new Date(p.ultimo_jogo).toLocaleDateString("pt-BR")
      : "há algum tempo",
    dias_sem_jogar: dj == null ? "alguns dias" : String(dj),
    ultimo_deposito: p.ultimo_deposito
      ? new Date(p.ultimo_deposito).toLocaleDateString("pt-BR")
      : "há algum tempo",
    dias_sem_depositar: dd == null ? "alguns dias" : String(dd),
    total_depositado: brl(dep),
    total_sacado: brl(saq),
    lucro: brl(dep - saq),
    categoria: p.vip ? "VIP" : safe(p.risco, "regular"),
    status_lead: safe(p.status, "ativo"),
    expert: safe(p.expert, "Equipe BETLEADS"),
    nome_expert: safe(p.expert, "Equipe BETLEADS"),
    ...links,
    cashback_amount: cashback != null ? cashback.toFixed(2).replace(".", ",") : "0,00",
    cashback_valor: brl(cashback ?? 0),
    cashback_pago_em: cashbackPaidAt
      ? cashbackPaidAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
      : "",
    id_push: safe(p.player_external_id, ""),
    platform_user_id: safe(p.player_external_id, ""),
  };
}

/** Substitui `{token}` em `content` pelos valores de `vars`. Tokens
 * desconhecidos são preservados (`{token_desconhecido}`) para evitar
 * mensagens com lacunas vazias enganosas — EXCETO um `{link_*}` desconhecido
 * quando `house.siteUrl` existe: cai para a URL do site da casa em vez de
 * vazar a chave literal (uma URL rápida apagada, por exemplo). Sem `house`
 * ou com `siteUrl: null`, o comportamento é idêntico ao legado.
 * `{{token}}` (chaves duplas, comum em modelos copiados de outras ferramentas)
 * é tratado como `{token}`: antes a chave externa sobrava no texto enviado
 * ("{JOAO DA SILVA}, saque pago!") e, no SMS, cada chave conta 2 caracteres. */
export function renderTemplate(
  content: string | null | undefined,
  vars: Record<string, string>,
  house?: HouseLinks | null,
): string {
  if (!content) return "";
  return content.replace(/\{\{(\w+)\}\}|\{(\w+)\}/g, (m, doubleKey?: string, singleKey?: string) => {
    const key = (doubleKey ?? singleKey)!;
    if (vars[key] != null) return vars[key];
    if (house?.siteUrl && key.startsWith("link_")) {
      const quickKey = key.slice("link_".length);
      return house.quickLinks[quickKey] ?? house.siteUrl;
    }
    return m;
  });
}
