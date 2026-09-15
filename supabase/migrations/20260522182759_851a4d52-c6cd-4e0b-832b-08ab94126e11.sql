
DO $$ BEGIN
  CREATE TYPE public.followup_acao AS ENUM ('whatsapp','sms','bonus','gerente','campanha','acompanhamento');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.lead_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL,
  alerta_tipo text NOT NULL,
  acao public.followup_acao NOT NULL,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_followups_player_idx ON public.lead_followups(player_id, created_at DESC);

ALTER TABLE public.lead_followups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins full access" ON public.lead_followups;
CREATE POLICY "Admins full access" ON public.lead_followups
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
