-- Popups nas casas: esquema base.
-- Desenho: docs/superpowers/specs/2026-11-13-popup-casas-design.md
--
-- O QUE ESTA MIGRAÇÃO CRIA (aditiva)
--   * site_popups: popups que a casa desenha no CRM e o loader do push
--     (/api/public/push/loader.js) mostra no site da casa.
--   * site_popup_audience_members: jogadores do público "filtro do CRM",
--     resolvido de antemão por geração (o endpoint público só consulta a
--     geração corrente; a troca de geração é atômica).
--   * site_popup_daily_stats: contadores por popup e dia (BRT), sem uma
--     linha por evento.
--   * site_popup_record_event, site_popup_set_audience_generation: RPCs
--     security definer, só service_role.
--
-- Todas as tabelas novas: RLS ligada, sem policy — só service_role lê/escreve;
-- as funções do servidor usam supabaseAdmin.
--
-- ROLLBACK (manual, aditivo):
--   drop function public.site_popup_set_audience_generation(uuid, integer, integer);
--   drop function public.site_popup_record_event(uuid, text);
--   drop table public.site_popup_daily_stats;
--   drop table public.site_popup_audience_members;
--   drop table public.site_popups;
--   alter table public.tenant_webpush_settings drop column popup_player_seen_at;

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.site_popups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho', 'ativo', 'pausado', 'encerrado')),
  prioridade integer NOT NULL DEFAULT 0 CHECK (prioridade BETWEEN 0 AND 1000),
  starts_at timestamptz,
  ends_at timestamptz,

  formato text NOT NULL DEFAULT 'central' CHECK (formato IN ('central', 'rodape', 'canto')),
  image_url text CHECK (image_url IS NULL OR (image_url ~ '^https://' AND char_length(image_url) <= 2000)),
  titulo text CHECK (titulo IS NULL OR char_length(titulo) BETWEEN 1 AND 80),
  texto text CHECK (texto IS NULL OR char_length(texto) BETWEEN 1 AND 400),
  botao_label text CHECK (botao_label IS NULL OR char_length(botao_label) BETWEEN 1 AND 40),
  botao_url text CHECK (botao_url IS NULL OR (botao_url ~ '^https://' AND char_length(botao_url) <= 2000)),

  audience_kind text NOT NULL DEFAULT 'todos'
    CHECK (audience_kind IN ('todos', 'logados', 'deslogados', 'filtro')),
  audience_label text CHECK (audience_label IS NULL OR char_length(audience_label) <= 200),
  audience_criteria jsonb,
  audience_generation integer NOT NULL DEFAULT 0,
  audience_count integer,
  audience_refreshed_at timestamptz,

  paginas_modo text NOT NULL DEFAULT 'todas' CHECK (paginas_modo IN ('todas', 'incluir', 'excluir')),
  paginas text[] NOT NULL DEFAULT '{}' CHECK (cardinality(paginas) <= 50),
  atraso_segundos integer NOT NULL DEFAULT 3 CHECK (atraso_segundos BETWEEN 0 AND 120),
  frequencia text NOT NULL DEFAULT 'dia'
    CHECK (frequencia IN ('sessao', 'dia', 'n_dias', 'ate_clicar')),
  frequencia_dias integer CHECK (frequencia_dias IS NULL OR frequencia_dias BETWEEN 1 AND 90),

  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT site_popups_has_content CHECK (titulo IS NOT NULL OR image_url IS NOT NULL),
  CONSTRAINT site_popups_button_pair CHECK ((botao_label IS NULL) = (botao_url IS NULL)),
  CONSTRAINT site_popups_filter_has_criteria
    CHECK (audience_kind <> 'filtro' OR audience_criteria IS NOT NULL),
  CONSTRAINT site_popups_n_dias CHECK (frequencia <> 'n_dias' OR frequencia_dias IS NOT NULL),
  CONSTRAINT site_popups_period CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CONSTRAINT site_popups_paginas CHECK (paginas_modo = 'todas' OR cardinality(paginas) > 0)
);

