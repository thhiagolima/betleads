import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertTenantCanOperate, resolveCurrentTenantId } from "@/lib/tenant-access.server";
import { smsAudienceCriteriaSchema } from "@/lib/sms-audience-criteria";

const audienceInput = z.object({ criteria: smsAudienceCriteriaSchema });

type PlayerRow = {
  id: string;
  telefone: string | null;
  email: string | null;
  total_depositado: number | null;
  total_sacado: number | null;
  ultimo_deposito: string | null;
  ftd_em: string | null;
  created_at: string;
  ultimo_login: string | null;
  last_cashback_paid_at: string | null;
};

const DEFAULT_THRESHOLDS = { bronze: 10, silver: 200, gold: 500, diamond: 1000, black: 3000 };
const DATABASE_PAGE_SIZE = 1000;

export const resolveSmsCampaignAudience = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => audienceInput.parse(input))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as any;
    // Super admin pode montar públicos sobre toda a base; usuários comuns ficam
    // estritamente limitados ao tenant atual.
    const tenantId = await resolveCurrentTenantId(supabase);
    await assertTenantCanOperate(tenantId);
    const scope = (query: any) => query.eq("tenant_id", tenantId);

    // O PostgREST respeita o limite max_rows do projeto (normalmente 1.000), mesmo
    // quando um range maior e solicitado. Publicos precisam percorrer todas as
    // paginas para nao calcular apenas uma amostra da base.
    const fetchAll = async (
      table: string,
      columns: string,
      configure?: (query: any) => any,
    ): Promise<any[]> => {
      const result: any[] = [];
      let lastId: string | null = null;
      for (;;) {
        let query = scope(supabase.from(table).select(columns));
        if (configure) query = configure(query);
        if (lastId) query = query.gt("id", lastId);
        const { data: page, error } = await query
          .order("id", { ascending: true })
          .limit(DATABASE_PAGE_SIZE);
        if (error) throw new Error(error.message);
        const pageRows = page ?? [];
        result.push(...pageRows);
        if (pageRows.length < DATABASE_PAGE_SIZE) break;
        lastId = String(pageRows[pageRows.length - 1].id);
      }
      return result;
    };

    const [{ data: settingsRow, error: settingsError }, rows, pendingPixRows, approvedWithdrawalRows, pendingWithdrawalRows] = await Promise.all([
      scope(supabase
        .from("gamification_settings")
        .select("level_thresholds,cooling_after_days,sleeping_after_days")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()),
      fetchAll(
        "players",
        "id,telefone,email,total_depositado,total_sacado,ultimo_deposito,ftd_em,created_at,ultimo_login,last_cashback_paid_at",
      ),
      fetchAll("deposits", "id,player_id,metodo,status", (query) => query.eq("status", "pendente")),
      fetchAll("withdrawals", "id,player_id", (query) => query.eq("status", "aprovado")),
      fetchAll("withdrawals", "id,player_id", (query) => query.eq("status", "pendente")),
    ]);
    // Instalações antigas podem ainda não ter a tabela; os mesmos padrões da Gamificação são usados.
    if (settingsError && !String(settingsError.message ?? "").includes("gamification_settings")) {
      throw new Error(settingsError.message);
    }

    const thresholds = { ...DEFAULT_THRESHOLDS, ...(settingsRow?.level_thresholds ?? {}) } as Record<string, number>;
    const cooling = Number(settingsRow?.cooling_after_days ?? 2);
    const sleeping = Number(settingsRow?.sleeping_after_days ?? 7);
    const criteria = data.criteria;
    const pendingPixPlayers = new Set<string>(
      (pendingPixRows as Array<{ player_id: string | null; metodo: string | null }>)
        .filter((row) => !row.metodo || String(row.metodo).toLowerCase().includes("pix"))
        .map((row) => row.player_id)
        .filter((id): id is string => !!id),
    );
    const withdrawnPlayers = new Set<string>(approvedWithdrawalRows.map((row: { player_id: string | null }) => row.player_id).filter((id: string | null): id is string => !!id));
    const pendingWithdrawalPlayers = new Set<string>(pendingWithdrawalRows.map((row: { player_id: string | null }) => row.player_id).filter((id: string | null): id is string => !!id));
    const now = Date.now();
    const startOfWeek = new Date();
    startOfWeek.setHours(0, 0, 0, 0);
    startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));

    const matchesLevel = (total: number, candidate: typeof criteria) => {
      if (!candidate.level) return true;
      const order = ["bronze", "silver", "gold", "diamond", "black"];
      const index = order.indexOf(candidate.level);
      const min = Number(thresholds[candidate.level] ?? 0);
      const next = order[index + 1];
      return total >= min && (!next || total < Number(thresholds[next] ?? Number.POSITIVE_INFINITY));
    };
    const daysSince = (value: string | null | undefined) =>
      value ? Math.max(0, Math.floor((now - new Date(value).getTime()) / 86400000)) : null;

    const playerRows = (rows ?? []) as PlayerRow[];
    const matchesCriteria = (player: PlayerRow, candidate: typeof criteria) => {
      const deposited = Number(player.total_depositado ?? 0);
      const withdrew = Number(player.total_sacado ?? 0);
      // Públicos, Gamificação e Jogadores compartilham a mesma definição:
      // o resumo consolidado do player (total/FTD) determina se ele já depositou.
      // Eventos financeiros pendentes continuam sendo lidos diretamente das tabelas.
      const hasDeposit = deposited > 0 || !!player.ftd_em;
      if (candidate.activity.deposit === "never" && hasDeposit) return false;
      if (candidate.activity.deposit === "yes" && !hasDeposit) return false;
      const hasWithdrawal = withdrew > 0 || withdrawnPlayers.has(player.id);
      if (candidate.activity.withdrawal === "yes" && !hasWithdrawal) return false;
      if (candidate.activity.withdrawal === "never" && hasWithdrawal) return false;
      if (candidate.activity.withdrawalPending && !pendingWithdrawalPlayers.has(player.id)) return false;
      if (candidate.activity.pixUnpaid && !pendingPixPlayers.has(player.id)) return false;
      if (candidate.activity.cashback && !player.last_cashback_paid_at) return false;
      if (!matchesLevel(deposited, candidate)) return false;

      const days = daysSince(player.ultimo_deposito ?? player.ftd_em ?? player.created_at);
      if (candidate.timing === "registered_week" && new Date(player.created_at) < startOfWeek) return false;
      if (candidate.timing === "cooling" && !(days != null && days >= cooling && days < sleeping)) return false;
      if (candidate.timing === "sleeping" && !(days != null && days >= sleeping)) return false;
      if (candidate.timing === "inactive30" && !(days != null && days >= 30)) return false;
      if (candidate.timing === "inactive90" && !(days != null && days >= 90)) return false;
      if (candidate.timing === "custom" && !(days != null && days >= candidate.customDays)) return false;
      const loginDays = daysSince(player.ultimo_login ?? player.created_at);
      if (candidate.daysWithoutLogin && !(loginDays != null && loginDays >= candidate.daysWithoutLogin)) return false;
      const registrationDays = daysSince(player.created_at);
      if (candidate.daysSinceRegistration && !(registrationDays != null && registrationDays >= candidate.daysSinceRegistration)) return false;
      return true;
    };

    const playersFor = (candidate: typeof criteria) =>
      playerRows.filter((player) => matchesCriteria(player, candidate));
    const phonesFor = (candidate: typeof criteria) =>
      Array.from(
        new Set(
          playersFor(candidate)
            .map((player) => String(player.telefone ?? "").replace(/\D/g, ""))
            .filter((phone) => phone.length >= 10),
        ),
      );
    // Quantitativos da interface representam jogadores. Telefones validos sao uma
    // metrica separada, usada apenas como lista efetiva de destinatarios do SMS.
    const countFor = (candidate: typeof criteria) => playersFor(candidate).length;
    const withActivity = (activity: typeof criteria.activity) => ({ ...criteria, activity });
    const withLevel = (level: typeof criteria.level) => ({ ...criteria, level });
    const withTiming = (timing: typeof criteria.timing) => ({ ...criteria, timing });
    const matchedPlayers = playersFor(criteria);
    const phones = Array.from(
      new Set(
        matchedPlayers
          .map((player) => String(player.telefone ?? "").replace(/\D/g, ""))
          .filter((phone) => phone.length >= 10),
      ),
    );
    const emailPlayerIds = matchedPlayers
      .filter((player) => Boolean(String(player.email ?? "").trim()))
      .map((player) => player.id);

    const facets = {
      activity: {
        depositNever: countFor({
          ...criteria,
          activity: { ...criteria.activity, deposit: "never" },
          level: null,
          timing: "any",
        }),
        depositYes: countFor(withActivity({ ...criteria.activity, deposit: "yes" })),
        pixUnpaid: countFor(withActivity({ ...criteria.activity, pixUnpaid: true })),
        withdrawalYes: countFor(withActivity({ ...criteria.activity, withdrawal: "yes" })),
        withdrawalNever: countFor(withActivity({ ...criteria.activity, withdrawal: "never" })),
        withdrawalPending: countFor(withActivity({ ...criteria.activity, withdrawalPending: true })),
        cashback: countFor(withActivity({ ...criteria.activity, cashback: true })),
      },
      levels: Object.fromEntries(
        (["bronze", "silver", "gold", "diamond", "black"] as const).map((level) => [
          level,
          countFor(withLevel(level)),
        ]),
      ),
      timings: Object.fromEntries(
        (["cooling", "sleeping", "inactive30", "inactive90"] as const).map((timing) => [
          timing,
          countFor(withTiming(timing)),
        ]),
      ),
    };

    return {
      phones,
      total: matchedPlayers.length,
      recipientTotal: phones.length,
      emailPlayerIds,
      emailRecipientTotal: emailPlayerIds.length,
      facets,
      settings: { thresholds, cooling, sleeping },
    };
  });
