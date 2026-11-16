-- PaganoPay como terceiro gateway Pix (docs/ESCOPO_GATEWAY_PAGANOPAY_2026-11-16.md).
--
-- 1) Os CHECK de provider passam a aceitar 'paganopay' em payment_charges,
--    payment_webhook_events, payment_gateway_accounts e
--    payment_gateway_settings. Os dois últimos foram criados com CHECK inline
--    (nome automático); o bloco DO abaixo apaga qualquer CHECK dessas colunas
--    antes de recriar com nome fixo.
-- 2) Taxa inicial da PaganoPay = a vigente da SpacePay (o PSP por trás dela
--    já era a PaganoPay), senão a da Upper. O superadmin ajusta depois com a
--    taxa real (GET /payments/fees, mostrada no "Testar conexão").
--
-- Aditiva e idempotente: nenhum dado existente muda. Aplicar ANTES do deploy
-- do código (ele grava provider = 'paganopay').
--
-- ROLLBACK (só sem linhas 'paganopay'):
--   recriar os quatro CHECK com ('upper','spacepay') e
--   DELETE FROM payment_fee_settings WHERE provider = 'paganopay';

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
    FROM pg_constraint c
    WHERE c.contype = 'c'
      AND c.conrelid IN (
        'public.payment_charges'::regclass,
        'public.payment_webhook_events'::regclass,
        'public.payment_gateway_accounts'::regclass,
        'public.payment_gateway_settings'::regclass
      )
      AND pg_get_constraintdef(c.oid) LIKE '%spacepay%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

ALTER TABLE public.payment_charges
  ADD CONSTRAINT payment_charges_provider_check
  CHECK (provider IN ('upper', 'spacepay', 'paganopay'));

ALTER TABLE public.payment_webhook_events
  ADD CONSTRAINT payment_webhook_events_provider_check
  CHECK (provider IN ('upper', 'spacepay', 'paganopay'));

ALTER TABLE public.payment_gateway_accounts
  ADD CONSTRAINT payment_gateway_accounts_provider_check
  CHECK (provider IN ('upper', 'spacepay', 'paganopay'));

ALTER TABLE public.payment_gateway_settings
  ADD CONSTRAINT payment_gateway_settings_active_provider_check
  CHECK (active_provider IN ('upper', 'spacepay', 'paganopay'));

COMMENT ON TABLE public.payment_gateway_accounts IS
  'Credenciais cifradas dos gateways Pix (upper, spacepay, paganopay). Linha presente vale inteira; sem linha, variáveis de ambiente. Nunca expor a anon/authenticated.';

INSERT INTO public.payment_fee_settings (provider, fee_percent, fee_fixed_cents, valid_from, updated_by)
SELECT 'paganopay', f.fee_percent, f.fee_fixed_cents, now(), null
FROM (
  SELECT fee_percent, fee_fixed_cents
  FROM public.payment_fee_settings
  WHERE provider IN ('spacepay', 'upper') AND valid_from <= now()
  ORDER BY (provider = 'spacepay') DESC, valid_from DESC
  LIMIT 1
) f
WHERE NOT EXISTS (
  SELECT 1 FROM public.payment_fee_settings WHERE provider = 'paganopay'
);
