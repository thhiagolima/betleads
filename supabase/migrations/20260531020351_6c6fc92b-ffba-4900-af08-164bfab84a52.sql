ALTER TABLE public.call_flow_blocks
  ADD CONSTRAINT call_flow_blocks_flow_id_fkey
  FOREIGN KEY (flow_id)
  REFERENCES public.call_flows(id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_call_flow_blocks_flow_id
  ON public.call_flow_blocks(flow_id);

CREATE INDEX IF NOT EXISTS idx_call_flow_block_sms_block_id
  ON public.call_flow_block_sms(block_id);