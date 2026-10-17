#!/usr/bin/env node
// Anonymized, idempotent clone of a client tenant into the demo tenant — also
// the demo reset (Task 12, spec §6).
//
//   node scripts/demo/clone-tenant-demo.mjs --source pixpgf --target demo           # dry-run
//   node scripts/demo/clone-tenant-demo.mjs --source pixpgf --target demo --apply   # writes
//
// Dry-run does EVERYTHING inside one transaction (including the PII scan),
// prints source × demo counts per table and rolls back. --apply commits, after
// uploading the Storage placeholders. Any PII scan hit rolls back and exits 1.
// Only a deterministic ~50% sample of the players (and the rows hanging from
// them) is cloned (ruling R14); configuration is cloned whole and the daily
// aggregates are recomputed for the demo.
//
// Connection: a direct Postgres connection (ruling R2 — no JWT claims, so the
// is_demo trigger accepts the change). URL from --db-url, DEMO_CLONE_DB_URL or
// SUPABASE_DB_URL (.env). The direct db.<ref>.supabase.co host is IPv6-only;
// when supabase/.temp/pooler-url exists its host/port/user are used with the
// password of SUPABASE_DB_URL. Needs the `pg` package (not a project
// dependency): `npm i --no-save pg`, or PG_MODULE_PATH=<dir containing pg>.
// Writing to production requires the user's explicit authorization each time.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { cloneTenantDemo } from "./clone-core.mjs";
import { formatHits } from "./pii-scan.mjs";
import { supabaseStorage } from "./storage.mjs";

function parseArgs(argv) {
  const out = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg.startsWith("--")) out[arg.slice(2)] = argv[(i += 1)];
  }
  return out;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

function findUp(relative) {
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Direct URL → session pooler URL when the direct host is the IPv6-only db.<ref> host. */
function resolveDbUrl(raw, poolerUrl) {
  const url = new URL(raw);
  if (!poolerUrl || !/^db\..+\.supabase\.co$/.test(url.hostname)) return raw;
  const pooler = new URL(poolerUrl.trim());
  pooler.password = url.password;
  pooler.pathname = url.pathname || pooler.pathname;
  return pooler.toString();
}

async function loadPg() {
  try {
    return (await import("pg")).default;
  } catch {
    const dir = process.env.PG_MODULE_PATH;
    if (!dir) throw new Error("the `pg` package is required: npm i --no-save pg (or set PG_MODULE_PATH)");
    return createRequire(path.join(dir, "noop.js"))("pg");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source || !args.target) {
    console.error("usage: node scripts/demo/clone-tenant-demo.mjs --source <slug> --target <slug> [--apply]");
    process.exit(2);
  }
  loadDotEnv(path.resolve(process.cwd(), ".env"));
  loadDotEnv(path.resolve(process.cwd(), ".env.local"));
  const rawDb = args["db-url"] ?? process.env.DEMO_CLONE_DB_URL ?? process.env.SUPABASE_DB_URL;
  if (!rawDb) throw new Error("set SUPABASE_DB_URL (or DEMO_CLONE_DB_URL / --db-url)");
  const poolerFile = findUp(path.join("supabase", ".temp", "pooler-url"));
  const connectionString = resolveDbUrl(rawDb, poolerFile ? fs.readFileSync(poolerFile, "utf8") : null);
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  if (!supabaseUrl) throw new Error("set SUPABASE_URL (Storage placeholder URLs)");

  let storage = null;
  if (args.apply) {
    const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) throw new Error("--apply needs SUPABASE_SECRET_KEY to upload the Storage placeholders");
    const { createClient } = await import("@supabase/supabase-js");
    storage = supabaseStorage(createClient(supabaseUrl, key, { auth: { persistSession: false } }));
  }

  const pg = await loadPg();
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    application_name: "clone-tenant-demo",
  });
  await client.connect();
  try {
    console.log(`${args.apply ? "APPLY" : "DRY-RUN"}: ${args.source} → ${args.target}`);
    const result = await cloneTenantDemo(client, {
      sourceSlug: args.source,
      targetSlug: args.target,
      apply: args.apply,
      storage,
      storageBaseUrl: supabaseUrl,
      log: (line) => console.log(line),
    });
    const width = Math.max(...result.counts.map((c) => c.table.length));
    // mode: whole = cloned in full; sample = R14 half-of-the-players sample
    // (expected = source rows in the sample); rebuilt = aggregate recomputed.
    console.log(`\n${"table".padEnd(width)}   source     demo  expected  mode`);
    for (const c of result.counts)
      console.log(
        `${c.table.padEnd(width)}  ${String(c.source).padStart(7)}  ${String(c.demo).padStart(7)}  ${String(c.expected ?? "-").padStart(8)}  ${c.mode}`,
      );
    if (!result.ok) {
      console.error(`\nPII scan found ${result.hits.length} hit(s) — rolled back, nothing written:\n${formatHits(result.hits)}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      result.applied
        ? `\nCOMMITTED: demo tenant ${result.demoTenantId} rebuilt, PII scan clean.`
        : "\nDRY-RUN: PII scan clean; transaction rolled back (use --apply to write).",
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
