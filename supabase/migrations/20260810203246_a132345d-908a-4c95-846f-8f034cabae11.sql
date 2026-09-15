UPDATE public.send_window_settings
   SET start_minute = GREATEST(start_minute, 480),
       end_minute = LEAST(end_minute, 1260),
       updated_at = now();

INSERT INTO public.send_window_settings (tenant_id, singleton, start_minute, end_minute, timezone, weekdays, enabled)
SELECT t.id, true, 480, 1260, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6], true
FROM public.tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM public.send_window_settings s WHERE s.tenant_id = t.id AND s.singleton = true
);