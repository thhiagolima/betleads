-- Resolve consent and suppression for a whole audience in one round trip.
CREATE OR REPLACE FUNCTION public.resolve_campaign_channel_eligibility(
  p_tenant_id uuid, p_channel text, p_candidates jsonb
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_result jsonb;
BEGIN
  IF p_channel NOT IN ('sms','email','voice') THEN RAISE EXCEPTION 'invalid channel'; END IF;
  IF NOT (public.has_tenant_access(p_tenant_id) OR auth.role()='service_role') THEN
    RAISE EXCEPTION 'access denied' USING ERRCODE='42501';
  END IF;
  IF p_channel='email' THEN
    WITH candidate_ids AS (
      SELECT value::uuid id FROM jsonb_array_elements_text(COALESCE(p_candidates,'[]'::jsonb))
    ), contacts AS (
      SELECT p.id,lower(trim(COALESCE(p.email,''))) email
      FROM candidate_ids c JOIN public.players p ON p.id=c.id AND p.tenant_id=p_tenant_id
    ), evaluated AS (
      SELECT c.*,(c.email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') valid,
        cc.status consent_status,
        EXISTS(SELECT 1 FROM public.suppressed_emails se WHERE lower(se.email)=c.email
          AND (se.tenant_id=p_tenant_id OR se.tenant_id IS NULL)) suppressed
      FROM contacts c LEFT JOIN public.channel_consents cc
        ON cc.tenant_id=p_tenant_id AND cc.channel='email' AND cc.subject=c.email
    ), eligible AS (
      SELECT DISTINCT ON (email) id,email FROM evaluated
      WHERE valid AND consent_status IS DISTINCT FROM 'revoked'
        AND (consent_status='granted' OR NOT suppressed) ORDER BY email,id
    )
    SELECT jsonb_build_object(
      'candidateCount',(SELECT count(*) FROM evaluated),
      'eligibleIdentifiers',COALESCE((SELECT jsonb_agg(email ORDER BY email) FROM eligible),'[]'::jsonb),
      'eligiblePlayerIds',COALESCE((SELECT jsonb_agg(id ORDER BY email) FROM eligible),'[]'::jsonb),
      'invalidCount',(SELECT count(*) FROM evaluated WHERE NOT valid),
      'optOutCount',(SELECT count(*) FROM evaluated WHERE valid AND (consent_status='revoked' OR (consent_status IS DISTINCT FROM 'granted' AND suppressed)))
    ) INTO v_result;
  ELSE
    WITH candidates AS (
      SELECT value raw,public.normalize_brazilian_phone(value) phone
      FROM jsonb_array_elements_text(COALESCE(p_candidates,'[]'::jsonb))
    ), evaluated AS (
      SELECT c.*,cc.status consent_status,
        CASE WHEN p_channel='sms' THEN EXISTS(SELECT 1 FROM public.sms_suppressions ss
          WHERE ss.tenant_id=p_tenant_id AND ss.phone=regexp_replace(c.phone,'[^0-9]','','g'))
        ELSE false END suppressed
      FROM candidates c LEFT JOIN public.channel_consents cc
        ON cc.tenant_id=p_tenant_id
       AND cc.channel=CASE WHEN p_channel='voice' THEN 'voice' ELSE 'sms' END
       AND cc.subject=regexp_replace(c.phone,'[^0-9]','','g')
    ), eligible AS (
      SELECT DISTINCT phone FROM evaluated WHERE phone IS NOT NULL
        AND consent_status IS DISTINCT FROM 'revoked'
        AND (p_channel<>'sms' OR consent_status='granted' OR NOT suppressed)
    )
    SELECT jsonb_build_object(
      'candidateCount',(SELECT count(*) FROM evaluated),
      'eligibleIdentifiers',COALESCE((SELECT jsonb_agg(phone ORDER BY phone) FROM eligible),'[]'::jsonb),
      'eligiblePlayerIds','[]'::jsonb,
      'invalidCount',(SELECT count(*) FROM evaluated WHERE phone IS NULL),
      'optOutCount',(SELECT count(*) FROM evaluated WHERE phone IS NOT NULL AND (consent_status='revoked' OR (p_channel='sms' AND consent_status IS DISTINCT FROM 'granted' AND suppressed)))
    ) INTO v_result;
  END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_campaign_channel_eligibility(uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.resolve_campaign_channel_eligibility(uuid,text,jsonb) TO authenticated,service_role;
CREATE INDEX IF NOT EXISTS suppressed_emails_tenant_email_idx ON public.suppressed_emails(tenant_id,lower(email));
