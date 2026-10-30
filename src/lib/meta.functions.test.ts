// meta.functions (MB0 + MB1): papel de admin nas ações que mexem na conexão, demo e
// casa suspensa no "Atualizar agora", token só cifrado, conta presa à conexão da
// mesma casa, lock renovado antes de cada job do worker, RPCs transacionais de
// conectar/selecionar/desconectar, escolha da chave no worker, blocos de 30 dias e
// redescoberta diária. O compilador do TanStack Start
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
  range?: [number, number];
};

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  calls: [] as Call[],
  rpc: {} as Record<string, (args: Record<string, unknown>) => unknown>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  rpcErrors: {} as Record<string, string>,
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
  // O "cifrado" do mock não contém o texto do token, para o teste conferir que ele não vaza.
  encryptMetaToken: vi.fn(async (value: string) => `enc(${value.length})`),
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
    let hit = rows.filter((row) => matches(row, call.filters));
    if (call.action === "update") hit.forEach((row) => Object.assign(row, call.payload as Row));
    if (call.action !== "select" && !returning) return { data: null, error: null };
    if (call.range) hit = hit.slice(call.range[0], call.range[1] + 1);
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
    range: (from: number, to: number) => Object.assign(call, { range: [from, to] }) && builder,
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
    rpc: async (name: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ name, args });
      const failure = db.rpcErrors[name];
      if (failure) return { data: null, error: { message: failure } };
      return { data: db.rpc[name]?.(args) ?? null, error: null };
    },
  },
}));

