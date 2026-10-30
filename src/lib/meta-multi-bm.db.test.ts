// Meta Ads, fase MB1: testes SQL de
// supabase/migrations/20261118100000_meta_mb1_multi_bm.sql
// (conexão por token, meta_ad_account_access N:N, RPCs de conectar, selecionar,
// desconectar, redescobrir e revogar acesso pelo worker, backfill fora da regra
// de run único).
// Escopo: docs/ESCOPO_META_MULTI_BM_2026-10-30.md, seções 4 a 6 (MB1).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const migration = (name: string) =>
  readFileSync(resolve(root, "supabase/migrations", name), "utf8");

// Só o começo de finish_meta_scope (colunas de saúde das contas); o resto cria
// funções de atribuição que dependem de tabelas fora deste teste.
const FINISH_SCOPE = (() => {
  const sql = migration("20261002190000_finish_meta_scope.sql");
  return sql.slice(0, sql.indexOf("create or replace function"));
})();

const MIGRATIONS_BEFORE = [
  migration("20260917173500_create_meta_oauth_tables.sql"),
  migration("20260930173000_meta_system_user_connections.sql"),
  migration("20261002110000_harden_meta_connections.sql"),
  migration("20261002143000_meta_sync_queue.sql"),
  FINISH_SCOPE,
  migration("20261116100000_meta_mb0_hardening.sql"),
];
const MIGRATION = migration("20261118100000_meta_mb1_multi_bm.sql");

const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";
const DEMO = "00000000-0000-4000-8000-000000000003";
const PRE = "00000000-0000-4000-8000-000000000004";
const ACTOR = "11111111-0000-4000-8000-000000000001";

const PRE_LEGACY_CONN = "22222222-0000-4000-8000-000000000001";
const PRE_DISABLED_CONN = "22222222-0000-4000-8000-000000000002";
const PRE_TOKEN_CONN = "22222222-0000-4000-8000-000000000003";
const PRE_LEGACY_ACCOUNT = "33333333-0000-4000-8000-000000000001";
const PRE_DISABLED_ACCOUNT = "33333333-0000-4000-8000-000000000002";
const PRE_TOKEN_ACCOUNT = "33333333-0000-4000-8000-000000000003";

const NO_KEY = "Nenhuma chave conectada alcança esta conta.";
const LOST = "A chave não alcança mais esta conta.";
const EMPTY = "A Meta não devolveu nenhuma conta para esta chave.";
const REAPED = "Tempo esgotado: o processamento da conta foi interrompido.";

// Pré-requisitos das migrations Meta (fora delas no projeto real).
const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create function auth.role() returns text language sql as $$ select 'service_role' $$;

create table public.tenants (
  id uuid primary key, slug text, status text not null default 'active',
  is_demo boolean not null default false);
create table public.tenant_billing (
  tenant_id uuid primary key references public.tenants(id), access_state text not null default 'ok');

create function public.is_demo_tenant(_tenant uuid) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select coalesce((select is_demo from public.tenants where id = _tenant), false) $$;
create function public.is_super_admin() returns boolean language sql stable as $$ select false $$;
create function public.current_tenant_id() returns uuid language sql stable as $$
  select nullif(current_setting('test.tenant', true), '')::uuid $$;
create function public.has_tenant_access(_tenant uuid) returns boolean language sql stable as $$
  select _tenant = public.current_tenant_id() $$;
create function public.update_updated_at_column() returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end $$;

-- Definição de 20260917164000_create_marketing_ads_tables.sql.
create table public.marketing_integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null check (provider in ('meta', 'windsor', 'csv')),
  status text not null default 'planned'
    check (status in ('planned', 'configured', 'connected', 'error', 'disabled')),
  account_name text,
  external_account_id text,
  currency text not null default 'BRL',
  settings jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  token_expires_at timestamptz,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider, external_account_id)
);
alter table public.marketing_integrations enable row level security;
grant all on public.marketing_integrations to authenticated, service_role;

-- pg_cron (stand-in, como em demo-workers-skip.db.test.ts) com o job antigo do
-- worker, sem timeout_milliseconds.
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
create function cron.schedule(_name text, _schedule text, _command text) returns bigint
  language sql as $f$
    insert into cron.job (jobname, schedule, command) values (_name, _schedule, _command)
    returning jobid $f$;
create function cron.unschedule(_jobid bigint) returns boolean
  language sql as $f$ delete from cron.job where jobid = _jobid returning true $f$;
insert into cron.job (jobname, schedule, command)
  values ('betleads-meta-sync-worker', '*/5 * * * *', 'select net.http_post(url := ''x'')');
