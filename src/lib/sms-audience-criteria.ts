import { z } from "zod";

export const smsAudienceCriteriaSchema = z.object({
  activity: z.object({
    deposit: z.enum(["any", "never", "yes"]).default("any"),
    pixUnpaid: z.boolean().default(false),
    cashback: z.boolean().default(false),
    withdrawal: z.enum(["any", "yes", "never"]).default("any"),
    withdrawalPending: z.boolean().default(false),
  }).default({ deposit: "any", pixUnpaid: false, cashback: false, withdrawal: "any", withdrawalPending: false }),
  level: z.enum(["bronze", "silver", "gold", "diamond", "black"]).nullable().default(null),
  timing: z.enum(["any", "cooling", "sleeping", "inactive30", "inactive90", "custom", "registered_week"]).default("any"),
  customDays: z.number().int().min(1).max(3650).default(2),
  daysWithoutLogin: z.number().int().min(1).max(3650).nullable().default(null),
  daysSinceRegistration: z.number().int().min(1).max(3650).nullable().default(null),
});

export type SmsAudienceCriteria = z.infer<typeof smsAudienceCriteriaSchema>;

export const EMPTY_SMS_AUDIENCE: SmsAudienceCriteria = {
  activity: { deposit: "any", pixUnpaid: false, cashback: false, withdrawal: "any", withdrawalPending: false },
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
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, any>;
  const legacyDays = Number(raw.daysWithoutDeposit ?? 0);
  const timing = raw.timing ?? (legacyDays === 2 ? "cooling" : legacyDays === 7 ? "sleeping" : legacyDays === 30 ? "inactive30" : legacyDays === 90 ? "inactive90" : legacyDays > 0 ? "custom" : "any");
  return smsAudienceCriteriaSchema.parse({
    ...raw,
    activity: raw.activity ?? { ...EMPTY_SMS_AUDIENCE.activity, deposit: raw.deposit ?? "any" },
    level: raw.level === "any" ? null : raw.level,
    timing,
    customDays: timing === "custom" ? legacyDays || raw.customDays || 2 : raw.customDays || 2,
    daysWithoutLogin: raw.daysWithoutLogin || null,
    daysSinceRegistration: raw.daysSinceRegistration || null,
  });
}

export function describeSmsAudience(criteria: SmsAudienceCriteria) {
  const parts: string[] = [];
  if (criteria.activity.deposit === "yes") parts.push("já depositou");
  if (criteria.activity.deposit === "never") parts.push("nunca depositou");
  if (criteria.activity.pixUnpaid) parts.push("gerou PIX e não pagou");
  if (criteria.activity.cashback) parts.push("recebeu cashback");
  if (criteria.activity.withdrawal === "yes") parts.push("já sacou");
  if (criteria.activity.withdrawal === "never") parts.push("nunca sacou");
  if (criteria.activity.withdrawalPending) parts.push("saque pendente");
  if (criteria.level) parts.push(`nível ${{ bronze: "Bronze", silver: "Prata", gold: "Ouro", diamond: "Diamante", black: "Black VIP" }[criteria.level]}`);
  const timing = criteria.timing === "cooling" ? "na faixa de esfriamento" : criteria.timing === "sleeping" ? "na faixa de dormência" : criteria.timing === "inactive30" ? "30+ dias sem depositar" : criteria.timing === "inactive90" ? "90+ dias sem depositar" : criteria.timing === "custom" ? `${criteria.customDays}+ dias sem depositar` : criteria.timing === "registered_week" ? "cadastrou nesta semana" : null;
  if (timing) parts.push(timing);
  if (criteria.daysWithoutLogin) parts.push(`${criteria.daysWithoutLogin}+ dias sem entrar`);
  if (criteria.daysSinceRegistration) parts.push(`${criteria.daysSinceRegistration}+ dias desde o cadastro`);
  return parts.length ? parts.join(" · ") : "Todos os jogadores com telefone válido";
}
