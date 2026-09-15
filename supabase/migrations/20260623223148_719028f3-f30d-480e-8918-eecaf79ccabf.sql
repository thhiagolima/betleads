
DROP INDEX IF EXISTS public.deposits_external_id_uidx;
DROP INDEX IF EXISTS public.withdrawals_external_id_uidx;
CREATE UNIQUE INDEX deposits_tenant_external_id_uidx
  ON public.deposits (tenant_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX withdrawals_tenant_external_id_uidx
  ON public.withdrawals (tenant_id, external_id)
  WHERE external_id IS NOT NULL;
