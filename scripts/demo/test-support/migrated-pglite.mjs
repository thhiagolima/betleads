// Test support: a PGlite database with every migration in supabase/migrations
// applied on top of minimal Supabase stand-ins (auth, storage, cron, net,
// realtime). Used by the clone integration test so it exercises the real
// columns, constraints and triggers. Migrations that only seed production
// tenants (they raise when Sorte Alta & co. are missing) fail harmlessly and
// are returned in `failed`.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations");

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

export async function createMigratedDb() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(STUBS);
  const failed = [];
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(resolve(MIGRATIONS, file), "utf8").replace(/create extension[^;]*;/gi, "");
    try {
      await db.exec(sql);
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
