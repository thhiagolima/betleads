WITH agg AS (
  SELECT
    campaign_id,
    COUNT(*)::int AS total_logs,
    COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_logs,
    COUNT(*) FILTER (WHERE status = 'error')::int AS error_logs,
    MAX(created_at) AS last_log
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
    'total', COALESCE(agg.total_logs, 0)
  ),
  updated_at = now()
FROM agg
WHERE c.id = agg.campaign_id
  AND c.status = 'enviando'
  AND agg.last_log < now() - interval '60 seconds';