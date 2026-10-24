import { z } from "zod";

/** Teto de jogadores num público de seleção (mesmo teto da exportação de Jogadores). */
export const MAX_SELECTION_PLAYER_IDS = 50_000;

export const smsAudienceCriteriaSchema = z.object({
  activity: z
    .object({
      deposit: z.enum(["any", "never", "yes"]).default("any"),
      pixUnpaid: z.boolean().default(false),
      cashback: z.boolean().default(false),
      withdrawal: z.enum(["any", "yes", "never"]).default("any"),
      withdrawalPending: z.boolean().default(false),
    })
    .default({
      deposit: "any",
      pixUnpaid: false,
      cashback: false,
      withdrawal: "any",
      withdrawalPending: false,
    }),
  level: z.enum(["bronze", "silver", "gold", "diamond", "black"]).nullable().default(null),
  timing: z
    .enum([
      "any",
      "cooling",
      "sleeping",
      "inactive30",
      "inactive90",
      "custom",
      "registered_week",
      // Marcador de público de seleção. O schema anterior a este campo não
      // conhece o valor e lança erro: código antigo falha fechado em vez de
      // tratar a seleção como "todos os jogadores".
      "selection",
    ])
    .default("any"),
  customDays: z.number().int().min(1).max(3650).default(2),
  daysWithoutLogin: z.number().int().min(1).max(3650).nullable().default(null),
  daysSinceRegistration: z.number().int().min(1).max(3650).nullable().default(null),
  /**
   * Público de seleção, forma gravada em `sms_audiences`: exatamente estes
   * jogadores (sempre restritos à casa). Exige `timing: "selection"` e
   * nenhuma regra.
   */
  playerIds: z.array(z.string().uuid()).max(MAX_SELECTION_PLAYER_IDS).optional(),
  /**
   * Público de seleção, forma de referência (lista, compositor, rascunho,
   * campanha agendada): o servidor carrega a lista do público pelo id + casa.
   */
  audienceId: z.string().uuid().optional(),
  /** Quantos jogadores a seleção tem (só exibição; a lista fica no servidor). */
  selectionCount: z.number().int().min(0).max(MAX_SELECTION_PLAYER_IDS).optional(),
});

/**
 * Critério de público que chega do navegador para campanha ou rascunho: a
 * seleção só vale pela forma de referência (`audienceId`); a lista de
 * jogadores (`playerIds`) é recusada.
 */
export const campaignAudienceCriteriaInput = z
  .record(z.string(), z.unknown())
  .refine((criteria) => !("playerIds" in criteria), {
    message: "Envie o público de seleção pelo id, não pela lista de jogadores.",
  });

export type SmsAudienceCriteria = z.infer<typeof smsAudienceCriteriaSchema>;

export const EMPTY_SMS_AUDIENCE: SmsAudienceCriteria = {
  activity: {
    deposit: "any",
    pixUnpaid: false,
    cashback: false,
    withdrawal: "any",
    withdrawalPending: false,
  },
  level: null,
  timing: "any",
  customDays: 2,
  daysWithoutLogin: null,
  daysSinceRegistration: null,
};

export const SYSTEM_SMS_AUDIENCES: Array<{
  id: string;
  name: string;
  description: string;
  criteria: SmsAudienceCriteria;
}> = [
  {
    id: "system:all-leads",
    name: "Todos os jogadores",
    description: "Todos os jogadores cadastrados na casa.",
    criteria: EMPTY_SMS_AUDIENCE,
  },
  {
    id: "system:level:bronze",
    name: "Bronze",
    description: "Jogadores classificados no nível Bronze.",
    criteria: { ...EMPTY_SMS_AUDIENCE, level: "bronze" },
  },
  {
    id: "system:level:silver",
    name: "Prata",
    description: "Jogadores classificados no nível Prata.",
    criteria: { ...EMPTY_SMS_AUDIENCE, level: "silver" },
  },
  {
    id: "system:level:gold",
    name: "Ouro",
    description: "Jogadores classificados no nível Ouro.",
    criteria: { ...EMPTY_SMS_AUDIENCE, level: "gold" },
  },
  {
    id: "system:level:diamond",
    name: "Diamante",
    description: "Jogadores classificados no nível Diamante.",
    criteria: { ...EMPTY_SMS_AUDIENCE, level: "diamond" },
  },
  {
    id: "system:level:black",
    name: "Black VIP",
    description: "Jogadores classificados no nível Black VIP.",
    criteria: { ...EMPTY_SMS_AUDIENCE, level: "black" },
  },
];

export function normalizeSmsAudienceCriteria(value: unknown): SmsAudienceCriteria {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const legacyDays = Number(raw.daysWithoutDeposit ?? 0);
  const timing =
    raw.timing ??
    (legacyDays === 2
      ? "cooling"
      : legacyDays === 7
        ? "sleeping"
        : legacyDays === 30
          ? "inactive30"
          : legacyDays === 90
            ? "inactive90"
            : legacyDays > 0
              ? "custom"
              : "any");
  if (timing === "selection" || "playerIds" in raw || raw.audienceId !== undefined)
    return normalizeSelectionCriteria(raw);
  const criteria = smsAudienceCriteriaSchema.parse({
    ...raw,
    activity: raw.activity ?? { ...EMPTY_SMS_AUDIENCE.activity, deposit: raw.deposit ?? "any" },
    level: raw.level === "any" ? null : raw.level,
    timing,
    customDays: timing === "custom" ? legacyDays || raw.customDays || 2 : raw.customDays || 2,
    daysWithoutLogin: raw.daysWithoutLogin || null,
    daysSinceRegistration: raw.daysSinceRegistration || null,
  });

  // Quem nunca depositou não possui nível pago nem tempo sem depósito.
  // A normalização protege públicos antigos, campanhas e chamadas diretas da API.
  if (criteria.activity.deposit === "never") {
    return { ...criteria, level: null, timing: "any" };
  }
  return criteria;
}

