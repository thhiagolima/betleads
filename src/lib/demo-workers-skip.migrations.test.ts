// Task 9 — static check: the LATEST definition (last migration in lexical
// order) of every queue/cron function that workers use to claim or iterate
// work must skip demo tenants, and the per-tenant orchestrator cron must not
// fan out to them.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "../..", "supabase/migrations");
const FILES = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const SOURCES = FILES.map((name) => ({
  name,
  sql: readFileSync(resolve(MIGRATIONS_DIR, name), "utf8"),
}));

// Functions whose claimed/iterated set is a table with a tenant_id column:
// the filter must be `public.is_demo_tenant(...)`.
const ROW_FILTERED = [
  "claim_call_flow_progress",
  "claim_due_email_campaigns",
  "claim_due_journey_enrollments",
  "claim_due_sms_campaigns",
  "claim_email_flow_leads",
  "claim_journey_scan_jobs",
  "claim_meta_sync_jobs",
  "claim_sms_flow_leads",
  "process_journey_level_outbox",
  "recover_stuck_email_campaigns",
  "recover_stuck_email_leads",
  "recover_stuck_sms_campaigns",
  "recover_stuck_sms_leads",
  // Journey maintenance RPCs the dispatcher/scanner call every tick.
  "recover_orphaned_journey_claims",
  "resume_priority_paused_journeys",
  "sweep_journey_exits",
  "sync_journey_scan_jobs",
];

// Functions with more than one statement writing tenant rows: every one of
// them must carry the filter (claim + retention DELETE, two UPDATEs, upsert +
// pause UPDATE).
const MIN_FILTERS: Record<string, number> = {
  process_journey_level_outbox: 2,
  recover_orphaned_journey_claims: 2,
  sync_journey_scan_jobs: 2,
};

// Functions that iterate `public.tenants` directly: `is_demo` on the tenant row.
const TENANT_LOOPS = [
  "claim_journey_enrollments_leased",
  "claim_webhook_logs_for_replay",
  "refresh_recent_dashboard_metrics_slot",
  "refresh_crm_results_recent",
  "check_crm_results_recent",
];

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The full text of the last `create [or replace] function <name>(` in the
 * last migration (lexical order) that defines it, up to the end of its
 * dollar-quoted body. */
function latestDefinition(name: string): { file: string; body: string } {
  const pattern = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.|"public"\\.)?"?${escapeRegExp(name)}"?\\s*\\(`,
    "gi",
  );
  for (let i = SOURCES.length - 1; i >= 0; i--) {
    const { name: file, sql } = SOURCES[i];
    const starts = [...sql.matchAll(pattern)].map((m) => m.index ?? 0);
    if (!starts.length) continue;
    const start = starts[starts.length - 1];
    const rest = sql.slice(start);
    const open = /\$([a-z_]*)\$/i.exec(rest);
    if (!open) throw new Error(`${name}: no dollar-quoted body in ${file}`);
    const close = rest.indexOf(open[0], open.index + open[0].length);
    if (close < 0) throw new Error(`${name}: unterminated body in ${file}`);
    return { file, body: rest.slice(0, close + open[0].length) };
  }
  throw new Error(`${name}: not defined in any migration`);
}

describe("latest worker/cron function definitions skip demo tenants", () => {
  it.each(ROW_FILTERED)("%s filters with is_demo_tenant", (name) => {
    const { file, body } = latestDefinition(name);
    expect(body, `${name} (latest in ${file})`).toMatch(/is_demo_tenant/);
    const count = body.match(/is_demo_tenant/g)?.length ?? 0;
    expect(count, `${name}: is_demo_tenant occurrences`).toBeGreaterThanOrEqual(
      MIN_FILTERS[name] ?? 1,
    );
  });

  it.each(TENANT_LOOPS)("%s skips demo tenants in its tenant loop", (name) => {
    const { file, body } = latestDefinition(name);
    expect(body, `${name} (latest in ${file})`).toMatch(/is_demo/);
  });
});

describe("betleads-orchestrate-tenants cron", () => {
  it("the latest schedule never posts for a demo tenant", () => {
    const pattern = /cron\.schedule\(\s*'betleads-orchestrate-tenants'/gi;
    let latest: { file: string; text: string } | null = null;
    for (const { name, sql } of SOURCES) {
      for (const m of sql.matchAll(pattern)) {
        const rest = sql.slice(m.index ?? 0);
        const end = rest.search(/\$job\$\s*\)\s*;/);
        latest = { file: name, text: end >= 0 ? rest.slice(0, end) : rest };
      }
    }
    expect(latest, "no cron.schedule for betleads-orchestrate-tenants").not.toBeNull();
    expect(latest!.text, `latest in ${latest!.file}`).toMatch(/is_demo/);
  });
});
