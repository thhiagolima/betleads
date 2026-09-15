UPDATE public.dispatch_pause_state
   SET paused = true,
       paused_at = now(),
       reason = 'BusinessCode em manutenção — pausa manual'
 WHERE channel IN ('sms','email')
   AND tenant_id = '00000000-0000-0000-0000-000000000001';

-- Garante que existam linhas (caso ainda não exista para algum canal nesse tenant)
INSERT INTO public.dispatch_pause_state (tenant_id, channel, paused, paused_at, reason)
SELECT '00000000-0000-0000-0000-000000000001'::uuid, ch, true, now(), 'BusinessCode em manutenção — pausa manual'
FROM (VALUES ('sms'), ('email')) AS t(ch)
ON CONFLICT (channel, tenant_id) DO UPDATE
  SET paused = true,
      paused_at = now(),
      reason = EXCLUDED.reason;