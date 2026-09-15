WITH src AS (
  SELECT DISTINCT ON (wl.tenant_id, wl.payload->'data'->>'userId')
    wl.tenant_id,
    wl.payload->'data'->>'userId' AS uid,
    regexp_replace(wl.payload->'data'->'pixData'->>'keyValue', '\D', '', 'g') AS cpf
  FROM public.webhook_logs wl
  WHERE lower(wl.payload->'data'->'pixData'->>'keyType') = 'cpf'
    AND wl.payload->'data'->>'userId' IS NOT NULL
  ORDER BY wl.tenant_id, wl.payload->'data'->>'userId', wl.created_at DESC
)
UPDATE public.players p
SET cpf = src.cpf, updated_at = now()
FROM src
WHERE p.tenant_id = src.tenant_id
  AND p.player_external_id = src.uid
  AND p.cpf IS NULL
  AND src.cpf ~ '^[0-9]{11}$'
  AND src.cpf !~ '^(.)\1{10}$';