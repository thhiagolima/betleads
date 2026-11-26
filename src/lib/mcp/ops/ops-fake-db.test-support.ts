// Test-only in-memory stand-in for the PostgREST reads the operação tools do
// (select + eq/in/gte/lte/lt/gt/or with and(...) groups, order, range,
// limit, rpc). Records the tenant ids every query was filtered by, so tests
// can assert that only the houses resolverEscopoOps returned were read.
type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };
type Filter = (row: Row) => boolean;

/** Splits on commas that are not inside parentheses. */
function splitTop(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of expr) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

function compare(op: string, value: unknown, raw: string): boolean {
  if (op === "is") return raw === "null" ? value == null : String(value) === raw;
  if (value == null) return false;
  const v = String(value);
  switch (op) {
    case "eq":
      return v === raw;
    case "neq":
      return v !== raw;
    case "gte":
      return v >= raw;
    case "gt":
      return v > raw;
    case "lte":
      return v <= raw;
    case "lt":
      return v < raw;
    default:
      throw new Error(`fake or(): unsupported op ${op}`);
  }
}

function parseTerm(term: string): Filter {
  const t = term.trim();
  const and = /^and\((.*)\)$/.exec(t);
  if (and) {
    const parts = splitTop(and[1]).map(parseTerm);
    return (row) => parts.every((p) => p(row));
  }
  const m = /^([^.]+)\.(is|eq|neq|gte|gt|lte|lt)\.(.*)$/.exec(t);
  if (!m) throw new Error(`fake or(): unsupported term ${t}`);
  const [, col, op, raw] = m;
  return (row) => compare(op, row[col], raw);
}

export type RecordedQuery = { table: string; tenantIds: string[] | null };

export function createOpsFakeDb() {
  const tables = new Map<string, Row[]>();
  const rpcs = new Map<string, (args: Row) => Result>();
  const queries: RecordedQuery[] = [];
  const rpcCalls: Array<{ fn: string; args: Row }> = [];
  const failRules: Array<{ table: string; tenantId?: string; message: string }> = [];

  const rows = (table: string) => {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  };

  function from(table: string) {
    const filters: Filter[] = [];
    const orderBys: Array<{ col: string; ascending: boolean }> = [];
    let tenantIds: string[] | null = null;
    let limit: number | null = null;
    let offset = 0;

    const run = (): Result => {
      queries.push({ table, tenantIds });
      const fail = failRules.find(
        (rule) =>
          rule.table === table && (!rule.tenantId || (tenantIds ?? []).includes(rule.tenantId)),
      );
      if (fail) return { data: null, error: { message: fail.message } };
      let matched = rows(table).filter((row) => filters.every((f) => f(row)));
      if (orderBys.length) {
        matched = [...matched].sort((a, b) => {
          for (const { col, ascending } of orderBys) {
            const av = String(a[col] ?? "");
            const bv = String(b[col] ?? "");
            if (av < bv) return ascending ? -1 : 1;
            if (av > bv) return ascending ? 1 : -1;
          }
          return 0;
        });
      }
      return {
        data: matched.slice(offset, limit === null ? undefined : offset + limit),
        error: null,
      };
    };

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- chainable fake */
    const builder: any = {
      select: () => builder,
      eq: (col: string, value: unknown) => {
        if (col === "tenant_id") tenantIds = [String(value)];
        filters.push((row) => row[col] === value);
        return builder;
      },
      in: (col: string, values: unknown[]) => {
        if (col === "tenant_id") tenantIds = values.map(String);
        filters.push((row) => values.includes(row[col]));
        return builder;
      },
      gte: (col: string, v: unknown) => (
        filters.push((r) => compare("gte", r[col], String(v))),
        builder
      ),
      gt: (col: string, v: unknown) => (
        filters.push((r) => compare("gt", r[col], String(v))),
        builder
      ),
      lte: (col: string, v: unknown) => (
        filters.push((r) => compare("lte", r[col], String(v))),
        builder
      ),
      lt: (col: string, v: unknown) => (
        filters.push((r) => compare("lt", r[col], String(v))),
        builder
      ),
      is: (col: string, value: null) => (filters.push((r) => (r[col] ?? null) === value), builder),
      or: (expr: string) => {
        const terms = splitTop(expr).map(parseTerm);
        filters.push((row) => terms.some((t) => t(row)));
        return builder;
      },
      order: (col: string, opts: { ascending?: boolean } = {}) => {
        orderBys.push({ col, ascending: opts.ascending !== false });
        return builder;
      },
      limit: (n: number) => ((limit = n), builder),
      range: (a: number, b: number) => ((offset = a), (limit = b - a + 1), builder),
      maybeSingle: async () => {
        const r = run();
        return r.error ? r : { data: ((r.data as Row[]) ?? [])[0] ?? null, error: null };
      },
      then: (resolve: (v: Result) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  }

  async function rpc(fn: string, args: Row): Promise<Result> {
    rpcCalls.push({ fn, args });
    const handler = rpcs.get(fn);
    if (!handler) throw new Error(`unexpected rpc ${fn}`);
    return handler(args);
  }

  return {
    client: { from, rpc },
    rows,
    queries,
    rpcCalls,
    onRpc(fn: string, handler: (args: Row) => Result) {
      rpcs.set(fn, handler);
    },
    /** Every query on `table` (for `tenantId`, when given) returns an error. */
    fail(table: string, message: string, tenantId?: string) {
      failRules.push({ table, tenantId, message });
    },
    reset() {
      tables.clear();
      rpcs.clear();
      queries.length = 0;
      rpcCalls.length = 0;
      failRules.length = 0;
    },
  };
}
