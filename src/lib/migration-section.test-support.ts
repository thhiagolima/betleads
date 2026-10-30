// Extracts one `-- >>> section: <name>` ... `-- <<< section: <name>` block of
// a migration, so a PGlite test can run only the part whose tables its
// minimal schema has.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");

export function migrationSection(file: string, name: string): string {
  const sql = readFileSync(resolve(root, "supabase/migrations", file), "utf8");
  const start = `-- >>> section: ${name}`;
  const end = `-- <<< section: ${name}`;
  const from = sql.indexOf(start);
  const to = sql.indexOf(end);
  if (from < 0 || to < from) throw new Error(`section ${name} not found in ${file}`);
  return sql.slice(from + start.length, to);
}

export const EXPERT_HARDENING = "20261125100000_expert_hardening.sql";
