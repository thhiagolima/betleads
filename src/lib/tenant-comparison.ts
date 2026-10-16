// Central de Resultados F5: comparison between houses (tenants).
//
// Rule from the client: only a user who is ADMIN in two or more houses can
// compare them, and only the houses where he is admin. "gestor" and "member"
// never count. A platform super admin is admin of every house.

export type UserRoleRow = { tenant_id: string | null; role: string };

export const MIN_COMPARABLE_TENANTS = 2;

/** Houses the user may compare; an empty list means no access. */
export function comparableTenantIds(
  roles: UserRoleRow[],
  isSuperAdmin: boolean,
  allTenantIds: string[],
): string[] {
  const ids = isSuperAdmin
    ? allTenantIds
    : [
        ...new Set(
          roles
            .filter((row) => row.role === "admin" && row.tenant_id)
            .map((row) => row.tenant_id as string),
        ),
      ];
  return ids.length >= MIN_COMPARABLE_TENANTS ? [...ids].sort() : [];
}
