-- 1) is_super_admin agora exige tenant_id IS NULL (super_admin é global, nunca de tenant)
CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND role = 'super_admin'
      AND tenant_id IS NULL
  )
$function$;

-- 2) has_role idem para a role 'super_admin' (defesa extra caso checks usem has_role)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
      AND (
        _role <> 'super_admin'
        OR tenant_id IS NULL
      )
  )
$function$;

-- 3) Sanitiza eventuais super_admins "de tenant" já existentes:
--    se houver linha role='super_admin' com tenant_id NOT NULL e o mesmo usuário
--    NÃO possui linha global, remove a linha viciada (não promove ninguém).
DELETE FROM public.user_roles
 WHERE role = 'super_admin'
   AND tenant_id IS NOT NULL
   AND user_id NOT IN (
     SELECT user_id FROM public.user_roles
      WHERE role = 'super_admin' AND tenant_id IS NULL
   );

-- 4) Política RESTRICTIVE: bloqueia INSERT/UPDATE de role='super_admin' por qualquer um
--    que não seja super_admin (já existente, global). Roda em conjunto com as policies
--    permissivas existentes, então o owner do tenant continua podendo inserir outras roles.
DROP POLICY IF EXISTS user_roles_block_super_admin_escalation ON public.user_roles;
CREATE POLICY user_roles_block_super_admin_escalation
  ON public.user_roles
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING (
    role <> 'super_admin'
    OR public.is_super_admin(auth.uid())
  )
  WITH CHECK (
    role <> 'super_admin'
    OR public.is_super_admin(auth.uid())
  );