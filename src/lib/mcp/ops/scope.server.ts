// MCP do grupo, área de operação: THE single permission gate (spec
// docs/superpowers/specs/2026-11-17-mcp-grupo-design.md §4.2). Every
// operação tool calls `resolverEscopoOps` first and only queries the houses it
// returns — no tool runs its own permission check, so the rule cannot drift
// between tools.
//
// Who sees what comes from the DB (`mcp_ops_tenant_ids` / `mcp_ops_can_view`,
// migration 20261231101400): super admin → every house; otherwise houses
// where the user is `admin` plus the houses of the groups they manage. Gestor
// and member see nothing. These functions are MCP-only: they never widen
// `has_tenant_access` & co. (a group manager gets no operational access
// outside the MCP).
//
// - casa: `mcp_ops_can_view`. A demo house is fine when asked for directly.
// - grupo: the group must be in `managedGroupIds` (a super admin gets all),
//   houses from `tenant_group_tenants` (a demo group only holds demo houses).
// - todas: every house of `mcp_ops_tenant_ids` minus the demo ones. Unlike
//   `resumo_financeiro` (super admin only), here "todas" means "every house
//   you see".
// At most MAX_OPS_TENANTS houses per call.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { toTenantCurrency, type TenantCurrency } from "@/lib/currency";
import { managedGroupIds } from "@/lib/tenants.functions";

import { MAX_OPS_TENANTS } from "../config.server";
import type { Escopo } from "../inputs.server";

/* eslint-disable @typescript-eslint/no-explicit-any -- loose client typing, same pattern as access.server.ts's db(). */
const db = () => supabaseAdmin as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type EscopoOps = Escopo;

export type CasaOps = {
  id: string;
  nome: string;
  moeda: TenantCurrency;
  status: string | null;
  isDemo: boolean;
  grupo: { id: string; nome: string } | null;
};

export type EscopoOpsResolvido = { casas: CasaOps[]; rotulo: string };

export type GrupoOps = { id: string; nome: string; isDemo: boolean; casas: number };
export type EscoposOps = { casas: CasaOps[]; grupos: GrupoOps[] };

export const SEM_ACESSO_CASA = "Você não tem acesso à operação desta casa.";
export const SEM_ACESSO_GRUPO = "Você não tem acesso à operação deste grupo.";
export const SEM_CASAS = "Você não tem acesso à operação de nenhuma casa.";
export const ESCOPO_GRANDE = "Escopo grande demais; consulte por grupo.";
export const TODAS_ROTULO = "Todas as casas";

/** `.in()` lists are chunked so a super admin's id list never builds a huge URL. */
const IN_CHUNK = 100;

type TenantRow = {
  id: string;
  nome: string;
  moeda: string | null;
  status: string | null;
  is_demo: boolean | null;
};
type GroupRow = { id: string; nome: string; is_demo: boolean | null };
type LinkRow = { group_id: string; tenant_id: string };

const byNome = <T extends { nome: string }>(a: T, b: T) => a.nome.localeCompare(b.nome, "pt-BR");

/** PostgREST returns a `setof uuid` as scalars; an object row is unwrapped defensively. */
function unwrapIds(data: unknown): string[] {
  return ((data as unknown[] | null) ?? [])
    .map((row) =>
      row && typeof row === "object" ? Object.values(row as Record<string, unknown>)[0] : row,
    )
    .filter((id): id is string => typeof id === "string");
}

async function selectIn<T>(table: string, columns: string, column: string, ids: string[]) {
  const unique = Array.from(new Set(ids));
  const rows: T[] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const { data, error } = await db()
      .from(table)
      .select(columns)
      .in(column, unique.slice(i, i + IN_CHUNK));
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as T[]));
  }
  return rows;
}

/** Every house id the user may see the operação of (`mcp_ops_tenant_ids`). */
async function opsTenantIds(userId: string): Promise<string[]> {
  const { data, error } = await db().rpc("mcp_ops_tenant_ids", { _user: userId });
  if (error) throw new Error(error.message);
  return unwrapIds(data);
}

async function opsCanView(userId: string, tenantId: string): Promise<boolean> {
  const { data, error } = await db().rpc("mcp_ops_can_view", { _user: userId, _tenant: tenantId });
  if (error) throw new Error(error.message);
  return data === true;
}

