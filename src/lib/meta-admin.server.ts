// MB4-03: painel "Meta Ads por casa" do super admin (Admin → Integrações). Corpo
// das server functions de meta-admin.functions.ts, exportado para os guards serem
// testáveis. Só contagens, datas e mensagens fixas: nenhum token sai daqui.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { readAllPages } from "@/lib/meta.functions";
import { checkMetaHealth, reportMetaAlerts, type MetaAlertCode } from "@/lib/meta-health.server";
import { isServerSentryActive } from "@/lib/observability/sentry.server";
import { assertSuperAdmin } from "@/lib/provider-governance.server";

type AdminContext = { userId: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any;

export type MetaHouseRow = {
  tenantId: string;
  tenantName: string | null;
  connections: { total: number; connected: number; error: number };
  accounts: { selected: number; total: number; inError: number };
  lastSuccessAt: string | null;
  latestRun: {
    status: string;
    triggerType: string;
    createdAt: string;
    finishedAt: string | null;
  } | null;
  alerts: { code: MetaAlertCode; message: string }[];
};

type ConnectionRow = { id: string; tenant_id: string; status: string };
type AccountRow = {
  id: string;
  tenant_id: string;
  selected: boolean | null;
  sync_status: string | null;
  last_success_at: string | null;
};
type RunRow = {
  status: string;
  trigger_type: string;
  created_at: string;
  finished_at: string | null;
};

function emptyRow(tenantId: string): MetaHouseRow {
  return {
    tenantId,
    tenantName: null,
    connections: { total: 0, connected: 0, error: 0 },
    accounts: { selected: 0, total: 0, inError: 0 },
    lastSuccessAt: null,
    latestRun: null,
    alerts: [],
  };
}

/** Casas com ao menos uma chave não desconectada ou alguma conta Meta. */
export async function adminListMetaHousesFor(ctx: AdminContext): Promise<MetaHouseRow[]> {
  await assertSuperAdmin(ctx.userId);

  const [connections, accounts, findings] = await Promise.all([
    readAllPages<ConnectionRow>((from, to) =>
      db()
        .from("meta_connections")
        .select("id,tenant_id,status")
        .neq("status", "disabled")
        .order("id", { ascending: true })
        .range(from, to),
    ),
    readAllPages<AccountRow>((from, to) =>
      db()
        .from("meta_ad_accounts")
        .select("id,tenant_id,selected,sync_status,last_success_at")
        .order("id", { ascending: true })
        .range(from, to),
    ),
    checkMetaHealth(new Date()),
  ]);

  const rows = new Map<string, MetaHouseRow>();
  const rowOf = (tenantId: string) => {
    let row = rows.get(tenantId);
    if (!row) {
      row = emptyRow(tenantId);
      rows.set(tenantId, row);
    }
    return row;
  };

  for (const connection of connections) {
    const row = rowOf(connection.tenant_id);
    row.connections.total += 1;
    if (connection.status === "connected") row.connections.connected += 1;
    if (connection.status === "error") row.connections.error += 1;
  }
  for (const account of accounts) {
    const row = rowOf(account.tenant_id);
    row.accounts.total += 1;
    if (!account.selected) continue;
    row.accounts.selected += 1;
    if (account.sync_status === "error") row.accounts.inError += 1;
    const success = account.last_success_at;
    if (success && (!row.lastSuccessAt || new Date(success) > new Date(row.lastSuccessAt))) {
      row.lastSuccessAt = success;
    }
  }

  const tenantIds = [...rows.keys()];
  if (tenantIds.length === 0) return [];

  const [tenantsRes, latestRuns] = await Promise.all([
    db().from("tenants").select("id, nome").in("id", tenantIds),
    Promise.all(
      tenantIds.map(async (tenantId) => {
        const { data, error } = await db()
          .from("meta_sync_runs")
          .select("status,trigger_type,created_at,finished_at")
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw new Error(error.message);
        return [tenantId, (data ?? null) as RunRow | null] as const;
      }),
    ),
  ]);
  if (tenantsRes.error) throw new Error(tenantsRes.error.message);
  for (const tenant of (tenantsRes.data ?? []) as Array<{ id: string; nome: string | null }>) {
    const row = rows.get(tenant.id);
    if (row) row.tenantName = tenant.nome ?? null;
  }
  for (const [tenantId, run] of latestRuns) {
    if (!run) continue;
    rowOf(tenantId).latestRun = {
      status: run.status,
      triggerType: run.trigger_type,
      createdAt: run.created_at,
      finishedAt: run.finished_at ?? null,
    };
  }
  for (const finding of findings) {
    rows.get(finding.tenantId)?.alerts.push({ code: finding.code, message: finding.message });
  }

  const nameOf = (row: MetaHouseRow) => row.tenantName ?? row.tenantId;
  return [...rows.values()].sort((a, b) => {
    const byAlerts = Number(b.alerts.length > 0) - Number(a.alerts.length > 0);
    return byAlerts || nameOf(a).localeCompare(nameOf(b), "pt-BR");
  });
}

export const META_TEST_ALERT_MESSAGE = "Alerta de teste da integração Meta.";

/** Dispara um alerta de teste pelo mesmo caminho dos reais (sem dedupe). */
export async function adminTestMetaAlertFor(
  ctx: AdminContext,
): Promise<{ ok: true; sentry: boolean }> {
  await assertSuperAdmin(ctx.userId);
  let sentry = false;
  try {
    sentry = isServerSentryActive();
  } catch {
    sentry = false;
  }
  await reportMetaAlerts(
    [
      {
        code: "run_stuck",
        tenantId: "teste",
        tenantName: "Teste",
        subjectId: "meta-alert-test",
        message: META_TEST_ALERT_MESSAGE,
        since: null,
      },
    ],
    { dedupe: false },
  );
  return { ok: true, sentry };
}