import {
  MetaApiError,
  connectMetaSystemUserTokenFor,
  disconnectMetaConnectionFor,
  enqueueMetaSyncFor,
  getMetaConnectionSummaryFor,
  metaErrorLevel,
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

const fetchMock = vi.fn(
  async (_input: string | URL, _init?: unknown) => new Response("{}", { status: 500 }),
);

// Graph API falsa: cada teste responde por caminho e token.
type MetaReply = { status?: number; body: unknown } | undefined;
function graph(route: (path: string, token: string | null, url: URL) => MetaReply) {
  fetchMock.mockImplementation(async (input: string | URL) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v[^/]+/, "");
    const reply = route(path, url.searchParams.get("access_token"), url);
    if (!reply) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
}
const metaError = (code: number, message: string, status = 400, subcode?: number): MetaReply => ({
  status,
  body: { error: { code, message, ...(subcode === undefined ? {} : { error_subcode: subcode }) } },
});
/** Acesso ativo de uma conta marcada por uma chave conectada da mesma casa. */
function eligibleAccess(accountId: string, tenantId: string): Row {
  return {
    id: `access-${accountId}`,
    account_id: accountId,
    tenant_id: tenantId,
    status: "active",
    meta_ad_accounts: { tenant_id: tenantId, selected: true },
    meta_connections: { status: "connected", tenant_id: tenantId },
  };
}

const fetchedPaths = () =>
  fetchMock.mock.calls.map(([input]) => {
    const url = new URL(String(input));
    return `${url.pathname.replace(/^\/v[^/]+/, "")}?${url.searchParams.get("access_token")}`;
  });

// `meta_record_account_sync_success` como o RPC: só com o acesso ativo e a chave
// conectada, marca o sucesso do acesso e da chave e torna a chave a preferida.
function recordAccountSyncSuccess(args: Record<string, unknown>) {
  const accessRow = (db.tables.meta_ad_account_access ?? []).find(
    (row) =>
      row.account_id === args.p_account_id &&
      row.connection_id === args.p_connection_id &&
      row.tenant_id === args.p_tenant_id,
  );
  const connection = (db.tables.meta_connections ?? []).find(
    (row) => row.id === args.p_connection_id && row.tenant_id === args.p_tenant_id,
  );
  const account = (db.tables.meta_ad_accounts ?? []).find((row) => row.id === args.p_account_id);
  if (accessRow?.status !== "active" || connection?.status !== "connected" || !account) {
    return false;
  }
  const now = new Date().toISOString();
  Object.assign(accessRow, { last_success_at: now, last_error: null });
  Object.assign(account, { connection_id: args.p_connection_id });
  Object.assign(connection, { last_sync_at: now, last_error: null });
  return true;
}

// `meta_revoke_account_access` como o RPC (a parte que o worker enxerga): revoga o
// acesso ativo da chave à conta e grava o erro.
function revokeAccountAccess(args: Record<string, unknown>) {
  const accessRow = (db.tables.meta_ad_account_access ?? []).find(
    (row) =>
      row.account_id === args.p_account_id &&
      row.connection_id === args.p_connection_id &&
      row.tenant_id === args.p_tenant_id &&
      row.status === "active",
  );
  if (!accessRow) return { revoked: false, moved: 0, stopped: 0 };
  Object.assign(accessRow, {
    status: "revoked",
    revoked_at: new Date().toISOString(),
    last_error: args.p_error,
  });
  return { revoked: true, moved: 0, stopped: 0 };
}

beforeEach(() => {
  db.tables = {};
  db.calls = [];
  db.rpc = {
    meta_record_account_sync_success: recordAccountSyncSuccess,
    meta_revoke_account_access: revokeAccountAccess,
  };
  db.rpcCalls = [];
  db.rpcErrors = {};
  access.isAdmin = true;
  access.demo = false;
  access.operateError = null;
  access.blockedTenants = new Set();
  access.billingLockedTenants = new Set();
  access.lookupErrorTenants = new Set();
  token.decrypt.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response("{}", { status: 500 }));
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
      expect(db.rpcCalls).toEqual([]);
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
    db.tables.meta_ad_account_access = [
      {
        id: "acc-1",
        account_id: "a1",
        tenant_id: "t1",
        status: "active",
        meta_ad_accounts: { tenant_id: "t1", selected: true },
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

  // A conta e um acesso ativo por chave. Cada conexão é o mesmo objeto na tabela e
  // no recurso embutido, então o update da conexão aparece no acesso. A primeira é
  // a preferida da conta.
  function account(...connections: Row[]) {
    const rows = connections.map((connection) =>
      Object.assign(connection, {
        id: connection.id ?? CONNECTION_ID,
        auth_type: "system_user_token",
        // Lista recém-lida: a redescoberta não mexe nestas conexões.
        accounts_discovered_at: connection.accounts_discovered_at ?? new Date().toISOString(),
      }),
    );
    db.tables.meta_connections = rows;
    db.tables.meta_ad_accounts = [
      {
        id: ACCOUNT_ID,
        tenant_id: "t1",
        connection_id: rows[0]?.id ?? CONNECTION_ID,
        meta_ad_account_id: "act_1",
        selected: true,
        timezone_name: "America/Sao_Paulo",
        currency: "BRL",
      },
    ];
    db.tables.meta_ad_account_access = rows.map((connection) => ({
      id: `access-${connection.id}`,
      tenant_id: "t1",
      account_id: ACCOUNT_ID,
      connection_id: connection.id,
      status: "active",
      meta_connections: connection,
    }));
  }

  const isAccessLoad = (item: Call) =>
    item.table === "meta_ad_account_access" &&
    item.action === "select" &&
    item.filters.some((filter) => filter.column === "account_id");

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
    const accessSelect = db.calls.find(isAccessLoad);
    expect(accessSelect?.filters).toContainEqual({
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
    db.tables.meta_ad_account_access = [eligibleAccess("a1", "t1"), eligibleAccess("a2", "t9")];
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
    db.tables.meta_ad_account_access = ["t1", "t8", "t9"].map((tenantId) =>
      eligibleAccess(`a-${tenantId}`, tenantId),
    );
    access.blockedTenants = new Set(["t9"]);
    access.lookupErrorTenants = new Set(["t8"]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await processMetaSyncQueue(1);

    expect(result.scheduled).toBe(1);
    const scheduleLogs = consoleError.mock.calls.filter(([tag]) => tag === "[meta-sync schedule]");
    expect(scheduleLogs).toEqual([["[meta-sync schedule]", "t8", "connection reset"]]);
    consoleError.mockRestore();
  });

  describe("MB1-05 escolha da chave", () => {
    const C1 = "c1";
    const C2 = "c2";
    const conn = (id: string, overrides: Row = {}): Row => ({
      id,
      tenant_id: "t1",
      status: "connected",
      encrypted_access_token: `enc-${id}`,
      token_validated_at: "2026-10-29T00:00:00Z",
      ...overrides,
    });
    const tokenOf = (id: string) => `plain:enc-${id}`;

    // Leitura normal da conta; `override` responde antes para um token.
    function readsWith(
      override: (path: string, token: string | null) => MetaReply = () => undefined,
    ) {
      graph((path, accessToken) => {
        const forced = override(path, accessToken);
        if (forced) return forced;
        if (path === "/me/permissions")
          return { body: { data: [{ permission: "ads_read", status: "granted" }] } };
        if (path === "/act_1/ads") return { body: { data: [] } };
        if (path === "/act_1/insights") return { body: { data: [{ ad_id: "ad1", spend: "1" }] } };
        return undefined;
      });
      db.rpc.replace_meta_ad_metrics = () => 5;
    }

    const accessRow = (id: string) =>
      db.tables.meta_ad_account_access.find((row) => row.connection_id === id) as Row;
    const finalJob = () => jobUpdates().at(-1)?.payload as Row;

    it("usa a preferida quando ela está conectada", async () => {
      claim([job("j1")]);
      account(conn(C1), conn(C2, { token_validated_at: "2026-10-30T00:00:00Z" }));
      readsWith();

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 1, failed: 0 });
      expect(new Set(fetchedPaths().map((path) => path.split("?")[1]))).toEqual(
        new Set([tokenOf(C1)]),
      );
      expect(accessRow(C1).last_success_at).toEqual(expect.any(String));
      expect(accessRow(C2).last_success_at).toBeUndefined();
    });

    it("cai para a segunda chave quando a preferida está em erro", async () => {
      claim([job("j1")]);
      account(conn(C1, { status: "error" }), conn(C2));
      readsWith();

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 1, retried: 0, failed: 0 });
      expect(fetchedPaths().every((path) => path.endsWith(tokenOf(C2)))).toBe(true);
      expect(db.tables.meta_ad_accounts[0]).toMatchObject({
        connection_id: C2,
        sync_status: "healthy",
        last_row_count: 5,
      });
      expect(accessRow(C2)).toMatchObject({ status: "active", last_error: null });
      expect(accessRow(C2).last_success_at).toEqual(expect.any(String));
      expect(finalJob()).toMatchObject({ status: "completed", rows_imported: 5 });
    });

    it("erro de permissão na conta revoga só aquele acesso e tenta a próxima chave", async () => {
      claim([job("j1")]);
      const first = conn(C1);
      account(first, conn(C2));
      readsWith((path, accessToken) =>
        accessToken === tokenOf(C1) && path === "/act_1/ads"
          ? metaError(200, "(#200) Ad account owner has NOT grant ads_management or ads_read")
          : undefined,
      );

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 1, failed: 0 });
      expect(accessRow(C1)).toMatchObject({
        status: "revoked",
        last_error: "(#200) Ad account owner has NOT grant ads_management or ads_read",
      });
      expect(accessRow(C1).revoked_at).toEqual(expect.any(String));
      // A revogação passa pelo RPC (sob a trava da casa), nunca por update direto.
      expect(db.rpcCalls.find((item) => item.name === "meta_revoke_account_access")?.args).toEqual({
        p_tenant_id: "t1",
        p_account_id: ACCOUNT_ID,
        p_connection_id: C1,
        p_error: "(#200) Ad account owner has NOT grant ads_management or ads_read",
      });
      expect(
        db.calls.filter(
          (item) => item.table === "meta_ad_account_access" && item.action === "update",
        ),
      ).toEqual([]);
      // A chave continua boa para as outras contas.
      expect(first.status).toBe("connected");
      expect(db.tables.meta_ad_accounts[0].connection_id).toBe(C2);
    });

    it("falha no meta_revoke_account_access é registrada e a próxima chave lê", async () => {
      claim([job("j1")]);
      account(conn(C1), conn(C2));
      readsWith((path, accessToken) =>
        accessToken === tokenOf(C1) && path === "/act_1/ads"
          ? metaError(100, "Object with ID 'act_1' does not exist", 400, 33)
          : undefined,
      );
      db.rpcErrors.meta_revoke_account_access = "deadlock detected";
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 1, failed: 0, retried: 0 });
      expect(fetchedPaths().some((path) => path.endsWith(tokenOf(C2)))).toBe(true);
      expect(finalJob()).toMatchObject({ status: "completed" });
      expect(consoleError).toHaveBeenCalledWith(
        "[meta-sync revoke]",
        ACCOUNT_ID,
        "deadlock detected",
      );
      consoleError.mockRestore();
    });

    it("270 (nível de acesso do app) numa chamada act_ é erro da chave, não da conta", async () => {
      claim([job("j1")]);
      const first = conn(C1);
      account(first);
      readsWith((path) =>
        path === "/act_1/ads"
          ? metaError(
              270,
              "(#270) This Ads API request is not allowed for apps with development access level",
            )
          : undefined,
      );

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 0, failed: 1 });
      expect(first).toMatchObject({
        status: "error",
        last_error: "O app da Meta não tem o nível de acesso necessário (Standard Access).",
      });
      expect(accessRow(C1).status).toBe("active");
      expect(db.rpcCalls.some((item) => item.name === "meta_revoke_account_access")).toBe(false);
      expect(permissionCalls()).toEqual([]);
      expect(finalJob()).toMatchObject({
        status: "failed",
        last_error: "O app da Meta não tem o nível de acesso necessário (Standard Access).",
      });
    });

    it("erro da chave põe a conexão em erro e tenta a próxima", async () => {
      claim([job("j1")]);
      const first = conn(C1);
      account(first, conn(C2));
      readsWith((_path, accessToken) =>
        accessToken === tokenOf(C1) ? metaError(190, "Session has expired") : undefined,
      );

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 1, failed: 0 });
      expect(first).toMatchObject({ status: "error", last_error: "Session has expired" });
      expect(accessRow(C1).status).toBe("active");
      expect(finalJob()).toMatchObject({ status: "completed" });
    });

    it("sem chave restante o job falha de vez, mesmo com tentativas sobrando", async () => {
      claim([job("j1", { attempt_count: 1, max_attempts: 3 })]);
      account(conn(C1));
      readsWith(() => metaError(463, "Session has expired on Thursday"));

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 0, retried: 0, failed: 1 });
      expect(finalJob()).toMatchObject({
        status: "failed",
        last_error: "Session has expired on Thursday",
      });
      expect(db.tables.meta_ad_accounts[0]).toMatchObject({ sync_status: "error" });
    });

    it("conta sem nenhum acesso ativo falha de vez sem chamar a Meta", async () => {
      claim([job("j1")]);
      account(conn(C1));
      db.tables.meta_ad_account_access[0].status = "revoked";

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 0, failed: 1 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(finalJob()).toMatchObject({
        status: "failed",
        last_error: "Nenhuma chave conectada alcança esta conta.",
      });
    });

    it("erro de leitura (temporário) não troca de chave: o job volta para a fila", async () => {
      claim([job("j1")]);
      const first = conn(C1);
      account(first, conn(C2));
      readsWith((_path, accessToken) =>
        accessToken === tokenOf(C1)
          ? metaError(2, "Service temporarily unavailable", 503)
          : undefined,
      );

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 0, retried: 1 });
      expect(fetchedPaths().some((path) => path.endsWith(tokenOf(C2)))).toBe(false);
      expect(first.status).toBe("connected");
      expect(accessRow(C1).status).toBe("active");
      expect(finalJob()).toMatchObject({ status: "retry" });
    });

    const retryDelayMinutes = () => {
      const nextAttempt = Date.parse(String(finalJob().next_attempt_at));
      return Math.round((nextAttempt - Date.now()) / 60_000);
    };

    it.each([
      [4, 1, 15],
      [17, 2, 30],
      [613, 3, 60],
      [80004, 1, 15],
    ])("rate limit (código %i) na tentativa %i volta em %i min", async (code, attempt, minutes) => {
      claim([job("j1", { attempt_count: attempt, max_attempts: 5 })]);
      const first = conn(C1);
      account(first, conn(C2));
      readsWith((path) =>
        path === "/act_1/insights" ? metaError(code, "User request limit reached") : undefined,
      );

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 0, retried: 1 });
      expect(finalJob()).toMatchObject({ status: "retry" });
      expect(retryDelayMinutes()).toBe(minutes);
      // Rate limit é leitura: sem trocar de chave nem revogar.
      expect(first.status).toBe("connected");
      expect(accessRow(C1).status).toBe("active");
      expect(fetchedPaths().some((path) => path.endsWith(tokenOf(C2)))).toBe(false);
    });

    it("outro erro de leitura mantém a espera de 2^n min", async () => {
      claim([job("j1", { attempt_count: 2, max_attempts: 5 })]);
      account(conn(C1));
      readsWith((path) =>
        path === "/act_1/insights"
          ? metaError(2, "Service temporarily unavailable", 503)
          : undefined,
      );

      await processMetaSyncQueue(1);

      expect(finalJob()).toMatchObject({ status: "retry" });
      expect(retryDelayMinutes()).toBe(4);
    });

    it("um job de 90 dias lê 3 blocos de 30 dias e soma as linhas", async () => {
      claim([job("j1", { days: 90, run_id: "run-b" })]);
      account(conn(C1));
      readsWith();

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 1 });
      const replaces = db.rpcCalls.filter((item) => item.name === "replace_meta_ad_metrics");
      expect(replaces).toHaveLength(3);
      const windows = replaces.map((item) => [item.args.p_since, item.args.p_until] as string[]);
      // Consecutivos, do mais antigo ao mais recente, cada um com no máximo 30 dias.
      for (let index = 1; index < windows.length; index += 1) {
        const previousEnd = new Date(`${windows[index - 1][1]}T00:00:00Z`);
        previousEnd.setUTCDate(previousEnd.getUTCDate() + 1);
        expect(windows[index][0]).toBe(previousEnd.toISOString().slice(0, 10));
      }
      for (const [since, until] of windows) {
        const days = (Date.parse(until) - Date.parse(since)) / 86_400_000 + 1;
        expect(days).toBeLessThanOrEqual(30);
      }
      const insightCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/insights"),
      );
      expect(insightCalls).toHaveLength(3);
      expect(finalJob()).toMatchObject({ status: "completed", rows_imported: 15 });
      // O lock é renovado antes do job e entre os blocos.
      const renewals = jobUpdates().filter(
        (item) => Object.keys(item.payload as Row).join() === "locked_at",
      );
      expect(renewals).toHaveLength(3);
    });

    it("falha no segundo bloco falha o job; o primeiro bloco já gravado fica", async () => {
      claim([job("j1", { days: 90, attempt_count: 3, max_attempts: 3 })]);
      account(conn(C1));
      let insightReads = 0;
      readsWith((path) => {
        if (path !== "/act_1/insights") return undefined;
        insightReads += 1;
        return insightReads === 2 ? metaError(1, "An unknown error occurred", 500) : undefined;
      });

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 0, failed: 1 });
      expect(db.rpcCalls.filter((item) => item.name === "replace_meta_ad_metrics")).toHaveLength(1);
      expect(finalJob()).toMatchObject({ status: "failed" });
    });

    const permissionCalls = () =>
      fetchedPaths().filter((path) => path.startsWith("/me/permissions?"));

    it("chave sem ads_read: conexão em erro, nenhum acesso revogado, a próxima chave lê", async () => {
      claim([job("j1")]);
      const first = conn(C1);
      account(first, conn(C2));
      // Outra conta que a mesma chave alcança: o acesso dela não pode mudar.
      const otherAccess: Row = {
        id: "access-outra",
        tenant_id: "t1",
        account_id: "outra-conta",
        connection_id: C1,
        status: "active",
        meta_connections: first,
      };
      db.tables.meta_ad_account_access.push(otherAccess);
      readsWith((path, accessToken) => {
        if (accessToken !== tokenOf(C1)) return undefined;
        if (path === "/me/permissions") return { body: { data: [] } };
        if (path === "/act_1/ads") return metaError(200, "(#200) Requires ads_read permission");
        return undefined;
      });

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 1, failed: 0 });
      expect(first).toMatchObject({
        status: "error",
        last_error: "A chave perdeu a permissão ads_read.",
      });
      expect(accessRow(C1)).toMatchObject({ status: "active" });
      expect(accessRow(C1).revoked_at).toBeUndefined();
      expect(otherAccess).toMatchObject({ status: "active" });
      expect(db.tables.meta_ad_accounts[0].connection_id).toBe(C2);
      expect(permissionCalls()).toEqual([`/me/permissions?${tokenOf(C1)}`]);
    });

    it("código 100/33 revoga o acesso sem consultar as permissões", async () => {
      claim([job("j1")]);
      const first = conn(C1);
      account(first, conn(C2));
      readsWith((path, accessToken) =>
        accessToken === tokenOf(C1) && path === "/act_1/ads"
          ? metaError(100, "Object with ID 'act_1' does not exist", 400, 33)
          : undefined,
      );

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 1 });
      expect(accessRow(C1)).toMatchObject({ status: "revoked" });
      expect(first.status).toBe("connected");
      expect(permissionCalls()).toEqual([]);
    });

    it("2635 (versão da API) é leitura: nova tentativa, sem revogar nem trocar de chave", async () => {
      claim([job("j1")]);
      const first = conn(C1);
      account(first, conn(C2));
      readsWith((path) =>
        path === "/act_1/insights"
          ? metaError(2635, "You are calling a deprecated version of the Ads API")
          : undefined,
      );

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 0, retried: 1 });
      expect(first.status).toBe("connected");
      expect(accessRow(C1).status).toBe("active");
      expect(fetchedPaths().some((path) => path.endsWith(tokenOf(C2)))).toBe(false);
      expect(permissionCalls()).toEqual([]);
      expect(finalJob()).toMatchObject({ status: "retry" });
    });

    it("a leitura de permissões é feita uma vez por chave no tick; falha nela não revoga", async () => {
      claim([job("j1"), job("j2")]);
      const first = conn(C1);
      account(first);
      readsWith((path) => {
        if (path === "/me/permissions") return metaError(1, "An unknown error occurred", 500);
        if (path === "/act_1/ads") return metaError(10, "(#10) Permission denied");
        return undefined;
      });

      const result = await processMetaSyncQueue(2);

      expect(result).toMatchObject({ completed: 0, retried: 2, failed: 0 });
      expect(permissionCalls()).toHaveLength(1);
      expect(first.status).toBe("connected");
      expect(accessRow(C1).status).toBe("active");
    });

    it("erro da chave não ressuscita uma chave desconectada no meio da leitura", async () => {
      claim([job("j1")]);
      const first = conn(C1);
      account(first, conn(C2));
      readsWith((_path, accessToken) => {
        if (accessToken !== tokenOf(C1)) return undefined;
        first.status = "disabled";
        return metaError(190, "Session has expired");
      });

      await processMetaSyncQueue(1);

      expect(first.status).toBe("disabled");
      const connectionUpdates = db.calls.filter(
        (item) => item.table === "meta_connections" && item.action === "update",
      );
      expect(connectionUpdates.length).toBeGreaterThan(0);
      for (const update of connectionUpdates) {
        expect(update.filters).toContainEqual({ op: "neq", column: "status", value: "disabled" });
      }
    });

    it("sucesso grava pelo meta_record_account_sync_success; se ele não aplica, o job termina", async () => {
      claim([job("j1")]);
      account(conn(C1));
      readsWith();
      db.rpc.meta_record_account_sync_success = () => false;
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await processMetaSyncQueue(1);

      expect(result).toMatchObject({ completed: 1 });
      expect(
        db.rpcCalls.find((item) => item.name === "meta_record_account_sync_success")?.args,
      ).toEqual({ p_tenant_id: "t1", p_account_id: ACCOUNT_ID, p_connection_id: C1 });
      // Nada de update direto na conexão nem no acesso no caminho de sucesso.
      expect(
        db.calls.filter(
          (item) =>
            (item.table === "meta_connections" || item.table === "meta_ad_account_access") &&
            item.action === "update",
        ),
      ).toEqual([]);
      expect(finalJob()).toMatchObject({ status: "completed", rows_imported: 5 });
      expect(consoleWarn).toHaveBeenCalled();
      consoleWarn.mockRestore();
    });

    describe("orçamento do tick", () => {
      // Relógio do orçamento: avança quando o teste manda.
      function clock() {
        const state = { t: 1_000_000 };
        return { state, now: () => state.t };
      }
      const releases = () =>
        jobUpdates().filter((item) => (item.payload as Row).status === "queued");

      it("passados 40 s, o job seguinte volta para a fila sem gastar tentativa e a redescoberta não roda", async () => {
        claim([job("j1"), job("j2", { attempt_count: 2 })]);
        account(conn(C1));
        db.tables.meta_connections.push({
          id: "c-stale",
          tenant_id: "t1",
          status: "connected",
          auth_type: "system_user_token",
          encrypted_access_token: "enc-stale",
          accounts_discovered_at: null,
        });
        const { state, now } = clock();
        readsWith((path) => {
          if (path === "/act_1/insights") state.t += 41_000;
          return undefined;
        });

        const result = await processMetaSyncQueue(2, { now });

        expect(result).toMatchObject({ completed: 1, released: 1, discovered: 0 });
        const [release] = releases();
        expect(release.payload).toEqual({ status: "queued", locked_at: null, attempt_count: 1 });
        expect(release.filters.map((filter) => filter.column)).toEqual(["id", "worker_id"]);
        expect(release.filters[0].value).toBe("j2");
        expect(db.calls.filter(isAccountLoad)).toHaveLength(1);
        expect(fetchedPaths().some((path) => path.startsWith("/me/adaccounts"))).toBe(false);
      });

      it("um backfill como primeiro job que termina dentro do orçamento deixa o seguinte começar", async () => {
        claim([job("j1", { days: 90 }), job("j2")]);
        account(conn(C1));
        const { state, now } = clock();
        readsWith((path) => {
          if (path === "/act_1/insights") state.t += 5_000;
          return undefined;
        });

        const result = await processMetaSyncQueue(2, { now });

        expect(result).toMatchObject({ completed: 2, released: 0 });
        expect(releases()).toEqual([]);
        // 3 blocos do j1 + 1 do j2.
        expect(db.rpcCalls.filter((item) => item.name === "replace_meta_ad_metrics")).toHaveLength(
          4,
        );
      });

      it("backfill seguido de outro backfill: o segundo começa e volta para a fila entre blocos ao estourar", async () => {
        claim([job("j1", { days: 90 }), job("j2", { days: 90, attempt_count: 1 })]);
        account(conn(C1));
        const { state, now } = clock();
        let insightReads = 0;
        readsWith((path) => {
          if (path !== "/act_1/insights") return undefined;
          insightReads += 1;
          // j1: 3 blocos em 30 s; o primeiro bloco do j2 passa dos 40 s.
          state.t += insightReads <= 3 ? 10_000 : 15_000;
          return undefined;
        });

        const result = await processMetaSyncQueue(2, { now });

        expect(result).toMatchObject({ completed: 1, released: 1, failed: 0, retried: 0 });
        expect(db.rpcCalls.filter((item) => item.name === "replace_meta_ad_metrics")).toHaveLength(
          4,
        );
        const [release] = releases();
        expect(release.filters[0].value).toBe("j2");
        expect(release.payload).toEqual({ status: "queued", locked_at: null, attempt_count: 0 });
      });

      it("o primeiro job nunca é interrompido pelo orçamento", async () => {
        claim([job("j1", { days: 90 })]);
        account(conn(C1));
        const { state, now } = clock();
        readsWith((path) => {
          if (path === "/act_1/insights") state.t += 41_000;
          return undefined;
        });

        const result = await processMetaSyncQueue(1, { now });

        expect(result).toMatchObject({ completed: 1, released: 0 });
        expect(finalJob()).toMatchObject({ status: "completed", rows_imported: 15 });
      });

      it("backfill depois do primeiro job volta para a fila entre blocos quando o tick estoura", async () => {
        claim([job("j1"), job("j2", { days: 90, attempt_count: 1 })]);
        account(conn(C1));
        const { state, now } = clock();
        let insightReads = 0;
        readsWith((path) => {
          if (path !== "/act_1/insights") return undefined;
          insightReads += 1;
          // O j1 lê 1 bloco rápido; o primeiro bloco do j2 passa do orçamento.
          if (insightReads === 2) state.t += 41_000;
          return undefined;
        });

        const result = await processMetaSyncQueue(2, { now });

        expect(result).toMatchObject({ completed: 1, released: 1, failed: 0, retried: 0 });
        // j1 (1 bloco) + o primeiro bloco do j2, que fica gravado.
        expect(db.rpcCalls.filter((item) => item.name === "replace_meta_ad_metrics")).toHaveLength(
          2,
        );
        const [release] = releases();
        expect(release.filters[0].value).toBe("j2");
        expect(release.payload).toEqual({ status: "queued", locked_at: null, attempt_count: 0 });
        expect(db.tables.meta_ad_accounts[0].sync_status).toBe("queued");
      });

      it("lock perdido entre blocos: o job para sem ser marcado como falho", async () => {
        claim([job("j1", { days: 90 })]);
        account(conn(C1));
        readsWith((path) => {
          // Outro worker pega o job depois do primeiro bloco.
          if (path === "/act_1/insights") db.tables.meta_sync_jobs[0].worker_id = "meta-outro";
          return undefined;
        });
        const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const result = await processMetaSyncQueue(1);

        expect(result).toMatchObject({ completed: 0, failed: 0, retried: 0, released: 0 });
        expect(db.rpcCalls.filter((item) => item.name === "replace_meta_ad_metrics")).toHaveLength(
          1,
        );
        // Só as renovações do lock: nenhum update de status no job.
        expect(jobUpdates().every((item) => !("status" in (item.payload as Row)))).toBe(true);
        consoleWarn.mockRestore();
      });

      it("os jobs são processados antes do agendamento", async () => {
        claim([job("j1")]);
        account(conn(C1));
        readsWith();
        let callsAtClaim = -1;
        const claimJobs = db.rpc.claim_meta_sync_jobs;
        db.rpc.claim_meta_sync_jobs = (args) => {
          callsAtClaim = db.calls.length;
          return claimJobs(args);
        };

        await processMetaSyncQueue(1);

        const finish = db.calls.findIndex(
          (item) =>
            item.table === "meta_sync_jobs" &&
            item.action === "update" &&
            (item.payload as Row).status === "completed",
        );
        const scheduleLookup = db.calls.findIndex(
          (item) =>
            item.table === "meta_ad_account_access" &&
            item.action === "select" &&
            !item.filters.some((filter) => filter.column === "account_id"),
        );
        expect(callsAtClaim).toBe(0);
        expect(finish).toBeGreaterThan(-1);
        expect(scheduleLookup).toBeGreaterThan(finish);
      });
    });
  });
});

