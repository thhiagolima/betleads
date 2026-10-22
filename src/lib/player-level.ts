// Regra única de nível do jogador. A lista de Jogadores, a ficha e o cálculo de
// gamificação usam esta função com as faixas configuradas em
// gamification_settings (mesma regra do RPC gamification_snapshot_v2).
// O nível depende só do total depositado; a flag `vip` não promove a Black VIP.

export type LevelSlug = "novice" | "bronze" | "silver" | "gold" | "diamond" | "black";
export type PaidLevelSlug = Exclude<LevelSlug, "novice">;
export type LevelThresholds = Record<PaidLevelSlug, number>;

export const DEFAULT_LEVEL_THRESHOLDS: LevelThresholds = {
  bronze: 10,
  silver: 200,
  gold: 500,
  diamond: 1000,
  black: 3000,
};

export const LEVEL_LABEL: Record<LevelSlug, string> = {
  novice: "Novato",
  bronze: "Bronze",
  silver: "Prata",
  gold: "Ouro",
  diamond: "Diamante",
  black: "Black VIP",
};

export function levelForTotal(
  total: number | null | undefined,
  thresholds: LevelThresholds = DEFAULT_LEVEL_THRESHOLDS,
): LevelSlug {
  const value = Number(total ?? 0);
  const amount = Number.isFinite(value) ? value : 0;
  if (amount >= thresholds.black) return "black";
  if (amount >= thresholds.diamond) return "diamond";
  if (amount >= thresholds.gold) return "gold";
  if (amount >= thresholds.silver) return "silver";
  if (amount >= thresholds.bronze) return "bronze";
  return "novice";
}

/** Lê `gamification_settings.level_thresholds` (jsonb) com os padrões do RPC. */
export function thresholdsFromSettingsRow(raw: unknown): LevelThresholds {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (key: PaidLevelSlug) => {
    const n = Number(value[key]);
    return value[key] != null && Number.isFinite(n) ? n : DEFAULT_LEVEL_THRESHOLDS[key];
  };
  return {
    bronze: pick("bronze"),
    silver: pick("silver"),
    gold: pick("gold"),
    diamond: pick("diamond"),
    black: pick("black"),
  };
}
