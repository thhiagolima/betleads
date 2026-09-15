
-- 1. flow_templates
CREATE TABLE public.flow_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Template',
  is_active boolean NOT NULL DEFAULT true,
  weight integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_flow_templates_flow ON public.flow_templates(flow_id);

ALTER TABLE public.flow_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins full access flow_templates" ON public.flow_templates
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER trg_flow_templates_updated_at
  BEFORE UPDATE ON public.flow_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. flow_blocks gains template ref
ALTER TABLE public.flow_blocks
  ADD COLUMN flow_template_id uuid REFERENCES public.flow_templates(id) ON DELETE CASCADE;

-- 3. backfill: one default template per existing flow + reparent blocks
DO $$
DECLARE
  f RECORD;
  tpl_id uuid;
BEGIN
  FOR f IN SELECT id FROM public.flows LOOP
    INSERT INTO public.flow_templates (flow_id, name, is_active, weight)
    VALUES (f.id, 'Template 1', true, 1)
    RETURNING id INTO tpl_id;

    UPDATE public.flow_blocks
      SET flow_template_id = tpl_id
      WHERE flow_id = f.id AND flow_template_id IS NULL;
  END LOOP;
END $$;

CREATE INDEX idx_flow_blocks_template ON public.flow_blocks(flow_template_id);

-- 4. flow_leads remembers the randomly chosen template
ALTER TABLE public.flow_leads
  ADD COLUMN template_id uuid REFERENCES public.flow_templates(id) ON DELETE SET NULL;
