// meta.functions (MB0): papel de admin nas ações que mexem na conexão, demo e casa
// suspensa no "Atualizar agora", token só cifrado, conta presa à conexão da mesma
// casa e lock renovado antes de cada job do worker. O compilador do TanStack Start
// troca o corpo do handler por um stub fora do servidor, então os testes chamam os
// `*For` que os handlers delegam.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "neq" | "in" | "is" | "gte"; column: string; value: unknown };
type Call = {
  table: string;
  action: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  filters: Filter[];
};

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  calls: [] as Call[],
  rpc: {} as Record<string, (args: Record<string, unknown>) => unknown>,
}));

const access = vi.hoisted(() => ({
  isAdmin: true,
  demo: false,
  operateError: null as string | null,
  blockedTenants: new Set<string>(),
  // Bloqueio de cobrança: como o guard real, só o ator super admin passa.
  billingLockedTenants: new Set<string>(),
  // Falha de leitura da casa (não é bloqueio).
  lookupErrorTenants: new Set<string>(),
}));

const token = vi.hoisted(() => ({ decrypt: vi.fn(async (value: string) => `plain:${value}`) }));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/meta-token.server", () => ({
  decryptMetaToken: token.decrypt,
  encryptMetaToken: vi.fn(async (value: string) => `enc:${value}`),
  metaTokenHint: () => "EAAG…1234",
}));

const TENANT_BLOCKED = vi.hoisted(
  () => "Tenant bloqueado para operacoes. Regularize a conta antes de continuar.",
);

vi.mock("@/lib/tenant-access.server", async () => {
  const { TenantBillingLockedError } = await import("@/lib/billing/billing-locked-error");
  return {
    TENANT_BLOCKED_MESSAGE: TENANT_BLOCKED,
    resolveCurrentTenantId: vi.fn(async () => "t1"),
    requireTenantAdmin: vi.fn(async (_client: unknown, tenantId: string, message: string) => {
      if (!access.isAdmin) throw new Error(message);
      return tenantId;
    }),
    assertTenantNotDemo: vi.fn(async () => {
      if (access.demo) throw new Error("DEMO_ACTION_BLOCKED");
    }),
    assertTenantCanOperate: vi.fn(async (tenantId: string, actor?: unknown) => {
      if (access.operateError) throw new Error(access.operateError);
      if (access.lookupErrorTenants.has(tenantId)) throw new Error("connection reset");
      if (access.blockedTenants.has(tenantId)) throw new Error(TENANT_BLOCKED);
      if (access.billingLockedTenants.has(tenantId) && !actor) throw new TenantBillingLockedError();
    }),
    listDemoTenantIds: vi.fn(async () => []),
  };
});

// Fake mínimo do PostgREST: filtros com caminho pontuado (`meta_connections.tenant_id`)
// leem o recurso embutido, como o `!inner` faz.
function valueAt(row: Row, column: string): unknown {
  return column.split(".").reduce<unknown>((current, key) => {
    if (Array.isArray(current)) current = current[0];
    return current && typeof current === "object" ? (current as Row)[key] : undefined;
  }, row);
}

function matches(row: Row, filters: Filter[]) {
  return filters.every(({ op, column, value }) => {
    const actual = valueAt(row, column);
    if (op === "eq") return actual === value;
    if (op === "neq") return actual !== value;
    if (op === "in") return (value as unknown[]).includes(actual);
    if (op === "is") return (actual ?? null) === value;
    return String(actual) >= String(value);
  });
}

function query(table: string) {
  const call: Call = { table, action: "select", filters: [] };
  let returning = false;
  const run = (mode: "many" | "single") => {
    db.calls.push(call);
    const rows = (db.tables[table] ??= []);
    if (call.action === "insert") {
      // Só o insert com retorno (o run) vira linha; os demais são apenas registrados.
      const inserted = [call.payload as Row[] | Row]
        .flat()
        .map((row) => ({ id: `${table}-${rows.length + 1}`, ...row }));
      if (returning) rows.push(...inserted);
      return { data: returning ? inserted[0] : null, error: null };
    }
    const hit = rows.filter((row) => matches(row, call.filters));
    if (call.action === "update") hit.forEach((row) => Object.assign(row, call.payload as Row));
    if (call.action !== "select" && !returning) return { data: null, error: null };
    return { data: mode === "single" ? (hit[0] ?? null) : hit, error: null };
  };
  const builder: Record<string, unknown> = {
    select: () => {
      if (call.action !== "select") returning = true;
      return builder;
    },
    insert: (payload: unknown) => Object.assign(call, { action: "insert", payload }) && builder,
    update: (payload: unknown) => Object.assign(call, { action: "update", payload }) && builder,
    upsert: (payload: unknown) => Object.assign(call, { action: "upsert", payload }) && builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => run("single"),
    single: async () => run("single"),
    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(run("many")).then(resolve, reject),
  };
  for (const op of ["eq", "neq", "in", "is", "gte"] as const) {
    builder[op] = (column: string, value: unknown) => {
      call.filters.push({ op, column, value });
      return builder;
    };
  }
  return builder;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => query(table),
    rpc: async (name: string, args: Record<string, unknown>) => ({
      data: db.rpc[name]?.(args) ?? null,
      error: null,
    }),
  },
}));