`;

let db: PGlite;

type Account = {
  meta_ad_account_id: string;
  account_id?: string;
  name?: string;
  business_id?: string | null;
  business_name?: string | null;
  currency?: string;
  timezone_name?: string;
  account_status?: number;
  raw?: Record<string, unknown>;
};

const acct = (id: string, business: string | null = "bm1"): Account => ({
  meta_ad_account_id: `act_${id}`,
  account_id: id,
  name: `Conta ${id}`,
  business_id: business,
  business_name: business ? `BM ${business}` : null,
  currency: "BRL",
  timezone_name: "America/Sao_Paulo",
  account_status: 1,
  raw: { id: `act_${id}` },
});

const uuidArray = (ids: string[]) => `{${ids.join(",")}}`;

type Json = Record<string, any>;

async function connect(
  tenant: string,
  user: string,
  accounts: Account[],
  opts: { app?: string; token?: string; label?: string } = {},
): Promise<Json> {
  const connection = {
    meta_user_id: user,
    meta_user_name: `Usuário ${user}`,
    app_id: opts.app ?? "app1",
    app_name: "App Teste",
    encrypted_access_token: opts.token ?? `cifrado-${user}`,
    token_hint: "…a3f9",
    scopes: ["ads_read", "business_management"],
    label: opts.label ?? `Chave ${user}`,
  };
  const { rows } = await db.query<{ r: Json }>(
    "select public.meta_connect_token($1, $2, $3::jsonb, $4::jsonb) as r",
    [tenant, ACTOR, JSON.stringify(connection), JSON.stringify(accounts)],
  );
  return rows[0].r;
}

async function upsert(tenant: string, connectionId: string, accounts: Account[]): Promise<Json> {
  const { rows } = await db.query<{ r: Json }>(
    "select public.meta_upsert_connection_accounts($1, $2, $3::jsonb) as r",
    [tenant, connectionId, JSON.stringify(accounts)],
  );
  return rows[0].r;
}

async function select(tenant: string, ids: string[], days?: number): Promise<Json> {
  const { rows } = await db.query<{ r: Json }>(
    days === undefined
      ? "select public.meta_select_accounts($1, $2, $3::uuid[]) as r"
      : "select public.meta_select_accounts($1, $2, $3::uuid[], $4) as r",
    days === undefined ? [tenant, ACTOR, uuidArray(ids)] : [tenant, ACTOR, uuidArray(ids), days],
  );
  return rows[0].r;
}

async function disconnect(tenant: string, connectionId: string): Promise<Json> {
  const { rows } = await db.query<{ r: Json }>(
    "select public.meta_disconnect_connection($1, $2, $3) as r",
    [tenant, ACTOR, connectionId],
  );
  return rows[0].r;
}

async function account(tenant: string, metaId: string) {
  const { rows } = await db.query<Json>(
    "select * from public.meta_ad_accounts where tenant_id = $1 and meta_ad_account_id = $2",
    [tenant, metaId],
  );
  return rows[0];
}

async function accesses(accountId: string) {
  const { rows } = await db.query<Json>(
    "select * from public.meta_ad_account_access where account_id = $1 order by created_at, id",
    [accountId],
  );
  return rows;
}

async function access(accountId: string, connectionId: string) {
  const { rows } = await db.query<Json>(
    "select * from public.meta_ad_account_access where account_id = $1 and connection_id = $2",
    [accountId, connectionId],
  );
  return rows[0];
}

async function count(sql: string, params: unknown[] = []) {
  const { rows } = await db.query<{ n: number }>(`select (${sql})::int as n`, params);
  return rows[0].n;
}

// Executa `sql` como `authenticated` da casa T1 e desfaz.
async function asMember(sql: string) {
  await db.query("BEGIN");
  try {
    await db.query(`select set_config('test.tenant', $1, true)`, [T1]);
    await db.exec("SET LOCAL ROLE authenticated");
    return await db.query<Json>(sql);
  } finally {
    await db.query("ROLLBACK");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(`
    insert into public.tenants (id, slug, is_demo) values
      ('${T1}', 'casa1', false), ('${T2}', 'casa2', false),
      ('${DEMO}', 'demo', true), ('${PRE}', 'pre', false);
  `);
  for (const sql of MIGRATIONS_BEFORE) await db.exec(sql);

  // Dados de antes da MB1: conexão legada (erro), uma chave desconectada e uma
  // chave conectada (modelo MB0, com business_id), cada uma com uma conta.
  await db.exec(`
    insert into public.meta_connections
      (id, tenant_id, connected_by_user_id, meta_user_id, access_token, encrypted_access_token,
       auth_type, status, app_id, business_id) values
      ('${PRE_LEGACY_CONN}', '${PRE}', '${ACTOR}', 'legacy', null, null, 'legacy_oauth', 'error', null, null),
      ('${PRE_DISABLED_CONN}', '${PRE}', '${ACTOR}', 'su-old', null, null, 'system_user_token', 'disabled', 'app0', 'bm0'),
      ('${PRE_TOKEN_CONN}', '${PRE}', '${ACTOR}', 'su-pre', null, 'cifrado', 'system_user_token', 'connected', 'app0', 'bm0');
    insert into public.meta_ad_accounts (id, tenant_id, connection_id, meta_ad_account_id, selected) values
      ('${PRE_LEGACY_ACCOUNT}', '${PRE}', '${PRE_LEGACY_CONN}', 'act_legacy', false),
      ('${PRE_DISABLED_ACCOUNT}', '${PRE}', '${PRE_DISABLED_CONN}', 'act_old', false),
      ('${PRE_TOKEN_ACCOUNT}', '${PRE}', '${PRE_TOKEN_CONN}', 'act_pre', true);
  `);

  await db.exec(MIGRATION);
  // Idempotente: aplicar de novo não pode falhar nem duplicar acessos.
  await db.exec(MIGRATION);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    delete from public.meta_sync_runs;
    delete from public.meta_connection_audit;
    delete from public.marketing_integrations;
    delete from public.meta_ad_accounts where tenant_id <> '${PRE}';
    delete from public.meta_connections where tenant_id <> '${PRE}';
  `);
});

