CREATE TABLE IF NOT EXISTS public.gamification_settings (
  tenant_id uuid PRIMARY KEY DEFAULT COALESCE(public.current_tenant_id(), '00000000-0000-0000-0000-000000000001'::uuid) REFERENCES public.tenants(id) ON DELETE CASCADE,
  level_thresholds jsonb NOT NULL DEFAULT '{
    "bronze": 10,
    "silver": 200,
    "gold": 500,
    "diamond": 1000,
    "black": 3000
  }'::jsonb,
  cooling_after_days integer NOT NULL DEFAULT 2,
  sleeping_after_days integer NOT NULL DEFAULT 7,
  vip_min_level text NOT NULL DEFAULT 'diamond',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT gamification_settings_days_chk CHECK (
    cooling_after_days >= 1
    AND sleeping_after_days >= cooling_after_days
    AND sleeping_after_days <= 365
  ),
  CONSTRAINT gamification_settings_vip_level_chk CHECK (
    vip_min_level IN ('bronze', 'silver', 'gold', 'diamond', 'black')
  )
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.gamification_settings TO authenticated;
GRANT ALL ON public.gamification_settings TO service_role;

ALTER TABLE public.gamification_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gamification_settings_tenant_isolation ON public.gamification_settings;
CREATE POLICY gamification_settings_tenant_isolation
  ON public.gamification_settings
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin())
  WITH CHECK (tenant_id = public.current_tenant_id() OR public.is_super_admin());

DROP TRIGGER IF EXISTS gamification_settings_set_updated_at ON public.gamification_settings;
CREATE TRIGGER gamification_settings_set_updated_at
  BEFORE UPDATE ON public.gamification_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.gamification_settings IS
  'Tenant-specific definitions for player gamification levels and inactivity status.';
