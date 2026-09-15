WITH agg AS (
  SELECT
    campaign_id,
    COUNT(*)::int AS total_logs,
    COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_logs,
    COUNT(*) FILTER (WHERE status = 'error')::int AS error_logs
  FROM public.email_send_logs
  WHERE campaign_id IS NOT NULL
  GROUP BY campaign_id
)
UPDATE public.email_campaigns c
SET
  status = 'concluida',
  stats = jsonb_build_object(
    'enviados', COALESCE(agg.sent_logs, 0),
    'entregues', COALESCE(agg.sent_logs, 0),
    'abertos', COALESCE((c.stats->>'abertos')::int, 0),
    'cliques', COALESCE((c.stats->>'cliques')::int, 0),
    'falhas', COALESCE(agg.error_logs, 0),
    'total', GREATEST(
      COALESCE((c.stats->>'total')::int, 0),
      COALESCE(agg.total_logs, 0)
    )
  ),
  updated_at = now()
FROM agg
WHERE c.id = agg.campaign_id
  AND c.status = 'enviando'
  AND c.updated_at < now() - interval '2 minutes';

UPDATE public.email_campaigns c
SET
  status = 'rascunho',
  stats = jsonb_build_object(
    'enviados', 0,
    'entregues', 0,
    'abertos', COALESCE((c.stats->>'abertos')::int, 0),
    'cliques', COALESCE((c.stats->>'cliques')::int, 0),
    'falhas', 0,
    'total', COALESCE((c.stats->>'total')::int, 0)
  ),
  updated_at = now()
WHERE c.status = 'enviando'
  AND c.updated_at < now() - interval '2 minutes'
  AND NOT EXISTS (
    SELECT 1
    FROM public.email_send_logs l
    WHERE l.campaign_id = c.id
  );