/** The houses of `ids` as CasaOps (with their group), sorted by name. */
async function loadCasas(ids: string[]): Promise<CasaOps[]> {
  if (!ids.length) return [];
  const tenants = await selectIn<TenantRow>("tenants", "id,nome,moeda,status,is_demo", "id", ids);
  const links = await selectIn<LinkRow>(
    "tenant_group_tenants",
    "group_id,tenant_id",
    "tenant_id",
    tenants.map((tenant) => tenant.id),
  );
  const groups = await selectIn<GroupRow>(
    "tenant_groups",
    "id,nome,is_demo",
    "id",
    links.map((link) => link.group_id),
  );
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const groupOfTenant = new Map(
    links.map((link) => [link.tenant_id, groupById.get(link.group_id)]),
  );

  return tenants
    .map((row): CasaOps => {
      const group = groupOfTenant.get(row.id);
      return {
        id: row.id,
        nome: row.nome,
        moeda: toTenantCurrency(row.moeda),
        status: row.status ?? null,
        isDemo: row.is_demo === true,
        grupo: group ? { id: group.id, nome: group.nome } : null,
      };
    })
    .sort(byNome);
}

function capped(casas: CasaOps[]): CasaOps[] {
  if (casas.length > MAX_OPS_TENANTS) throw new Error(ESCOPO_GRANDE);
  return casas;
}

/**
 * The houses of `escopo` the user may see the operação of, and the scope's
 * label. The only gate of the operação tools: throws the pt-BR refusal when
 * the user may not see the house/group, and ESCOPO_GRANDE above
 * MAX_OPS_TENANTS houses.
 */
export async function resolverEscopoOps(
  userId: string,
  escopo: EscopoOps,
): Promise<EscopoOpsResolvido> {
  if (escopo.tipo === "casa") {
    if (!(await opsCanView(userId, escopo.id))) throw new Error(SEM_ACESSO_CASA);
    const casas = await loadCasas([escopo.id]);
    if (!casas.length) throw new Error(SEM_ACESSO_CASA);
    return { casas, rotulo: casas[0].nome };
  }

  if (escopo.tipo === "grupo") {
    const managed = await managedGroupIds(userId);
    if (!managed.includes(escopo.id)) throw new Error(SEM_ACESSO_GRUPO);
    const { data: group, error: groupError } = await db()
      .from("tenant_groups")
      .select("id,nome,is_demo")
      .eq("id", escopo.id)
      .maybeSingle();
    if (groupError) throw new Error(groupError.message);
    if (!group) throw new Error(SEM_ACESSO_GRUPO);
    const { data: links, error: linksError } = await db()
      .from("tenant_group_tenants")
      .select("tenant_id")
      .eq("group_id", escopo.id);
    if (linksError) throw new Error(linksError.message);
    const ids = ((links ?? []) as Array<{ tenant_id: string }>).map((link) => link.tenant_id);
    if (ids.length > MAX_OPS_TENANTS) throw new Error(ESCOPO_GRANDE);
    return { casas: capped(await loadCasas(ids)), rotulo: (group as GroupRow).nome };
  }

  const ids = await opsTenantIds(userId);
  const casas = (await loadCasas(ids)).filter((casa) => !casa.isDemo);
  if (!casas.length) throw new Error(SEM_CASAS);
  return { casas: capped(casas), rotulo: TODAS_ROTULO };
}

/**
 * What `listar_escopos` shows under `operacao` (spec §5.1): every house the
 * user may see the operação of (demo included, marked — a demo house can be
 * asked for directly) and the groups they manage, with their house count.
 * List-only: every tool still goes through `resolverEscopoOps`.
 */
export async function listarEscoposOps(userId: string): Promise<EscoposOps> {
  const [ids, groupIds] = await Promise.all([opsTenantIds(userId), managedGroupIds(userId)]);
  const [casas, groups, links] = await Promise.all([
    loadCasas(ids),
    selectIn<GroupRow>("tenant_groups", "id,nome,is_demo", "id", groupIds),
    selectIn<LinkRow>("tenant_group_tenants", "group_id,tenant_id", "group_id", groupIds),
  ]);
  const counts = new Map<string, number>();
  for (const link of links) counts.set(link.group_id, (counts.get(link.group_id) ?? 0) + 1);
  return {
    casas,
    grupos: groups
      .map((group) => ({
        id: group.id,
        nome: group.nome,
        isDemo: group.is_demo === true,
        casas: counts.get(group.id) ?? 0,
      }))
      .sort(byNome),
  };
}
