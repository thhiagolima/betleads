// MB4-02: saúde da integração Meta (alertas operacionais).
//
// `checkMetaHealth` lê, de todas as casas, o estado da fila e das contas e devolve
// achados com código estável e mensagem em português (nunca token ou segredo):
//
//   código          regra
//   --------------  ------------------------------------------------------------
//   run_stuck       run `queued`/`running` criado há mais de 2 h (backfill: 12 h)
//   account_error   conta marcada em `error` sem leitura com sucesso há mais de 48 h
//                   (sem sucesso: conta desde a criação da conta)
//   token_expiring  chave `system_user_token` não desconectada, ainda com acesso
//                   ativo a conta marcada, que vence (token ou acesso aos dados)
//                   em até 7 dias, ou já venceu
//   connection_error chave `system_user_token` em `error` que ainda tem acesso
//                   ativo a conta marcada da casa (chave revogada ou inválida)
//   house_stale     casa com contas marcadas com acesso ativo por chave não
//                   desconectada (conectada ou em erro) e nenhuma leitura com
//                   sucesso há mais de 26 h
//
// Casas demo e casas que não podem operar (suspensas, canceladas, bloqueadas por
// cobrança) ficam de fora: o worker também não as processa.
//
// Alerta (`runMetaHealthStage`, chamado pelo tick do worker, no máximo uma vez a
// cada 10 min por processo): um evento no Sentry por achado (agrupado por código +
// sujeito) quando o Sentry do servidor está ativo; senão `console.error` com o
// prefixo `[meta-alert]`, cada código+sujeito no máximo uma vez por hora por
// processo. O heartbeat `meta_sync` do Better Stack vai como falha quando há run
// parado; se a checagem falha, nenhum ping sai (o heartbeat acusa a ausência).

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isBillingLockedError } from "@/lib/billing/billing-locked-error";
import { readAllPages } from "@/lib/meta.functions";
import { pingHeartbeat } from "@/lib/observability/job-monitor.server";
import { captureServerMessage, isServerSentryActive } from "@/lib/observability/sentry.server";
import {
  TENANT_BLOCKED_MESSAGE,
  assertTenantCanOperate,
  listDemoTenantIds,
} from "@/lib/tenant-access.server";

export type MetaAlertCode =
  "run_stuck" | "account_error" | "token_expiring" | "connection_error" | "house_stale";

export type MetaFinding = {
  code: MetaAlertCode;
  tenantId: string;
  tenantName: string | null;
  subjectId: string;
  message: string;
  since: string | null;
};

export const META_ALERT_LOG_PREFIX = "[meta-alert]";
export const META_HEALTH_HEARTBEAT_JOB = "meta_sync";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const RUN_STUCK_MS = 2 * HOUR_MS;
export const BACKFILL_STUCK_MS = 12 * HOUR_MS;
export const ACCOUNT_ERROR_MS = 48 * HOUR_MS;
export const TOKEN_EXPIRING_MS = 7 * 24 * HOUR_MS;
export const HOUSE_STALE_MS = 26 * HOUR_MS;
/** Sem Sentry, cada código+sujeito vai para o log no máximo uma vez neste período. */
export const LOG_DEDUPE_MS = HOUR_MS;
/** O estágio roda no máximo uma vez neste período por processo. */
export const STAGE_INTERVAL_MS = 10 * MINUTE_MS;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any;

const BRT_FORMAT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatBrt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "data desconhecida";
  return BRT_FORMAT.format(date);
}

