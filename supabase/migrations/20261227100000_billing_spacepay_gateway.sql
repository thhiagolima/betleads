-- Segundo gateway Pix: SpacePay, ao lado da Upper (escopo em
-- docs/spacepay-gateway-scope.md §4). O gateway em uso é global, escolhido
-- por variável de ambiente, e o pagador fixo também vem do ambiente: por
-- isso nada muda em tenant_billing.
--
-- 1) payment_charges.provider passa a aceitar só 'upper' ou 'spacepay'
--    (antes era texto livre com default 'upper'; toda linha existente é
--    'upper'). Índice (provider, status) para a conciliação por cron
--    filtrar as cobranças abertas de cada gateway.
--
-- 2) payment_webhook_events ganha `provider` (default 'upper', mesma
--    checagem): o event_id continua a chave primária, e as linhas antigas
--    ficam como 'upper', que é de onde vieram.
--
-- 3) payment_fee_settings não é uma linha por provedor: é um histórico por
--    (provider, valid_from) e billing_credit_paid_charge usa a linha mais
--    recente com valid_from <= now(). Aqui só copia a taxa vigente da Upper
--    para a SpacePay, se houver uma e se a SpacePay ainda não tiver nenhuma
--    (não há chave única para ON CONFLICT, então é um NOT EXISTS). Se a
--    taxa real da SpacePay for outra, o superadmin cadastra uma linha nova
--    com valid_from mais recente.
--
-- billing_credit_paid_charge não muda: a única coisa por provedor nela é a
-- busca da taxa (where provider = v_charge.provider).
--
-- Aditiva e idempotente. Não aplicada em nenhum ambiente ainda.

alter table public.payment_charges
  drop constraint if exists payment_charges_provider_check;
alter table public.payment_charges
  add constraint payment_charges_provider_check
  check (provider in ('upper', 'spacepay'));

create index if not exists idx_payment_charges_provider_status
  on public.payment_charges (provider, status);

alter table public.payment_webhook_events
  add column if not exists provider text not null default 'upper';

alter table public.payment_webhook_events
  drop constraint if exists payment_webhook_events_provider_check;
alter table public.payment_webhook_events
  add constraint payment_webhook_events_provider_check
  check (provider in ('upper', 'spacepay'));

insert into public.payment_fee_settings (provider, fee_percent, fee_fixed_cents, valid_from, updated_by)
select 'spacepay', f.fee_percent, f.fee_fixed_cents, now(), null
from (
  select fee_percent, fee_fixed_cents
  from public.payment_fee_settings
  where provider = 'upper' and valid_from <= now()
  order by valid_from desc
  limit 1
) f
where not exists (
  select 1 from public.payment_fee_settings where provider = 'spacepay'
);
