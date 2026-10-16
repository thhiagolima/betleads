-- F0-12 (QA-01, QA-18, SEC-18): e-mail opt-out per tenant, normalized e-mail.
--
-- Before: suppressed_emails had a UNIQUE index on lower(email) (global, not per
-- tenant) and the code upserted with ON CONFLICT (email), which matches no
-- constraint, so every write failed ("no unique or exclusion constraint
-- matching the ON CONFLICT specification") and the error was ignored.
-- email_unsubscribe_tokens had the same global UNIQUE on lower(email), so the
-- first tenant that e-mailed an address owned its token (and its opt-out).
--
-- After:
--   * e-mail is always stored as lower(btrim(email)) (trigger), so the code
--     compares with = instead of ilike (no _ / % wildcards);
--   * suppressed_emails is UNIQUE (tenant_id, email) NULLS NOT DISTINCT (one
--     global row per address when tenant_id is null), which PostgREST
--     upserts can target with onConflict "tenant_id,email";
--   * email_unsubscribe_tokens is keyed by (tenant_id, email) (non-unique
--     index: two tokens for the same pair are harmless, and no existing link
--     is ever invalidated).
--
-- Data safety: no row is lost. Rows that collapse onto the same
-- (tenant_id, normalized e-mail) are copied to suppressed_emails_dedupe_backup
-- before being removed; the oldest row of each group is kept, so the address
-- stays suppressed for that tenant. Tokens are never deleted.
-- Requires PostgreSQL 15+ (NULLS NOT DISTINCT); production runs 17.

-- 1) The global unique indexes go first: normalizing values below could
--    otherwise collide across tenants on lower(email).
DROP INDEX IF EXISTS public.suppressed_emails_email_key;
DROP INDEX IF EXISTS public.email_unsubscribe_tokens_email_key;

-- 2) Backup + dedupe of suppressed_emails per (tenant_id, normalized e-mail).
CREATE TABLE IF NOT EXISTS public.suppressed_emails_dedupe_backup (
  id uuid NOT NULL,
  email text NOT NULL,
  reason text NOT NULL,
  tenant_id uuid NULL,
  source text NULL,
  notes text NULL,
  created_at timestamptz NOT NULL,
  kept_id uuid NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.suppressed_emails_dedupe_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.suppressed_emails_dedupe_backup FROM anon, authenticated;
GRANT ALL ON TABLE public.suppressed_emails_dedupe_backup TO service_role;

WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER w AS kept_id,
    row_number() OVER w AS rn
  FROM public.suppressed_emails
  WINDOW w AS (
    PARTITION BY tenant_id, lower(btrim(email))
    ORDER BY created_at, id
  )
), moved AS (
  INSERT INTO public.suppressed_emails_dedupe_backup
    (id, email, reason, tenant_id, source, notes, created_at, kept_id)
  SELECT s.id, s.email, s.reason, s.tenant_id, s.source, s.notes, s.created_at, r.kept_id
  FROM public.suppressed_emails s
  JOIN ranked r ON r.id = s.id
  WHERE r.rn > 1
  RETURNING id
)
DELETE FROM public.suppressed_emails s
USING moved
WHERE s.id = moved.id;

-- 3) Normalize stored values.
UPDATE public.suppressed_emails
SET email = lower(btrim(email))
WHERE email IS DISTINCT FROM lower(btrim(email));

UPDATE public.email_unsubscribe_tokens
SET email = lower(btrim(email))
WHERE email IS DISTINCT FROM lower(btrim(email));

-- 4) Keep them normalized for every writer (service code, imports, SQL).
CREATE OR REPLACE FUNCTION public.normalize_email_column()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS normalize_email_suppressed_emails ON public.suppressed_emails;
CREATE TRIGGER normalize_email_suppressed_emails
  BEFORE INSERT OR UPDATE OF email ON public.suppressed_emails
  FOR EACH ROW EXECUTE FUNCTION public.normalize_email_column();

DROP TRIGGER IF EXISTS normalize_email_unsubscribe_tokens ON public.email_unsubscribe_tokens;
CREATE TRIGGER normalize_email_unsubscribe_tokens
  BEFORE INSERT OR UPDATE OF email ON public.email_unsubscribe_tokens
  FOR EACH ROW EXECUTE FUNCTION public.normalize_email_column();

-- 5) Per-tenant keys.
CREATE UNIQUE INDEX IF NOT EXISTS suppressed_emails_tenant_email_key
  ON public.suppressed_emails (tenant_id, email) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS email_unsubscribe_tokens_tenant_email_idx
  ON public.email_unsubscribe_tokens (tenant_id, email);
