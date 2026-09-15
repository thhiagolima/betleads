
WITH priority(trigger_type, rank) AS (
  VALUES
    ('recuperacao_vip'::text,1),
    ('vip_esfriando',2),
    ('alto_potencial',3),
    ('quase_vip',4),
    ('dinheiro_parado',5),
    ('receita_em_queda',6),
    ('lead_quente_esfriando',7),
    ('frequencia_caindo',8),
    ('reativacao_em_curso',9),
    ('sem_login_7_14',10),
    ('sem_login_15_24',11),
    ('sem_login_25_34',12),
    ('sem_login_35_44',13),
    ('sem_login_45_59',14),
    ('sem_login_60_mais',15),
    ('engajado_sem_converter',16),
    ('cadastrados_sem_deposito',17)
),
active AS (
  SELECT fl.id, fl.player_id, fl.flow_id, fl.started_at, p.rank
    FROM public.flow_leads fl
    JOIN public.flows f ON f.id = fl.flow_id
    JOIN priority p ON p.trigger_type = f.trigger_type::text
   WHERE fl.status IN ('pending','running')
     AND fl.player_id IS NOT NULL
),
keepers AS (
  SELECT DISTINCT ON (player_id) id
    FROM active
   ORDER BY player_id, rank ASC, started_at ASC
)
UPDATE public.flow_leads
   SET status = 'exited',
       exit_reason = 'duplicate_lower_priority',
       completed_at = now()
 WHERE id IN (SELECT id FROM active)
   AND id NOT IN (SELECT id FROM keepers);