const SELECTION_ERROR = "Público de seleção inválido.";

/**
 * Seleção: `timing: "selection"` com `playerIds` (lista) ou `audienceId`
 * (referência). Qualquer forma ambígua lança erro; nunca vira "todos".
 */
function normalizeSelectionCriteria(raw: Record<string, unknown>): SmsAudienceCriteria {
  const hasList = "playerIds" in raw;
  if (hasList && !Array.isArray(raw.playerIds))
    throw new Error(`${SELECTION_ERROR} A lista de jogadores não é uma lista.`);
  if (raw.timing !== undefined && raw.timing !== "selection")
    throw new Error(`${SELECTION_ERROR} Seleção não combina com regras de tempo.`);
  const playerIds = hasList
    ? Array.from(new Set((raw.playerIds as unknown[]).map((id) => String(id).toLowerCase())))
    : undefined;
  if (!playerIds && typeof raw.audienceId !== "string")
    throw new Error(`${SELECTION_ERROR} Falta a lista de jogadores.`);
  const criteria = smsAudienceCriteriaSchema.parse({
    ...raw,
    ...(playerIds ? { playerIds } : {}),
    timing: "selection",
  });
  if (!hasNoAudienceRules(criteria))
    throw new Error(`${SELECTION_ERROR} Um público de seleção não aceita regras.`);
  return criteria;
}

/** Público de seleção (lista de jogadores) em vez de público por regras. */
export function isSelectionAudience(criteria: Pick<SmsAudienceCriteria, "timing">) {
  return criteria.timing === "selection";
}

/** Quantos jogadores a seleção tem, na forma gravada ou de referência. */
export function selectionCountOf(criteria: SmsAudienceCriteria) {
  return criteria.playerIds?.length ?? criteria.selectionCount ?? 0;
}

/**
 * Forma de referência enviada ao navegador: sem a lista, com o id do público
 * e a contagem. O servidor recarrega a lista pelo id + casa.
 */
export function toSelectionReference(
  criteria: SmsAudienceCriteria,
  audienceId: string,
): SmsAudienceCriteria {
  return {
    ...EMPTY_SMS_AUDIENCE,
    timing: "selection",
    audienceId,
    selectionCount: selectionCountOf(criteria),
  };
}

/** As regras (tudo exceto a seleção) não restringem ninguém. */
export function hasNoAudienceRules(criteria: SmsAudienceCriteria) {
  const { activity } = criteria;
  return (
    activity.deposit === "any" &&
    !activity.pixUnpaid &&
    !activity.cashback &&
    activity.withdrawal === "any" &&
    !activity.withdrawalPending &&
    criteria.level === null &&
    (criteria.timing === "any" || criteria.timing === "selection") &&
    criteria.daysWithoutLogin === null &&
    criteria.daysSinceRegistration === null
  );
}

/** "N jogadores escolhidos" de um público de seleção. */
export function selectionAudienceLabel(count: number) {
  return count === 1
    ? "1 jogador escolhido"
    : `${count.toLocaleString("pt-BR")} jogadores escolhidos`;
}

export function describeSmsAudience(criteria: SmsAudienceCriteria) {
  const parts: string[] = [];
  if (isSelectionAudience(criteria)) parts.push(selectionAudienceLabel(selectionCountOf(criteria)));
  if (criteria.activity.deposit === "yes") parts.push("já depositou");
  if (criteria.activity.deposit === "never") parts.push("nunca depositou");
  if (criteria.activity.pixUnpaid) parts.push("gerou PIX e não pagou");
  if (criteria.activity.cashback) parts.push("recebeu cashback");
  if (criteria.activity.withdrawal === "yes") parts.push("já sacou");
  if (criteria.activity.withdrawal === "never") parts.push("nunca sacou");
  if (criteria.activity.withdrawalPending) parts.push("saque pendente");
  if (criteria.level)
    parts.push(
      `nível ${{ bronze: "Bronze", silver: "Prata", gold: "Ouro", diamond: "Diamante", black: "Black VIP" }[criteria.level]}`,
    );
  const timing =
    criteria.timing === "cooling"
      ? "na faixa de esfriamento"
      : criteria.timing === "sleeping"
        ? "na faixa de dormência"
        : criteria.timing === "inactive30"
          ? "30+ dias sem depositar"
          : criteria.timing === "inactive90"
            ? "90+ dias sem depositar"
            : criteria.timing === "custom"
              ? `${criteria.customDays}+ dias sem depositar`
              : criteria.timing === "registered_week"
                ? "cadastrou nesta semana"
                : null;
  if (timing) parts.push(timing);
  if (criteria.daysWithoutLogin) parts.push(`${criteria.daysWithoutLogin}+ dias sem entrar`);
  if (criteria.daysSinceRegistration)
    parts.push(`${criteria.daysSinceRegistration}+ dias desde o cadastro`);
  return parts.length ? parts.join(" · ") : "Todos os jogadores com telefone válido";
}
