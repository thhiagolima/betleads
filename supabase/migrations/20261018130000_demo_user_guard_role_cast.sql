-- Hotfix for 20261018100000: user_roles.role is the app_role enum, and
-- demo_user_role_violation takes text. There is no implicit enum → text cast
-- for function resolution, so both guards failed with "function
-- public.demo_user_role_violation(uuid, app_role) does not exist" on every
-- user_roles write — for real users too. Cast explicitly.

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

  IF v_is_demo_user AND public.demo_user_role_violation(NEW.tenant_id, NEW.role::text) THEN
    RAISE EXCEPTION 'DEMO_USER_ROLE_BLOCKED: demo users may only hold gestor/member roles in a demo tenant';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_auth_users_demo_user_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF (NEW.raw_app_meta_data ->> 'is_demo_user') = 'true' THEN
    IF EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = NEW.id
        AND public.demo_user_role_violation(ur.tenant_id, ur.role::text)
    ) THEN
      RAISE EXCEPTION 'DEMO_USER_ROLE_BLOCKED: demo users may only hold gestor/member roles in a demo tenant';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
