// Meta Ads, fase MB2: testes SQL de
// supabase/migrations/20261127100000_meta_mb2_sync.sql
// (rate_limited_count, tipo/validade da chave em meta_connect_token, claim justo
// com no máximo 2 jobs por casa e 3 por app, cron a cada minuto).
// Escopo: docs/ESCOPO_META_MULTI_BM_2026-10-30.md, seção 6 (MB2-01, MB2-03, MB2-05).

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
  migration("20261118100000_meta_mb1_multi_bm.sql"),
];
const MIGRATION = migration("20261127100000_meta_mb2_sync.sql");

const tenantId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T = [1, 2, 3, 4, 5, 6].map(tenantId);
const DEMO = tenantId(90);
const SUSPENDED = tenantId(91);
const FROZEN = tenantId(92);
const ACTOR = "11111111-0000-4000-8000-000000000001";

const REAPED = "Tempo esgotado: o processamento da conta foi interrompido.";

// Pré-requisitos das migrations Meta (fora delas no projeto real); mesmo
// stand-in de meta-multi-bm.db.test.ts.
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

-- pg_cron (stand-in) com o job antigo do worker.
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

type Json = Record<string, any>;

let seq = 0;

// Cria uma conexão (app `app`, ou legada sem app quando null), um run de
// backfill e `n` contas com um job cada. `ages` = segundos atrás de
// next_attempt_at por job (padrão: 60 s, todos vencidos).
async function seedJobs(
  tenant: string,
  app: string | null,
  n: number,
  opts: { ages?: number[] } = {},
): Promise<string[]> {
  seq += 1;
  const { rows: conn } = await db.query<{ id: string }>(
    `insert into public.meta_connections
       (tenant_id, connected_by_user_id, meta_user_id, access_token, encrypted_access_token,
        auth_type, status, app_id)
     values ($1, $2, $3, null, 'cifrado', $4, 'connected', $5)
     returning id`,
    [tenant, ACTOR, `su-${seq}`, app ? "system_user_token" : "legacy_oauth", app],
  );
  const { rows: run } = await db.query<{ id: string }>(
    `insert into public.meta_sync_runs (tenant_id, trigger_type, status, days)
     values ($1, 'backfill', 'queued', 30) returning id`,
    [tenant],
  );
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const { rows: account } = await db.query<{ id: string }>(
      `insert into public.meta_ad_accounts (tenant_id, connection_id, meta_ad_account_id, selected)
       values ($1, $2, $3, true) returning id`,
      [tenant, conn[0].id, `act_${seq}_${i}`],
    );
    const age = opts.ages?.[i] ?? 60;
    const { rows: job } = await db.query<{ id: string }>(
      `insert into public.meta_sync_jobs (run_id, tenant_id, account_id, days, next_attempt_at)
       values ($1, $2, $3, 30, now() - make_interval(secs => $4)) returning id`,
      [run[0].id, tenant, account[0].id, age],
    );
    ids.push(job[0].id);
  }
  return ids;
}

async function claim(limit: number, worker = "w1") {
  const { rows } = await db.query<Json>(
    "select * from public.claim_meta_sync_jobs($1, $2)",
    [limit, worker],
  );
  return rows;
}

async function appOf(jobId: string): Promise<string | null> {
  const { rows } = await db.query<{ app_id: string | null }>(
    `select connection.app_id
     from public.meta_sync_jobs job
     join public.meta_ad_accounts account on account.id = job.account_id
     join public.meta_connections connection on connection.id = account.connection_id
     where job.id = $1`,
    [jobId],
  );
  return rows[0].app_id;
}

const countBy = <K>(items: K[]) =>
  items.reduce<Map<K, number>>((map, key) => map.set(key, (map.get(key) ?? 0) + 1), new Map());

