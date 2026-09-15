UPDATE public.call_flow_blocks
SET delay_after_seconds = 0, updated_at = now()
WHERE delay_after_seconds > 0;