UPDATE public.players p
SET total_depositado = s.total,
    ultimo_deposito = GREATEST(COALESCE(p.ultimo_deposito,'1970-01-01'::timestamptz), COALESCE(s.ultimo_dep,'1970-01-01'::timestamptz)),
    ftd_em = COALESCE(p.ftd_em, s.primeiro_dep),
    updated_at = now()
FROM public._pixpgf_dep_import s
WHERE p.id = s.player_id;

DROP TABLE public._pixpgf_dep_import;