CREATE TABLE IF NOT EXISTS public._pixpgf_dep_import (
  player_id uuid PRIMARY KEY,
  total numeric NOT NULL,
  ultimo_dep timestamptz,
  primeiro_dep timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public._pixpgf_dep_import TO authenticated, service_role;
ALTER TABLE public._pixpgf_dep_import ENABLE ROW LEVEL SECURITY;
CREATE POLICY "super_admin_all" ON public._pixpgf_dep_import FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());