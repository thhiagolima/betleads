/* eslint-disable @typescript-eslint/no-explicit-any -- generic Supabase query builder; the real
   client is typed by Supabase codegen, this just needs `.gt`/`.order`/`.limit`. */

// Shared pagination helper (moved out of conversion-report.functions.ts, Task 8 fix round 1,
// I3, so billing-admin.functions.ts can reuse it without behavior change).
//
// PostgREST caps every response at `max_rows` (1000 on Supabase) without an error. A query over
// wallet_ledger, payment_charges or billing_invoices can exceed that for a busy month, which
// would silently drop rows. Page by keyset on `id` (stable under concurrent inserts, unlike
// OFFSET) up to a hard ceiling.
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

export type PagedResult<T> = { data: T[]; error: { message: string } | null; truncated: boolean };

type ChunkResult<T> = { data: T[] | null; error: { message: string } | null };

// Exported so tests can prove it actually pages past PAGE_SIZE instead of mocking the whole
// caller's handler + auth middleware.
//
// `keyColumn` (Task 9 fix round 1, I2) defaults to "id" — unchanged behavior for every existing
// caller — but a table whose primary key isn't `id` (e.g. `tenant_billing`, keyed on
// `tenant_id`) can page on that column instead, as long as it's unique and sortable.
export async function selectAllPages<T extends Record<string, unknown>>(
  label: string,
  build: () => any,
  keyColumn: string = "id",
): Promise<PagedResult<T>> {
  const rows: T[] = [];
  let lastKey: unknown = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = build();
    if (lastKey !== null) query = query.gt(keyColumn, lastKey);
    const result: ChunkResult<T> = await query.order(keyColumn, { ascending: true }).limit(PAGE_SIZE);
    if (result.error) return { data: rows, error: result.error, truncated: false };
    const data = result.data ?? [];
    rows.push(...data);
    if (data.length < PAGE_SIZE) return { data: rows, error: null, truncated: false };
    lastKey = (data[data.length - 1] as Record<string, unknown>)[keyColumn];
  }
  console.warn(
    `[selectAllPages] ${label}: stopped after ${MAX_PAGES * PAGE_SIZE} rows; report truncated.`,
  );
  return { data: rows, error: null, truncated: true };
}
