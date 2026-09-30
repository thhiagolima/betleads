import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertTenantCanOperate, resolveCurrentTenantId } from "@/lib/tenant-access.server";

const activitySchema = z.object({
  deposit: z.enum(["any", "never", "yes"]).default("any"),
  pixUnpaid: z.boolean().default(false),
  withdrawal: z.enum(["any", "yes", "never"]).default("any"),
});

const criteriaSchema = z.object({
  activity: activitySchema.default({ deposit: "any", pixUnpaid: false, withdrawal: "any" }),
  level: z.enum(["bronze", "silver", "gold", "diamond", "black"]).nullable().default(null),
  timing: z.enum(["any", "cooling", "sleeping", "inactive30", "inactive90", "custom", "registered_week"]).default("any"),
  customDays: z.number().int().min(1).max(7).default(2),
});

const audienceInput = z.object({ criteria: criteriaSchema });

type PlayerRow = {
  id: string;
  telefone: string | null;
  total_depositado: number | null;
  total_sacado: number | null;
  ultimo_deposito: string | null;
  ftd_em: string | null;
  created_at: string;
};

const DEFAULT_THRESHOLDS = { bronze: 10, silver: 200, gold: 500, diamond: 1000, black: 3000 };

export const resolveSmsCampaignAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => audienceInput.parse(input))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as any;
    // Super admin pode montar públicos sobre toda a base; usuários comuns ficam
    // estritamente limitados ao tenant atual.
    const { data: superAdmin } = await supabase.rpc("is_super_admin");
    const tenantId = await resolveCurrentTenantId(supabase).catch(() => null);
    if (!superAdmin && !tenantId) throw new Error("Tenant atual não encontrado para o usuário.");
    if (tenantId) await assertTenantCanOperate(tenantId);
    const scope = (query: any) => (tenantId && !superAdmin ? query.eq("tenant_id", tenantId) : query);
    const [{ data: settingsRow, error: settingsError }, { data: rows, error: playersError }, pendingPixResult, approvedDepositsResult, approvedWithdrawalsResult] = await Promise.all([
      scope(supabase
        .from("gamification_settings")
        .select("level_thresholds,cooling_after_days,sleeping_after_days")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()),
      scope(supabase
        .from("players")
        .select("id,telefone,total_depositado,total_sacado,ultimo_deposito,ftd_em,created_at")
        .not("telefone", "is", null)
        .range(0, 49999)),
      scope(supabase
        .from("deposits")
        .select("player_id,metodo,status")
        .neq("status", "aprovado")
        .range(0, 49999)),
      scope(supabase
        .from("deposits")
        .select("player_id")
        .eq("status", "aprovado")
        .range(0, 49999)),
      scope(supabase
        .from("withdrawals")
        .select("player_id")
        .eq("status", "aprovado")
        .range(0, 49999)),
    ]);
    if (playersError) throw new Error(playersError.message);
    // Instalações antigas podem ainda não ter a tabela; os mesmos padrões da Gamificação são usados.
    if (settingsError && !String(settingsError.message ?? "").includes("gamification_settings")) {
      throw new Error(settingsError.message);
    }

    const thresholds = { ...DEFAULT_THRESHOLDS, ...(settingsRow?.level_thresholds ?? {}) } as Record<string, number>;
    const cooling = Number(settingsRow?.cooling_after_days ?? 2);
    const sleeping = Number(settingsRow?.sleeping_after_days ?? 7);
    const criteria = data.criteria;
    const pendingPixPlayers = new Set<string>(
      ((pendingPixResult.data ?? []) as Array<{ player_id: string | null; metodo: string | null }>)
        .filter((row) => !row.metodo || String(row.metodo).toLowerCase().includes("pix"))
        .map((row) => row.player_id)
        .filter((id): id is string => !!id),
    );
    const depositedPlayers = new Set<string>((approvedDepositsResult.data ?? []).map((row: { player_id: string | null }) => row.player_id).filter((id: string | null): id is string => !!id));
    const withdrawnPlayers = new Set<string>((approvedWithdrawalsResult.data ?? []).map((row: { player_id: string | null }) => row.player_id).filter((id: string | null): id is string => !!id));
    const now = Date.now();
    const startOfWeek = new Date();
    startOfWeek.setHours(0, 0, 0, 0);
    startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));

    const matchesLevel = (total: number) => {
      if (!criteria.level) return true;
      const order = ["bronze", "silver", "gold", "diamond", "black"];
      const index = order.indexOf(criteria.level);
      const min = Number(thresholds[criteria.level] ?? 0);
      const next = order[index + 1];
      return total >= min && (!next || total < Number(thresholds[next] ?? Number.POSITIVE_INFINITY));
    };
    const daysSince = (value: string | null | undefined) =>
      value ? Math.max(0, Math.floor((now - new Date(value).getTime()) / 86400000)) : null;

    const phones = Array.from(new Set(((rows ?? []) as PlayerRow[]).filter((player) => {
      const deposited = Number(player.total_depositado ?? 0);
      const withdrew = Number(player.total_sacado ?? 0);
      const hasDeposit = deposited > 0 || !!player.ftd_em || depositedPlayers.has(player.id);
      if (criteria.activity.deposit === "never" && hasDeposit) return false;
      if (criteria.activity.deposit === "yes" && !hasDeposit) return false;
      const hasWithdrawal = withdrew > 0 || withdrawnPlayers.has(player.id);
      if (criteria.activity.withdrawal === "yes" && !hasWithdrawal) return false;
      if (criteria.activity.withdrawal === "never" && hasWithdrawal) return false;
      if (criteria.activity.pixUnpaid && !pendingPixPlayers.has(player.id)) return false;
      if (!matchesLevel(deposited)) return false;

      const days = daysSince(player.ultimo_deposito ?? player.ftd_em ?? player.created_at);
      if (criteria.timing === "registered_week" && new Date(player.created_at) < startOfWeek) return false;
      if (criteria.timing === "cooling" && !(days != null && days >= cooling && days < sleeping)) return false;
      if (criteria.timing === "sleeping" && !(days != null && days >= sleeping)) return false;
      if (criteria.timing === "inactive30" && !(days != null && days >= 30)) return false;
      if (criteria.timing === "inactive90" && !(days != null && days >= 90)) return false;
      if (criteria.timing === "custom" && !(days != null && days >= criteria.customDays)) return false;
      return true;
    }).map((player) => String(player.telefone ?? "").replace(/\D/g, "")).filter((phone) => phone.length >= 10)));

    return { phones, total: phones.length, settings: { thresholds, cooling, sleeping } };
  });