describe("metaErrorLevel", () => {
  const apiError = (code: number | null, path: string | null, subcode: number | null = null) =>
    new MetaApiError("erro", { code, subcode, status: 400, path });

  it.each([
    ["190", apiError(190, "/act_1/ads"), "token"],
    ["102", apiError(102, "/act_1/ads"), "token"],
    ["subcódigo 463", apiError(1, "/act_1/ads", 463), "token"],
    ["467", apiError(467, "/act_1/insights"), "token"],
    ["200 em /me/adaccounts", apiError(200, "/me/adaccounts"), "token"],
    ["10 em /me/permissions", apiError(10, "/me/permissions"), "token"],
    ["100/33", apiError(100, "/act_1/ads", 33), "account"],
    ["200 em act_", apiError(200, "/act_1/insights"), "account_permission"],
    ["10 em act_", apiError(10, "/act_1/ads"), "account_permission"],
    ["2635 em act_", apiError(2635, "/act_1/insights"), null],
    ["270 em act_ (nível de acesso do app)", apiError(270, "/act_1/ads"), "token"],
    ["279 em act_", apiError(279, "/act_1/insights"), "token"],
    ["275 em /me/adaccounts", apiError(275, "/me/adaccounts"), "token"],
    ["269 em act_ segue permissão", apiError(269, "/act_1/ads"), "account_permission"],
    ["rate limit 17 em act_", apiError(17, "/act_1/insights"), null],
    ["200 em /app", apiError(200, "/app"), null],
    ["100 sem subcódigo 33", apiError(100, "/act_1/ads"), null],
    ["desconhecido", apiError(1, "/act_1/ads"), null],
  ] as const)("%s", (_label, error, level) => {
    expect(metaErrorLevel(error)).toBe(level);
  });

  it("conexão antiga é erro da chave; texto solto não é erro de conta", () => {
    expect(metaErrorLevel(new Error(LEGACY_MESSAGE))).toBe("token");
    expect(metaErrorLevel(new Error("O token não possui mais acesso"))).toBeNull();
  });
});

