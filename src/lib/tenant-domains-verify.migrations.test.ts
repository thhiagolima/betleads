// Task 6 — static check: the tenant-domains verification cron job
// (pg_cron + pg_net), following the pattern of
// 20261014193000_accelerate_shortio_click_sync.sql:14-29.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION_PATH = resolve(
  __dirname,
  "../..",
  "supabase/migrations/20261021100100_tenant_domains_verify_cron.sql",
);
const SQL = readFileSync(MIGRATION_PATH, "utf8");

describe("tenant_domains verify cron migration", () => {
  it("unschedules the prior job by name before scheduling", () => {
    const unscheduleIdx = SQL.search(/cron\.job\s+where\s+jobname\s*=\s*'betleads-tenant-domains-verify'/i);
    expect(unscheduleIdx, "no cron.unschedule lookup for betleads-tenant-domains-verify").toBeGreaterThan(-1);
    expect(SQL.slice(unscheduleIdx, unscheduleIdx + 200)).toMatch(/cron\.unschedule/i);

    const scheduleIdx = SQL.indexOf("cron.schedule('betleads-tenant-domains-verify'");
    expect(scheduleIdx, "no cron.schedule for betleads-tenant-domains-verify").toBeGreaterThan(-1);
    expect(unscheduleIdx).toBeLessThan(scheduleIdx);
  });

  it("schedules every 10 minutes", () => {
    expect(SQL).toMatch(/cron\.schedule\('betleads-tenant-domains-verify',\s*'\*\/10 \* \* \* \*'/);
  });

  it("posts to the verify endpoint", () => {
    expect(SQL).toContain("https://betleads.io/api/public/tenant-domains/verify");
  });

  it("reads the bearer token from the betleads_cron_secret vault entry", () => {
    expect(SQL).toMatch(/'Bearer '\s*\|\|\s*\(/);
    expect(SQL).toMatch(/from\s+vault\.decrypted_secrets/i);
    expect(SQL).toMatch(/where\s+name\s*=\s*'betleads_cron_secret'/i);
  });

  it("ends with a schema reload notification", () => {
    expect(SQL.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });
});
