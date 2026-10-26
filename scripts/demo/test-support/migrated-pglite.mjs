// Test support: a PGlite database with every migration in supabase/migrations
// applied on top of minimal Supabase stand-ins (auth, storage, cron, net,
// realtime). Used by the clone integration tests so they exercise the real
// columns, constraints and triggers. Migrations that only seed production
// tenants (they raise when Sorte Alta & co. are missing) fail harmlessly and
// are returned in `failed`.
//
// Applying ~all migrations costs several CPU-seconds; under the full parallel
// suite that starved other PGlite test files into timeouts. So the migrated
// data directory is built ONCE per migration set and cached as a tarball in
// the OS temp dir (keyed by a hash of the stubs, the migrations and the
// PGlite version); every later database is restored from it. A lock file
// makes concurrent test files wait for a single builder.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../../supabase/migrations");
const CACHE_DIR = join(tmpdir(), "betleads-demo-pglite");
const LOCK_STALE_MS = 5 * 60 * 1000;
const WAIT_MS = 4 * 60 * 1000;

const STUBS = `
DO $$ BEGIN
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
  CREATE ROLE supabase_realtime_admin NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA extensions;
CREATE SCHEMA realtime;
CREATE TABLE realtime.messages (id bigserial primary key, topic text, extension text);
CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE SCHEMA cron;
CREATE SCHEMA net;
CREATE SCHEMA vault;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  created_at timestamptz, last_sign_in_at timestamptz, banned_until timestamptz, confirmation_token text,
  recovery_token text, email_change_token_new text, email_change text, email_change_token_current text,
  phone_change text, phone_change_token text, reauthentication_token text, email_confirmed_at timestamptz,
  updated_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint,
  allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now(), owner uuid);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS $$ SELECT string_to_array(name,'/') $$;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text, command text, active boolean default true);
CREATE FUNCTION cron.schedule(a text, b text, c text) RETURNS bigint LANGUAGE sql AS $$ INSERT INTO cron.job(jobname,schedule,command) VALUES (a,b,c) RETURNING jobid $$;
CREATE FUNCTION cron.unschedule(a bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION cron.unschedule(a text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 1000) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
CREATE PUBLICATION supabase_realtime;
SET check_function_bodies = off;
`;

function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(resolve(MIGRATIONS, file), "utf8") }));
}

function cacheKey(files) {
  const hash = createHash("sha256").update(STUBS).update(readFileSync(fileURLToPath(import.meta.url)));
  for (const { file, sql } of files) hash.update(file).update("\0").update(sql).update("\0");
  try {
    hash.update(readFileSync(resolve(HERE, "../../../node_modules/@electric-sql/pglite/package.json")));
  } catch {
    // version unknown: the migration hash still keys the cache
  }
  return hash.digest("hex").slice(0, 24);
}

async function build(files) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(STUBS);
  const failed = [];
  for (const { file, sql } of files) {
    try {
      // 20261022100000 (PG1 Task 2) requires exactly 3 tenants with these
      // slugs to already exist (they're exempt in production); seed
      // placeholders right before it so its functions (billing_price_book,
      // billing_report_unit_price, ...) actually get created here instead
      // of failing "harmlessly" like the other production-tenant-seeding
      // migrations below — later migrations (PG1 Task 6) call them at
      // runtime, not just at apply time, so a harmless failure here would
      // stop being harmless.
      if (file === "20261022100000_billing_price_book.sql") {
        await db.exec(`
          insert into public.tenants (id, nome, slug, status, plano)
          values
            (gen_random_uuid(), 'PixPGF', 'pixpgf', 'active', 'starter'),
            (gen_random_uuid(), 'PixReals', 'pixreals', 'active', 'starter'),
            (gen_random_uuid(), 'ForrandoBet', 'forrandobet', 'active', 'starter')
          on conflict (slug) do nothing;
        `);
      }
      await db.exec(sql.replace(/create extension[^;]*;/gi, ""));
    } catch (error) {
      failed.push({ file, error: String(error?.message ?? error).slice(0, 200) });
      try {
        await db.exec("ROLLBACK");
      } catch {
        // not in a transaction
      }
    }
  }
  await db.exec("RESET check_function_bodies");
  return { db, failed };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function restore(tarPath, metaPath) {
  const blob = new Blob([readFileSync(tarPath)]);
  const db = new PGlite({ extensions: { pgcrypto }, loadDataDir: blob });
  await db.waitReady;
  const { failed } = JSON.parse(readFileSync(metaPath, "utf8"));
  return { db, failed };
}

/** A fresh, fully migrated PGlite database (restored from the shared cache when possible). */
export async function createMigratedDb({ cache = process.env.DEMO_PGLITE_CACHE !== "0" } = {}) {
  const files = migrationFiles();
  if (!cache) return build(files);
  mkdirSync(CACHE_DIR, { recursive: true });
  const key = cacheKey(files);
  const tarPath = join(CACHE_DIR, `${key}.tar.gz`);
  const metaPath = join(CACHE_DIR, `${key}.json`);
  const lockPath = join(CACHE_DIR, `${key}.lock`);

  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    if (existsSync(tarPath) && existsSync(metaPath)) {
      try {
        return await restore(tarPath, metaPath);
      } catch {
        // corrupt cache entry: rebuild below
        try {
          unlinkSync(tarPath);
        } catch {
          // already gone
        }
      }
    }
    let fd = null;
    try {
      fd = openSync(lockPath, "wx");
    } catch {
      // someone else is building — unless the lock is stale
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
      } catch {
        // lock vanished
      }
    }
    if (fd !== null) {
      try {
        const built = await build(files);
        const dump = await built.db.dumpDataDir("gzip");
        const bytes = Buffer.from(await dump.arrayBuffer());
        writeFileSync(`${tarPath}.tmp`, bytes);
        writeFileSync(`${metaPath}.tmp`, JSON.stringify({ failed: built.failed }));
        renameSync(`${metaPath}.tmp`, metaPath);
        renameSync(`${tarPath}.tmp`, tarPath);
        return built;
      } finally {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {
          // already removed
        }
      }
    }
    if (Date.now() > deadline) return build(files);
    await sleep(250);
  }
}
