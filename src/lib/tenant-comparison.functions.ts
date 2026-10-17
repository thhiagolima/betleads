/* eslint-disable @typescript-eslint/no-explicit-any -- CRM result tables precede generated Supabase types. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { aggregateCrmResults, type CrmResultRow } from "./crm-results";
import { comparableTenantIds } from "./tenant-comparison";

const PAGE = 1000;
const db = supabaseAdmin as any;

/**
 * Houses this user may compare, decided on the server on every call: only
 * houses where the user is admin, and only when there are two or more.
 */
async function comparableTenants(userId: string) {
  const [{ data: superAdmin, error: superAdminError }, { data: roles, error: rolesError }] =
    await Promise.all([
      db.rpc("is_super_admin", { _user_id: userId }),
      db.from("user_roles").select("tenant_id,role").eq("user_id", userId),
    ]);
  if (superAdminError || rolesError) throw new Error("Não foi possível validar a permissão.");
  const { data: tenants, error } = await db.from("tenants").select("id,nome").order("nome");
  if (error) throw new Error("Não foi possível carregar as casas.");
  const allowed = new Set(
    comparableTenantIds(
      (roles ?? []) as Array<{ tenant_id: string | null; role: string }>,
      Boolean(superAdmin),
      ((tenants ?? []) as Array<{ id: string }>).map((tenant) => tenant.id),
    ),
  );
  return ((tenants ?? []) as Array<{ id: string; nome: string }>).filter((tenant) =>
    allowed.has(tenant.id),
  );
}

export const getComparisonAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenants = await comparableTenants(context.userId);
    return { allowed: tenants.length > 0, tenants: tenants.map((tenant) => tenant.nome) };
  });

function brtDate(offset = 0) {
  return new Date(Date.now() - offset * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "America/Sao_Paulo",
  });
}

export const getTenantComparison = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((value: unknown) =>
    z.object({ days: z.number().int().min(1).max(180).default(30) }).parse(value ?? {}),
  )
  .handler(async ({ data, context }) => {
    const tenants = await comparableTenants(context.userId);
    if (tenants.length === 0)
      throw new Error("Disponível apenas para administradores de duas ou mais casas.");
    const from = brtDate(data.days - 1);
    const fromInstant = new Date(`${from}T00:00:00-03:00`).toISOString();
    const closedCohortBefore = brtDate(14);

    const rows = await Promise.all(
      tenants.map(async (tenant) => {
        const results: CrmResultRow[] = [];
        for (let page = 0; page < 50; page += 1) {
          const { data: chunk, error } = await db
            .from("crm_results_daily")
            .select(
              "metric_date,source_type,source_key,source_id,step_position,player_state,sent,failed,cost,recipients,human_clicks,direct_conversions,direct_players,direct_revenue,influenced_players,influenced_deposits,influenced_revenue",
            )
            .eq("tenant_id", tenant.id)
            .gte("metric_date", from)
            .order("metric_date")
            .order("source_type")
            .order("source_key")
            .order("step_position")
            .order("player_state")
            .range(page * PAGE, page * PAGE + PAGE - 1);
          if (error) throw new Error("Não foi possível carregar os resultados das casas.");
          results.push(...((chunk ?? []) as CrmResultRow[]));
          if (!chunk || chunk.length < PAGE) break;
        }
        const [lifecycle, funnel, cohorts] = await Promise.all([
          db.rpc("crm_lifecycle_snapshot", { _tenant: tenant.id }),
          db.rpc("crm_acquisition_funnel", {
            _tenant: tenant.id,
            _from: fromInstant,
            _to: new Date().toISOString(),
          }),
          db.rpc("crm_retention_cohorts", { _tenant: tenant.id, _weeks: 8 }),
        ]);
        const totals = aggregateCrmResults(results).totals;
        const states = Object.fromEntries(
          ((lifecycle.data ?? []) as Array<{ state: string; players: number }>).map((row) => [
            row.state,
            Number(row.players),
          ]),
        );
        const total = ((funnel.data ?? []) as Array<Record<string, unknown>>).find(
          (row) => row.origin === "__total__",
        );
        // Latest weekly cohort whose 7-day window has closed for everyone.
        const cohort = ((cohorts.data ?? []) as Array<Record<string, unknown>>)
          .filter((row) => String(row.cohort_week) <= closedCohortBefore)
          .at(-1);
        return {
          tenant: tenant.nome,
          clicks: totals.humanClicks,
          clickRate: totals.clickRate,
          directPlayers: totals.directPlayers,
          conversionRate: totals.conversionRate,
          costPerConversion: totals.costPerConversion,
          clickRoi: totals.clickRoi,
          sent: totals.sent,
          cost: totals.cost,
          influencedPlayers: totals.influencedPlayers,
          influencedRevenue: totals.influencedRevenue,
          directRevenue: totals.directRevenue,
          costPerRecovered: totals.costPerRecovered,
          roi: totals.roi,
          costOnActiveShare: totals.cost > 0 ? totals.costOnActive / totals.cost : null,
          base: {
            ativo: states.ativo ?? 0,
            esfriando: states.esfriando ?? 0,
            dormindo: states.dormindo ?? 0,
            perdido: states.perdido ?? 0,
            sem_ftd: states.sem_ftd ?? 0,
          },
          signups: Number(total?.signups ?? 0),
          signupToFtd:
            Number(total?.signups ?? 0) > 0
              ? Number(total?.first_deposit ?? 0) / Number(total?.signups)
              : null,
          secondDeposit7d:
            cohort?.second_7d_pct == null ? null : Number(cohort.second_7d_pct) / 100,
          cohortWeek: cohort ? String(cohort.cohort_week) : null,
        };
      }),
    );
    return { from, days: data.days, rows };
  });
