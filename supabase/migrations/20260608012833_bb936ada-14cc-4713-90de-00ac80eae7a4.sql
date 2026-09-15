
-- Restrict SELECT to admins only on these operational tables
DROP POLICY IF EXISTS "Authenticated users can read dashboard_settings" ON public.dashboard_settings;
DROP POLICY IF EXISTS "dashboard_settings_select_authenticated" ON public.dashboard_settings;
DROP POLICY IF EXISTS "Anyone authenticated can read dashboard_settings" ON public.dashboard_settings;
DROP POLICY IF EXISTS "Authenticated can read dashboard_settings" ON public.dashboard_settings;
DROP POLICY IF EXISTS "dashboard_settings read" ON public.dashboard_settings;

CREATE POLICY "Admins can read dashboard_settings"
  ON public.dashboard_settings
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Authenticated users can read send_window_settings" ON public.send_window_settings;
DROP POLICY IF EXISTS "send_window_settings_select_authenticated" ON public.send_window_settings;
DROP POLICY IF EXISTS "Anyone authenticated can read send_window_settings" ON public.send_window_settings;
DROP POLICY IF EXISTS "Authenticated can read send_window_settings" ON public.send_window_settings;
DROP POLICY IF EXISTS "send_window_settings read" ON public.send_window_settings;

CREATE POLICY "Admins can read send_window_settings"
  ON public.send_window_settings
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "Authenticated users can read system_alerts" ON public.system_alerts;
DROP POLICY IF EXISTS "system_alerts_select_authenticated" ON public.system_alerts;
DROP POLICY IF EXISTS "Anyone authenticated can read system_alerts" ON public.system_alerts;
DROP POLICY IF EXISTS "Authenticated can read system_alerts" ON public.system_alerts;
DROP POLICY IF EXISTS "system_alerts read" ON public.system_alerts;

CREATE POLICY "Admins can read system_alerts"
  ON public.system_alerts
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