describe("contas elegíveis paginadas", () => {
  it("o agendado lê todas as páginas de acessos (mais de 1000)", async () => {
    db.tables.meta_ad_account_access = [
      ...Array.from({ length: 1000 }, (_, index) => eligibleAccess(`a${index}`, "t1")),
      eligibleAccess("a-t2", "t2"),
    ];

    const result = await processMetaSyncQueue(1);

    expect(result.scheduled).toBe(2);
    const pages = db.calls
      .filter((item) => item.table === "meta_ad_account_access" && item.range)
      .map((item) => item.range);
    expect(pages).toEqual(
      expect.arrayContaining([
        [0, 999],
        [1000, 1999],
      ]),
    );
  });
});

describe("resumo da conexão", () => {
  it("lê os acessos ativos em páginas de 1000, em ordem estável", async () => {
    db.tables.meta_connections = [{ id: "c1", tenant_id: "t1", status: "connected" }];
    db.tables.meta_ad_accounts = [
      { id: "a1", tenant_id: "t1" },
      { id: "a2", tenant_id: "t1" },
    ];
    db.tables.meta_ad_account_access = [
      ...Array.from({ length: 1000 }, (_, index) => ({
        id: `x${index}`,
        tenant_id: "t1",
        status: "active",
        account_id: "a1",
        connection_id: `c${index}`,
      })),
      { id: "y", tenant_id: "t1", status: "active", account_id: "a2", connection_id: "c1" },
      { id: "z", tenant_id: "t2", status: "active", account_id: "a2", connection_id: "c9" },
    ];

    const summary = await getMetaConnectionSummaryFor({ supabase: {} });

    const pages = db.calls
      .filter((item) => item.table === "meta_ad_account_access")
      .map((item) => item.range);
    expect(pages).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    const byId = new Map(summary.accounts.map((item) => [item.id, item.access_connection_ids]));
    expect(byId.get("a1")).toHaveLength(1000);
    expect(byId.get("a2")).toEqual(["c1"]);
  });
});

