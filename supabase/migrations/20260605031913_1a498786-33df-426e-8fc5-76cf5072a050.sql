DROP POLICY IF EXISTS "Authenticated can insert send window" ON public.send_window_settings;
DROP POLICY IF EXISTS "Authenticated can update send window" ON public.send_window_settings;

CREATE POLICY "Admins can insert send window"
  ON public.send_window_settings
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update send window"
  ON public.send_window_settings
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));