async function connect(user: string, extra: Json) {
  const connection = {
    meta_user_id: user,
    meta_user_name: `Usuário ${user}`,
    app_id: "app1",
    app_name: "App Teste",
    encrypted_access_token: `cifrado-${user}`,
    token_hint: "…a3f9",
    scopes: ["ads_read", "business_management"],
    label: `Chave ${user}`,
    ...extra,
  };
  const accounts = [
    {
      meta_ad_account_id: `act_${user}`,
      account_id: user,
      name: `Conta ${user}`,
      business_id: "bm1",
      business_name: "BM 1",
      currency: "BRL",
      timezone_name: "America/Sao_Paulo",
      account_status: 1,
      raw: {},
    },
  ];
  const { rows } = await db.query<{ r: Json }>(
    "select public.meta_connect_token($1, $2, $3::jsonb, $4::jsonb) as r",
    [T[0], ACTOR, JSON.stringify(connection), JSON.stringify(accounts)],
  );
  return rows[0].r;
}

async function connection(id: string) {
  const { rows } = await db.query<Json>("select * from public.meta_connections where id = $1", [
    id,
  ]);
  return rows[0];
}

async function asMember(sql: string) {
  await db.query("BEGIN");
  try {
    await db.query(`select set_config('test.tenant', $1, true)`, [T[0]]);
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
    insert into public.tenants (id, slug, is_demo, status) values
      ${T.map((id, i) => `('${id}', 'casa${i + 1}', false, 'active')`).join(", ")},
      ('${DEMO}', 'demo', true, 'active'),
      ('${SUSPENDED}', 'suspensa', false, 'suspended'),
      ('${FROZEN}', 'congelada', false, 'active');
    insert into public.tenant_billing (tenant_id, access_state) values ('${FROZEN}', 'frozen');
  `);
  for (const sql of MIGRATIONS_BEFORE) await db.exec(sql);
  await db.exec(MIGRATION);
  // Idempotente: aplicar de novo não pode falhar.
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
    delete from public.meta_ad_accounts;
    delete from public.meta_connections;
  `);
});

describe("migration", () => {
  it("adiciona as colunas uma vez só, com rate_limited_count padrão 0", async () => {
    const { rows } = await db.query<Json>(
      `select table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns
       where (table_name = 'meta_sync_jobs' and column_name = 'rate_limited_count')
          or (table_name = 'meta_connections' and column_name in ('token_type', 'health_checked_at'))
       order by table_name, column_name`,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        table_name: "meta_connections",
        column_name: "health_checked_at",
        data_type: "timestamp with time zone",
      }),
      expect.objectContaining({
        table_name: "meta_connections",
        column_name: "token_type",
        data_type: "text",
      }),
      expect.objectContaining({
        table_name: "meta_sync_jobs",
        column_name: "rate_limited_count",
        data_type: "integer",
        is_nullable: "NO",
        column_default: "0",
      }),
    ]);

    const [job] = await seedJobs(T[0], "appA", 1);
    const { rows: jobs } = await db.query<Json>(
      "select rate_limited_count from public.meta_sync_jobs where id = $1",
      [job],
    );
    expect(jobs[0].rate_limited_count).toBe(0);
    // O claim devolve a coluna nova na linha do job.
    const claimed = await claim(1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: job, rate_limited_count: 0 });

    await expect(
      db.query("update public.meta_sync_jobs set rate_limited_count = -1 where id = $1", [job]),
    ).rejects.toThrow(/check/);
  });
});

