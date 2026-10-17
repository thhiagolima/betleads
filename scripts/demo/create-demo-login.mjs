#!/usr/bin/env node
// Demo login generator (Task 13, spec §7): creates Supabase Auth users for
// the `demo` tenant (gestor role only, never admin/super_admin — see Task 1's
// trg_user_roles_demo_user_guard / trg_auth_users_demo_user_guard) and prints
// e-mail + password once; --revoke bans a login and drops its role.
//
// Refuses to run unless the `demo` tenant exists with is_demo = true.
//
//   node scripts/demo/create-demo-login.mjs --count 2 --label "prospect x"
//   node scripts/demo/create-demo-login.mjs --revoke demo+prospect-x-ab12cd34@betleads.io
//
// Needs SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)
// from the environment or .env/.env.local.
//
// Writing to production requires the user's explicit authorization each
// time (project rule) — never run this against prod without that; the live
// run happens in Task 14, not here.
import fs from "node:fs";
import path from "node:path";

import { createDemoLogins, revokeDemoLogin } from "./create-demo-login.core.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
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

async function buildClient() {
  loadDotEnv(path.resolve(process.cwd(), ".env"));
  loadDotEnv(path.resolve(process.cwd(), ".env.local"));
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey)
    throw new Error("set SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)");
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

const KNOWN_OPTIONS = new Set(["count", "label", "revoke"]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Unknown options fail loudly (e.g. an old --expires-at: no expiry is
  // enforced anywhere, so logins end with --revoke).
  const unknown = Object.keys(args).filter((key) => !KNOWN_OPTIONS.has(key));
  if (unknown.length) throw new Error(`unknown option(s): ${unknown.map((k) => `--${k}`).join(", ")}`);
  const client = await buildClient();

  if (args.revoke) {
    const result = await revokeDemoLogin(client, { email: String(args.revoke) });
    console.log(`Revoked demo login ${result.email} (user ${result.userId}).`);
    return;
  }

  const count = args.count !== undefined ? Number(args.count) : 1;
  const results = await createDemoLogins(client, {
    count,
    label: args.label !== undefined ? String(args.label) : undefined,
  });

  console.log(`Created ${results.length} demo login(s):\n`);
  for (const r of results) {
    console.log(`  e-mail: ${r.email}`);
    console.log(`  senha:  ${r.password}`);
    console.log("");
  }
  console.log("Repasse e-mail e senha ao prospect agora — a senha não é mostrada de novo.");
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
