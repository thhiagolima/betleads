// Meta Ads, fase MB0: testes SQL de
// supabase/migrations/20261116100000_meta_mb0_hardening.sql
// (reaper do claim, casas bloqueadas, token legado e escrita direta por membros).
// Escopo: docs/ESCOPO_META_MULTI_BM_2026-10-30.md, seção 6 (MB0-02 a MB0-05).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const QUEUE_MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261002143000_meta_sync_queue.sql"),
  "utf8",
);
const MIGRATION = readFileSync(
  resolve(root, "supabase/migrations/20261116100000_meta_mb0_hardening.sql"),
  "utf8",
);

const ACTIVE = "00000000-0000-4000-8000-000000000001";
const SUSPENDED = "00000000-0000-4000-8000-000000000002";
const DEMO = "00000000-0000-4000-8000-000000000003";
const FROZEN = "00000000-0000-4000-8000-000000000004";
const CANCELED = "00000000-0000-4000-8000-000000000005";
const TENANTS = [ACTIVE, SUSPENDED, DEMO, FROZEN, CANCELED];
// Conta n da casa t: um uuid estável por (casa, n).
const ACCOUNT = (t: string, n: number) =>
  `aaaaaaaa-0000-4000-8000-000000000${t.slice(-1)}${String(n).padStart(2, "0")}`;

// Esquema mínimo, com os privilégios de produção antes da migration
// (`authenticated` com escrita e policy FOR ALL nas tabelas de conta/integração).
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

create table public.meta_connections (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
  access_token text, encrypted_access_token text,
  auth_type text not null default 'legacy_oauth', status text not null default 'connected');

create table public.meta_ad_accounts (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
  connection_id uuid, meta_ad_account_id text not null, selected boolean not null default false);
alter table public.meta_ad_accounts enable row level security;
create policy meta_ad_accounts_tenant_rls on public.meta_ad_accounts
  as permissive for all to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  with check ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));
grant all on public.meta_ad_accounts to anon, authenticated, service_role;

create table public.marketing_integrations (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
  provider text not null, status text);
alter table public.marketing_integrations enable row level security;
create policy marketing_integrations_tenant_rls on public.marketing_integrations
  as permissive for all to authenticated
  using ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()))
  with check ((select public.is_super_admin()) or tenant_id = (select public.current_tenant_id()));
grant all on public.marketing_integrations to anon, authenticated, service_role;
`;

let db: PGlite;

async function claim(limit = 10) {
  const { rows } = await db.query<{ id: string; tenant_id: string; attempt_count: number }>(
    "select id, tenant_id, attempt_count from public.claim_meta_sync_jobs($1, 'test-worker')",
    [limit],
  );
  return rows;
}

async function createRun(tenant: string, status = "running") {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.meta_sync_runs (tenant_id, status, total_accounts, started_at)
     values ($1, $2, 1, now()) returning id`,
    [tenant, status],
  );
  return rows[0].id;
}

