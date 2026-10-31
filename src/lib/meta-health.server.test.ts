// MB4-02: regras de saúde da integração Meta, alerta (Sentry ou log com dedupe),
// estágio do tick (uma vez a cada 10 min) e heartbeat `meta_sync`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failTable: null as string | null,
  ranges: [] as Array<{ table: string; range: [number, number] }>,
}));

// Fake mínimo do PostgREST: filtro com caminho pontuado lê o recurso embutido.
function valueAt(row: Row, column: string): unknown {
  return column.split(".").reduce<unknown>((current, key) => {
    if (Array.isArray(current)) current = current[0];
    return current && typeof current === "object" ? (current as Row)[key] : undefined;
  }, row);
}

function query(table: string) {
  const filters: Filter[] = [];
  let range: [number, number] | null = null;
  let limit: number | null = null;
  const run = () => {
    if (db.failTable === table) return { data: null, error: { message: `falha em ${table}` } };
    let rows = (db.tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    if (range) {
      db.ranges.push({ table, range });
      rows = rows.slice(range[0], range[1] + 1);
    }
    if (limit !== null) rows = rows.slice(0, limit);
    return { data: rows, error: null };
  };
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (c: string, v: unknown) => (filters.push((r) => valueAt(r, c) === v), builder),
    neq: (c: string, v: unknown) => (filters.push((r) => valueAt(r, c) !== v), builder),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(valueAt(r, c))), builder),
    lt: (c: string, v: unknown) => (
      filters.push((r) => String(valueAt(r, c)) < String(v)),
      builder
    ),
    order: () => builder,
    limit: (n: number) => ((limit = n), builder),
    range: (from: number, to: number) => ((range = [from, to]), builder),
    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(run()).then(resolve, reject),
  };
  return builder;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => query(table) },
}));

// O `readAllPages` real (meta.functions) traz o módulo inteiro; aqui, a mesma regra.
vi.mock("@/lib/meta.functions", () => ({
  readAllPages: async (
    page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  ) => {
    const rows: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await page(from, from + 999);
      if (error) throw new Error((error as { message: string }).message);
      const chunk = (data ?? []) as unknown[];
      rows.push(...chunk);
      if (chunk.length < 1000) return rows;
    }
  },
}));

const TENANT_BLOCKED = vi.hoisted(
  () => "Tenant bloqueado para operacoes. Regularize a conta antes de continuar.",
);
const access = vi.hoisted(() => ({
  demo: [] as string[],
  blocked: new Set<string>(),
  billingLocked: new Set<string>(),
  lookupError: new Set<string>(),
}));
vi.mock("@/lib/tenant-access.server", async () => {
  const { TenantBillingLockedError } = await import("@/lib/billing/billing-locked-error");
  return {
    TENANT_BLOCKED_MESSAGE: TENANT_BLOCKED,
    listDemoTenantIds: vi.fn(async () => access.demo),
    assertTenantCanOperate: vi.fn(async (tenantId: string) => {
      if (access.lookupError.has(tenantId)) throw new Error("connection reset");
      if (access.blocked.has(tenantId)) throw new Error(TENANT_BLOCKED);
      if (access.billingLocked.has(tenantId)) throw new TenantBillingLockedError();
    }),
  };
});

const sentry = vi.hoisted(() => ({ active: false, captureServerMessage: vi.fn() }));
vi.mock("@/lib/observability/sentry.server", () => ({
  isServerSentryActive: () => sentry.active,
  captureServerMessage: sentry.captureServerMessage,
}));

const { pingHeartbeat } = vi.hoisted(() => ({ pingHeartbeat: vi.fn(async () => undefined) }));
vi.mock("@/lib/observability/job-monitor.server", () => ({ pingHeartbeat }));

import {
  __resetMetaHealthStateForTests,
  checkMetaHealth,
  reportMetaAlerts,
  runMetaHealthStage,
  type MetaFinding,
} from "./meta-health.server";

