
-- Remove leitura global e restringe SELECT a super_admin para todas as
-- tabelas globais de infraestrutura. Os dispatchers usam service role
-- (supabaseAdmin) e não são afetados por RLS.

DROP POLICY IF EXISTS call_providers_global_read       ON public.call_providers;
DROP POLICY IF EXISTS email_smtp_configs_global_read   ON public.email_smtp_configs;
DROP POLICY IF EXISTS whatsapp_proxies_global_read     ON public.whatsapp_proxies;
DROP POLICY IF EXISTS antiban_settings_global_read     ON public.antiban_settings;
DROP POLICY IF EXISTS email_senders_global_read        ON public.email_senders;
DROP POLICY IF EXISTS send_window_settings_global_read ON public.send_window_settings;

CREATE POLICY call_providers_super_admin_read
  ON public.call_providers FOR SELECT TO authenticated
  USING (public.is_super_admin());

CREATE POLICY email_smtp_configs_super_admin_read
  ON public.email_smtp_configs FOR SELECT TO authenticated
  USING (public.is_super_admin());

CREATE POLICY whatsapp_proxies_super_admin_read
  ON public.whatsapp_proxies FOR SELECT TO authenticated
  USING (public.is_super_admin());

CREATE POLICY antiban_settings_super_admin_read
  ON public.antiban_settings FOR SELECT TO authenticated
  USING (public.is_super_admin());

CREATE POLICY email_senders_super_admin_read
  ON public.email_senders FOR SELECT TO authenticated
  USING (public.is_super_admin());

CREATE POLICY send_window_settings_super_admin_read
  ON public.send_window_settings FOR SELECT TO authenticated
  USING (public.is_super_admin());
