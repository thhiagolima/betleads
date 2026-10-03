-- Prevent new uses of retired tenant roles while preserving legacy rows for a
-- controlled cleanup. New tenant memberships must use the canonical contract.
ALTER TABLE public.user_roles
  DROP CONSTRAINT IF EXISTS user_roles_canonical_scope;

ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_canonical_scope
  CHECK (
    (role = 'super_admin' AND tenant_id IS NULL)
    OR (role IN ('admin', 'gestor', 'member') AND tenant_id IS NOT NULL)
  ) NOT VALID;
