-- Realinhar enum email_trigger_type com os 17 gatilhos reais usados em SMS/WhatsApp
ALTER TABLE public.email_flows ALTER COLUMN trigger_type DROP DEFAULT;
ALTER TABLE public.email_flows ALTER COLUMN trigger_type TYPE text USING trigger_type::text;

-- Remapear valores "fake" para o gatilho real mais próximo
UPDATE public.email_flows SET trigger_type = CASE trigger_type
  WHEN 'lead_sem_login'      THEN 'sem_login_7_14'
  WHEN 'lead_sem_deposito'   THEN 'cadastrados_sem_deposito'
  WHEN 'abandono_cadastro'   THEN 'cadastrados_sem_deposito'
  WHEN 'abandono_deposito'   THEN 'cadastrados_sem_deposito'
  WHEN 'primeiro_deposito'   THEN 'reativacao_em_curso'
  WHEN 'pos_deposito'        THEN 'reativacao_em_curso'
  WHEN 'pos_saque'           THEN 'reativacao_em_curso'
  WHEN 'vip_inativo'         THEN 'recuperacao_vip'
  WHEN 'cashback'            THEN 'dinheiro_parado'
  WHEN 'cupom'               THEN 'engajado_sem_converter'
  WHEN 'conversao'           THEN 'cadastrados_sem_deposito'
  WHEN 'retorno'             THEN 'reativacao_em_curso'
  WHEN 'reativacao'          THEN 'reativacao_em_curso'
  WHEN 'manual'              THEN 'cadastrados_sem_deposito'
  WHEN 'customizado'         THEN 'cadastrados_sem_deposito'
  ELSE trigger_type
END
WHERE trigger_type NOT IN (
  'recuperacao_vip','vip_esfriando','receita_em_queda','lead_quente_esfriando',
  'quase_vip','alto_potencial','reativacao_em_curso','dinheiro_parado',
  'engajado_sem_converter','frequencia_caindo','cadastrados_sem_deposito',
  'sem_login_7_14','sem_login_15_24','sem_login_25_34','sem_login_35_44',
  'sem_login_45_59','sem_login_60_mais'
);

DROP TYPE public.email_trigger_type;
CREATE TYPE public.email_trigger_type AS ENUM (
  'recuperacao_vip','vip_esfriando','receita_em_queda','lead_quente_esfriando',
  'quase_vip','alto_potencial','reativacao_em_curso','dinheiro_parado',
  'engajado_sem_converter','frequencia_caindo','cadastrados_sem_deposito',
  'sem_login_7_14','sem_login_15_24','sem_login_25_34','sem_login_35_44',
  'sem_login_45_59','sem_login_60_mais'
);

ALTER TABLE public.email_flows
  ALTER COLUMN trigger_type TYPE public.email_trigger_type USING trigger_type::public.email_trigger_type;
ALTER TABLE public.email_flows
  ALTER COLUMN trigger_type SET DEFAULT 'cadastrados_sem_deposito'::public.email_trigger_type;