function timeOf(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return new Date(iso).getTime();
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function embedded<T>(value: T | T[] | null | undefined): T | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

const TRIGGER_LABEL: Record<string, string> = {
  manual: "manual",
  scheduled: "automática",
  backfill: "de importação inicial",
};

type RunRow = {
  id: string;
  tenant_id: string;
  trigger_type: string;
  status: string;
  created_at: string;
};
type AccountRow = {
  id: string;
  tenant_id: string;
  name: string | null;
  meta_ad_account_id: string;
  last_success_at: string | null;
  last_attempt_at: string | null;
  created_at: string | null;
};
type ConnectionRow = {
  id: string;
  tenant_id: string;
  connection_label: string | null;
  meta_user_name: string | null;
  status: string;
  auth_type: string | null;
  token_expires_at: string | null;
  data_access_expires_at: string | null;
};
type AccessRow = {
  tenant_id: string;
  account_id: string;
  connection_id: string;
  created_at: string | null;
  meta_ad_accounts:
    | { tenant_id: string; last_success_at: string | null }
    | { tenant_id: string; last_success_at: string | null }[]
    | null;
  meta_connections:
    { tenant_id: string; status: string } | { tenant_id: string; status: string }[] | null;
};

const SYSTEM_USER_TOKEN = "system_user_token";

/** Acessos cuja conta e chave são da mesma casa do acesso (o resto é ignorado). */
function sameTenantAccess(rows: AccessRow[]): AccessRow[] {
  return rows.filter(
    (row) =>
      embedded(row.meta_ad_accounts)?.tenant_id === row.tenant_id &&
      embedded(row.meta_connections)?.tenant_id === row.tenant_id,
  );
}

/** Contas marcadas distintas com acesso ativo, por chave. */
function selectedAccountsByConnection(rows: AccessRow[]): Map<string, Set<string>> {
  const byConnection = new Map<string, Set<string>>();
  for (const row of rows) {
    const accounts = byConnection.get(row.connection_id) ?? new Set<string>();
    accounts.add(row.account_id);
    byConnection.set(row.connection_id, accounts);
  }
  return byConnection;
}

function connectionName(connection: ConnectionRow): string {
  return connection.connection_label ?? connection.meta_user_name ?? "sem nome";
}

type RawFinding = Omit<MetaFinding, "tenantName">;

function runStuckFindings(rows: RunRow[], nowMs: number): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const run of rows) {
    const limit = run.trigger_type === "backfill" ? BACKFILL_STUCK_MS : RUN_STUCK_MS;
    const createdMs = timeOf(run.created_at);
    if (!Number.isFinite(createdMs) || nowMs - createdMs <= limit) continue;
    const label = TRIGGER_LABEL[run.trigger_type] ?? run.trigger_type;
    const state = run.status === "queued" ? "na fila" : "em andamento";
    findings.push({
      code: "run_stuck",
      tenantId: run.tenant_id,
      subjectId: run.id,
      message: `Sincronização ${label} parada (${state}) desde ${formatBrt(run.created_at)}.`,
      since: run.created_at,
    });
  }
  return findings;
}

function accountErrorFindings(rows: AccountRow[], nowMs: number): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const account of rows) {
    // Sem sucesso registrado, conta-se desde que a conta entrou na casa.
    const sinceIso = account.last_success_at ?? account.created_at;
    const sinceMs = timeOf(sinceIso);
    if (!Number.isFinite(sinceMs) || nowMs - sinceMs <= ACCOUNT_ERROR_MS) continue;
    const label = account.name
      ? `${account.name} (${account.meta_ad_account_id})`
      : account.meta_ad_account_id;
    findings.push({
      code: "account_error",
      tenantId: account.tenant_id,
      subjectId: account.id,
      message: account.last_success_at
        ? `A conta ${label} está em erro e não é lida há mais de 48 h (última leitura em ${formatBrt(account.last_success_at)}).`
        : `A conta ${label} está em erro e nunca foi lida com sucesso (marcada há mais de 48 h).`,
      since: account.last_success_at,
    });
  }
  return findings;
}

function tokenExpiringFindings(
  rows: ConnectionRow[],
  accountsByConnection: Map<string, Set<string>>,
  nowMs: number,
): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const connection of rows) {
    // Só chaves de sistema que ainda servem alguma conta marcada: uma chave antiga
    // (legacy_oauth) ou sem uso alertaria para sempre.
    if (connection.auth_type !== SYSTEM_USER_TOKEN) continue;
    if (!accountsByConnection.has(connection.id)) continue;
    const candidates = [
      { iso: connection.token_expires_at, what: "A chave" },
      { iso: connection.data_access_expires_at, what: "O acesso aos dados da chave" },
    ].filter((item) => Number.isFinite(timeOf(item.iso)));
    if (candidates.length === 0) continue;
    const first = candidates.reduce((a, b) => (timeOf(b.iso) < timeOf(a.iso) ? b : a));
    const expiresMs = timeOf(first.iso);
    if (expiresMs - nowMs > TOKEN_EXPIRING_MS) continue;
    const name = connectionName(connection);
    const when = formatBrt(first.iso!);
    findings.push({
      code: "token_expiring",
      tenantId: connection.tenant_id,
      subjectId: connection.id,
      message:
        expiresMs <= nowMs
          ? `${first.what} "${name}" venceu em ${when}. Gere uma nova chave no Business Manager.`
          : `${first.what} "${name}" vence em ${when}. Gere uma nova chave no Business Manager.`,
      since: first.iso ?? null,
    });
  }
  return findings;
}

