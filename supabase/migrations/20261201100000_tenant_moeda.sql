-- Moeda de exibição da casa (ISO 4217). As casas internacionais (ex.: Los
-- Hermanos, ARS) recebem depósitos/saques na moeda local, já em unidades
-- maiores; os valores gravados não mudam, só a exibição no CRM. A cobrança da
-- plataforma (carteira, SMS, mensalidade) continua sempre em BRL.
alter table public.tenants
  add column if not exists moeda text not null default 'BRL';

alter table public.tenants
  drop constraint if exists tenants_moeda_check;

alter table public.tenants
  add constraint tenants_moeda_check
  check (moeda in ('BRL', 'ARS', 'CLP', 'COP', 'MXN', 'PEN', 'PYG', 'UYU', 'USD'));

update public.tenants set moeda = 'ARS' where slug = 'loshermanos-bet';
