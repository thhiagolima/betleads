// Variáveis de modelo que a Área do Expert sabe preencher de verdade
// (client-safe, sem I/O). Lista única usada por `renderExpertMessage`
// (`expert-templates.functions.ts`) e pela ajuda "Variáveis disponíveis" de
// `/expert/modelos`.
//
// `renderExpertMessage` monta as variáveis com `buildPlayerVariables`
// (`template-vars.server.ts`) a partir do que `VisibleLead` carrega — nome,
// telefone, depósitos, saques, vip/risco e cashback — mais o nome do expert.
// As demais chaves que `buildPlayerVariables` devolve só teriam o valor
// padrão inventado ("R$ 0,00", "ativo", "há algum tempo", e-mail vazio…),
// então elas ficam literais no texto e o envio é bloqueado até o expert
// editar o modelo. `{link}` é tratado à parte (link rastreado gerado na
// ficha).

/** Chaves de `buildPlayerVariables` preenchidas com dado real do lead/expert. */
export const EXPERT_SUPPORTED_VARIABLE_KEYS = [
  "primeiro_nome",
  "nome",
  "telefone",
  "ultimo_deposito",
  "dias_sem_depositar",
  "total_depositado",
  "total_sacado",
  "lucro",
  "categoria",
  "cashback_valor",
  "cashback_amount",
  "cashback_pago_em",
  "expert",
  "nome_expert",
  "link_login",
  "link_deposito",
] as const;

/** Chaves de `buildPlayerVariables` que o caminho do expert não consegue
 * preencher com a verdade (só sairiam com o valor padrão). */
export const EXPERT_UNSUPPORTED_VARIABLE_KEYS = [
  "email",
  "saldo",
  "saldo_atual",
  "ultimo_login",
  "dias_sem_login",
  "ultimo_jogo",
  "dias_sem_jogar",
  "status_lead",
  "id_push",
  "platform_user_id",
] as const;

/** Links da casa (não rastreados para o expert). Só são reais quando a casa
 * tem URL do site configurada; sem ela `buildPlayerVariables` cairia num
 * endereço genérico. */
export const EXPERT_HOUSE_LINK_VARIABLE_KEYS = ["link_login", "link_deposito"] as const;

const SUPPORTED = new Set<string>(EXPERT_SUPPORTED_VARIABLE_KEYS);
const HOUSE_LINKS = new Set<string>(EXPERT_HOUSE_LINK_VARIABLE_KEYS);

export function isExpertSupportedVariable(key: string, options?: { houseHasSite?: boolean }) {
  const houseHasSite = options?.houseHasSite ?? true;
  if (key === "link") return true; // link rastreado, validado à parte
  if (HOUSE_LINKS.has(key)) return houseHasSite;
  if (SUPPORTED.has(key)) return true;
  // Um `{link_*}` desconhecido cai na URL do site da casa (renderTemplate).
  return houseHasSite && key.startsWith("link_");
}

/** Tokens `{chave}` do texto que o expert não pode preencher, na ordem em que
 * aparecem e sem repetição. Inclui variáveis desconhecidas, que também
 * ficariam literais na mensagem. */
export function unsupportedExpertVariables(
  conteudo: string,
  options?: { houseHasSite?: boolean },
): string[] {
  const found: string[] = [];
  for (const match of conteudo.matchAll(/\{(\w+)\}/g)) {
    const token = match[0];
    if (!isExpertSupportedVariable(match[1], options) && !found.includes(token)) {
      found.push(token);
    }
  }
  return found;
}

export function unsupportedVariablesMessage(tokens: string[]): string {
  return `Este modelo usa variáveis que o expert não pode preencher: ${tokens.join(", ")}. Edite o texto.`;
}