describe("MB1-02 conectar via RPC", () => {
  const TOKEN = `EAAG${"x".repeat(60)}`;
  const GRANTED = { body: { data: [{ permission: "ads_read", status: "granted" }] } };

  function metaAccounts() {
    graph((path) => {
      if (path === "/me") return { body: { id: "su1", name: "Mídia Interna" } };
      if (path === "/app") return { body: { id: "app1", name: "Betleads Ads" } };
      if (path === "/me/permissions") return GRANTED;
      if (path === "/me/adaccounts")
        return {
          body: {
            data: [
              { id: "act_1", account_id: "1", name: "SA 01", business: { id: "b1", name: "BM 1" } },
              { id: "act_2", account_id: "2", name: "SA 02", business: { id: "b2", name: "BM 2" } },
              { id: "act_3", account_id: "3", currency: "USD" },
            ],
          },
        };
      return undefined;
    });
  }

  it("chama meta_connect_token com o token cifrado e devolve as contagens", async () => {
    metaAccounts();
    db.rpc.meta_connect_token = () => ({
      connection_id: CONNECTION_ID,
      created: true,
      accounts_total: 3,
      accounts_new: 2,
      accounts_revoked: 0,
      businesses: 3,
    });

    const result = (await call(connectMetaSystemUserTokenFor, { accessToken: TOKEN })) as Row;

    const rpc = db.rpcCalls.find((item) => item.name === "meta_connect_token");
    expect(rpc?.args).toMatchObject({
      p_tenant_id: "t1",
      p_actor: "u1",
      p_connection: {
        meta_user_id: "su1",
        meta_user_name: "Mídia Interna",
        app_id: "app1",
        app_name: "Betleads Ads",
        encrypted_access_token: `enc(${TOKEN.length})`,
        token_hint: "EAAG…1234",
        scopes: ["ads_read"],
        label: "Mídia Interna",
      },
    });
    const accounts = rpc?.args.p_accounts as Row[];
    expect(accounts).toHaveLength(3);
    expect(accounts[0]).toMatchObject({
      meta_ad_account_id: "act_1",
      account_id: "1",
      name: "SA 01",
      business_id: "b1",
      business_name: "BM 1",
    });
    expect(accounts[2]).toMatchObject({ business_id: null, currency: "USD" });
    // O token em texto nunca sai para o banco, e nada é gravado fora do RPC.
    expect(JSON.stringify(db.rpcCalls)).not.toContain(TOKEN);
    expect(db.calls.filter((item) => item.action !== "select")).toEqual([]);
    expect(result).toMatchObject({
      connectionId: CONNECTION_ID,
      created: true,
      accountsTotal: 3,
      accountsNew: 2,
      businesses: 3,
      userName: "Mídia Interna",
      permissions: ["ads_read"],
    });
    expect(result.accounts).toHaveLength(3);
  });

  it("o rótulo cai no nome do app quando o Usuário do Sistema não tem nome", async () => {
    graph((path) => {
      if (path === "/me") return { body: { id: "su1" } };
      if (path === "/app") return { body: { id: "app1", name: "Betleads Ads" } };
      if (path === "/me/permissions") return GRANTED;
      if (path === "/me/adaccounts") return { body: { data: [{ id: "act_1" }] } };
      return undefined;
    });
    db.rpc.meta_connect_token = () => ({ connection_id: CONNECTION_ID, created: false });

    const result = (await call(connectMetaSystemUserTokenFor, { accessToken: TOKEN })) as Row;

    const rpc = db.rpcCalls.find((item) => item.name === "meta_connect_token");
    expect((rpc?.args.p_connection as Row).label).toBe("Betleads Ads");
    expect(result).toMatchObject({ created: false, accountsTotal: 0 });
  });

  it("devolve o erro do RPC", async () => {
    metaAccounts();
    db.rpcErrors.meta_connect_token = "Conexão Meta não encontrada.";
    await expect(call(connectMetaSystemUserTokenFor, { accessToken: TOKEN })).rejects.toThrow(
      "Conexão Meta não encontrada.",
    );
  });

  it("sem ads_read não chama o RPC", async () => {
    graph((path) => {
      if (path === "/me/permissions") return { body: { data: [] } };
      if (path === "/me/adaccounts") return { body: { data: [{ id: "act_1" }] } };
      return { body: { id: "x" } };
    });
    await expect(call(connectMetaSystemUserTokenFor, { accessToken: TOKEN })).rejects.toThrow(
      "ads_read",
    );
    expect(db.rpcCalls).toEqual([]);
  });
});

