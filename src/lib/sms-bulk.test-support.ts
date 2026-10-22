/* eslint-disable @typescript-eslint/no-explicit-any -- minimal fake of the Supabase query builder for tests. */
// In-memory stand-in for the subset of the Supabase query builder used by the
// SMS bulk path (sms-bulk.server, shortio batch preparation, campaign dedupe,
// sms-webhook). Test-only: imported by *.test.ts files.

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type Result = {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
};

export type FakeDb = ReturnType<typeof createFakeDb>;

function likeToRegex(pattern: string) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function createFakeDb(options: { unique?: Record<string, string[][]> } = {}) {
  const tables = new Map<string, Row[]>();
  const unique: Record<string, string[][]> = { ...options.unique };
  const rpcHandlers = new Map<string, (args: Row) => Result | Promise<Result>>();
  const failures: Array<{ table: string; op: string; message: string }> = [];
  const calls: Array<{ table: string; op: string; count: number }> = [];
  let seq = 0;

  const rows = (table: string) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };

  function conflictRow(table: string, row: Row, onConflict?: string) {
    const keys = onConflict
      ? [onConflict.split(",").map((s) => s.trim())]
      : [["id"], ...(unique[table] ?? [])];
    return rows(table).find((existing) =>
      keys.some((cols) => cols.every((col) => row[col] !== undefined && existing[col] === row[col])),
    );
  }

  function from(table: string) {
    const filters: Filter[] = [];
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: Row[] = [];
    let patch: Row = {};
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let limit: number | null = null;
    let returning = false;
    let selectCount: "exact" | null = null;
    let selectHead = false;
    const orderBys: Array<{ col: string; ascending: boolean; nullsFirst: boolean }> = [];

    const run = (): Result => {
      const failure = failures.findIndex((f) => f.table === table && f.op === op);
      if (failure >= 0) {
        const [f] = failures.splice(failure, 1);
        return { data: null, error: { message: f.message } };
      }
      calls.push({ table, op, count: op === "insert" || op === "upsert" ? payload.length : 1 });
      if (op === "insert") {
        const out: Row[] = [];
        for (const r of payload) {
          if (conflictRow(table, r)) return { data: null, error: { message: "duplicate key", code: "23505" } };
          const row = { id: r.id ?? `${table}-${++seq}`, created_at: new Date().toISOString(), ...r };
          rows(table).push(row);
          out.push(row);
        }
        return { data: out, error: null };
      }
      if (op === "upsert") {
        const out: Row[] = [];
        for (const r of payload) {
          const existing = conflictRow(table, r, upsertOpts.onConflict);
          if (existing) {
            if (!upsertOpts.ignoreDuplicates) {
              Object.assign(existing, r);
              out.push(existing);
            }
            continue;
          }
          const row = { id: r.id ?? `${table}-${++seq}`, created_at: new Date().toISOString(), ...r };
          rows(table).push(row);
          out.push(row);
        }
        return { data: out, error: null };
      }
      const matched = rows(table).filter((row) => filters.every((f) => f(row)));
      if (op === "update") {
        for (const row of matched) Object.assign(row, patch);
        return { data: returning ? matched : null, error: null };
      }
      if (op === "delete") {
        tables.set(table, rows(table).filter((row) => !matched.includes(row)));
        return { data: matched, error: null };
      }
      let ordered = matched;
      if (orderBys.length > 0) {
        ordered = [...matched].sort((a, b) => {
          for (const { col, ascending, nullsFirst } of orderBys) {
            const av = a[col];
            const bv = b[col];
            if (av == null && bv == null) continue;
            if (av == null) return nullsFirst ? -1 : 1;
            if (bv == null) return nullsFirst ? 1 : -1;
            if (av < bv) return ascending ? -1 : 1;
            if (av > bv) return ascending ? 1 : -1;
          }
          return 0;
        });
      }
      const limited = limit === null ? ordered : ordered.slice(0, limit);
      const result: Result = { data: selectHead ? null : limited, error: null };
      if (selectCount === "exact") result.count = matched.length;
      return result;
    };

    const builder: any = {
      select: (_columns?: string, options?: { count?: "exact"; head?: boolean }) => {
        if (op !== "select") returning = true;
        if (options?.count) selectCount = options.count;
        if (options?.head) selectHead = true;
        return builder;
      },
      insert: (value: Row | Row[]) => {
        op = "insert";
        payload = Array.isArray(value) ? value : [value];
        return builder;
      },
      upsert: (value: Row | Row[], opts: typeof upsertOpts = {}) => {
        op = "upsert";
        payload = Array.isArray(value) ? value : [value];
        upsertOpts = opts;
        return builder;
      },
      update: (value: Row) => {
        op = "update";
        patch = value;
        return builder;
      },
      delete: () => {
        op = "delete";
        return builder;
      },
      eq: (col: string, value: unknown) => (filters.push((r) => r[col] === value), builder),
      neq: (col: string, value: unknown) => (filters.push((r) => r[col] !== value), builder),
      is: (col: string, value: unknown) =>
        (filters.push((r) => (value === null ? r[col] == null : r[col] === value)), builder),
      in: (col: string, values: unknown[]) => (filters.push((r) => values.includes(r[col])), builder),
      // PostgREST `not(col, "in", "(a,b)")` and `not(col, "is", null)`.
      not: (col: string, operator: string, value: unknown) => {
        if (operator === "in") {
          const list = String(value).replace(/^\(|\)$/g, "").split(",").filter(Boolean);
          filters.push((r) => !list.includes(String(r[col])));
        } else if (operator === "is" && value === null) {
          filters.push((r) => r[col] !== null && r[col] !== undefined);
        }
        return builder;
      },
      like: (col: string, pattern: string) => {
        const re = likeToRegex(pattern);
        filters.push((r) => typeof r[col] === "string" && re.test(r[col] as string));
        return builder;
      },
      gte: (col: string, v: unknown) => (filters.push((r) => String(r[col]) >= String(v)), builder),
      lte: (col: string, v: unknown) => (filters.push((r) => String(r[col]) <= String(v)), builder),
      lt: (col: string, v: unknown) => (filters.push((r) => String(r[col]) < String(v)), builder),
      gt: (col: string, v: unknown) => (filters.push((r) => String(r[col]) > String(v)), builder),
      order: (col: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) => {
        orderBys.push({
          col,
          ascending: opts.ascending !== false,
          nullsFirst: opts.nullsFirst ?? false,
        });
        return builder;
      },
      limit: (n: number) => ((limit = n), builder),
      range: () => builder,
      single: async () => {
        const r = run();
        const list = (r.data as Row[] | null) ?? [];
        return r.error ? r : { data: list[0] ?? null, error: list[0] ? null : { message: "no rows" } };
      },
      maybeSingle: async () => {
        const r = run();
        const list = (r.data as Row[] | null) ?? [];
        return r.error ? r : { data: list[0] ?? null, error: null };
      },
      then: (resolve: (v: Result) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  }

  async function rpc(fn: string, args: Row): Promise<Result> {
    const handler = rpcHandlers.get(fn);
    if (!handler) throw new Error(`unexpected rpc ${fn}`);
    return handler(args);
  }

  return {
    client: { from, rpc },
    rows,
    calls,
    onRpc(fn: string, handler: (args: Row) => Result | Promise<Result>) {
      rpcHandlers.set(fn, handler);
    },
    failNext(table: string, op: string, message = "simulated failure") {
      failures.push({ table, op, message });
    },
    reset() {
      tables.clear();
      rpcHandlers.clear();
      failures.length = 0;
      calls.length = 0;
    },
  };
}

/** SMS unit price used by the fake wallet (global-constraints.md: R$0.08). */
const SMS_UNIT_PRICE = 0.08;

/**
 * Wallet ledger stand-in with the idempotency/insufficient-balance semantics
 * of wallet_reserve/wallet_refund (Task 3). `units` comes straight from the
 * caller's `_units` argument (countSmsSegments().segments, min 1); `balance`
 * is expressed in units (not R$) to keep existing test expectations simple.
 */
export function installCreditLedger(db: FakeDb, opts: { balance?: () => number } = {}) {
  const ledger = () => db.rows("wallet_ledger");
  const chargedUnits = () =>
    ledger()
      .filter((row) => row.entry_type === "usage_reservation" || row.entry_type === "usage_refund")
      .reduce((sum, row) => sum + Number(row.units) * (row.entry_type === "usage_refund" ? -1 : 1), 0);

  db.onRpc("wallet_reserve", (args) => {
    const existing = ledger().find(
      (row) => row.tenant_id === args._tenant && row.idempotency_key === args._idempotency_key,
    );
    if (existing) return { data: { ok: true, idempotent: true, amount: existing.amount }, error: null };
    const units = Number(args._units ?? 0);
    if (opts.balance && chargedUnits() + units > opts.balance()) {
      return { data: null, error: { message: "insufficient_balance" } };
    }
    const amount = -(units * SMS_UNIT_PRICE);
    ledger().push({
      id: `ledger-${ledger().length + 1}`,
      tenant_id: args._tenant,
      idempotency_key: args._idempotency_key,
      reference_id: args._reference_id,
      units,
      amount,
      entry_type: "usage_reservation",
    });
    return { data: { ok: true, idempotent: false, amount, exempt: false }, error: null };
  });

  db.onRpc("wallet_refund", (args) => {
    const existing = ledger().find(
      (row) => row.tenant_id === args._tenant && row.idempotency_key === args._idempotency_key,
    );
    if (existing) return { data: { ok: true, idempotent: true }, error: null };
    const reservation = ledger().find(
      (row) => row.tenant_id === args._tenant && row.reference_id === args._reference_id
        && row.entry_type === "usage_reservation",
    );
    if (!reservation) return { data: { ok: false, reason: "reservation_not_found" }, error: null };
    const alreadyRefunded = ledger().some(
      (row) => row.entry_type === "usage_refund" && row.reference_id === args._reference_id,
    );
    if (alreadyRefunded) return { data: { ok: false, reason: "already_refunded" }, error: null };
    ledger().push({
      id: `ledger-${ledger().length + 1}`,
      tenant_id: args._tenant,
      idempotency_key: args._idempotency_key,
      reference_id: args._reference_id,
      units: reservation.units,
      amount: -Number(reservation.amount),
      entry_type: "usage_refund",
    });
    return { data: { ok: true, idempotent: false }, error: null };
  });

  return {
    /** Units currently charged (reservations minus refunds), not R$. */
    charged: chargedUnits,
    ledger,
  };
}