const NOW = new Date("2026-10-31T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const hoursAhead = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

function eligibleAccess(
  id: string,
  tenantId: string,
  lastSuccess: string | null,
  createdAt: string,
  connection: { id?: string; status?: string } = {},
) {
  return {
    id: `access-${id}`,
    tenant_id: tenantId,
    account_id: id,
    connection_id: connection.id ?? `conn-${tenantId}`,
    status: "active",
    created_at: createdAt,
    meta_ad_accounts: { tenant_id: tenantId, selected: true, last_success_at: lastSuccess },
    meta_connections: { tenant_id: tenantId, status: connection.status ?? "connected" },
  };
}

/** Acesso ativo e recente da chave a uma conta marcada (não deixa a casa parada). */
function freshAccess(connectionId: string, tenantId = "t1", status = "connected") {
  return eligibleAccess(`acc-${connectionId}`, tenantId, hoursAgo(1), hoursAgo(200), {
    id: connectionId,
    status,
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db.tables = {
    tenants: [
      { id: "t1", nome: "Casa Um" },
      { id: "t2", nome: "Casa Dois" },
    ],
  };
  db.failTable = null;
  db.ranges = [];
  access.demo = [];
  access.blocked = new Set();
  access.billingLocked = new Set();
  access.lookupError = new Set();
  sentry.active = false;
  sentry.captureServerMessage.mockClear();
  pingHeartbeat.mockClear();
  __resetMetaHealthStateForTests();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const codes = (findings: MetaFinding[]) => findings.map((f) => `${f.code}:${f.subjectId}`).sort();

describe("checkMetaHealth: run_stuck", () => {
  it("run normal parado há mais de 2 h e backfill há mais de 12 h", async () => {
    db.tables.meta_sync_runs = [
      {
        id: "r-old",
        tenant_id: "t1",
        trigger_type: "scheduled",
        status: "running",
        created_at: hoursAgo(3),
      },
      {
        id: "r-new",
        tenant_id: "t1",
        trigger_type: "manual",
        status: "queued",
        created_at: hoursAgo(1),
      },
      {
        id: "r-done",
        tenant_id: "t1",
        trigger_type: "manual",
        status: "completed",
        created_at: hoursAgo(5),
      },
      {
        id: "b-young",
        tenant_id: "t1",
        trigger_type: "backfill",
        status: "running",
        created_at: hoursAgo(5),
      },
      {
        id: "b-old",
        tenant_id: "t1",
        trigger_type: "backfill",
        status: "queued",
        created_at: hoursAgo(13),
      },
    ];
    const findings = await checkMetaHealth(NOW);
    expect(codes(findings)).toEqual(["run_stuck:b-old", "run_stuck:r-old"]);
    const old = findings.find((f) => f.subjectId === "r-old")!;
    expect(old.tenantName).toBe("Casa Um");
    expect(old.since).toBe(hoursAgo(3));
    expect(old.message).toMatch(/^Sincronização automática parada \(em andamento\) desde /);
  });

  it("lê os runs em páginas de 1000", async () => {
    db.tables.meta_sync_runs = Array.from({ length: 1001 }, (_, i) => ({
      id: `r${i}`,
      tenant_id: "t1",
      trigger_type: "scheduled",
      status: "running",
      created_at: hoursAgo(3),
    }));
    const findings = await checkMetaHealth(NOW);
    expect(findings.filter((f) => f.code === "run_stuck")).toHaveLength(1001);
    expect(db.ranges.filter((r) => r.table === "meta_sync_runs").map((r) => r.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });
});

describe("checkMetaHealth: account_error", () => {
  it("conta marcada em erro sem sucesso há mais de 48 h", async () => {
    const base = {
      tenant_id: "t1",
      selected: true,
      sync_status: "error",
      meta_ad_account_id: "act_1",
    };
    db.tables.meta_ad_accounts = [
      {
        ...base,
        id: "a-old",
        name: "Conta A",
        last_success_at: hoursAgo(50),
        created_at: hoursAgo(100),
      },
      {
        ...base,
        id: "a-recent",
        name: "B",
        last_success_at: hoursAgo(30),
        created_at: hoursAgo(100),
      },
      { ...base, id: "a-never-old", name: null, last_success_at: null, created_at: hoursAgo(49) },
      { ...base, id: "a-never-new", name: "D", last_success_at: null, created_at: hoursAgo(30) },
      {
        ...base,
        id: "a-ok",
        name: "E",
        sync_status: "success",
        last_success_at: hoursAgo(40),
        created_at: hoursAgo(100),
      },
      {
        ...base,
        id: "a-unselected",
        name: "F",
        selected: false,
        last_success_at: hoursAgo(40),
        created_at: hoursAgo(100),
      },
    ];
    const findings = await checkMetaHealth(NOW);
    expect(codes(findings)).toEqual(["account_error:a-never-old", "account_error:a-old"]);
    const old = findings.find((f) => f.subjectId === "a-old")!;
    expect(old.message).toContain("Conta A (act_1)");
    expect(old.message).toContain("há mais de 48 h");
    expect(old.since).toBe(hoursAgo(50));
    expect(findings.find((f) => f.subjectId === "a-never-old")!.message).toContain(
      "nunca foi lida com sucesso",
    );
  });
});

describe("checkMetaHealth: token_expiring", () => {
  it("chave não desconectada que vence em até 7 dias ou já venceu", async () => {
    const base = {
      tenant_id: "t1",
      connection_label: "Chave X",
      meta_user_name: null,
      auth_type: "system_user_token",
    };
    db.tables.meta_ad_account_access = [
      freshAccess("c-soon"),
      freshAccess("c-data", "t1", "error"),
      freshAccess("c-far"),
      freshAccess("c-never"),
    ];
    db.tables.meta_connections = [
      {
        ...base,
        id: "c-soon",
        status: "connected",
        token_expires_at: hoursAhead(48),
        data_access_expires_at: null,
      },
      {
        ...base,
        id: "c-data",
        status: "error",
        token_expires_at: null,
        data_access_expires_at: hoursAgo(1),
      },
      {
        ...base,
        id: "c-far",
        status: "connected",
        token_expires_at: hoursAhead(24 * 30),
        data_access_expires_at: hoursAhead(24 * 60),
      },
      {
        ...base,
        id: "c-never",
        status: "connected",
        token_expires_at: null,
        data_access_expires_at: null,
      },
      {
        ...base,
        id: "c-disabled",
        status: "disabled",
        token_expires_at: hoursAgo(1),
        data_access_expires_at: null,
      },
    ];
    const findings = (await checkMetaHealth(NOW)).filter((f) => f.code === "token_expiring");
    expect(codes(findings)).toEqual(["token_expiring:c-data", "token_expiring:c-soon"]);
    expect(findings.find((f) => f.subjectId === "c-soon")!.message).toMatch(
      /^A chave "Chave X" vence em/,
    );
    expect(findings.find((f) => f.subjectId === "c-data")!.message).toMatch(
      /^O acesso aos dados da chave "Chave X" venceu em/,
    );
  });

  it("usa o menor dos dois vencimentos", async () => {
    db.tables.meta_ad_account_access = [freshAccess("c1")];
    db.tables.meta_connections = [
      {
        id: "c1",
        tenant_id: "t1",
        status: "connected",
        auth_type: "system_user_token",
        connection_label: null,
        meta_user_name: "Fulano",
        token_expires_at: hoursAhead(24 * 30),
        data_access_expires_at: hoursAhead(24 * 3),
      },
    ];
    const [finding] = await checkMetaHealth(NOW);
    expect(finding.since).toBe(hoursAhead(24 * 3));
    expect(finding.message).toContain('"Fulano"');
  });

  it("chave legacy_oauth vencida, ou chave sem acesso a conta marcada, não alerta", async () => {
    db.tables.meta_ad_account_access = [
      freshAccess("c-legacy", "t1", "error"),
      // Acesso revogado e conta desmarcada não contam como uso da chave.
      { ...freshAccess("c-revoked"), status: "revoked" },
      {
        ...freshAccess("c-unselected"),
        meta_ad_accounts: { tenant_id: "t1", selected: false, last_success_at: hoursAgo(1) },
      },
    ];
    const base = {
      tenant_id: "t1",
      connection_label: "Chave",
      meta_user_name: null,
      data_access_expires_at: null,
    };
    db.tables.meta_connections = [
      {
        ...base,
        id: "c-legacy",
        status: "error",
        auth_type: "legacy_oauth",
        token_expires_at: hoursAgo(24 * 30),
      },
      {
        ...base,
        id: "c-unused",
        status: "connected",
        auth_type: "system_user_token",
        token_expires_at: hoursAhead(24),
      },
      {
        ...base,
        id: "c-revoked",
        status: "connected",
        auth_type: "system_user_token",
        token_expires_at: hoursAhead(24),
      },
      {
        ...base,
        id: "c-unselected",
        status: "connected",
        auth_type: "system_user_token",
        token_expires_at: hoursAhead(24),
      },
    ];
    expect(await checkMetaHealth(NOW)).toEqual([]);
  });
});

describe("checkMetaHealth: connection_error", () => {
  const connection = (overrides: Row) => ({
    tenant_id: "t1",
    connection_label: "Chave BM",
    meta_user_name: null,
    status: "error",
    auth_type: "system_user_token",
    last_error: "Error validating access token: SEGREDO-DA-META",
    token_expires_at: null,
    data_access_expires_at: null,
    ...overrides,
  });

  it("chave de sistema em erro com acesso ativo a conta marcada", async () => {
    db.tables.meta_ad_account_access = [
      freshAccess("c-err", "t1", "error"),
      eligibleAccess("a2", "t1", hoursAgo(1), hoursAgo(200), { id: "c-err", status: "error" }),
      freshAccess("c-ok"),
    ];
    db.tables.meta_connections = [
      connection({ id: "c-err" }),
      connection({ id: "c-ok", status: "connected" }),
    ];
    const findings = await checkMetaHealth(NOW);
    expect(codes(findings)).toEqual(["connection_error:c-err"]);
    expect(findings[0].tenantName).toBe("Casa Um");
    expect(findings[0].message).toBe(
      'A chave "Chave BM" está com erro e ainda é a fonte de 2 contas marcadas. Confira a chave no Business Manager e reconecte em Integrações > Meta Ads.',
    );
    expect(JSON.stringify(findings)).not.toContain("SEGREDO");
  });

  it("sem acesso ativo a conta marcada, legacy_oauth, desconectada ou de outra casa: não alerta", async () => {
    db.tables.meta_ad_account_access = [
      freshAccess("c-legacy", "t1", "error"),
      { ...freshAccess("c-revoked", "t1", "error"), status: "revoked" },
      {
        ...freshAccess("c-unselected", "t1", "error"),
        meta_ad_accounts: { tenant_id: "t1", selected: false, last_success_at: hoursAgo(1) },
      },
      // Acesso da casa t2 apontando para uma chave da t1: ignorado.
      {
        ...freshAccess("c-other", "t2", "error"),
        meta_connections: { tenant_id: "t1", status: "error" },
      },
    ];
    db.tables.meta_connections = [
      connection({ id: "c-legacy", auth_type: "legacy_oauth" }),
      connection({ id: "c-revoked" }),
      connection({ id: "c-unselected" }),
      connection({ id: "c-unused" }),
      connection({ id: "c-other" }),
      connection({ id: "c-disabled", status: "disabled" }),
    ];
    expect(await checkMetaHealth(NOW)).toEqual([]);
  });
});

describe("checkMetaHealth: house_stale", () => {
  it("casa sem leitura há mais de 26 h nas contas elegíveis", async () => {
    db.tables.meta_ad_account_access = [
      // t1: a mais recente das contas tem 30 h -> parada.
      eligibleAccess("a1", "t1", hoursAgo(30), hoursAgo(200)),
      eligibleAccess("a2", "t1", hoursAgo(40), hoursAgo(200)),
      // t2: uma conta leu há 2 h -> ok.
      eligibleAccess("b1", "t2", hoursAgo(50), hoursAgo(200)),
      eligibleAccess("b2", "t2", hoursAgo(2), hoursAgo(200)),
    ];
    const findings = await checkMetaHealth(NOW);
    expect(codes(findings)).toEqual(["house_stale:t1"]);
    expect(findings[0].since).toBe(hoursAgo(30));
    expect(findings[0].message).toContain("há mais de 26 h");
  });

  it("nunca leu: conta desde o acesso mais antigo", async () => {
    db.tables.meta_ad_account_access = [
      eligibleAccess("a1", "t1", null, hoursAgo(27)),
      eligibleAccess("b1", "t2", null, hoursAgo(3)),
    ];
    const findings = await checkMetaHealth(NOW);
    expect(codes(findings)).toEqual(["house_stale:t1"]);
    expect(findings[0].since).toBeNull();
  });

  it("acesso não elegível (conta desmarcada, chave desconectada, outra casa) não conta", async () => {
    const stale = eligibleAccess("a1", "t1", hoursAgo(100), hoursAgo(200));
    db.tables.meta_ad_account_access = [
      {
        ...stale,
        meta_ad_accounts: { tenant_id: "t1", selected: false, last_success_at: hoursAgo(100) },
      },
      { ...stale, id: "x2", meta_connections: { tenant_id: "t1", status: "disabled" } },
      { ...stale, id: "x3", meta_connections: { tenant_id: "t2", status: "connected" } },
      { ...stale, id: "x4", status: "revoked" },
    ];
    expect(await checkMetaHealth(NOW)).toEqual([]);
  });

  it("casa cuja única chave está em erro também fica parada depois de 26 h", async () => {
    db.tables.meta_ad_account_access = [
      eligibleAccess("a1", "t1", hoursAgo(27), hoursAgo(200), { id: "c-err", status: "error" }),
      eligibleAccess("b1", "t2", hoursAgo(20), hoursAgo(200), { id: "c-err2", status: "error" }),
    ];
    const findings = await checkMetaHealth(NOW);
    expect(codes(findings)).toEqual(["house_stale:t1"]);
    expect(findings[0].since).toBe(hoursAgo(27));
  });
});

describe("checkMetaHealth: casas fora", () => {
  beforeEach(() => {
    db.tables.meta_sync_runs = ["t1", "t2", "t3", "t4"].map((tenantId) => ({
      id: `run-${tenantId}`,
      tenant_id: tenantId,
      trigger_type: "manual",
      status: "running",
      created_at: hoursAgo(3),
    }));
  });

  it("pula casa demo, suspensa e bloqueada por cobrança; falha de leitura não é bloqueio", async () => {
    access.demo = ["t1"];
    access.blocked.add("t2");
    access.billingLocked.add("t3");
    access.lookupError.add("t4");
    const findings = await checkMetaHealth(NOW);
    expect(codes(findings)).toEqual(["run_stuck:run-t4"]);
    expect(findings[0].tenantName).toBeNull();
  });

  it("leitura que falha lança", async () => {
    db.failTable = "meta_connections";
    await expect(checkMetaHealth(NOW)).rejects.toThrow("falha em meta_connections");
  });
});

const finding = (overrides: Partial<MetaFinding> = {}): MetaFinding => ({
  code: "run_stuck",
  tenantId: "t1",
  tenantName: "Casa Um",
  subjectId: "r1",
  message: "Sincronização manual parada.",
  since: null,
  ...overrides,
});

describe("reportMetaAlerts", () => {
  it("com Sentry: um warning por achado, com tags e fingerprint por código+sujeito", async () => {
    sentry.active = true;
    const sent = await reportMetaAlerts([
      finding(),
      finding({ code: "house_stale", subjectId: "t1" }),
    ]);
    expect(sent).toBe(2);
    expect(sentry.captureServerMessage).toHaveBeenCalledTimes(2);
    expect(sentry.captureServerMessage).toHaveBeenCalledWith(
      "[meta-alert] run_stuck: Casa Um: Sincronização manual parada.",
      "warning",
      {
        job: "meta_sync",
        tags: { alert_code: "run_stuck", tenant_id: "t1" },
        fingerprint: ["meta-alert", "run_stuck", "r1"],
      },
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("sem Sentry: log com prefixo, deduplicado por código+sujeito por 1 h", async () => {
    expect(await reportMetaAlerts([finding()])).toBe(1);
    expect(await reportMetaAlerts([finding()])).toBe(0);
    expect(await reportMetaAlerts([finding({ subjectId: "r2" })])).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/^\[meta-alert\] run_stuck: Casa Um: /);
  });

  it("dedupe: false ignora o dedupe", async () => {
    await reportMetaAlerts([finding()]);
    expect(await reportMetaAlerts([finding()], { dedupe: false })).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("depois de 1 h volta a logar", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      await reportMetaAlerts([finding()]);
      vi.setSystemTime(new Date(NOW.getTime() + 61 * 60_000));
      expect(await reportMetaAlerts([finding()])).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sem achados não faz nada", async () => {
    expect(await reportMetaAlerts([])).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("runMetaHealthStage", () => {
  it("sem achados pinga ok", async () => {
    expect(await runMetaHealthStage(NOW)).toEqual({ findings: 0, reported: 0, skipped: false });
    expect(pingHeartbeat).toHaveBeenCalledWith("meta_sync", true);
  });

  it("run parado: alerta e pinga falha", async () => {
    db.tables.meta_sync_runs = [
      {
        id: "r1",
        tenant_id: "t1",
        trigger_type: "manual",
        status: "running",
        created_at: hoursAgo(3),
      },
    ];
    db.tables.meta_ad_account_access = [eligibleAccess("a1", "t2", hoursAgo(30), hoursAgo(200))];
    expect(await runMetaHealthStage(NOW)).toEqual({ findings: 2, reported: 2, skipped: false });
    expect(pingHeartbeat).toHaveBeenCalledWith("meta_sync", false);
  });

  it("outros achados não derrubam o heartbeat", async () => {
    db.tables.meta_ad_account_access = [eligibleAccess("a1", "t2", hoursAgo(30), hoursAgo(200))];
    expect(await runMetaHealthStage(NOW)).toMatchObject({ findings: 1, skipped: false });
    expect(pingHeartbeat).toHaveBeenCalledWith("meta_sync", true);
  });

  it("roda no máximo uma vez a cada 10 min por processo", async () => {
    await runMetaHealthStage(NOW);
    const soon = new Date(NOW.getTime() + 9 * 60_000);
    expect(await runMetaHealthStage(soon)).toEqual({ findings: 0, reported: 0, skipped: true });
    expect(pingHeartbeat).toHaveBeenCalledTimes(1);
    const later = new Date(NOW.getTime() + 10 * 60_000);
    expect((await runMetaHealthStage(later)).skipped).toBe(false);
    expect(pingHeartbeat).toHaveBeenCalledTimes(2);
  });

  it("checagem que falha: registra, não lança e não pinga", async () => {
    db.failTable = "meta_sync_runs";
    expect(await runMetaHealthStage(NOW)).toEqual({ findings: 0, reported: 0, skipped: false });
    expect(pingHeartbeat).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("[meta-health] stage failed", expect.anything());
  });
});

describe("mensagens sem segredo", () => {
  it("nenhum achado carrega token", async () => {
    db.tables.meta_connections = [
      {
        id: "c1",
        tenant_id: "t1",
        status: "connected",
        auth_type: "system_user_token",
        connection_label: "Chave",
        meta_user_name: null,
        encrypted_access_token: "SEGREDO",
        token_expires_at: hoursAhead(1),
        data_access_expires_at: null,
      },
    ];
    db.tables.meta_ad_account_access = [freshAccess("c1")];
    const findings = await checkMetaHealth(NOW);
    expect(codes(findings)).toEqual(["token_expiring:c1"]);
    expect(JSON.stringify(findings)).not.toContain("SEGREDO");
  });
});
