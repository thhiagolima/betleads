import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseOverviewPeriod } from "@/lib/marketing-overview";
import { buildOriginBreakdown, ORIGIN_GROUPS } from "@/lib/origin-breakdown";
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
