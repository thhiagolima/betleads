CREATE OR REPLACE FUNCTION public.get_players_alert_ids()
RETURNS TABLE(tipo text, player_id uuid)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH logins AS (
  SELECT e.player_id AS pid,
    count(*) FILTER (WHERE e.created_at >= now() - interval '30 days') AS l30,
    count(*) FILTER (WHERE e.created_at <  now() - interval '30 days'
                       AND e.created_at >= now() - interval '60 days') AS l3060
  FROM events e
  WHERE e.tipo = 'login' AND e.player_id IS NOT NULL
  GROUP BY 1
),
deps AS (
  SELECT d.player_id AS pid,
    coalesce(sum(d.valor) FILTER (WHERE d.created_at >= now() - interval '30 days'), 0) AS d30,
    coalesce(sum(d.valor) FILTER (WHERE d.created_at <  now() - interval '30 days'), 0) AS d3060
  FROM deposits d
  WHERE d.status = 'aprovado'
    AND d.created_at >= now() - interval '60 days'
    AND d.player_id IS NOT NULL
  GROUP BY 1
),
dep_days AS (
  SELECT DISTINCT d.player_id AS pid,
         (d.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dd
  FROM deposits d
  WHERE d.status = 'aprovado'
    AND d.created_at >= now() - interval '60 days'
    AND d.player_id IS NOT NULL
),
seq AS (
  -- sequência de dias seguidos depositando, ancorada no dia de depósito mais recente
  SELECT x.pid, count(*) AS seg
  FROM (
    SELECT dd.pid, dd.dd,
           row_number() OVER (PARTITION BY dd.pid ORDER BY dd.dd DESC) AS rn,
           max(dd.dd) OVER (PARTITION BY dd.pid) AS last_dd
    FROM dep_days dd
  ) x
  WHERE x.dd = x.last_dd - (x.rn::int - 1)
    AND x.last_dd >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 14
  GROUP BY x.pid
),
reativados AS (
  SELECT DISTINCT y.player_id AS pid
  FROM (
    SELECT d.player_id, d.created_at,
           lag(d.created_at) OVER (PARTITION BY d.player_id ORDER BY d.created_at) AS prev
    FROM deposits d
    WHERE d.status = 'aprovado' AND d.player_id IS NOT NULL
  ) y
  WHERE y.created_at >= now() - interval '7 days'
    AND y.prev IS NOT NULL
    AND y.created_at - y.prev >= interval '14 days'
)
SELECT 'alto_potencial'::text AS tipo, p.id AS player_id
FROM players p
JOIN logins l ON l.pid = p.id
LEFT JOIN deps dp ON dp.pid = p.id
WHERE l.l30 >= 10
  AND coalesce(dp.d30, 0) > coalesce(dp.d3060, 0)
  AND p.ultimo_login >= now() - interval '2 days'
  AND NOT (p.vip OR p.total_depositado >= 1000)

UNION ALL
SELECT 'player_reativado', r.pid FROM reativados r

UNION ALL
SELECT 'sequencia_depositos', p.id
FROM players p
JOIN seq s ON s.pid = p.id
WHERE s.seg >= 5
  AND p.ultimo_login >= now() - interval '2 days'

UNION ALL
SELECT 'login_sem_deposito', p.id
FROM players p
JOIN logins l ON l.pid = p.id
WHERE l.l30 >= 8
  AND p.total_depositado > 0
  AND (p.ultimo_deposito IS NULL OR p.ultimo_deposito < now() - interval '14 days')

UNION ALL
SELECT 'frequencia_caindo', p.id
FROM players p
JOIN logins l ON l.pid = p.id
WHERE l.l3060 >= 5
  AND l.l30 < l.l3060 * 0.5
$$;

GRANT EXECUTE ON FUNCTION public.get_players_alert_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_players_alert_ids() TO service_role;