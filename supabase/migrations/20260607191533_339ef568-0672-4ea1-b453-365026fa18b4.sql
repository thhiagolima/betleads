DROP POLICY IF EXISTS "auth read dispatch_rate_state" ON public.dispatch_rate_state;
CREATE POLICY "admins read dispatch_rate_state" ON public.dispatch_rate_state
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "auth read dispatcher_runs" ON public.dispatcher_runs;
CREATE POLICY "admins read dispatcher_runs" ON public.dispatcher_runs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));