ALTER TABLE public.flows ADD COLUMN IF NOT EXISTS activated_at timestamptz;

CREATE OR REPLACE FUNCTION public.flows_set_activated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.active = true AND (OLD.active IS DISTINCT FROM true) THEN
    NEW.activated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS flows_set_activated_at_trigger ON public.flows;
CREATE TRIGGER flows_set_activated_at_trigger
BEFORE UPDATE ON public.flows
FOR EACH ROW
EXECUTE FUNCTION public.flows_set_activated_at();