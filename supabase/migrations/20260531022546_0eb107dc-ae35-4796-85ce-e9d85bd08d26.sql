DO $$
DECLARE
  v_flow_id uuid;
BEGIN
  SELECT id INTO v_flow_id FROM public.call_flows WHERE name ILIKE '%dinheiro parado%' LIMIT 1;

  IF v_flow_id IS NULL THEN
    RAISE WARNING 'Skipping dinheiro parado call flow delay setup: flow not found';
    RETURN;
  END IF;

  -- Remove existing delay blocks to avoid duplication.
  DELETE FROM public.call_flow_blocks WHERE flow_id = v_flow_id AND block_type = 'delay';

  -- Reorder calls to even indexes (0,2,4,6,8,10,12).
  WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY order_index) - 1 AS rn
    FROM public.call_flow_blocks
    WHERE flow_id = v_flow_id AND block_type = 'call'
  )
  UPDATE public.call_flow_blocks b
  SET order_index = ordered.rn * 2, updated_at = now()
  FROM ordered
  WHERE b.id = ordered.id;

  -- Insert 7 delay blocks on odd indexes (1,3,5,7,9,11,13).
  INSERT INTO public.call_flow_blocks (flow_id, block_type, order_index, delay_seconds, delay_after_seconds, max_attempts, max_call_seconds)
  SELECT v_flow_id, 'delay', i, 86400, 0, 1, 60
  FROM generate_series(1, 13, 2) AS i;
END $$;