describe("migration", () => {
  it("cria um acesso por conta existente, revogado quando a conexão está desconectada", async () => {
    const legacy = await accesses(PRE_LEGACY_ACCOUNT);
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({
      connection_id: PRE_LEGACY_CONN,
      tenant_id: PRE,
      status: "active",
      revoked_at: null,
    });

    const disabled = await accesses(PRE_DISABLED_ACCOUNT);
    expect(disabled).toHaveLength(1);
    expect(disabled[0].status).toBe("revoked");
    expect(disabled[0].revoked_at).not.toBeNull();

    const token = await accesses(PRE_TOKEN_ACCOUNT);
    expect(token).toHaveLength(1);
    expect(token[0]).toMatchObject({ connection_id: PRE_TOKEN_CONN, status: "active" });

    // Aplicada duas vezes: sem duplicatas; conexão legada intacta.
    expect(
      await count("select count(*) from public.meta_ad_account_access where tenant_id = $1", [PRE]),
    ).toBe(3);
    const { rows } = await db.query<Json>(
      "select status from public.meta_connections where id = $1",
      [PRE_LEGACY_CONN],
    );
    expect(rows[0].status).toBe("error");
  });

  it("troca o índice de identidade e adiciona accounts_discovered_at", async () => {
    const { rows } = await db.query<{ indexname: string; indexdef: string }>(
      "select indexname, indexdef from pg_indexes where tablename in ('meta_connections', 'meta_sync_runs')",
    );
    const names = rows.map((row) => row.indexname);
    expect(names).not.toContain("meta_connections_system_identity_key");
    expect(names).toContain("meta_connections_token_identity_key");
    const runIndex = rows.find((row) => row.indexname === "meta_sync_runs_one_active_tenant");
    expect(runIndex?.indexdef).toContain("backfill");
    expect(
      await count(
        "select count(*) from information_schema.columns where table_name = 'meta_connections' and column_name = 'accounts_discovered_at'",
      ),
    ).toBe(1);
  });
});

