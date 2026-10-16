-- Demo tenant flag: `tenants.is_demo`, a protection trigger so only
-- service_role (or a direct/migration connection with no JWT at all) can
-- flip it, `is_demo_tenant`/`tenants_demo_ids` helpers for workers and RLS,
-- and a guard that keeps demo users (`auth.users.raw_app_meta_data
-- ->> 'is_demo_user' = 'true'`) confined to gestor/member roles inside a
-- demo tenant.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

-- `true` only for an existing tenant with is_demo = true. `null`/unknown
-- tenant_id -> false: it is used as a filter in worker queues (Task 9) and
-- legacy rows with a null tenant_id must not disappear from those queues.
-- Fail-closed send guarding belongs to the TS guard in Task 2, not here.
CREATE OR REPLACE FUNCTION public.is_demo_tenant(_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT coalesce(
    (SELECT is_demo FROM public.tenants WHERE id = _tenant),
    false
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_demo_tenant(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tenants_demo_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT id FROM public.tenants WHERE is_demo = true
$$;

GRANT EXECUTE ON FUNCTION public.tenants_demo_ids() TO authenticated, service_role;

-- Protects tenants.is_demo from any PostgREST caller other than
-- service_role. Reads the JWT role from request.jwt.claims (falling back to
-- the legacy request.jwt.claim.role GUC) and treats empty-string GUCs as
-- absent. When there are no claims at all (a direct pg connection or a
-- migration) it only allows the change when current_user is not
-- authenticated/anon, so superuser/migration/service connections still work.
CREATE OR REPLACE FUNCTION public.protect_tenants_is_demo()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_claims text;
  v_role text;
BEGIN
  v_claims := nullif(current_setting('request.jwt.claims', true), '');
  IF v_claims IS NOT NULL THEN
    BEGIN
      v_role := nullif(v_claims::jsonb ->> 'role', '');
    EXCEPTION WHEN OTHERS THEN
      v_role := NULL;
    END;
  END IF;

  IF v_role IS NULL THEN
    v_role := nullif(current_setting('request.jwt.claim.role', true), '');
  END IF;

  IF v_role IS NOT NULL THEN
    IF v_role = 'service_role' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'DEMO_FLAG_PROTECTED: tenants.is_demo can only be changed by service_role';
  END IF;

  -- No JWT claims at all: a direct pg connection (migrations, psql, this
  -- trigger's own tests). Still block it if the role itself is
  -- authenticated/anon (PostgREST without claims set).
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'DEMO_FLAG_PROTECTED: tenants.is_demo can only be changed by service_role';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenants_protect_is_demo ON public.tenants;
CREATE TRIGGER trg_tenants_protect_is_demo
  BEFORE UPDATE OF is_demo ON public.tenants
  FOR EACH ROW
  WHEN (OLD.is_demo IS DISTINCT FROM NEW.is_demo)
  EXECUTE FUNCTION public.protect_tenants_is_demo();

-- Keeps demo users (auth.users.raw_app_meta_data ->> 'is_demo_user' = 'true')
-- confined to the demo tenant(s), as gestor or member only. Normal users are
-- untouched.
CREATE OR REPLACE FUNCTION public.guard_user_roles_demo_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_demo_user boolean;
BEGIN
  SELECT (raw_app_meta_data ->> 'is_demo_user') = 'true'
  INTO v_is_demo_user
  FROM auth.users
  WHERE id = NEW.user_id;

  IF v_is_demo_user THEN
    IF NEW.tenant_id IS NULL
      OR NOT public.is_demo_tenant(NEW.tenant_id)
      OR NEW.role NOT IN ('gestor', 'member') THEN
      RAISE EXCEPTION 'DEMO_USER_ROLE_BLOCKED: demo users may only hold gestor/member roles in a demo tenant';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_roles_demo_user_guard ON public.user_roles;
CREATE TRIGGER trg_user_roles_demo_user_guard
  BEFORE INSERT OR UPDATE ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_user_roles_demo_user();
