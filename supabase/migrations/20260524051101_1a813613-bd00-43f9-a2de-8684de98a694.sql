-- Tabela de vínculo permanente lead -> sessão WhatsApp
CREATE TABLE public.lead_whatsapp_assignments (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  phone_e164 text NOT NULL UNIQUE,
  player_id uuid NULL,
  session_id uuid NOT NULL REFERENCES public.whatsapp_sessions(id) ON DELETE RESTRICT,
  previous_session_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','orphaned')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_assignments_session ON public.lead_whatsapp_assignments(session_id);
CREATE INDEX idx_lead_assignments_status ON public.lead_whatsapp_assignments(status);

ALTER TABLE public.lead_whatsapp_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins full access lead_whatsapp_assignments"
ON public.lead_whatsapp_assignments
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER set_updated_at_lead_assignments
BEFORE UPDATE ON public.lead_whatsapp_assignments
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.lead_whatsapp_assignments;

-- Backfill a partir dos chats 1:1 existentes — escolhe a sessão da conversa mais recente por telefone.
INSERT INTO public.lead_whatsapp_assignments (phone_e164, session_id, status, assigned_at, updated_at)
SELECT DISTINCT ON (c.phone)
  c.phone AS phone_e164,
  c.session_id,
  'active',
  COALESCE(c.last_message_at, c.created_at),
  now()
FROM public.whatsapp_chats c
WHERE c.is_group = false
  AND c.phone IS NOT NULL
  AND c.phone <> ''
ORDER BY c.phone, c.last_message_at DESC NULLS LAST, c.created_at DESC
ON CONFLICT (phone_e164) DO NOTHING;