describe("meta_connect_token", () => {
  it("um token com contas de 3 BMs = 1 conexão e 3 BMs", async () => {
    const result = await connect(T1, "su1", [
      acct("1", "bm1"),
      acct("2", "bm1"),
      acct("3", "bm2"),
      acct("4", "bm3"),
    ]);
    expect(result).toMatchObject({
      created: true,
      accounts_total: 4,
      accounts_new: 4,
      accounts_revoked: 0,
      businesses: 3,
    });
    const connectionId = result.connection_id as string;

    const { rows: connections } = await db.query<Json>(
      "select * from public.meta_connections where tenant_id = $1",
      [T1],
    );
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      id: connectionId,
      auth_type: "system_user_token",
      status: "connected",
      business_id: null,
      app_id: "app1",
      meta_user_id: "su1",
      encrypted_access_token: "cifrado-su1",
      access_token: null,
      connection_label: "Chave su1",
      connected_by_user_id: ACTOR,
    });
    expect(connections[0].scopes).toEqual(["ads_read", "business_management"]);
    expect(connections[0].accounts_discovered_at).not.toBeNull();
    expect(connections[0].token_validated_at).not.toBeNull();

    const { rows: accounts } = await db.query<Json>(
      "select * from public.meta_ad_accounts where tenant_id = $1 order by meta_ad_account_id",
      [T1],
    );
    expect(accounts).toHaveLength(4);
    expect(accounts.every((row) => row.selected === false)).toBe(true);
    expect(accounts.every((row) => row.connection_id === connectionId)).toBe(true);
    expect(accounts[2]).toMatchObject({
      business_id: "bm2",
      business_name: "BM bm2",
      currency: "BRL",
    });
    expect(
      await count(
        "select count(*) from public.meta_ad_account_access where connection_id = $1 and status = 'active'",
        [connectionId],
      ),
    ).toBe(4);

    const { rows: audit } = await db.query<Json>(
      "select action, metadata from public.meta_connection_audit where connection_id = $1 order by action",
      [connectionId],
    );
    expect(audit.map((row) => row.action)).toEqual(["accounts_discovered", "connected"]);
    expect(audit[0].metadata).toMatchObject({ accounts_total: 4, businesses: 3 });
    expect(audit[1].metadata).toEqual({ app_id: "app1" });

    const { rows: integrations } = await db.query<Json>(
      "select * from public.marketing_integrations where tenant_id = $1",
      [T1],
    );
    expect(integrations).toHaveLength(1);
    expect(integrations[0]).toMatchObject({
      provider: "meta",
      external_account_id: "meta:app1:su1",
      account_name: "Chave su1",
      status: "configured",
    });
    expect(integrations[0].settings).toEqual({
      connection_id: connectionId,
      app_id: "app1",
      discovered_accounts: 4,
      selected_accounts: 0,
    });
  });

  it("reconectar o mesmo token mantém a conexão e não duplica contas", async () => {
    const first = await connect(T1, "su1", [acct("1", "bm1"), acct("2", "bm2")]);
    const firstAccount = await account(T1, "act_1");
    await select(T1, [firstAccount.id]);

    const again = await connect(T1, "su1", [acct("1", "bm1"), acct("2", "bm2")], {
      token: "cifrado-novo",
    });
    expect(again).toMatchObject({
      connection_id: first.connection_id,
      created: false,
      accounts_total: 2,
      accounts_new: 0,
    });
    expect(
      await count("select count(*) from public.meta_connections where tenant_id = $1", [T1]),
    ).toBe(1);
    expect(
      await count("select count(*) from public.meta_ad_accounts where tenant_id = $1", [T1]),
    ).toBe(2);
    expect(
      await count("select count(*) from public.meta_ad_account_access where tenant_id = $1", [T1]),
    ).toBe(2);
    expect((await account(T1, "act_1")).selected).toBe(true);

    const { rows } = await db.query<Json>(
      "select encrypted_access_token from public.meta_connections where id = $1",
      [first.connection_id],
    );
    expect(rows[0].encrypted_access_token).toBe("cifrado-novo");
    expect(
      await count(
        "select count(*) from public.meta_connection_audit where connection_id = $1 and action = 'token_replaced'",
        [first.connection_id],
      ),
    ).toBe(1);
    const { rows: integrations } = await db.query<Json>(
      "select settings from public.marketing_integrations where tenant_id = $1",
      [T1],
    );
    expect(integrations).toHaveLength(1);
    expect(integrations[0].settings.selected_accounts).toBe(1);
  });

  it("dois tokens que alcançam a mesma conta = 1 conta e 2 acessos", async () => {
    const one = await connect(T1, "su1", [acct("s", "bm1"), acct("x1", "bm1")]);
    const two = await connect(T1, "su2", [acct("s", "bm1"), acct("x2", "bm2")]);
    expect(two).toMatchObject({ created: true, accounts_total: 2, accounts_new: 1 });
    expect(two.connection_id).not.toBe(one.connection_id);

    expect(
      await count("select count(*) from public.meta_ad_accounts where tenant_id = $1", [T1]),
    ).toBe(3);
    const shared = await account(T1, "act_s");
    const rows = await accesses(shared.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "active")).toBe(true);
    // A preferida continua a primeira chave, que segue saudável.
    expect(shared.connection_id).toBe(one.connection_id);
  });

  it("conta presa à conexão legada passa a preferir a chave nova", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.meta_connections (tenant_id, connected_by_user_id, meta_user_id, auth_type, status)
       values ($1, $2, 'legacy', 'legacy_oauth', 'error') returning id`,
      [T1, ACTOR],
    );
    const legacyConn = rows[0].id;
    const { rows: accounts } = await db.query<{ id: string }>(
      `insert into public.meta_ad_accounts (tenant_id, connection_id, meta_ad_account_id, selected, name)
       values ($1, $2, 'act_legacy', false, 'Antiga') returning id`,
      [T1, legacyConn],
    );
    await db.query(
      `insert into public.meta_ad_account_access (tenant_id, account_id, connection_id) values ($1, $2, $3)`,
      [T1, accounts[0].id, legacyConn],
    );

    const result = await connect(T1, "su-new", [{ meta_ad_account_id: "act_legacy" }]);
    expect(result.accounts_new).toBe(0);
    const legacy = await account(T1, "act_legacy");
    expect(legacy.connection_id).toBe(result.connection_id);
    // Payload sem nome não apaga o nome já gravado.
    expect(legacy.name).toBe("Antiga");
    expect(await accesses(legacy.id)).toHaveLength(2);
  });

  it("recusa dados incompletos", async () => {
    await expect(connect(T1, "", [])).rejects.toThrow(/Dados da conexão Meta incompletos/);
    await expect(connect(T1, "su1", [], { token: "" })).rejects.toThrow(
      /Chave de acesso Meta ausente/,
    );
  });
});

describe("meta_upsert_connection_accounts", () => {
  it("revoga o acesso à conta que saiu da lista e a desmarca se nenhuma chave restar", async () => {
    const conn = await connect(T1, "su1", [acct("a"), acct("b")]);
    const a = await account(T1, "act_a");
    const b = await account(T1, "act_b");
    await select(T1, [a.id, b.id]);

    const result = await upsert(T1, conn.connection_id, [acct("a")]);
    expect(result).toEqual({
      accounts_total: 1,
      accounts_new: 0,
      accounts_revoked: 1,
      businesses: 1,
    });

    const revoked = await access(b.id, conn.connection_id);
    expect(revoked.status).toBe("revoked");
    expect(revoked.revoked_at).not.toBeNull();
    expect(revoked.last_error).toBe(LOST);
    expect(await account(T1, "act_b")).toMatchObject({
      selected: false,
      sync_status: "warning",
      last_error: NO_KEY,
    });
    expect((await account(T1, "act_a")).selected).toBe(true);

    // Voltou a ser alcançada: acesso ativo, aviso limpo, continua desmarcada.
    const back = await upsert(T1, conn.connection_id, [acct("a"), acct("b")]);
    expect(back.accounts_revoked).toBe(0);
    expect((await access(b.id, conn.connection_id)).status).toBe("active");
    expect(await account(T1, "act_b")).toMatchObject({
      selected: false,
      sync_status: "never",
      last_error: null,
    });
  });

  it("conta que sai de uma chave mas é alcançada por outra muda de preferida", async () => {
    const one = await connect(T1, "su1", [acct("s"), acct("x")]);
    const two = await connect(T1, "su2", [acct("s")]);
    const shared = await account(T1, "act_s");
    await select(T1, [shared.id]);

    await upsert(T1, one.connection_id, [acct("x")]);
    expect(await account(T1, "act_s")).toMatchObject({
      selected: true,
      connection_id: two.connection_id,
    });
  });

  it("recusa conexão de outra casa ou desconectada", async () => {
    const other = await connect(T2, "su1", [acct("z")]);
    await expect(upsert(T1, other.connection_id, [])).rejects.toThrow(
      "Conexão Meta não encontrada.",
    );
    await disconnect(T2, other.connection_id);
    await expect(upsert(T2, other.connection_id, [])).rejects.toThrow(
      "Conexão Meta não encontrada.",
    );
  });

  it("lista vazia ou sem id válido é recusada sem revogar nada", async () => {
    const conn = await connect(T1, "su1", [acct("a"), acct("b")]);
    const a = (await account(T1, "act_a")).id;
    const b = (await account(T1, "act_b")).id;
    await select(T1, [a, b]);
    const accessRows = async () =>
      (
        await db.query<Json>(
          "select account_id, status, revoked_at, last_error from public.meta_ad_account_access where tenant_id = $1 order by account_id",
          [T1],
        )
      ).rows;
    const before = await accessRows();

    const invalid: Account[][] = [[], [{ meta_ad_account_id: "  " }]];
    for (const accounts of invalid) {
      await expect(upsert(T1, conn.connection_id, accounts)).rejects.toThrow(EMPTY);
    }
    // Reconectar a mesma chave (ou uma nova) sem contas também é recusado.
    await expect(connect(T1, "su1", [], { token: "cifrado-novo" })).rejects.toThrow(EMPTY);
    await expect(connect(T1, "su-sem-contas", [])).rejects.toThrow(EMPTY);

    const after = await accessRows();
    expect(after).toEqual(before);
    expect(after.every((row) => row.status === "active")).toBe(true);
    expect(await account(T1, "act_a")).toMatchObject({
      selected: true,
      connection_id: conn.connection_id,
    });
    expect(await account(T1, "act_b")).toMatchObject({
      selected: true,
      connection_id: conn.connection_id,
    });
    const { rows: conns } = await db.query<Json>(
      "select meta_user_id, encrypted_access_token from public.meta_connections where tenant_id = $1",
      [T1],
    );
    expect(conns).toEqual([{ meta_user_id: "su1", encrypted_access_token: "cifrado-su1" }]);
  });
});

describe("meta_select_accounts", () => {
  it("aplica o diff e cria um run de backfill com um job por conta adicionada", async () => {
    const conn = await connect(T1, "su1", [acct("a"), acct("b"), acct("c")]);
    const a = (await account(T1, "act_a")).id;
    const b = (await account(T1, "act_b")).id;
    const c = (await account(T1, "act_c")).id;

    const first = await select(T1, [a, b]);
    expect(first).toMatchObject({ selected: 2, added: 2, removed: 0 });
    expect(first.backfill_run_id).toBeTruthy();
    const { rows: runs } = await db.query<Json>(
      "select * from public.meta_sync_runs where id = $1",
      [first.backfill_run_id],
    );
    expect(runs[0]).toMatchObject({
      tenant_id: T1,
      trigger_type: "backfill",
      days: 90,
      total_accounts: 2,
      status: "queued",
      requested_by_user_id: ACTOR,
    });
    const { rows: jobs } = await db.query<Json>(
      "select account_id, days, status from public.meta_sync_jobs where run_id = $1 order by account_id",
      [first.backfill_run_id],
    );
    expect(jobs.map((job) => job.account_id).sort()).toEqual([a, b].sort());
    expect(jobs.every((job) => job.days === 90 && job.status === "queued")).toBe(true);
    expect(await account(T1, "act_a")).toMatchObject({ selected: true, sync_status: "queued" });

    // b fica, a sai, c entra.
    await db.query("update public.meta_ad_accounts set sync_status = 'healthy' where id = $1", [b]);
    const second = await select(T1, [b, c], 30);
    expect(second).toMatchObject({ selected: 2, added: 1, removed: 1 });
    const { rows: secondJobs } = await db.query<Json>(
      "select account_id, days from public.meta_sync_jobs where run_id = $1",
      [second.backfill_run_id],
    );
    expect(secondJobs).toEqual([{ account_id: c, days: 30 }]);
    expect((await account(T1, "act_a")).selected).toBe(false);
    expect((await account(T1, "act_b")).sync_status).toBe("healthy");

    const { rows: audit } = await db.query<Json>(
      "select metadata from public.meta_connection_audit where action = 'accounts_selected' and connection_id = $1 order by created_at, id",
      [conn.connection_id],
    );
    expect(audit.map((row) => row.metadata)).toEqual([
      { added: 2, removed: 0 },
      { added: 1, removed: 1 },
    ]);
    const { rows: integrations } = await db.query<Json>(
      "select settings from public.marketing_integrations where tenant_id = $1",
      [T1],
    );
    expect(integrations[0].settings.selected_accounts).toBe(2);

    // Sem mudança: nada a fazer, sem run novo.
    const same = await select(T1, [c, b, b]);
    expect(same).toEqual({ selected: 2, added: 0, removed: 0, backfill_run_id: null });
  });

  it("o backfill convive com um run manual na fila", async () => {
    await connect(T1, "su1", [acct("a"), acct("b")]);
    await db.query(
      "insert into public.meta_sync_runs (tenant_id, trigger_type, status) values ($1, 'manual', 'queued')",
      [T1],
    );
    const a = (await account(T1, "act_a")).id;
    const b = (await account(T1, "act_b")).id;
    expect((await select(T1, [a])).backfill_run_id).toBeTruthy();
    expect((await select(T1, [a, b])).backfill_run_id).toBeTruthy();
    // A regra "um run ativo" continua valendo para manual/agendado.
    await expect(
      db.query(
        "insert into public.meta_sync_runs (tenant_id, trigger_type, status) values ($1, 'scheduled', 'queued')",
        [T1],
      ),
    ).rejects.toThrow(/meta_sync_runs_one_active_tenant/);
  });

  it("recusa conta sem acesso ativo, de chave em erro ou de outra casa", async () => {
    const conn = await connect(T1, "su1", [acct("a"), acct("b")]);
    const a = (await account(T1, "act_a")).id;
    const b = (await account(T1, "act_b")).id;
    await upsert(T1, conn.connection_id, [acct("a")]);
    await expect(select(T1, [b])).rejects.toThrow(
      "Uma das contas selecionadas não pertence à sua operação.",
    );

    await connect(T2, "su1", [acct("z")]);
    const z = (await account(T2, "act_z")).id;
    await expect(select(T1, [a, z])).rejects.toThrow(
      "Uma das contas selecionadas não pertence à sua operação.",
    );
    await expect(select(T1, ["99999999-0000-4000-8000-000000000000"])).rejects.toThrow(
      "Uma das contas selecionadas não pertence à sua operação.",
    );

    // Chave em erro: não dá para marcar conta nova por ela...
    await db.query("update public.meta_connections set status = 'error' where id = $1", [
      conn.connection_id,
    ]);
    await expect(select(T1, [a])).rejects.toThrow(
      "Uma das contas selecionadas não pertence à sua operação.",
    );
    // ...mas uma conta já marcada pode continuar na lista.
    await db.query("update public.meta_connections set status = 'connected' where id = $1", [
      conn.connection_id,
    ]);
    await select(T1, [a]);
    await db.query("update public.meta_connections set status = 'error' where id = $1", [
      conn.connection_id,
    ]);
    expect(await select(T1, [a])).toMatchObject({ selected: 1, added: 0, removed: 0 });

    expect(
      await count(
        "select count(*) from public.meta_ad_accounts where tenant_id = $1 and selected",
        [T1],
      ),
    ).toBe(1);
    await expect(select(T1, [a], 91)).rejects.toThrow(/Período/);
  });

  it("casa demo marca a conta mas não ganha run de backfill", async () => {
    await connect(DEMO, "su1", [acct("d")]);
    const d = (await account(DEMO, "act_d")).id;
    const result = await select(DEMO, [d]);
    expect(result).toEqual({ selected: 1, added: 1, removed: 0, backfill_run_id: null });
    expect(
      await count("select count(*) from public.meta_sync_runs where tenant_id = $1", [DEMO]),
    ).toBe(0);
  });
});

describe("meta_disconnect_connection", () => {
  it("conta compartilhada continua marcada pela outra chave; exclusiva é desmarcada", async () => {
    const one = await connect(T1, "su1", [acct("s"), acct("e")]);
    const two = await connect(T1, "su2", [acct("s")]);
    const s = (await account(T1, "act_s")).id;
    const e = (await account(T1, "act_e")).id;
    await select(T1, [s, e]);
    expect((await account(T1, "act_s")).connection_id).toBe(one.connection_id);

    const result = await disconnect(T1, one.connection_id);
    expect(result).toEqual({ accounts_moved: 1, accounts_stopped: 1 });

    expect(await account(T1, "act_s")).toMatchObject({
      selected: true,
      connection_id: two.connection_id,
    });
    expect(await account(T1, "act_e")).toMatchObject({
      selected: false,
      sync_status: "warning",
      last_error: NO_KEY,
    });

    const { rows } = await db.query<Json>("select * from public.meta_connections where id = $1", [
      one.connection_id,
    ]);
    expect(rows[0]).toMatchObject({
      status: "disabled",
      encrypted_access_token: null,
      access_token: null,
      disabled_by_user_id: ACTOR,
      last_error: null,
    });
    expect(rows[0].disabled_at).not.toBeNull();
    expect((await access(s, one.connection_id)).status).toBe("revoked");
    expect((await access(e, one.connection_id)).status).toBe("revoked");
    expect((await access(s, two.connection_id)).status).toBe("active");

    const { rows: integrations } = await db.query<Json>(
      "select external_account_id, status from public.marketing_integrations where tenant_id = $1 order by external_account_id",
      [T1],
    );
    expect(integrations).toEqual([
      { external_account_id: "meta:app1:su1", status: "disabled" },
      { external_account_id: "meta:app1:su2", status: "configured" },
    ]);
    const { rows: audit } = await db.query<Json>(
      "select metadata from public.meta_connection_audit where connection_id = $1 and action = 'disabled'",
      [one.connection_id],
    );
    expect(audit[0].metadata).toEqual({ accounts_moved: 1, accounts_stopped: 1 });

    await expect(disconnect(T1, one.connection_id)).rejects.toThrow("Conexão Meta não encontrada.");
    await expect(disconnect(T2, two.connection_id)).rejects.toThrow("Conexão Meta não encontrada.");

    // Reconectar a chave desconectada cria uma conexão nova (a antiga fica disabled).
    const back = await connect(T1, "su1", [acct("s"), acct("e")]);
    expect(back.created).toBe(true);
    expect(back.connection_id).not.toBe(one.connection_id);
    expect(back.accounts_new).toBe(0);
  });
});

describe("meta_record_account_sync_success", () => {
  async function record(tenant: string, accountId: string, connectionId: string) {
    const { rows } = await db.query<{ r: boolean }>(
      "select public.meta_record_account_sync_success($1, $2, $3) as r",
      [tenant, accountId, connectionId],
    );
    return rows[0].r;
  }

  it("grava o sucesso no acesso, na preferência da conta e na conexão", async () => {
    const one = await connect(T1, "su1", [acct("s")]);
    const two = await connect(T1, "su2", [acct("s")]);
    const s = (await account(T1, "act_s")).id;
    await select(T1, [s]);
    expect((await account(T1, "act_s")).connection_id).toBe(one.connection_id);
    await db.query("update public.meta_connections set last_error = 'falha antiga' where id = $1", [
      two.connection_id,
    ]);
    await db.query(
      "update public.meta_ad_account_access set last_error = 'falha antiga' where account_id = $1 and connection_id = $2",
      [s, two.connection_id],
    );

    expect(await record(T1, s, two.connection_id)).toBe(true);

    const row = await access(s, two.connection_id);
    expect(row.last_success_at).not.toBeNull();
    expect(row.last_error).toBeNull();
    expect((await account(T1, "act_s")).connection_id).toBe(two.connection_id);
    const { rows } = await db.query<Json>(
      "select status, last_sync_at, last_error from public.meta_connections where id = $1",
      [two.connection_id],
    );
    expect(rows[0].status).toBe("connected");
    expect(rows[0].last_sync_at).not.toBeNull();
    expect(rows[0].last_error).toBeNull();
    // O acesso pela outra chave não é tocado.
    expect((await access(s, one.connection_id)).last_success_at).toBeNull();
  });

  it("chave desconectada no meio da sincronização: devolve false e não muda nada", async () => {
    const one = await connect(T1, "su1", [acct("s")]);
    const two = await connect(T1, "su2", [acct("s")]);
    const s = (await account(T1, "act_s")).id;
    await select(T1, [s]);
    // O worker estava usando a chave 1; o admin a desconecta antes do fim.
    await disconnect(T1, one.connection_id);
    expect((await account(T1, "act_s")).connection_id).toBe(two.connection_id);

    const snapshot = async () => ({
      account: await account(T1, "act_s"),
      access: await access(s, one.connection_id),
      connection: (
        await db.query<Json>("select * from public.meta_connections where id = $1", [
          one.connection_id,
        ])
      ).rows[0],
    });
    const before = await snapshot();
    expect(await record(T1, s, one.connection_id)).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(before.connection.status).toBe("disabled");
    expect(before.connection.last_sync_at).toBeNull();

    // Conexão em erro também não conta; outra casa também não.
    await db.query("update public.meta_connections set status = 'error' where id = $1", [
      two.connection_id,
    ]);
    expect(await record(T1, s, two.connection_id)).toBe(false);
    expect(await record(T2, s, two.connection_id)).toBe(false);
    expect((await access(s, two.connection_id)).last_success_at).toBeNull();
  });
});

describe("meta_revoke_account_access", () => {
  const PERM = "(#200) Ad account owner has NOT grant ads_management or ads_read permission";

  async function revoke(tenant: string, accountId: string, connectionId: string, error = PERM) {
    const { rows } = await db.query<{ r: Json }>(
      "select public.meta_revoke_account_access($1, $2, $3, $4) as r",
      [tenant, accountId, connectionId, error],
    );
    return rows[0].r;
  }

  it("única chave: revoga o acesso e desmarca a conta com aviso", async () => {
    const conn = await connect(T1, "su1", [acct("a"), acct("b")]);
    const a = (await account(T1, "act_a")).id;
    const b = (await account(T1, "act_b")).id;
    await select(T1, [a, b]);

    expect(await revoke(T1, a, conn.connection_id)).toEqual({
      revoked: true,
      moved: 0,
      stopped: 1,
    });
    const row = await access(a, conn.connection_id);
    expect(row.status).toBe("revoked");
    expect(row.revoked_at).not.toBeNull();
    expect(row.last_error).toBe(PERM);
    expect(await account(T1, "act_a")).toMatchObject({
      selected: false,
      sync_status: "warning",
      last_error: NO_KEY,
    });
    // A outra conta da mesma chave não é tocada.
    expect((await account(T1, "act_b")).selected).toBe(true);
    expect((await access(b, conn.connection_id)).status).toBe("active");
  });

  it("com outra chave conectada: move a preferência e a conta continua marcada", async () => {
    const one = await connect(T1, "su1", [acct("s")]);
    const two = await connect(T1, "su2", [acct("s")]);
    const s = (await account(T1, "act_s")).id;
    await select(T1, [s]);
    expect((await account(T1, "act_s")).connection_id).toBe(one.connection_id);

    expect(await revoke(T1, s, one.connection_id)).toEqual({
      revoked: true,
      moved: 1,
      stopped: 0,
    });
    expect(await account(T1, "act_s")).toMatchObject({
      selected: true,
      connection_id: two.connection_id,
    });
    expect((await access(s, one.connection_id)).status).toBe("revoked");
    expect((await access(s, two.connection_id)).status).toBe("active");

    // Revogar a chave que não é a preferida não mexe na preferência.
    const three = await connect(T1, "su3", [acct("s")]);
    expect(await revoke(T1, s, three.connection_id)).toEqual({
      revoked: true,
      moved: 0,
      stopped: 0,
    });
    expect(await account(T1, "act_s")).toMatchObject({
      selected: true,
      connection_id: two.connection_id,
    });
  });

  it("acesso já revogado, de outra casa ou inexistente: revoked=false e nada muda", async () => {
    const conn = await connect(T1, "su1", [acct("a")]);
    const a = (await account(T1, "act_a")).id;
    await select(T1, [a]);
    await revoke(T1, a, conn.connection_id);

    const snapshot = async () => ({
      account: await account(T1, "act_a"),
      access: await access(a, conn.connection_id),
    });
    const before = await snapshot();
    const none = { revoked: false, moved: 0, stopped: 0 };
    expect(await revoke(T1, a, conn.connection_id, "outro erro")).toEqual(none);
    expect(await revoke(T2, a, conn.connection_id)).toEqual(none);
    expect(await revoke(T1, a, "99999999-0000-4000-8000-000000000000")).toEqual(none);
    expect(await snapshot()).toEqual(before);
    expect(before.access.last_error).toBe(PERM);
  });

  it("a varredura do upsert corrige conta marcada sem acesso ativo deixada por código antigo", async () => {
    const one = await connect(T1, "su1", [acct("a"), acct("b"), acct("c")]);
    const two = await connect(T1, "su2", [acct("b"), acct("x")]);
    const a = (await account(T1, "act_a")).id;
    const b = (await account(T1, "act_b")).id;
    const c = (await account(T1, "act_c")).id;
    await select(T1, [a, b, c]);

    // Revogação "crua" (como o worker fazia antes), sem trocar a preferência.
    await db.query(
      `update public.meta_ad_account_access
       set status = 'revoked', revoked_at = now(), last_error = 'antigo'
       where connection_id = $1 and account_id = any($2::uuid[])`,
      [one.connection_id, uuidArray([a, b])],
    );
    expect(await account(T1, "act_a")).toMatchObject({
      selected: true,
      connection_id: one.connection_id,
    });

    // Redescoberta de OUTRA chave (que não alcança a, nem foi a que revogou).
    await upsert(T1, two.connection_id, [acct("b"), acct("x")]);

    // a: nenhuma chave conectada a alcança => desmarcada com aviso.
    expect(await account(T1, "act_a")).toMatchObject({
      selected: false,
      sync_status: "warning",
      last_error: NO_KEY,
    });
    // b: alcançada pela chave 2 => preferência movida, continua marcada.
    expect(await account(T1, "act_b")).toMatchObject({
      selected: true,
      connection_id: two.connection_id,
    });
    // c: acesso ativo por chave conectada => intocada.
    expect(await account(T1, "act_c")).toMatchObject({
      selected: true,
      connection_id: one.connection_id,
      sync_status: "queued",
      last_error: null,
    });
  });
});

describe("claim_meta_sync_jobs (MB1)", () => {
  it("o reaper falha o job vencido e tira a conta de syncing", async () => {
    await connect(T1, "su1", [acct("a"), acct("b")]);
    const a = (await account(T1, "act_a")).id;
    const b = (await account(T1, "act_b")).id;
    const { backfill_run_id: runId } = await select(T1, [a, b]);
    await db.query(
      `update public.meta_sync_jobs
       set status = 'running', attempt_count = max_attempts,
           locked_at = now() - interval '11 minutes'
       where run_id = $1 and account_id = $2`,
      [runId, a],
    );
    await db.query(
      `update public.meta_sync_jobs
       set status = 'completed', finished_at = now()
       where run_id = $1 and account_id = $2`,
      [runId, b],
    );
    await db.query(
      "update public.meta_ad_accounts set sync_status = 'syncing', last_error = null where id = any($1::uuid[])",
      [uuidArray([a, b])],
    );

    const { rows: claimed } = await db.query<Json>(
      "select * from public.claim_meta_sync_jobs(5, 'test-worker')",
    );
    expect(claimed).toEqual([]);

    const { rows: jobs } = await db.query<Json>(
      "select status, last_error, locked_at from public.meta_sync_jobs where run_id = $1 and account_id = $2",
      [runId, a],
    );
    expect(jobs[0]).toMatchObject({ status: "failed", last_error: REAPED, locked_at: null });
    expect(await account(T1, "act_a")).toMatchObject({ sync_status: "error", last_error: REAPED });
    // Conta sem job vencido fica como estava.
    expect(await account(T1, "act_b")).toMatchObject({ sync_status: "syncing", last_error: null });
    const { rows: runs } = await db.query<Json>(
      "select status from public.meta_sync_runs where id = $1",
      [runId],
    );
    expect(["queued", "running"]).not.toContain(runs[0].status);
  });

  it("job vencido com tentativas sobrando é reclamado de novo, sem mexer na conta", async () => {
    await connect(T1, "su1", [acct("a")]);
    const a = (await account(T1, "act_a")).id;
    const { backfill_run_id: runId } = await select(T1, [a]);
    await db.query(
      `update public.meta_sync_jobs
       set status = 'running', attempt_count = 1, locked_at = now() - interval '11 minutes'
       where run_id = $1`,
      [runId],
    );
    await db.query("update public.meta_ad_accounts set sync_status = 'syncing' where id = $1", [a]);
    const { rows } = await db.query<Json>(
      "select account_id, attempt_count from public.claim_meta_sync_jobs(5, 'test-worker')",
    );
    expect(rows).toEqual([{ account_id: a, attempt_count: 2 }]);
    expect((await account(T1, "act_a")).sync_status).toBe("syncing");
  });
});

describe("cron do worker", () => {
  it("reagenda betleads-meta-sync-worker com timeout de 55 s", async () => {
    const { rows } = await db.query<Json>(
      "select schedule, command from cron.job where jobname = 'betleads-meta-sync-worker'",
    );
    // Migration aplicada duas vezes: continua um job só.
    expect(rows).toHaveLength(1);
    expect(rows[0].schedule).toBe("*/5 * * * *");
    expect(rows[0].command).toContain("https://betleads.io/api/public/meta-sync/tick");
    expect(rows[0].command).toContain("betleads_cron_secret");
    expect(rows[0].command).toContain("timeout_milliseconds := 55000");
  });
});

describe("privilégios", () => {
  it("authenticated só lê meta_ad_account_access da própria casa", async () => {
    await connect(T1, "su1", [acct("a")]);
    await connect(T2, "su1", [acct("z")]);
    const { rows } = await asMember("select tenant_id from public.meta_ad_account_access");
    expect(rows.length).toBe(1);
    expect(rows.every((row) => row.tenant_id === T1)).toBe(true);

    const a = (await account(T1, "act_a")).id;
    const { rows: conns } = await db.query<Json>(
      "select id from public.meta_connections where tenant_id = $1",
      [T1],
    );
    await expect(
      asMember(
        `insert into public.meta_ad_account_access (tenant_id, account_id, connection_id)
         values ('${T1}', '${a}', '${conns[0].id}')`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asMember("update public.meta_ad_account_access set status = 'active'"),
    ).rejects.toThrow(/permission denied/);
    await expect(asMember("delete from public.meta_ad_account_access")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("authenticated não executa as RPCs", async () => {
    const calls = [
      `select public.meta_upsert_connection_accounts('${T1}', gen_random_uuid(), '[]'::jsonb)`,
      `select public.meta_connect_token('${T1}', '${ACTOR}', '{}'::jsonb, '[]'::jsonb)`,
      `select public.meta_select_accounts('${T1}', '${ACTOR}', '{}'::uuid[])`,
      `select public.meta_disconnect_connection('${T1}', '${ACTOR}', gen_random_uuid())`,
      `select public.meta_reassign_account_preference('${T1}', '{}'::uuid[])`,
      `select public.meta_lock_tenant_accounts('${T1}')`,
      `select public.meta_record_account_sync_success('${T1}', gen_random_uuid(), gen_random_uuid())`,
      `select * from public.claim_meta_sync_jobs(1, null)`,
      `select public.meta_revoke_account_access('${T1}', gen_random_uuid(), gen_random_uuid(), 'x')`,
    ];
    for (const sql of calls) {
      await expect(asMember(sql)).rejects.toThrow(/permission denied/);
    }
  });
});
