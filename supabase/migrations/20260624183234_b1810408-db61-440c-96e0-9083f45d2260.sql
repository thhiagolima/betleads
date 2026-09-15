UPDATE public.sms_flow_steps
   SET scheduled_day_offset = (order_index / 3),
       scheduled_time = CASE (order_index % 3)
                          WHEN 0 THEN '08:00'
                          WHEN 1 THEN '13:30'
                          WHEN 2 THEN '20:30'
                        END,
       delay_days = 0
 WHERE flow_id = 'bd2a473d-0439-4634-95ef-53899cfa2558';

UPDATE public.sms_flows
   SET is_active = true,
       updated_at = now()
 WHERE id = 'bd2a473d-0439-4634-95ef-53899cfa2558';

INSERT INTO public.send_window_settings (tenant_id, singleton, start_minute, end_minute, timezone, weekdays, enabled)
SELECT '48627b40-6ee3-4475-a24e-50b00fde3192'::uuid, true, 360, 1320, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6], true
WHERE EXISTS (
  SELECT 1 FROM public.tenants WHERE id = '48627b40-6ee3-4475-a24e-50b00fde3192'::uuid
)
ON CONFLICT (tenant_id, singleton) DO UPDATE
  SET start_minute = EXCLUDED.start_minute,
      end_minute   = EXCLUDED.end_minute,
      enabled      = true,
      updated_at   = now();

INSERT INTO public.sms_flow_leads
  (flow_id, player_id, phone_e164, status, current_step_index, next_run_at, entered_at, tenant_id)
SELECT
  'bd2a473d-0439-4634-95ef-53899cfa2558'::uuid,
  p.id,
  p.telefone,
  'pending'::sms_flow_lead_status,
  0,
  ((now() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '1 day' + INTERVAL '8 hours') AT TIME ZONE 'America/Sao_Paulo',
  ((now() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo',
  '48627b40-6ee3-4475-a24e-50b00fde3192'::uuid
FROM public.players p
WHERE EXISTS (
    SELECT 1 FROM public.tenants WHERE id = '48627b40-6ee3-4475-a24e-50b00fde3192'::uuid
  )
  AND EXISTS (
    SELECT 1 FROM public.sms_flows WHERE id = 'bd2a473d-0439-4634-95ef-53899cfa2558'::uuid
  )
  AND p.affiliate_id IN ('69cb55b159dc0d386aee4290','696ac80b49538ecc55b0d72c')
  AND p.telefone IS NOT NULL
  AND length(btrim(p.telefone)) >= 10
ON CONFLICT (flow_id, player_id) DO NOTHING;
