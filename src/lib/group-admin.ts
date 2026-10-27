// Pure helpers for the super admin groups page (/grupos, spec §3). Isolated
// from groups.functions.ts (server fns) so it can be unit tested without any
// server/db wiring.

export type SelectableTenant = { id: string; nome: string };
export type UngroupedTenant = SelectableTenant & { is_demo: boolean };

/**
 * Houses a group's "manage houses" multi-select may offer: houses without a
 * group that share the group's demo-ness, plus the houses already in this
 * group (so they stay checked and can be removed). Sorted by name (pt-BR).
 */
export function selectableTenantsForGroup(params: {
  groupIsDemo: boolean;
  ungroupedTenants: UngroupedTenant[];
  groupTenants: SelectableTenant[];
}): SelectableTenant[] {
  const byId = new Map<string, SelectableTenant>();
  for (const tenant of params.groupTenants) byId.set(tenant.id, { id: tenant.id, nome: tenant.nome });
  for (const tenant of params.ungroupedTenants) {
    if (tenant.is_demo !== params.groupIsDemo) continue;
    byId.set(tenant.id, { id: tenant.id, nome: tenant.nome });
  }
  return [...byId.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}