describe("meta_connect_token (MB2)", () => {
  it("grava tipo e validade da chave e marca health_checked_at", async () => {
    const result = await connect("su1", {
      token_type: "SYSTEM_USER",
      token_expires_at: null,
      data_access_expires_at: "2027-01-28T12:00:00.000Z",
    });
    expect(result.created).toBe(true);
    const row = await connection(result.connection_id);
    expect(row.token_type).toBe("SYSTEM_USER");
    expect(row.token_expires_at).toBeNull();
    expect(new Date(row.data_access_expires_at).toISOString()).toBe("2027-01-28T12:00:00.000Z");
    expect(row.health_checked_at).not.toBeNull();
    expect(row.status).toBe("connected");
  });

  it("trocar a chave regrava os campos; chaves ausentes viram null", async () => {
    const first = await connect("su1", {
      token_type: "SYSTEM_USER",
      token_expires_at: "2026-12-01T00:00:00Z",
      data_access_expires_at: "2027-01-01T00:00:00Z",
    });
    const second = await connect("su1", {
      token_type: "SYSTEM_USER",
      token_expires_at: "2027-06-01T00:00:00Z",
      data_access_expires_at: null,
    });
    expect(second).toMatchObject({ connection_id: first.connection_id, created: false });
    let row = await connection(first.connection_id);
    expect(new Date(row.token_expires_at).toISOString()).toBe("2027-06-01T00:00:00.000Z");
    expect(row.data_access_expires_at).toBeNull();
    const checkedAt = row.health_checked_at;
    expect(checkedAt).not.toBeNull();

    // Sem as chaves novas (payload da MB1): tudo null; health_checked_at fica.
    const third = await connect("su1", {});
    expect(third.connection_id).toBe(first.connection_id);
    row = await connection(first.connection_id);
    expect(row).toMatchObject({
      token_type: null,
      token_expires_at: null,
      data_access_expires_at: null,
    });
    expect(row.health_checked_at).toEqual(checkedAt);

    // Conexão nova sem as chaves: tudo null, inclusive health_checked_at.
    const other = await connect("su2", {});
    expect(await connection(other.connection_id)).toMatchObject({
      token_type: null,
      token_expires_at: null,
      data_access_expires_at: null,
      health_checked_at: null,
    });
  });

  it("recusa validade em formato inválido sem gravar nada", async () => {
    await expect(connect("su1", { token_expires_at: "amanhã" })).rejects.toThrow(
      "Validade da chave Meta em formato inválido.",
    );
    const { rows } = await db.query("select id from public.meta_connections");
    expect(rows).toEqual([]);
  });
});

describe("claim_meta_sync_jobs (MB2): justiça", () => {
  it("casa com 5 jobs e outra com 1: limite 10 pega 2 + 1", async () => {
    const t1 = await seedJobs(T[0], "appA", 5);
    const t2 = await seedJobs(T[1], "appB", 1);
    const claimed = await claim(10);
    expect(claimed).toHaveLength(3);
    const byTenant = countBy(claimed.map((job) => job.tenant_id));
    expect(byTenant.get(T[0])).toBe(2);
    expect(byTenant.get(T[1])).toBe(1);
    expect(claimed.map((job) => job.id)).toContain(t2[0]);
    for (const job of claimed) {
      expect(job).toMatchObject({ status: "running", attempt_count: 1, worker_id: "w1" });
      expect(job.locked_at).not.toBeNull();
    }
    // Os 3 restantes da casa 1 continuam na fila.
    const { rows } = await db.query<Json>(
      "select count(*)::int as n from public.meta_sync_jobs where id = any($1::uuid[]) and status = 'queued'",
      [`{${t1.join(",")}}`],
    );
    expect(rows[0].n).toBe(3);
  });

  it("4 casas no mesmo app: no máximo 3 jobs desse app", async () => {
    for (const tenant of T.slice(0, 4)) await seedJobs(tenant, "appA", 2);
    const other = await seedJobs(T[4], "appB", 2);
    const claimed = await claim(10);
    const apps = countBy(await Promise.all(claimed.map((job) => appOf(job.id))));
    expect(apps.get("appA")).toBe(3);
    expect(apps.get("appB")).toBe(2);
    expect(claimed).toHaveLength(5);
    expect(claimed.map((job) => job.id).sort()).toEqual(expect.arrayContaining(other));
    // Nenhuma casa com mais de 2.
    for (const n of countBy(claimed.map((job) => job.tenant_id)).values()) {
      expect(n).toBeLessThanOrEqual(2);
    }
  });

  it("contas sem app (conexão legada) formam um grupo só", async () => {
    for (const tenant of T.slice(0, 3)) await seedJobs(tenant, null, 2);
    await seedJobs(T[3], "appA", 1);
    const claimed = await claim(10);
    const apps = countBy(await Promise.all(claimed.map((job) => appOf(job.id))));
    expect(apps.get(null)).toBe(3);
    expect(apps.get("appA")).toBe(1);
    expect(claimed).toHaveLength(4);
  });

  it("o limite fica entre 1 e 10", async () => {
    for (const [i, tenant] of T.entries()) await seedJobs(tenant, `app${i}`, 2);
    expect(await claim(100)).toHaveLength(10);
    await db.exec("update public.meta_sync_jobs set status = 'queued', attempt_count = 0");
    expect(await claim(0)).toHaveLength(1);
  });

  it("casas demo, suspensas ou congeladas não ocupam vaga do app", async () => {
    await seedJobs(DEMO, "appA", 2, { ages: [600, 600] });
    await seedJobs(SUSPENDED, "appA", 2, { ages: [600, 600] });
    await seedJobs(FROZEN, "appA", 2, { ages: [600, 600] });
    const mine = await seedJobs(T[0], "appA", 2);
    const claimed = await claim(10);
    expect(claimed.map((job) => job.id).sort()).toEqual([...mine].sort());
  });
});

