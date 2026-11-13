-- Conta própria de provedor por casa — Fase 1 (schema: dono e concessões).
-- Escopo: docs/superpowers/specs/2026-11-07-conta-propria-provedor-design.md
--
-- O QUE ESTA MIGRAÇÃO CRIA (aditiva)
--   * public.provider_accounts.owner_tenant_id: NULL = conta da BetLeads
--     (compartilhada, pode ser padrão da plataforma). Preenchido = conta
--     própria de uma casa, só ligável à própria casa, nunca padrão da
--     plataforma. ON DELETE CASCADE: excluir a casa apaga a conta dela.
--   * public.provider_accounts.own_unit_cost: custo unitário (numeric,
--     4 casas) que a casa paga pelo envio nessa conta própria — só tem
--     sentido com owner_tenant_id preenchido; não há check cruzado aqui
--     (fica para a tarefa que usa a coluna no envio).
--   * public.provider_accounts.callback_token_encrypted /
--     last_callback_at: token de callback cifrado (igual padrão de
--     credentials_encrypted) e último callback recebido, para a conta
--     própria validar o callback é da própria conta (tarefa 8).
--   * public.tenant_own_provider_grants: (casa, canal) -> a casa pode usar
--     conta própria nesse canal (allowed) e quanto paga por mês por isso
--     (monthly_fee_cents, congelado na fatura na emissão). pending_decision
--     marca uma concessão revogada que está aguardando a casa escolher
--     entre voltar para a conta padrão ou ficar pausada.
--   Mesmas checagens de owner_tenant_id em tenant_channel_providers_check_channel
--   (a conta com dono só liga à própria casa) e platform_channel_defaults_check
--   (conta com dono nunca é padrão da plataforma) — funções recriadas com o
--   corpo atual (20261108100000 / 20261215100000) mais a checagem de dono.
--   Só service_role acessa tenant_own_provider_grants. RLS ligada sem
--   políticas, igual às tabelas de provider_accounts.
--
-- COMPATIBILIDADE / ORDEM DE DEPLOY
--   * Aplicar ANTES do app novo (igual às migrações anteriores de
--     provedores). O app antigo não grava owner_tenant_id/own_unit_cost/
--     callback_token_encrypted/last_callback_at nem lê
--     tenant_own_provider_grants — ignora tudo.
--
-- ROLLBACK
--   DROP TABLE public.tenant_own_provider_grants;
--   ALTER TABLE public.provider_accounts DROP COLUMN last_callback_at;
--   ALTER TABLE public.provider_accounts DROP COLUMN callback_token_encrypted;
--   ALTER TABLE public.provider_accounts DROP COLUMN own_unit_cost;
--   ALTER TABLE public.provider_accounts DROP COLUMN owner_tenant_id;
--   -- (as funções voltam ao corpo de 20261108100000 / 20261215100000 se
--   -- essas migrações forem reaplicadas, ou com um CREATE OR REPLACE manual.)

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.provider_accounts
  ADD COLUMN IF NOT EXISTS owner_tenant_id uuid NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS own_unit_cost numeric(12, 4) NULL CHECK (own_unit_cost >= 0),
  ADD COLUMN IF NOT EXISTS callback_token_encrypted text NULL,
  ADD COLUMN IF NOT EXISTS last_callback_at timestamptz NULL;

COMMENT ON COLUMN public.provider_accounts.owner_tenant_id IS
  'NULL = conta da BetLeads (pode ser padrão da plataforma). Preenchido = conta própria da casa; só liga à própria casa, nunca é padrão da plataforma. ON DELETE CASCADE: casa excluída apaga a conta.';
COMMENT ON COLUMN public.provider_accounts.own_unit_cost IS
  'Custo unitário que a casa paga pela conta própria (só com owner_tenant_id preenchido).';
COMMENT ON COLUMN public.provider_accounts.callback_token_encrypted IS
  'Token de callback cifrado da conta própria (mesmo padrão de credentials_encrypted), para validar que um callback recebido é da própria conta.';
COMMENT ON COLUMN public.provider_accounts.last_callback_at IS
  'Último callback recebido por esta conta própria.';

CREATE TABLE IF NOT EXISTS public.tenant_own_provider_grants (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'email', 'voice')),
  allowed boolean NOT NULL,
  monthly_fee_cents bigint NOT NULL DEFAULT 0 CHECK (monthly_fee_cents >= 0),
  granted_at timestamptz,
  granted_by uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  pending_decision boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel)
);

COMMENT ON TABLE public.tenant_own_provider_grants IS
  'Concessão de conta própria de provedor por casa e canal: allowed (pode usar conta própria), monthly_fee_cents (taxa mensal, congelada na fatura). pending_decision = concessão revogada aguardando a casa escolher entre voltar para a conta padrão ou ficar pausada.';

-- Recria a função com o corpo de 20261108100000 mais a checagem de dono:
-- conta com owner_tenant_id só liga à própria casa.
CREATE OR REPLACE FUNCTION public.tenant_channel_providers_check_channel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_owner_tenant_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.provider_accounts a
    WHERE a.id = NEW.provider_account_id AND NEW.channel = ANY (a.channels)
  ) THEN
    RAISE EXCEPTION 'A conta % não atende o canal %', NEW.provider_account_id, NEW.channel;
  END IF;

  SELECT a.owner_tenant_id INTO v_owner_tenant_id
  FROM public.provider_accounts a
  WHERE a.id = NEW.provider_account_id;

  IF v_owner_tenant_id IS NOT NULL AND v_owner_tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'A conta % não pertence à casa %', NEW.provider_account_id, NEW.tenant_id;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Recria a função com o corpo de 20261215100000 mais a checagem de dono:
-- conta com owner_tenant_id (conta própria de uma casa) nunca é padrão da
-- plataforma.
CREATE OR REPLACE FUNCTION public.platform_channel_defaults_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.provider_accounts a
    WHERE a.id = NEW.provider_account_id
      AND NEW.channel = ANY (a.channels)
      AND a.status = 'active'
  ) THEN
    RAISE EXCEPTION 'A conta % não atende o canal % ou não está ativa', NEW.provider_account_id, NEW.channel;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.provider_accounts a
    WHERE a.id = NEW.provider_account_id AND a.owner_tenant_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A conta % é uma conta própria de casa e não pode ser padrão da plataforma', NEW.provider_account_id;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

ALTER TABLE public.tenant_own_provider_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_own_provider_grants FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_own_provider_grants TO service_role;

RESET lock_timeout;

NOTIFY pgrst, 'reload schema';
