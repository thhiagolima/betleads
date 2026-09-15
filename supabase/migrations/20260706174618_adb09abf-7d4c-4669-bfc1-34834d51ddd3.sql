
CREATE OR REPLACE FUNCTION public.dashboard_totals(
  _tenant uuid,
  _from timestamptz,
  _to timestamptz,
  _reset_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb;
  v_from_eff timestamptz := GREATEST(_from, _reset_at);
BEGIN
  IF NOT public.has_tenant_access(_tenant) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT jsonb_build_object(
    'deposits_period_sum',
      COALESCE((SELECT SUM(valor) FROM public.deposits
                WHERE tenant_id = _tenant AND status = 'aprovado'
                  AND created_at >= v_from_eff AND created_at <= _to), 0),
    'deposits_period_count',
      COALESCE((SELECT COUNT(*) FROM public.deposits
                WHERE tenant_id = _tenant AND status = 'aprovado'
                  AND created_at >= v_from_eff AND created_at <= _to), 0),
    'depositantes_period',
      COALESCE((SELECT COUNT(DISTINCT player_id) FROM public.deposits
                WHERE tenant_id = _tenant AND status = 'aprovado'
                  AND created_at >= v_from_eff AND created_at <= _to
                  AND player_id IS NOT NULL), 0),
    'sacado_total_since_reset',
      COALESCE((SELECT SUM(valor) FROM public.withdrawals
                WHERE tenant_id = _tenant AND status = 'aprovado'
                  AND created_at >= _reset_at), 0),
    'deposits_series_30d',
      COALESCE((
        SELECT jsonb_agg(row_to_json(t) ORDER BY t.day)
        FROM (
          SELECT to_char((created_at AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS day,
                 SUM(valor)::numeric AS value
          FROM public.deposits
          WHERE tenant_id = _tenant AND status = 'aprovado'
            AND created_at >= GREATEST(_reset_at, now() - interval '30 days')
          GROUP BY 1
        ) t
      ), '[]'::jsonb),
    'players_series_30d',
      COALESCE((
        SELECT jsonb_agg(row_to_json(t) ORDER BY t.day)
        FROM (
          SELECT to_char((created_at AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS day,
                 COUNT(*)::int AS value
          FROM public.players
          WHERE tenant_id = _tenant
            AND created_at >= now() - interval '30 days'
          GROUP BY 1
        ) t
      ), '[]'::jsonb),
    'top_depositante_period',
      (SELECT to_jsonb(x) FROM (
        SELECT p.nome, SUM(d.valor)::numeric AS total
        FROM public.deposits d
        JOIN public.players p ON p.id = d.player_id
        WHERE d.tenant_id = _tenant AND d.status = 'aprovado'
          AND d.created_at >= v_from_eff AND d.created_at <= _to
        GROUP BY p.nome
        ORDER BY 2 DESC
        LIMIT 1
      ) x)
  ) INTO v;

  RETURN v;
END;
$$;

GRANT EXECUTE ON FUNCTION public.dashboard_totals(uuid, timestamptz, timestamptz, timestamptz) TO authenticated;