function connectionErrorFindings(
  rows: ConnectionRow[],
  accountsByConnection: Map<string, Set<string>>,
): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const connection of rows) {
    if (connection.status !== "error" || connection.auth_type !== SYSTEM_USER_TOKEN) continue;
    const count = accountsByConnection.get(connection.id)?.size ?? 0;
    if (count === 0) continue;
    const accounts = count === 1 ? "1 conta marcada" : `${count} contas marcadas`;
    findings.push({
      code: "connection_error",
      tenantId: connection.tenant_id,
      subjectId: connection.id,
      // Sem `last_error`: pode trazer texto cru da Meta.
      message: `A chave "${connectionName(connection)}" está com erro e ainda é a fonte de ${accounts}. Confira a chave no Business Manager e reconecte em Integrações > Meta Ads.`,
      since: null,
    });
  }
  return findings;
}

function houseStaleFindings(rows: AccessRow[], nowMs: number): RawFinding[] {
  const byTenant = new Map<
    string,
    { lastSuccessMs: number; lastSuccess: string | null; firstAccessMs: number }
  >();
  for (const row of rows) {
    const account = embedded(row.meta_ad_accounts);
    if (!account) continue;
    const entry = byTenant.get(row.tenant_id) ?? {
      lastSuccessMs: Number.NaN,
      lastSuccess: null,
      firstAccessMs: Number.NaN,
    };
    const successMs = timeOf(account.last_success_at);
    if (Number.isFinite(successMs) && !(successMs <= entry.lastSuccessMs)) {
      entry.lastSuccessMs = successMs;
      entry.lastSuccess = account.last_success_at;
    }
    const accessMs = timeOf(row.created_at);
    if (Number.isFinite(accessMs) && !(accessMs >= entry.firstAccessMs)) {
      entry.firstAccessMs = accessMs;
    }
    byTenant.set(row.tenant_id, entry);
  }
  const findings: RawFinding[] = [];
  for (const [tenantId, entry] of byTenant) {
    const reference = Number.isFinite(entry.lastSuccessMs)
      ? entry.lastSuccessMs
      : entry.firstAccessMs;
    if (!Number.isFinite(reference) || nowMs - reference <= HOUSE_STALE_MS) continue;
    findings.push({
      code: "house_stale",
      tenantId,
      subjectId: tenantId,
      message: entry.lastSuccess
        ? `Nenhuma conta Meta da casa é lida há mais de 26 h (última leitura em ${formatBrt(entry.lastSuccess)}).`
        : "Nenhuma conta Meta da casa foi lida com sucesso, e as contas estão marcadas há mais de 26 h.",
      since: entry.lastSuccess,
    });
  }
  return findings;
}

function isOperateBlock(error: unknown): boolean {
  if (isBillingLockedError(error)) return true;
  return error instanceof Error && error.message === TENANT_BLOCKED_MESSAGE;
}

/**
 * Achados de todas as casas, já sem as casas demo e as que não podem operar.
 * Lança se uma leitura falhar (o estágio registra e não pinga o heartbeat).
 */
