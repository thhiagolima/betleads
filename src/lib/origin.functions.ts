import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseOverviewPeriod } from "@/lib/marketing-overview";
import {
  buildOriginBreakdown,
  ORIGIN_GROUPS,
  RULE_CHANNELS,
  type OriginPlayerRow,
} from "@/lib/origin-breakdown";
import { resolveCurrentTenantId } from "@/lib/tenant-access.server";

const value = z.string().max(500).nullable().optional();

const inputSchema = z.object({
  from: z.string().trim(),
  to: z.string().trim(),
  group: z.enum(ORIGIN_GROUPS),
  filters: z
    .object({
      channel: value,
      source: value,
      medium: value,
      campaign: value,
      term: value,
      content: value,
      affiliate: value,
      search: z.string().trim().max(120).optional(),
      onlyFtd: z.boolean().optional(),
    })
    .strict()
    .default({}),
  includeCrm: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(100),
});

export type OriginBreakdownInput = z.infer<typeof inputSchema>;

export function parseOriginBreakdownInput(input: unknown): OriginBreakdownInput {
  const parsed = inputSchema.parse(input ?? {});
  const period = parseOverviewPeriod(parsed.from, parsed.to);
  // Mesmo teto da RPC: a coorte inteira passa pelos depósitos de cada jogador.
  const days =
    (Date.parse(`${period.to}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`)) / 86_400_000;
  if (days > 92) throw new Error("O período máximo é de 93 dias.");
  // Só as chaves presentes viram filtro: ausente = todos, null = valor vazio.
  const filters = Object.fromEntries(
    Object.entries(parsed.filters).filter(([key, v]) => {
      if (key === "search") return typeof v === "string" && v !== "";
      if (key === "onlyFtd") return v === true;
      return v !== undefined;
    }),
  );
  return { ...parsed, ...period, filters };
}

type DbClient = {
  rpc: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export const getOriginBreakdown = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => parseOriginBreakdownInput(input))
  .handler(async ({ data, context }) => {
    const db = context.supabase as unknown as DbClient;
    const tenantId = await resolveCurrentTenantId(db as never);
    const { data: raw, error } = await db.rpc("origin_breakdown", {
      _tenant: tenantId,
      _from: data.from,
      _to: data.to,
      _group: data.group,
      _filters: data.filters,
      _include_crm: data.includeCrm,
      _limit: data.limit,
    });
    if (error) throw new Error(error.message);
    return buildOriginBreakdown(raw);
  });

// ---------------------------------------------------------------------------
// U2: apelidos e regras de canal (RPCs checam admin/gestor da casa)
// ---------------------------------------------------------------------------
const labelSchema = z.object({
  dimension: z.enum(["source", "medium", "campaign", "term", "content", "affiliate"]),
  value: z.string().trim().min(1).max(500),
  label: z.string().trim().max(120),
});

export const setUtmLabel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => labelSchema.parse(input))
  .handler(async ({ data, context }) => {
    const db = context.supabase as unknown as DbClient;
    const tenantId = await resolveCurrentTenantId(db as never);
    const { error } = await db.rpc("set_utm_label", {
      _tenant: tenantId,
      _dimension: data.dimension,
      _value: data.value,
      _label: data.label,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const ruleSchema = z.object({
  field: z.enum(["source", "medium", "campaign"]),
  match: z.enum(["exact", "prefix", "contains"]),
  pattern: z.string().trim().min(1).max(120),
  channel: z.enum(RULE_CHANNELS),
});

export type ChannelRule = z.infer<typeof ruleSchema> & { id: string; created_at: string };

type TableClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: unknown,
      ) => {
        order: (
          column: string,
          options?: { ascending?: boolean },
        ) => Promise<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
};

export const listChannelRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = context.supabase as unknown as DbClient & TableClient;
    const tenantId = await resolveCurrentTenantId(db as never);
    const { data, error } = await db
      .from("tenant_channel_rules")
      .select("id, field, match, pattern, channel, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as ChannelRule[];
  });

export const upsertChannelRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => ruleSchema.parse(input))
  .handler(async ({ data, context }) => {
    const db = context.supabase as unknown as DbClient;
    const tenantId = await resolveCurrentTenantId(db as never);
    const { error } = await db.rpc("upsert_channel_rule", {
      _tenant: tenantId,
      _field: data.field,
      _match: data.match,
      _pattern: data.pattern.toLowerCase(),
      _channel: data.channel,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteChannelRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const db = context.supabase as unknown as DbClient;
    const tenantId = await resolveCurrentTenantId(db as never);
    const { error } = await db.rpc("delete_channel_rule", { _tenant: tenantId, _id: data.id });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ---------------------------------------------------------------------------
// U3: jogadores por trás de uma linha
// ---------------------------------------------------------------------------
const playersSchema = inputSchema.omit({ group: true, limit: true }).extend({
  limit: z.number().int().min(1).max(2000).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
});

type OriginPlayer = OriginPlayerRow;

export const getOriginPlayers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => {
    const parsed = playersSchema.parse(input ?? {});
    const base = parseOriginBreakdownInput({ ...parsed, group: "channel", limit: 1 });
    return { ...parsed, from: base.from, to: base.to, filters: base.filters };
  })
  .handler(async ({ data, context }) => {
    const db = context.supabase as unknown as DbClient;
    const tenantId = await resolveCurrentTenantId(db as never);
    const { data: raw, error } = await db.rpc("origin_breakdown_players", {
      _tenant: tenantId,
      _from: data.from,
      _to: data.to,
      _filters: data.filters,
      _include_crm: data.includeCrm,
      _limit: data.limit,
      _offset: data.offset,
    });
    if (error) throw new Error(error.message);
    const r = (raw ?? {}) as { total?: unknown; rows?: Array<Record<string, unknown>> };
    const n = (v: unknown) => Number(v ?? 0) || 0;
    return {
      total: n(r.total),
      rows: (r.rows ?? []).map((row): OriginPlayer => ({
        id: String(row.id),
        nome: (row.nome as string | null) ?? null,
        createdAt: String(row.createdAt),
        channel: String(row.channel ?? "outros"),
        source: (row.source as string | null) ?? null,
        medium: (row.medium as string | null) ?? null,
        campaign: (row.campaign as string | null) ?? null,
        term: (row.term as string | null) ?? null,
        content: (row.content as string | null) ?? null,
        affiliate: (row.affiliate as string | null) ?? null,
        referral: (row.referral as string | null) ?? null,
        expert: (row.expert as string | null) ?? null,
        ftd: row.ftd === true,
        ftdValue: n(row.ftdValue),
        deposits: n(row.deposits),
        withdrawals: n(row.withdrawals),
      })),
    };
  });