describe("claim_meta_sync_jobs (MB2): ordem e travas", () => {
  it("pega primeiro o next_attempt_at mais antigo; futuro fica de fora", async () => {
    const jobs = await seedJobs(T[0], "appA", 4, { ages: [10, 30, 20, -600] });
    expect((await claim(1)).map((job) => job.id)).toEqual([jobs[1]]);
    expect((await claim(1)).map((job) => job.id)).toEqual([jobs[2]]);
    expect((await claim(1)).map((job) => job.id)).toEqual([jobs[0]]);
    // O job no futuro não é reclamado.
    expect(await claim(10)).toEqual([]);
  });

  it("dentro da casa, os 2 escolhidos são os mais antigos", async () => {
    const jobs = await seedJobs(T[0], "appA", 4, { ages: [10, 40, 20, 30] });
    const claimed = await claim(10);
    expect(claimed.map((job) => job.id).sort()).toEqual([jobs[1], jobs[3]].sort());
  });

  it("dois claims seguidos nunca devolvem o mesmo job", async () => {
    for (const tenant of T.slice(0, 3)) await seedJobs(tenant, `app-${tenant}`, 2);
    const first = await claim(3, "w1");
    const second = await claim(3, "w2");
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    const firstIds = new Set(first.map((job) => job.id));
    expect(second.some((job) => firstIds.has(job.id))).toBe(false);
    // Fila vazia: um terceiro claim não devolve nada.
    expect(await claim(10, "w3")).toEqual([]);
    const { rows } = await db.query<Json>(
      "select worker_id, count(*)::int as n from public.meta_sync_jobs group by worker_id order by worker_id",
    );
    expect(rows).toEqual([
      { worker_id: "w1", n: 3 },
      { worker_id: "w2", n: 3 },
    ]);
  });

  it("job em andamento com lock recente não é reclamado de novo", async () => {
    // O PGlite tem uma sessão só: a concorrência real (SKIP LOCKED entre dois
    // workers) não dá para reproduzir aqui; conferimos o efeito em sequência.
    const [a, b] = await seedJobs(T[0], "appA", 2, { ages: [60, 30] });
    await seedJobs(T[1], "appB", 1, { ages: [10] });
    await db.query(
      "update public.meta_sync_jobs set status = 'running', locked_at = now(), attempt_count = 1 where id = $1",
      [a],
    );
    const claimed = await claim(10);
    expect(claimed.map((job) => job.id)).not.toContain(a);
    expect(claimed.map((job) => job.id)).toContain(b);
  });
});