COMMENT ON TABLE public.site_popups IS
  'Popups que a casa mostra no próprio site pelo loader do push. Conteúdo estruturado (nunca HTML). audience_generation aponta a geração corrente de site_popup_audience_members (público filtro).';

CREATE INDEX IF NOT EXISTS site_popups_tenant_status_idx
  ON public.site_popups (tenant_id, status, prioridade DESC);

CREATE TABLE IF NOT EXISTS public.site_popup_audience_members (
  popup_id uuid NOT NULL REFERENCES public.site_popups(id) ON DELETE CASCADE,
  generation integer NOT NULL,
  player_id uuid NOT NULL,
  PRIMARY KEY (popup_id, generation, player_id)
);

COMMENT ON TABLE public.site_popup_audience_members IS
  'Jogadores do público filtro de um popup, por geração. Só a geração em site_popups.audience_generation vale; as anteriores são apagadas depois da troca.';

-- O endpoint público consulta por jogador (um jogador → seus popups filtro).
CREATE INDEX IF NOT EXISTS site_popup_audience_members_player_idx
  ON public.site_popup_audience_members (player_id, popup_id);

CREATE TABLE IF NOT EXISTS public.site_popup_daily_stats (
  popup_id uuid NOT NULL REFERENCES public.site_popups(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  dia date NOT NULL,
  exibicoes bigint NOT NULL DEFAULT 0,
  cliques bigint NOT NULL DEFAULT 0,
  fechamentos bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (popup_id, dia)
);

COMMENT ON TABLE public.site_popup_daily_stats IS
  'Contadores de exibição, clique e fechamento por popup e dia (America/Sao_Paulo).';

CREATE INDEX IF NOT EXISTS site_popup_daily_stats_tenant_dia_idx
  ON public.site_popup_daily_stats (tenant_id, dia);

-- Quando o endpoint público do popup recebeu pela primeira vez um jogador
-- identificado (window.betleads.playerId que casa com um jogador da casa).
ALTER TABLE public.tenant_webpush_settings
  ADD COLUMN IF NOT EXISTS popup_player_seen_at timestamptz;

-- Soma um evento ao contador do dia. Popup inexistente: não faz nada.
CREATE OR REPLACE FUNCTION public.site_popup_record_event(p_popup_id uuid, p_kind text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
  v_dia date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF p_kind NOT IN ('exibicao', 'clique', 'fechamento') THEN
    RAISE EXCEPTION 'evento de popup inválido: %', p_kind;
  END IF;
  SELECT tenant_id INTO v_tenant FROM public.site_popups WHERE id = p_popup_id;
  IF v_tenant IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO public.site_popup_daily_stats AS s (popup_id, tenant_id, dia, exibicoes, cliques, fechamentos)
  VALUES (
    p_popup_id, v_tenant, v_dia,
    (p_kind = 'exibicao')::int, (p_kind = 'clique')::int, (p_kind = 'fechamento')::int
  )
  ON CONFLICT (popup_id, dia) DO UPDATE SET
    exibicoes = s.exibicoes + (p_kind = 'exibicao')::int,
    cliques = s.cliques + (p_kind = 'clique')::int,
    fechamentos = s.fechamentos + (p_kind = 'fechamento')::int;
  RETURN true;
END;
$$;

-- Passa o popup para a geração de público já gravada e apaga as outras.
CREATE OR REPLACE FUNCTION public.site_popup_set_audience_generation(
  p_popup_id uuid,
  p_generation integer,
  p_count integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.site_popups
     SET audience_generation = p_generation,
         audience_count = p_count,
         audience_refreshed_at = now()
   WHERE id = p_popup_id;
  DELETE FROM public.site_popup_audience_members
   WHERE popup_id = p_popup_id AND generation <> p_generation;
END;
$$;

ALTER TABLE public.site_popups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_popup_audience_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_popup_daily_stats ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.site_popups FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.site_popup_audience_members FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.site_popup_daily_stats FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.site_popup_record_event(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.site_popup_set_audience_generation(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.site_popup_record_event(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.site_popup_set_audience_generation(uuid, integer, integer) TO service_role;
