CREATE TABLE public.email_senders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  from_name TEXT,
  reply_to TEXT,
  domain TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_senders TO authenticated;
GRANT ALL ON public.email_senders TO service_role;

ALTER TABLE public.email_senders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins full access email_senders"
ON public.email_senders
FOR ALL
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER trg_email_senders_updated_at
BEFORE UPDATE ON public.email_senders
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