describe("claim_meta_sync_jobs (MB2): reaper", () => {
  it("falha o job vencido na última tentativa e tira a conta de syncing", async () => {
    const [stale, fresh] = await seedJobs(T[0], "appA", 2);
    await db.query(
      `update public.meta_sync_jobs
       set status = 'running', attempt_count = max_attempts, locked_at = now() - interval '11 minutes',
           worker_id = 'old-worker'
       where id = $1`,
      [stale],
    );
    await db.query(
      "update public.meta_sync_jobs set status = 'completed', finished_at = now() where id = $1",
      [fresh],
    );
    await db.exec("update public.meta_ad_accounts set sync_status = 'syncing', last_error = null");

    expect(await claim(5)).toEqual([]);

    const { rows } = await db.query<Json>(
      `select job.status, job.last_error, job.locked_at, job.worker_id, job.finished_at,
              account.sync_status,
              account.last_error as account_error, run.status as run_status
       from public.meta_sync_jobs job
       join public.meta_ad_accounts account on account.id = job.account_id
       join public.meta_sync_runs run on run.id = job.run_id
       where job.id = $1`,
      [stale],
    );
    expect(rows[0]).toMatchObject({
      status: "failed",
      last_error: REAPED,
      locked_at: null,
      worker_id: null,
      sync_status: "error",
      account_error: REAPED,
    });
    expect(rows[0].finished_at).not.toBeNull();
    expect(["queued", "running"]).not.toContain(rows[0].run_status);

    // O worker original, se acordar depois, não consegue reabrir nem concluir
    // o job já finalizado pelo reaper (ele filtra por worker_id).
    for (const status of ["queued", "completed"]) {
      const result = await db.query(
        `update public.meta_sync_jobs set status = $3, locked_at = null
         where id = $1 and worker_id = $2`,
        [stale, "old-worker", status],
      );
      expect(result.affectedRows).toBe(0);
    }
    const { rows: after } = await db.query<Json>(
      "select status from public.meta_sync_jobs where id = $1",
      [stale],
    );
    expect(after[0].status).toBe("failed");

    const { rows: other } = await db.query<Json>(
      `select account.sync_status from public.meta_sync_jobs job
       join public.meta_ad_accounts account on account.id = job.account_id where job.id = $1`,
      [fresh],
    );
    expect(other[0].sync_status).toBe("syncing");
  });

  it("job vencido com tentativas sobrando é reclamado de novo", async () => {
    const [job] = await seedJobs(T[0], "appA", 1);
    await db.query(
      `update public.meta_sync_jobs
       set status = 'running', attempt_count = 1, locked_at = now() - interval '11 minutes',
           worker_id = 'old-worker'
       where id = $1`,
      [job],
    );
    const claimed = await claim(5, "new-worker");
    expect(claimed.map((row) => [row.id, row.attempt_count])).toEqual([[job, 2]]);
    expect(claimed[0].worker_id).toBe("new-worker");

    // O worker antigo perdeu a posse: o update dele não acha a linha.
    const result = await db.query(
      `update public.meta_sync_jobs set status = 'completed'
       where id = $1 and worker_id = $2`,
      [job, "old-worker"],
    );
    expect(result.affectedRows).toBe(0);
  });

  it("o reaper vale para casa demo", async () => {
    const [job] = await seedJobs(DEMO, "appA", 1);
    await db.query(
      `update public.meta_sync_jobs
       set status = 'running', attempt_count = max_attempts, locked_at = now() - interval '11 minutes'
       where id = $1`,
      [job],
    );
    expect(await claim(5)).toEqual([]);
    const { rows } = await db.query<Json>("select status from public.meta_sync_jobs where id = $1", [
      job,
    ]);
    expect(rows[0].status).toBe("failed");
  });
});

describe("cron do worker", () => {
  it("roda a cada minuto com timeout de 55 s e um job só", async () => {
    const { rows } = await db.query<Json>(
      "select schedule, command from cron.job where jobname = 'betleads-meta-sync-worker'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].schedule).toBe("* * * * *");
    expect(rows[0].command).toContain("https://betleads.io/api/public/meta-sync/tick");
    expect(rows[0].command).toContain("betleads_cron_secret");
    expect(rows[0].command).toContain("timeout_milliseconds := 55000");
  });
});

describe("privilégios", () => {
  it("as funções seguem security definer e só service_role executa", async () => {
    const { rows } = await db.query<Json>(
      `select proname, prosecdef, proconfig
       from pg_proc
       where proname in ('claim_meta_sync_jobs', 'meta_connect_token')
       order by proname`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.prosecdef).toBe(true);
      expect(row.proconfig).toEqual(["search_path=public"]);
    }
    const calls = [
      `select * from public.claim_meta_sync_jobs(1, null)`,
      `select public.meta_connect_token('${T[0]}', '${ACTOR}', '{}'::jsonb, '[]'::jsonb)`,
    ];
    for (const sql of calls) {
      await expect(asMember(sql)).rejects.toThrow(/permission denied/);
    }
    const { rows: grants } = await db.query<Json>(
      `select has_function_privilege('service_role', 'public.claim_meta_sync_jobs(integer, text)', 'execute') as claim,
              has_function_privilege('service_role', 'public.meta_connect_token(uuid, uuid, jsonb, jsonb)', 'execute') as connect`,
    );
    expect(grants[0]).toEqual({ claim: true, connect: true });
  });
});