async function createJob(
  runId: string,
  tenant: string,
  account: number,
  fields: { status: string; attempt_count?: number; locked_minutes_ago?: number | null },
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.meta_sync_jobs
       (run_id, tenant_id, account_id, days, status, attempt_count, locked_at, next_attempt_at)
     values ($1, $2, $3, 7, $4, $5,
       case when $6::int is null then null else now() - make_interval(mins => $6::int) end,
       now() - interval '1 minute')
     returning id`,
    [
      runId,
      tenant,
      ACCOUNT(tenant, account),
      fields.status,
      fields.attempt_count ?? 0,
      fields.locked_minutes_ago ?? null,
    ],
  );
  return rows[0].id;
}

async function job(id: string) {
  const { rows } = await db.query<Record<string, unknown>>(
    "select * from public.meta_sync_jobs where id = $1",
    [id],
  );
  return rows[0];
}

async function run(id: string) {
  const { rows } = await db.query<Record<string, unknown>>(
    "select * from public.meta_sync_runs where id = $1",
    [id],
  );
  return rows[0];
}

// Executa `sql` como `authenticated` da casa ACTIVE e desfaz.
async function asMember(sql: string) {
  await db.query("BEGIN");
  try {
    await db.query(`select set_config('test.tenant', $1, true)`, [ACTIVE]);
    await db.exec("SET LOCAL ROLE authenticated");
    return await db.query<Record<string, unknown>>(sql);
  } finally {
    await db.query("ROLLBACK");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(QUEUE_MIGRATION);
  // Produção: `authenticated` herdou escrita nas tabelas da fila.
  await db.exec(`
    grant all on public.meta_sync_runs to anon, authenticated;
    grant all on public.meta_sync_jobs to anon, authenticated;
  `);

  await db.exec(`
    insert into public.tenants (id, slug, status, is_demo) values
      ('${ACTIVE}', 'ativa', 'active', false),
      ('${SUSPENDED}', 'suspensa', 'suspended', false),
      ('${DEMO}', 'demo', 'active', true),
      ('${FROZEN}', 'congelada', 'active', false),
      ('${CANCELED}', 'cancelada', 'canceled', false);
    insert into public.tenant_billing (tenant_id, access_state) values
      ('${ACTIVE}', 'ok'), ('${FROZEN}', 'frozen');
    insert into public.meta_connections (tenant_id, access_token, encrypted_access_token, auth_type, status) values
      ('${ACTIVE}', 'EAA-legado', null, 'legacy_oauth', 'error'),
      ('${ACTIVE}', null, 'cifrado', 'system_user_token', 'connected');
    insert into public.marketing_integrations (tenant_id, provider, status) values
      ('${ACTIVE}', 'meta', 'connected');
  `);
  for (const tenant of TENANTS) {
    for (let n = 1; n <= 6; n++) {
      await db.query(
        `insert into public.meta_ad_accounts (id, tenant_id, meta_ad_account_id, selected)
         values ($1, $2, $3, true)`,
        [ACCOUNT(tenant, n), tenant, `act_${n}`],
      );
    }
  }

  await db.exec(MIGRATION);
  // Idempotente: aplicar de novo não pode falhar.
  await db.exec(MIGRATION);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec("delete from public.meta_sync_runs");
});

describe("claim_meta_sync_jobs: reaper", () => {
  it("falha o job vencido na última tentativa, fecha o run e libera um run novo da casa", async () => {
    const runId = await createRun(ACTIVE);
    const stale = await createJob(runId, ACTIVE, 1, {
      status: "running",
      attempt_count: 3,
      locked_minutes_ago: 20,
    });
    const done = await createJob(runId, ACTIVE, 2, { status: "completed", attempt_count: 1 });
    await db.query("update public.meta_sync_jobs set rows_imported = 42 where id = $1", [done]);

    // Antes: o índice de run ativo bloqueia um run novo da casa.
    await expect(createRun(ACTIVE, "queued")).rejects.toThrow(/meta_sync_runs_one_active_tenant/);

    const claimed = await claim();
    expect(claimed.map((row) => row.id)).not.toContain(stale);

    const reaped = await job(stale);
    expect(reaped.status).toBe("failed");
    expect(reaped.last_error).toBe("Tempo esgotado: o processamento da conta foi interrompido.");
    expect(reaped.locked_at).toBeNull();
    expect(reaped.finished_at).not.toBeNull();
    expect(reaped.attempt_count).toBe(3);

    const closed = await run(runId);
    expect(closed.status).toBe("partial");
    expect(closed.processed_accounts).toBe(2);
    expect(closed.successful_accounts).toBe(1);
    expect(closed.failed_accounts).toBe(1);
    expect(closed.rows_imported).toBe(42);
    expect(closed.finished_at).not.toBeNull();
    expect(closed.error_summary).toBe("Tempo esgotado: o processamento da conta foi interrompido.");

    const newRun = await createRun(ACTIVE, "queued");
    expect(newRun).toBeTruthy();
  });

  it("run com todos os jobs vencidos vira failed; com jobs pendentes continua running", async () => {
    const allStale = await createRun(ACTIVE);
    await createJob(allStale, ACTIVE, 1, {
      status: "running",
      attempt_count: 3,
      locked_minutes_ago: 30,
    });
    await createJob(allStale, ACTIVE, 2, {
      status: "running",
      attempt_count: 3,
      locked_minutes_ago: 30,
    });

    const mixed = await createRun(SUSPENDED);
    await createJob(mixed, SUSPENDED, 1, {
      status: "running",
      attempt_count: 3,
      locked_minutes_ago: 30,
    });
    await createJob(mixed, SUSPENDED, 2, { status: "queued" });

    await claim();

    const a = await run(allStale);
    expect(a.status).toBe("failed");
    expect(a.failed_accounts).toBe(2);
    expect(a.error_summary).toBe(
      "Tempo esgotado: o processamento da conta foi interrompido. · Tempo esgotado: o processamento da conta foi interrompido.",
    );

    const m = await run(mixed);
    expect(m.status).toBe("running");
    expect(m.processed_accounts).toBe(1);
    expect(m.finished_at).toBeNull();
  });

  it("job vencido na tentativa 1 é reclamado de novo (tentativa 2)", async () => {
    const runId = await createRun(ACTIVE);
    const stale = await createJob(runId, ACTIVE, 1, {
      status: "running",
      attempt_count: 1,
      locked_minutes_ago: 20,
    });

    const claimed = await claim();
    expect(claimed.map((row) => row.id)).toContain(stale);

    const reclaimed = await job(stale);
    expect(reclaimed.status).toBe("running");
    expect(reclaimed.attempt_count).toBe(2);
    expect(reclaimed.worker_id).toBe("test-worker");
    expect((await run(runId)).status).toBe("running");
  });

  it("job running com lock recente não é reaped nem reclamado", async () => {
    const runId = await createRun(ACTIVE);
    const fresh = await createJob(runId, ACTIVE, 1, {
      status: "running",
      attempt_count: 3,
      locked_minutes_ago: 2,
    });

    expect((await claim()).map((row) => row.id)).not.toContain(fresh);
    expect((await job(fresh)).status).toBe("running");
  });
});

describe("claim_meta_sync_jobs: casas que não podem operar", () => {
  it("não reclama job de casa suspensa, cancelada, congelada ou demo; reclama a ativa", async () => {
    const jobs: Record<string, string> = {};
    for (const tenant of TENANTS) {
      const runId = await createRun(tenant, "queued");
      jobs[tenant] = await createJob(runId, tenant, 3, { status: "queued" });
    }

    const claimed = (await claim()).map((row) => row.id);
    expect(claimed).toEqual([jobs[ACTIVE]]);

    for (const tenant of [SUSPENDED, CANCELED, FROZEN, DEMO]) {
      const row = await job(jobs[tenant]);
      expect(row.status).toBe("queued");
      expect(row.attempt_count).toBe(0);
    }
  });

  it("casa reativada volta a ter o job reclamado", async () => {
    const runId = await createRun(SUSPENDED, "queued");
    const queued = await createJob(runId, SUSPENDED, 4, { status: "queued" });
    expect(await claim()).toEqual([]);

    await db.exec(`update public.tenants set status = 'active' where id = '${SUSPENDED}'`);
    try {
      expect((await claim()).map((row) => row.id)).toEqual([queued]);
    } finally {
      await db.exec(`update public.tenants set status = 'suspended' where id = '${SUSPENDED}'`);
    }
  });
});

describe("refresh_meta_sync_run", () => {
  it("recalcula contadores e fecha como completed quando tudo deu certo", async () => {
    const runId = await createRun(ACTIVE);
    const a = await createJob(runId, ACTIVE, 1, { status: "completed", attempt_count: 1 });
    const b = await createJob(runId, ACTIVE, 2, { status: "completed", attempt_count: 2 });
    await db.query("update public.meta_sync_jobs set rows_imported = 10 where id in ($1, $2)", [
      a,
      b,
    ]);

    const { rows } = await db.query<{ status: string }>(
      "select public.refresh_meta_sync_run($1) as status",
      [runId],
    );
    expect(rows[0].status).toBe("completed");
    const closed = await run(runId);
    expect(closed.rows_imported).toBe(20);
    expect(closed.error_summary).toBeNull();
    expect(closed.finished_at).not.toBeNull();
  });

  it("error_summary usa no máximo 3 erros", async () => {
    const runId = await createRun(ACTIVE);
    for (let n = 1; n <= 5; n++) {
      const id = await createJob(runId, ACTIVE, n, { status: "failed", attempt_count: 3 });
      await db.query(
        "update public.meta_sync_jobs set last_error = $2, finished_at = now() + make_interval(secs => $3::int) where id = $1",
        [id, `erro ${n}`, n],
      );
    }
    await db.query("select public.refresh_meta_sync_run($1)", [runId]);
    const closed = await run(runId);
    expect(closed.status).toBe("failed");
    expect(closed.error_summary).toBe("erro 1 · erro 2 · erro 3");
  });

  it("devolve null para run inexistente e só service_role executa", async () => {
    const { rows } = await db.query<{ status: string | null }>(
      "select public.refresh_meta_sync_run(gen_random_uuid()) as status",
    );
    expect(rows[0].status).toBeNull();
    await expect(
      asMember("select public.refresh_meta_sync_run(gen_random_uuid())"),
    ).rejects.toThrow(/permission denied/);
    await expect(asMember("select * from public.claim_meta_sync_jobs(1, null)")).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("MB0-03: token legado", () => {
  it("zera o access_token das conexões legacy_oauth e mantém o cifrado", async () => {
    const { rows } = await db.query<{
      auth_type: string;
      access_token: string | null;
      encrypted_access_token: string | null;
    }>(
      "select auth_type, access_token, encrypted_access_token from public.meta_connections order by auth_type",
    );
    expect(rows).toEqual([
      { auth_type: "legacy_oauth", access_token: null, encrypted_access_token: null },
      { auth_type: "system_user_token", access_token: null, encrypted_access_token: "cifrado" },
    ]);
  });
});

describe("MB0-02: membro só lê", () => {
  it("lê as contas da própria casa", async () => {
    const { rows } = await asMember("select tenant_id from public.meta_ad_accounts");
    expect(rows.length).toBe(6);
    expect(new Set(rows.map((row) => row.tenant_id))).toEqual(new Set([ACTIVE]));
    const integrations = await asMember("select provider from public.marketing_integrations");
    expect(integrations.rows).toEqual([{ provider: "meta" }]);
  });

  it.each([
    ["update public.meta_ad_accounts set selected = false"],
    ["update public.meta_ad_accounts set connection_id = gen_random_uuid()"],
    [
      `insert into public.meta_ad_accounts (tenant_id, meta_ad_account_id) values ('${ACTIVE}', 'act_x')`,
    ],
    ["delete from public.meta_ad_accounts"],
    ["update public.marketing_integrations set status = 'disconnected'"],
    [
      `insert into public.marketing_integrations (tenant_id, provider) values ('${ACTIVE}', 'meta')`,
    ],
    ["delete from public.marketing_integrations"],
    [`insert into public.meta_sync_runs (tenant_id) values ('${ACTIVE}')`],
    ["update public.meta_sync_runs set status = 'failed'"],
    ["update public.meta_sync_jobs set status = 'failed'"],
    ["delete from public.meta_sync_jobs"],
  ])("recusa %s", async (sql) => {
    await expect(asMember(sql)).rejects.toThrow(/permission denied/);
  });

  it("deixa só a policy de SELECT nas tabelas de conta e integração", async () => {
    const { rows } = await db.query<{ tablename: string; policyname: string; cmd: string }>(
      `select tablename, policyname, cmd from pg_policies
       where tablename in ('meta_ad_accounts', 'marketing_integrations')
       order by tablename`,
    );
    expect(rows).toEqual([
      {
        tablename: "marketing_integrations",
        policyname: "marketing_integrations_tenant_select",
        cmd: "SELECT",
      },
      {
        tablename: "meta_ad_accounts",
        policyname: "meta_ad_accounts_tenant_select",
        cmd: "SELECT",
      },
    ]);
  });
});