describe("MB1-03 / MB1-04 selecionar e desconectar via RPC", () => {
  it("selecionar chama meta_select_accounts com backfill de 90 dias", async () => {
    db.rpc.meta_select_accounts = () => ({
      selected: 3,
      added: 2,
      removed: 1,
      backfill_run_id: "run-b",
    });

    const result = await call(updateMetaAccountSelectionFor, { accountIds: [ACCOUNT_ID] });

    expect(db.rpcCalls).toEqual([
      {
        name: "meta_select_accounts",
        args: {
          p_tenant_id: "t1",
          p_actor: "u1",
          p_account_ids: [ACCOUNT_ID],
          p_backfill_days: 90,
        },
      },
    ]);
    expect(result).toEqual({ selected: 3, added: 2, removed: 1, backfillRunId: "run-b" });
    expect(db.calls.filter((item) => item.action !== "select")).toEqual([]);
  });

  it("selecionar devolve o erro do RPC", async () => {
    db.rpcErrors.meta_select_accounts = "Uma das contas selecionadas não pertence à sua operação.";
    await expect(call(updateMetaAccountSelectionFor, { accountIds: [ACCOUNT_ID] })).rejects.toThrow(
      "Uma das contas selecionadas não pertence à sua operação.",
    );
  });

  it("desconectar chama meta_disconnect_connection e devolve movidas/paradas", async () => {
    db.rpc.meta_disconnect_connection = () => ({ accounts_moved: 2, accounts_stopped: 4 });

    const result = await call(disconnectMetaConnectionFor, { connectionId: CONNECTION_ID });

    expect(db.rpcCalls).toEqual([
      {
        name: "meta_disconnect_connection",
        args: { p_tenant_id: "t1", p_actor: "u1", p_connection_id: CONNECTION_ID },
      },
    ]);
    expect(result).toEqual({ ok: true, accountsMoved: 2, accountsStopped: 4 });
  });

  it("desconectar devolve o erro do RPC", async () => {
    db.rpcErrors.meta_disconnect_connection = "Conexão Meta não encontrada.";
    await expect(
      call(disconnectMetaConnectionFor, { connectionId: CONNECTION_ID }),
    ).rejects.toThrow("Conexão Meta não encontrada.");
  });

  it("a casa demo não chama os RPCs", async () => {
    access.demo = true;
    await expect(call(updateMetaAccountSelectionFor, { accountIds: [] })).rejects.toThrow(
      "DEMO_ACTION_BLOCKED",
    );
    await expect(
      call(disconnectMetaConnectionFor, { connectionId: CONNECTION_ID }),
    ).rejects.toThrow("DEMO_ACTION_BLOCKED");
    expect(db.rpcCalls).toEqual([]);
  });
});

