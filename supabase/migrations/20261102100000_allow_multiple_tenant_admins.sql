-- A house may have several admins. The app still refuses to demote or remove
-- the last one (countTenantAdmins in tenants.functions.ts / admin.functions.ts).
-- user_roles_one_membership_per_tenant keeps one role per user per house.
DROP INDEX IF EXISTS public.user_roles_one_admin_per_tenant;
