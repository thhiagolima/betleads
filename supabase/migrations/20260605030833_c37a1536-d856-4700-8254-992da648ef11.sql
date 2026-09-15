-- Fix legacy delay blocks where value was stored in delay_after_seconds
UPDATE public.call_flow_blocks
SET delay_seconds = delay_after_seconds,
    delay_after_seconds = 0
WHERE block_type = 'delay'
  AND COALESCE(delay_seconds, 0) <= 0
  AND COALESCE(delay_after_seconds, 0) > 0;

-- Ensure no remaining delay block has 0 (fallback to 1 day)
UPDATE public.call_flow_blocks
SET delay_seconds = 86400
WHERE block_type = 'delay'
  AND COALESCE(delay_seconds, 0) <= 0;

-- Persist exit conditions for SMS flows
ALTER TABLE public.sms_flows
ADD COLUMN IF NOT EXISTS exit_conditions jsonb NOT NULL DEFAULT '[]'::jsonb;