describe("validar sem filtro de BM", () => {
  it("relê todas as contas da chave e grava pela meta_upsert_connection_accounts", async () => {
    db.tables.meta_connections = [
      {
        id: CONNECTION_ID,
        tenant_id: "t1",
        status: "error",
        app_id: "app1",
        business_id: "b1",
        encrypted_access_token: "enc-c",
      },
    ];
    graph((path) => {
      if (path === "/app") return { body: { id: "app1" } };
      if (path === "/me/permissions")
        return { body: { data: [{ permission: "ads_read", status: "granted" }] } };
      if (path === "/me/adaccounts")
        return {
          body: {
            data: [
              { id: "act_1", business: { id: "b1" } },
              { id: "act_2", business: { id: "b2" } },
            ],
          },
        };
      return undefined;
    });
    db.rpc.meta_upsert_connection_accounts = () => ({
      accounts_total: 2,
      accounts_new: 1,
      accounts_revoked: 0,
      businesses: 2,
    });

    const result = await call(validateMetaConnectionFor, { connectionId: CONNECTION_ID });

    expect(result).toMatchObject({ ok: true, accounts: 2, accountsNew: 1 });
    const upsert = db.rpcCalls.find((item) => item.name === "meta_upsert_connection_accounts");
    expect(upsert?.args).toMatchObject({ p_tenant_id: "t1", p_connection_id: CONNECTION_ID });
    expect((upsert?.args.p_accounts as Row[]).map((row) => row.meta_ad_account_id)).toEqual([
      "act_1",
      "act_2",
    ]);
    expect(db.tables.meta_connections[0]).toMatchObject({ status: "connected", last_error: null });
  });
});

describe("enqueue e backfill", () => {
  it("um backfill ativo não é reaproveitado nem impede o run manual", async () => {
    db.tables.meta_sync_runs = [
      { id: "run-b", tenant_id: "t1", status: "running", trigger_type: "backfill" },
    ];
    db.tables.meta_ad_account_access = [eligibleAccess("a1", "t1")];

    const run = (await call(enqueueMetaSyncFor, { days: 7 })) as Row;

    expect(run.reused).toBe(false);
    const activeLookup = db.calls.find(
      (item) =>
        item.table === "meta_sync_runs" &&
        item.action === "select" &&
        item.filters.some((filter) => filter.op === "in"),
    );
    expect(activeLookup?.filters).toContainEqual({
      op: "neq",
      column: "trigger_type",
      value: "backfill",
    });
    const jobs = db.calls.find(
      (item) => item.table === "meta_sync_jobs" && item.action === "insert",
    );
    expect(jobs?.payload).toEqual([{ run_id: run.id, tenant_id: "t1", account_id: "a1", days: 7 }]);
  });

  it("conta sem acesso ativo não entra no run", async () => {
    db.tables.meta_ad_account_access = [{ ...eligibleAccess("a1", "t1"), status: "revoked" }];
    await expect(call(enqueueMetaSyncFor, { days: 7 })).rejects.toThrow(
      "Nenhuma conta Meta selecionada",
    );
  });
});