export async function checkMetaHealth(now: Date): Promise<MetaFinding[]> {
  const nowMs = now.getTime();
  const runCutoff = new Date(nowMs - RUN_STUCK_MS).toISOString();

  const [demoIds, runs, accounts, connections, access] = await Promise.all([
    listDemoTenantIds(),
    readAllPages<RunRow>((from, to) =>
      db()
        .from("meta_sync_runs")
        .select("id,tenant_id,trigger_type,status,created_at")
        .in("status", ["queued", "running"])
        .lt("created_at", runCutoff)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    readAllPages<AccountRow>((from, to) =>
      db()
        .from("meta_ad_accounts")
        .select("id,tenant_id,name,meta_ad_account_id,last_success_at,last_attempt_at,created_at")
        .eq("selected", true)
        .eq("sync_status", "error")
        .order("id", { ascending: true })
        .range(from, to),
    ),
    readAllPages<ConnectionRow>((from, to) =>
      db()
        .from("meta_connections")
        .select(
          "id,tenant_id,connection_label,meta_user_name,status,auth_type,token_expires_at,data_access_expires_at",
        )
        .neq("status", "disabled")
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // Contas marcadas com acesso ativo por uma chave não desconectada (conectada
    // ou em erro: a casa cuja única chave caiu também fica parada).
    readAllPages<AccessRow>((from, to) =>
      db()
        .from("meta_ad_account_access")
        .select(
          "id,tenant_id,account_id,connection_id,created_at,meta_ad_accounts!inner(tenant_id,selected,last_success_at),meta_connections!inner(tenant_id,status)",
        )
        .eq("status", "active")
        .eq("meta_ad_accounts.selected", true)
        .in("meta_connections.status", ["connected", "error"])
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  // Acesso conferido: conta e chave da casa do acesso; logo a chave de cada
  // entrada do mapa é da mesma casa das contas que serve.
  const selectedAccess = sameTenantAccess(access);
  const accountsByConnection = selectedAccountsByConnection(selectedAccess);

  const raw: RawFinding[] = [
    ...runStuckFindings(runs, nowMs),
    ...accountErrorFindings(accounts, nowMs),
    ...tokenExpiringFindings(connections, accountsByConnection, nowMs),
    ...connectionErrorFindings(connections, accountsByConnection),
    ...houseStaleFindings(selectedAccess, nowMs),
  ];

  const demo = new Set(demoIds);
  const tenantIds = [...new Set(raw.map((f) => f.tenantId))].filter((id) => !demo.has(id));
  const operational = new Set<string>();
  for (const tenantId of tenantIds) {
    try {
      await assertTenantCanOperate(tenantId);
      operational.add(tenantId);
    } catch (error) {
      // Falha ao ler a casa não é bloqueio: o worker também segue com ela.
      if (isOperateBlock(error)) continue;
      console.error("[meta-health tenant]", tenantId, errorText(error));
      operational.add(tenantId);
    }
  }

  const names = new Map<string, string | null>();
  if (operational.size > 0) {
    const { data, error } = await db()
      .from("tenants")
      .select("id, nome")
      .in("id", [...operational]);
    if (error) throw new Error(errorText(error));
    for (const row of (data ?? []) as Array<{ id: string; nome: string | null }>) {
      names.set(row.id, row.nome ?? null);
    }
  }

  return raw
    .filter((f) => operational.has(f.tenantId))
    .map((f) => ({ ...f, tenantName: names.get(f.tenantId) ?? null }));
}

const lastLoggedAt = new Map<string, number>();
let lastStageAt: number | null = null;

/** Test hook: zera o dedupe do log e o relógio do estágio. */
export function __resetMetaHealthStateForTests(): void {
  lastLoggedAt.clear();
  lastStageAt = null;
}

/**
 * Um evento no Sentry por achado (warning, agrupado por código + sujeito) quando
 * ativo; senão `console.error` com META_ALERT_LOG_PREFIX, cada código+sujeito no
 * máximo uma vez por LOG_DEDUPE_MS por processo (`dedupe: false` ignora, para o
 * alerta de teste). Devolve quantos alertas saíram. Nunca lança.
 */
export async function reportMetaAlerts(
  findings: MetaFinding[],
  opts: { dedupe?: boolean } = {},
): Promise<number> {
  if (findings.length === 0) return 0;
  const nowMs = Date.now();
  const dedupe = opts.dedupe !== false;
  let useSentry = false;
  try {
    useSentry = isServerSentryActive();
  } catch {
    useSentry = false;
  }
  let reported = 0;
  for (const finding of findings) {
    try {
      const house = finding.tenantName ?? finding.tenantId;
      const text = `${META_ALERT_LOG_PREFIX} ${finding.code}: ${house}: ${finding.message}`;
      if (useSentry) {
        captureServerMessage(text, "warning", {
          job: META_HEALTH_HEARTBEAT_JOB,
          tags: { alert_code: finding.code, tenant_id: finding.tenantId },
          fingerprint: ["meta-alert", finding.code, finding.subjectId],
        });
      } else {
        const key = `${finding.code}:${finding.subjectId}`;
        const last = lastLoggedAt.get(key);
        if (dedupe && last !== undefined && nowMs - last < LOG_DEDUPE_MS) continue;
        lastLoggedAt.set(key, nowMs);
        console.error(text);
      }
      reported += 1;
    } catch {
      // O alerta nunca quebra quem chamou.
    }
  }
  return reported;
}

/**
 * Estágio do tick: no máximo uma vez a cada STAGE_INTERVAL_MS por processo
 * (senão `skipped: true`), checa, alerta e pinga o heartbeat `meta_sync` (falha
 * quando há run parado). Nunca lança: uma checagem que falha é registrada e não
 * pinga.
 */
export async function runMetaHealthStage(
  now: Date,
): Promise<{ findings: number; reported: number; skipped: boolean }> {
  const nowMs = now.getTime();
  if (lastStageAt !== null && nowMs - lastStageAt < STAGE_INTERVAL_MS) {
    return { findings: 0, reported: 0, skipped: true };
  }
  lastStageAt = nowMs;
  try {
    const findings = await checkMetaHealth(now);
    const reported = await reportMetaAlerts(findings);
    const stuck = findings.filter((f) => f.code === "run_stuck").length;
    void pingHeartbeat(META_HEALTH_HEARTBEAT_JOB, stuck === 0);
    return { findings: findings.length, reported, skipped: false };
  } catch (error) {
    console.error("[meta-health] stage failed", { error: errorText(error) });
    return { findings: 0, reported: 0, skipped: false };
  }
}
