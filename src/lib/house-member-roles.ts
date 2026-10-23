// Papéis de quem é da equipe de uma casa (admin, gestor, membro). Um
// `expert` também tem linha em `user_roles`, mas NÃO é da equipe: só vê os
// leads permitidos pelo tipo dele, nada mais da casa (Área do Expert).
//
// Toda leitura de `user_roles` que decide "a quais casas esta pessoa tem
// acesso" para depois ler dados da casa (principalmente via `supabaseAdmin`,
// que ignora RLS) precisa filtrar por estes papéis:
// `.in("role", [...HOUSE_MEMBER_ROLES])`.
export const HOUSE_MEMBER_ROLES = ["admin", "gestor", "member"] as const;

export type HouseMemberRole = (typeof HOUSE_MEMBER_ROLES)[number];

export function isHouseMemberRole(role: string | null | undefined): role is HouseMemberRole {
  return (HOUSE_MEMBER_ROLES as readonly string[]).includes(role ?? "");
}