describe("MB1-06 redescoberta diária", () => {
  it("relê só as chaves com lista vencida; o erro numa não para as outras", async () => {
    const day = 24 * 60 * 60 * 1000;
    const connection = (id: string, discoveredAt: string | null): Row => ({
      id,
      tenant_id: "t1",
      status: "connected",
      auth_type: "system_user_token",
      encrypted_access_token: `enc-${id}`,
      accounts_discovered_at: discoveredAt,
    });
    const transient = connection("cB", new Date(Date.now() - 3 * day).toISOString());
    const revoked = connection("cC", new Date(Date.now() - 2 * day).toISOString());
    const never = connection("cA", null);
    const fresh = connection("cD", new Date(Date.now() - 60_000).toISOString());
    db.tables.meta_connections = [transient, revoked, never, fresh];
    graph((path, accessToken) => {
      if (path !== "/me/adaccounts") return undefined;
      if (accessToken === "plain:enc-cB") return metaError(1, "An unknown error occurred", 500);
      if (accessToken === "plain:enc-cC") return metaError(190, "Error validating access token");
      return { body: { data: [{ id: "act_9", name: "Nova" }] } };
    });
    db.rpc.meta_upsert_connection_accounts = () => ({ accounts_total: 1, accounts_new: 1 });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await processMetaSyncQueue(1);

    expect(result.discovered).toBe(1);
    const upserts = db.rpcCalls.filter((item) => item.name === "meta_upsert_connection_accounts");
    expect(upserts.map((item) => item.args.p_connection_id)).toEqual(["cA"]);
    expect((upserts[0].args.p_accounts as Row[])[0]).toMatchObject({
      meta_ad_account_id: "act_9",
      name: "Nova",
    });
    expect(fetchedPaths()).not.toContain("/me/adaccounts?plain:enc-cD");
    expect(fetchedPaths()).toEqual(
      expect.arrayContaining([
        "/me/adaccounts?plain:enc-cA",
        "/me/adaccounts?plain:enc-cB",
        "/me/adaccounts?plain:enc-cC",
      ]),
    );
    expect(transient.status).toBe("connected");
    expect(revoked).toMatchObject({
      status: "error",
      last_error: "Error validating access token",
    });
    const discoverLogs = consoleError.mock.calls.filter(([tag]) => tag === "[meta-sync discover]");
    expect(discoverLogs.map((entry) => entry[1])).toEqual(expect.arrayContaining(["cB", "cC"]));
    consoleError.mockRestore();
  });

  it("não relê chaves de casa demo nem de casa bloqueada", async () => {
    const { listDemoTenantIds } = await import("@/lib/tenant-access.server");
    vi.mocked(listDemoTenantIds).mockResolvedValueOnce(["tDemo"]);
    access.blockedTenants = new Set(["tBlocked"]);
    db.tables.meta_connections = ["tDemo", "tBlocked"].map((tenantId) => ({
      id: `c-${tenantId}`,
      tenant_id: tenantId,
      status: "connected",
      auth_type: "system_user_token",
      encrypted_access_token: "enc",
      accounts_discovered_at: null,
    }));

    const result = await processMetaSyncQueue(1);

    expect(result.discovered).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const stale = (id: string, extra: Row = {}): Row => ({
    id,
    tenant_id: "t1",
    status: "connected",
    auth_type: "system_user_token",
    encrypted_access_token: `enc-${id}`,
    accounts_discovered_at: null,
    ...extra,
  });

  it("lista vazia põe a chave em erro e nunca chama o upsert com []", async () => {
    const connection = stale("cE");
    db.tables.meta_connections = [connection];
    graph((path) => (path === "/me/adaccounts" ? { body: { data: [] } } : undefined));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await processMetaSyncQueue(1);

    expect(result.discovered).toBe(0);
    expect(db.rpcCalls.some((item) => item.name === "meta_upsert_connection_accounts")).toBe(false);
    expect(connection).toMatchObject({
      status: "error",
      last_error: "A Meta não devolveu nenhuma conta para esta chave. Teste o acesso.",
    });
    consoleError.mockRestore();
  });

  it("erro de permissão em /me/adaccounts é erro da chave", async () => {
    const connection = stale("cP");
    db.tables.meta_connections = [connection];
    graph((path) =>
      path === "/me/adaccounts" ? metaError(200, "(#200) Missing permissions") : undefined,
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await processMetaSyncQueue(1);

    expect(connection).toMatchObject({ status: "error", last_error: "(#200) Missing permissions" });
    consoleError.mockRestore();
  });

  it("registra a tentativa, pula a chave tentada na última hora e tenta antes a mais antiga", async () => {
    const hour = 60 * 60 * 1000;
    const recent = stale("cR", {
      permissions_checked_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const older = stale("cO", {
      permissions_checked_at: new Date(Date.now() - 5 * hour).toISOString(),
    });
    const oldest = stale("cX", {
      permissions_checked_at: new Date(Date.now() - 9 * hour).toISOString(),
    });
    db.tables.meta_connections = [recent, older, oldest];
    graph((path) =>
      path === "/me/adaccounts" ? metaError(1, "An unknown error occurred", 500) : undefined,
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = Date.now();

    await processMetaSyncQueue(1);

    expect(fetchedPaths()).toEqual(["/me/adaccounts?plain:enc-cX", "/me/adaccounts?plain:enc-cO"]);
    // A falha temporária não põe a chave em erro, mas fica registrada como tentativa.
    for (const connection of [older, oldest]) {
      expect(connection.status).toBe("connected");
      expect(Date.parse(String(connection.permissions_checked_at))).toBeGreaterThanOrEqual(before);
    }
    consoleError.mockRestore();
  });

  it("não ressuscita a chave desconectada durante a redescoberta", async () => {
    const connection = stale("cD");
    db.tables.meta_connections = [connection];
    graph((path) => {
      if (path !== "/me/adaccounts") return undefined;
      connection.status = "disabled";
      return metaError(190, "Error validating access token");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await processMetaSyncQueue(1);

    expect(connection.status).toBe("disabled");
    consoleError.mockRestore();
  });
});

describe("validar não ressuscita chave desconectada", () => {
  it("falha no teste depois de desconectada mantém disabled", async () => {
    const connection: Row = {
      id: CONNECTION_ID,
      tenant_id: "t1",
      status: "connected",
      app_id: "app1",
      encrypted_access_token: "enc-c",
    };
    db.tables.meta_connections = [connection];
    graph((path) => {
      connection.status = "disabled";
      if (path === "/app") return { body: { id: "app1" } };
      if (path === "/me/permissions") return { body: { data: [] } };
      if (path === "/me/adaccounts") return { body: { data: [{ id: "act_1" }] } };
      return undefined;
    });

    await expect(call(validateMetaConnectionFor, { connectionId: CONNECTION_ID })).rejects.toThrow(
      "ads_read",
    );

    expect(connection.status).toBe("disabled");
    const update = db.calls.find(
      (item) => item.table === "meta_connections" && item.action === "update",
    );
    expect(update?.filters).toContainEqual({ op: "neq", column: "status", value: "disabled" });
  });
});