import {
  connectMetaSystemUserTokenFor,
  disconnectMetaConnectionFor,
  enqueueMetaSyncFor,
  processMetaSyncQueue,
  updateMetaAccountSelectionFor,
  validateMetaConnectionFor,
} from "./meta.functions";

type Invoke = (context: unknown, data: unknown) => Promise<unknown>;
const call = (fn: unknown, data: unknown) => (fn as Invoke)({ supabase: {}, userId: "u1" }, data);

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_MESSAGE = "Apenas administradores da casa podem alterar a conexão com a Meta.";
const LEGACY_MESSAGE = "Conexão antiga: reconecte usando a chave de acesso do Usuário do Sistema.";

const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));

beforeEach(() => {
  db.tables = {};
  db.calls = [];
  db.rpc = {};
  access.isAdmin = true;
  access.demo = false;
  access.operateError = null;
  access.blockedTenants = new Set();
  access.billingLockedTenants = new Set();
  access.lookupErrorTenants = new Set();
  token.decrypt.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

describe("papel: só o admin da casa mexe na conexão", () => {
  const actions: Array<[string, unknown, unknown, string]> = [
    ["connect", connectMetaSystemUserTokenFor, { accessToken: "E".repeat(60) }, ADMIN_MESSAGE],
    ["select", updateMetaAccountSelectionFor, { accountIds: [] }, ADMIN_MESSAGE],
    ["validate", validateMetaConnectionFor, { connectionId: CONNECTION_ID }, ADMIN_MESSAGE],
    ["disconnect", disconnectMetaConnectionFor, { connectionId: CONNECTION_ID }, ADMIN_MESSAGE],
    [
      "enqueue",
      enqueueMetaSyncFor,
      { days: 7 },
      "Apenas administradores da casa podem sincronizar a Meta.",
    ],
  ];

  it.each(actions)(
    "%s recusa quem não é admin, sem chamar a Meta nem gravar",
    async (_, fn, data, message) => {
      access.isAdmin = false;
      await expect(call(fn, data)).rejects.toThrow(message);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.calls.filter((item) => item.action !== "select")).toEqual([]);
    },
  );
});

describe("enqueueMetaSync", () => {
  it("bloqueia a casa demo", async () => {
    access.demo = true;
    await expect(call(enqueueMetaSyncFor, { days: 7 })).rejects.toThrow("DEMO_ACTION_BLOCKED");
    expect(db.calls).toEqual([]);
  });

  it("bloqueia a casa suspensa com a mensagem de operação", async () => {
    access.operateError = TENANT_BLOCKED;
    await expect(call(enqueueMetaSyncFor, { days: 7 })).rejects.toThrow("Tenant bloqueado");
    expect(db.calls).toEqual([]);
  });

  it("recusa a casa bloqueada por cobrança mesmo para o super admin", async () => {
    // O guard é chamado sem o ator: o claim nunca pegaria os jobs e o run ficaria
    // `queued` para sempre, travando as próximas sincronizações da casa.
    access.billingLockedTenants = new Set(["t1"]);
    await expect(call(enqueueMetaSyncFor, { days: 7 })).rejects.toThrow(
      "Acesso suspenso. Regularize a mensalidade",
    );
    expect(db.calls).toEqual([]);
  });

  it("só conta as contas cuja conexão é da mesma casa", async () => {
    db.tables.meta_ad_accounts = [
      {
        id: "a1",
        tenant_id: "t1",
        selected: true,
        meta_connections: { status: "connected", tenant_id: "t2" },
      },
    ];
    await expect(call(enqueueMetaSyncFor, { days: 7 })).rejects.toThrow(
      "Nenhuma conta Meta selecionada",
    );
  });
});

describe("token só cifrado", () => {
  it("validar uma conexão sem token cifrado pede reconexão e não chama a Meta", async () => {
    db.tables.meta_connections = [
      {
        id: CONNECTION_ID,
        tenant_id: "t1",
        status: "connected",
        access_token: "EAAG-legado-em-texto",
        encrypted_access_token: null,
      },
    ];
    await expect(call(validateMetaConnectionFor, { connectionId: CONNECTION_ID })).rejects.toThrow(
      LEGACY_MESSAGE,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(token.decrypt).not.toHaveBeenCalled();
  });
});

describe("processMetaSyncQueue", () => {
  function job(id: string, overrides: Row = {}) {
    return {
      id,
      run_id: "run-1",
      tenant_id: "t1",
      account_id: ACCOUNT_ID,
      days: 7,
      attempt_count: 1,
      max_attempts: 3,
      next_attempt_at: "2026-10-30T00:00:00Z",
      status: "queued",
      ...overrides,
    };
  }

  function claim(jobs: Row[]) {
    db.tables.meta_sync_jobs = jobs;
    db.rpc.claim_meta_sync_jobs = ({ p_worker_id }) => {
      jobs.forEach((item) => Object.assign(item, { status: "running", worker_id: p_worker_id }));
      return jobs.map((item) => ({ ...item }));
    };
  }

  function account(connection: Row) {
    db.tables.meta_ad_accounts = [
      {
        id: ACCOUNT_ID,
        tenant_id: "t1",
        connection_id: CONNECTION_ID,
        meta_ad_account_id: "act_1",
        selected: true,
        timezone_name: "America/Sao_Paulo",
        currency: "BRL",
        meta_connections: connection,
      },
    ];
  }

  // A leitura da conta de um job (filtra por id); as do agendado não filtram.
  const isAccountLoad = (item: Call) =>
    item.table === "meta_ad_accounts" &&
    item.action === "select" &&
    item.filters.some((filter) => filter.column === "id");

  const jobUpdates = () =>
    db.calls.filter((item) => item.table === "meta_sync_jobs" && item.action === "update");

  it("não sincroniza a conta cuja conexão é de outra casa", async () => {
    claim([job("j1")]);
    account({ tenant_id: "t2", status: "connected", encrypted_access_token: "enc-t2" });

    const result = await processMetaSyncQueue(1);

    expect(result.completed).toBe(0);
    expect(token.decrypt).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const accountSelect = db.calls.find(isAccountLoad);
    expect(accountSelect?.filters).toContainEqual({
      op: "eq",
      column: "meta_connections.tenant_id",
      value: "t1",
    });
  });

  it("conexão sem token cifrado falha de vez, sem chamar a Meta", async () => {
    claim([job("j1")]);
    account({
      tenant_id: "t1",
      status: "connected",
      access_token: "EAAG-legado-em-texto",
      encrypted_access_token: null,
    });

    const result = await processMetaSyncQueue(1);

    expect(result).toMatchObject({ completed: 0, retried: 0, failed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    const final = jobUpdates().at(-1)?.payload as Row;
    expect(final).toMatchObject({ status: "failed", last_error: LEGACY_MESSAGE });
  });

  it("renova o lock de cada job antes de processá-lo", async () => {
    claim([job("j1"), job("j2")]);
    account({ tenant_id: "t2", status: "connected", encrypted_access_token: "enc" });

    await processMetaSyncQueue(2);

    const sequence = db.calls
      .filter(
        (item) =>
          (item.table === "meta_sync_jobs" && item.action === "update") || isAccountLoad(item),
      )
      .map((item) => {
        const id = item.filters.find((filter) => filter.column === "id")?.value;
        const payload = (item.payload ?? {}) as Row;
        if (item.table === "meta_ad_accounts") return "load";
        return "status" in payload ? `finish:${id}` : `renew:${id}`;
      });
    expect(sequence).toEqual(["renew:j1", "load", "finish:j1", "renew:j2", "load", "finish:j2"]);
    const renew = jobUpdates()[0];
    expect(Object.keys(renew.payload as Row)).toEqual(["locked_at"]);
    expect(renew.filters.map((filter) => filter.column)).toEqual(["id", "worker_id", "status"]);
  });

  it("pula o job cujo lock outro worker já pegou", async () => {
    claim([job("j1")]);
    db.rpc.claim_meta_sync_jobs = () => [{ ...job("j1"), status: "running" }];
    db.tables.meta_sync_jobs = [{ ...job("j1"), status: "running", worker_id: "meta-outro" }];
    account({ tenant_id: "t1", status: "connected", encrypted_access_token: "enc" });

    const result = await processMetaSyncQueue(1);

    expect(result).toMatchObject({ claimed: 1, completed: 0, retried: 0, failed: 0 });
    expect(token.decrypt).not.toHaveBeenCalled();
    expect(jobUpdates()).toHaveLength(1);
  });

  it("o agendado ignora a casa suspensa", async () => {
    db.tables.meta_ad_accounts = [
      {
        id: "a1",
        tenant_id: "t1",
        selected: true,
        meta_connections: { status: "connected", tenant_id: "t1" },
      },
      {
        id: "a2",
        tenant_id: "t9",
        selected: true,
        meta_connections: { status: "connected", tenant_id: "t9" },
      },
    ];
    access.blockedTenants = new Set(["t9"]);

    const result = await processMetaSyncQueue(1);

    expect(result.scheduled).toBe(1);
    const runs = db.calls.filter(
      (item) => item.table === "meta_sync_runs" && item.action === "insert",
    );
    expect(runs.map((item) => (item.payload as Row).tenant_id)).toEqual(["t1"]);
  });
  it("devolve à fila, sem gastar tentativa, os jobs da casa bloqueada", async () => {
    claim([job("j1", { attempt_count: 2 }), job("j2", { tenant_id: "t2", run_id: "run-2" })]);
    db.tables.meta_sync_runs = [
      { id: "run-1", tenant_id: "t1", status: "running" },
      { id: "run-2", tenant_id: "t2", status: "queued" },
    ];
    account({ tenant_id: "t1", status: "connected", encrypted_access_token: "enc" });
    access.billingLockedTenants = new Set(["t2"]);

    const before = Date.now();
    const result = await processMetaSyncQueue(2);

    expect(result).toMatchObject({ claimed: 2, parked: 1 });
    const parked = jobUpdates().find(
      (item) => item.filters.find((filter) => filter.column === "id")?.value === "j2",
    );
    expect(parked?.filters.map((filter) => filter.column)).toEqual(["id", "worker_id"]);
    const payload = parked?.payload as Row;
    expect(payload).toMatchObject({ status: "retry", attempt_count: 0, locked_at: null });
    const nextAttempt = Date.parse(String(payload.next_attempt_at));
    expect(nextAttempt).toBeGreaterThanOrEqual(before + 59 * 60_000);
    // Só o j2 foi estacionado; o run-2 é recalculado e o j1 segue normal.
    expect(jobUpdates().filter((item) => item.filters.some((f) => f.value === "j2"))).toHaveLength(
      1,
    );
    expect(db.tables.meta_sync_runs.find((run) => run.id === "run-2")?.status).toBe("running");
    expect(db.calls.filter(isAccountLoad)).toHaveLength(1);
  });

  it("falha ao ler a casa não estaciona o job: registra e processa", async () => {
    claim([job("j1")]);
    account({ tenant_id: "t2", status: "connected", encrypted_access_token: "enc" });
    access.lookupErrorTenants = new Set(["t1"]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await processMetaSyncQueue(1);

    expect(result.parked).toBe(0);
    expect(db.calls.filter(isAccountLoad)).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith("[meta-sync tenant]", "t1", "connection reset");
    consoleError.mockRestore();
  });

  it("o agendado registra falha de leitura, mas não o bloqueio", async () => {
    db.tables.meta_ad_accounts = ["t1", "t8", "t9"].map((tenantId) => ({
      id: `a-${tenantId}`,
      tenant_id: tenantId,
      selected: true,
      meta_connections: { status: "connected", tenant_id: tenantId },
    }));
    access.blockedTenants = new Set(["t9"]);
    access.lookupErrorTenants = new Set(["t8"]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await processMetaSyncQueue(1);

    expect(result.scheduled).toBe(1);
    const scheduleLogs = consoleError.mock.calls.filter(([tag]) => tag === "[meta-sync schedule]");
    expect(scheduleLogs).toEqual([["[meta-sync schedule]", "t8", "connection reset"]]);
    consoleError.mockRestore();
  });
});
