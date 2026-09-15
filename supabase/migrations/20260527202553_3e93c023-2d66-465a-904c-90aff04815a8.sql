
-- 1. Idempotência por transactionId
ALTER TABLE public.deposits ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE public.withdrawals ADD COLUMN IF NOT EXISTS external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS deposits_external_id_uidx ON public.deposits(external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_external_id_uidx ON public.withdrawals(external_id) WHERE external_id IS NOT NULL;

-- 2. Increment atômico para evitar race condition
CREATE OR REPLACE FUNCTION public.increment_player_totals(
  p_player_id uuid,
  p_delta_deposito numeric,
  p_delta_saque numeric,
  p_set_ultimo_deposito boolean,
  p_set_ultimo_saque boolean,
  p_set_ftd boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.players
  SET
    total_depositado = total_depositado + COALESCE(p_delta_deposito, 0),
    total_sacado = total_sacado + COALESCE(p_delta_saque, 0),
    ultimo_deposito = CASE WHEN p_set_ultimo_deposito THEN now() ELSE ultimo_deposito END,
    ultimo_saque = CASE WHEN p_set_ultimo_saque THEN now() ELSE ultimo_saque END,
    ftd_em = CASE WHEN p_set_ftd AND ftd_em IS NULL THEN now() ELSE ftd_em END,
    updated_at = now()
  WHERE id = p_player_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_player_totals(uuid, numeric, numeric, boolean, boolean, boolean) TO service_role, authenticated;

-- 3. Reconciliação one-shot: backfill external_id em deposits/withdrawals existentes
--    e reprocessar webhooks de hoje sem deposit correspondente.
DO $$
DECLARE
  rec record;
  v_player_id uuid;
  v_amount numeric;
  v_tx text;
  v_metodo text;
  v_dep_id uuid;
BEGIN
  FOR rec IN
    SELECT wl.id AS log_id, wl.created_at, wl.payload, wl.evento
    FROM public.webhook_logs wl
    WHERE wl.evento IN ('deposito-aprovado','saque-aprovado','saque-concluido')
      AND (wl.created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')
  LOOP
    v_tx := rec.payload->'data'->>'transactionId';
    v_amount := NULLIF(rec.payload->'data'->>'amount','')::numeric;
    v_metodo := rec.payload->'data'->>'paymentMethod';
    IF v_amount IS NULL OR v_tx IS NULL THEN
      CONTINUE;
    END IF;
    v_amount := abs(v_amount);

    SELECT id INTO v_player_id FROM public.players
    WHERE player_external_id = rec.payload->'data'->>'userId'
    LIMIT 1;
    IF v_player_id IS NULL THEN CONTINUE; END IF;

    IF rec.evento = 'deposito-aprovado' THEN
      -- Já existe?
      PERFORM 1 FROM public.deposits WHERE external_id = v_tx;
      IF FOUND THEN CONTINUE; END IF;

      INSERT INTO public.deposits(player_id, valor, status, metodo, external_id, created_at)
      VALUES (v_player_id, v_amount, 'aprovado', v_metodo, v_tx, rec.created_at)
      ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING
      RETURNING id INTO v_dep_id;

      IF v_dep_id IS NOT NULL THEN
        PERFORM public.increment_player_totals(v_player_id, v_amount, 0, true, false, true);
      END IF;
    ELSE
      PERFORM 1 FROM public.withdrawals WHERE external_id = v_tx;
      IF FOUND THEN CONTINUE; END IF;

      INSERT INTO public.withdrawals(player_id, valor, status, metodo, external_id, created_at)
      VALUES (v_player_id, v_amount, 'aprovado', v_metodo, v_tx, rec.created_at)
      ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING
      RETURNING id INTO v_dep_id;

      IF v_dep_id IS NOT NULL THEN
        PERFORM public.increment_player_totals(v_player_id, 0, v_amount, false, true, false);
      END IF;
    END IF;
  END LOOP;
END $$;
