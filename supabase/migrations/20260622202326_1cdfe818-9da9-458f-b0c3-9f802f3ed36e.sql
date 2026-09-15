
-- 1) Tabela de emails suprimidos
CREATE TABLE IF NOT EXISTS public.suppressed_emails (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('unsubscribe','complaint','bounce_hard','manual','repeated_failures')),
  tenant_id UUID NULL,
  source TEXT NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS suppressed_emails_email_key
  ON public.suppressed_emails (lower(email));

CREATE INDEX IF NOT EXISTS suppressed_emails_tenant_idx
  ON public.suppressed_emails (tenant_id);

GRANT SELECT ON public.suppressed_emails TO authenticated;
GRANT ALL ON public.suppressed_emails TO service_role;

ALTER TABLE public.suppressed_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant members can view suppression list"
  ON public.suppressed_emails FOR SELECT
  TO authenticated
  USING (
    tenant_id IS NULL
    OR public.is_super_admin()
    OR public.has_tenant_access(tenant_id)
  );

-- 2) Tokens de descadastro (1 por email)
CREATE TABLE IF NOT EXISTS public.email_unsubscribe_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  tenant_id UUID NULL,
  used_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_unsubscribe_tokens_email_key
  ON public.email_unsubscribe_tokens (lower(email));

GRANT ALL ON public.email_unsubscribe_tokens TO service_role;
-- sem grants para anon/authenticated: tudo passa por server function / rota pública com service_role.

ALTER TABLE public.email_unsubscribe_tokens ENABLE ROW LEVEL SECURITY;
-- nenhuma policy = ninguém via API direta. OK.
