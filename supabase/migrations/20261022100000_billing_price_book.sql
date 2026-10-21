-- Tabela de preços (PG1, Task 2): planos, preço unitário de SMS/voz/e-mail,
-- exceções por casa e a isenção da casa "interno".
--
-- `billing_plans` é o catálogo comercial (crm_unico, interno); por ora só
-- `interno` é usado para algo automático (a isenção). `billing_price_book`
-- guarda o preço vigente por item com histórico (valid_from); uma casa pode
-- ter uma exceção em `tenant_price_overrides` que vence o preço padrão
-- enquanto estiver vigente. `admin_clear_tenant_price` "limpa" a exceção
-- inserindo uma vigência nova com unit_price nulo (billing_effective_price
-- ignora overrides nulos e volta ao preço padrão).
--
-- Igual a `sms_effective_pricing`/`hide_sms_provider_cost`: o custo do
-- fornecedor (`provider_unit_cost`) nunca chega a um usuário de casa.

create table public.billing_plans (
  code text primary key,
  name text not null,
  price_cents bigint not null default 0,
  interval text not null default 'monthly',
  included jsonb not null default '{}'::jsonb,
  exempt_all boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.billing_plans (code, name, price_cents, interval, exempt_all) values
  ('crm_unico', 'CRM Único', 400000, 'monthly', false),
  ('interno', 'Interno', 0, 'monthly', true);

create table public.billing_price_book (
  item text not null check (item in ('sms', 'voice_30s', 'email')),
  valid_from timestamptz not null,
  unit_price numeric(12,4) not null,
  provider_unit_cost numeric(12,4),
  free_monthly_units integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (item, valid_from)
);

-- Preços iniciais (Global Constraints), vigentes a partir de 2026-10-01.
insert into public.billing_price_book (item, valid_from, unit_price, provider_unit_cost, free_monthly_units) values
  ('sms', '2026-10-01', 0.08, 0.059, 0),
  ('voice_30s', '2026-10-01', 0.09, null, 0),
  ('email', '2026-10-01', 0.002, null, 100000);

create table public.tenant_price_overrides (
  tenant_id uuid not null,
  item text not null check (item in ('sms', 'voice_30s', 'email')),
  valid_from timestamptz not null,
  unit_price numeric(12,4),
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (tenant_id, item, valid_from)
);

-- Dados: casas que entram isentas nesta fase (plano = 'interno').
-- Roda antes do trigger de proteção do plano (criado mais abaixo) para não
-- precisar de um bypass: nesta migration ainda não há guarda para contornar.
do $$
declare
  v_slug_count int;
  v_other record;
begin
  select count(*) into v_slug_count
  from public.tenants
  where slug in ('pixpgf', 'pixreals', 'forrandobet');

  if v_slug_count <> 3 then
    raise exception
      'billing_price_book: esperava exatamente 3 casas por slug (pixpgf, pixreals, forrandobet), encontrou %',
      v_slug_count;
  end if;

  for v_other in
    select slug
    from public.tenants
    where plano = 'interno'
      and slug not in ('pixpgf', 'pixreals', 'forrandobet')
      and coalesce(is_demo, false) = false
  loop
    raise notice 'billing_price_book: casa % já estava com plano = interno antes desta migration', v_other.slug;
  end loop;

  update public.tenants
  set plano = 'interno'
  where slug in ('pixpgf', 'pixreals', 'forrandobet')
     or coalesce(is_demo, false) = true;
end $$;

-- Verdadeiro quando o plano da casa aponta para um billing_plans com exempt_all.
-- Casas com um plano que não existe em billing_plans (a maioria, hoje) não
-- são isentas: o coalesce cobre o join vazio.
create or replace function public.billing_tenant_exempt(_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    (
      select bp.exempt_all
      from public.tenants t
      join public.billing_plans bp on bp.code = t.plano
      where t.id = _tenant
    ),
    false
  )
$$;

-- Preço efetivo de um item para uma casa num instante: a exceção da casa
-- (se houver uma vigente e não nula) vence o preço padrão. `source` diz qual
-- dos dois foi usado. O custo do fornecedor é removido do retorno para
-- qualquer usuário autenticado que não seja superadmin (mesma regra de
-- sms_effective_pricing).
create or replace function public.billing_effective_price(
  _tenant uuid,
  _item text,
  _at timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_default public.billing_price_book%rowtype;
  v_override public.tenant_price_overrides%rowtype;
  v_unit_price numeric(12,4);
  v_source text;
  v_result jsonb;
begin
  if _tenant is null
     or (
       not public.has_tenant_access(_tenant)
       and not public.is_super_admin()
       and auth.role() <> 'service_role'
     ) then
    raise exception 'forbidden';
  end if;

  select * into v_default
  from public.billing_price_book
  where item = _item and valid_from <= _at
  order by valid_from desc
  limit 1;

  select * into v_override
  from public.tenant_price_overrides
  where tenant_id = _tenant and item = _item and valid_from <= _at
  order by valid_from desc
  limit 1;

  if v_override.unit_price is not null then
    v_unit_price := v_override.unit_price;
    v_source := 'override';
  else
    v_unit_price := v_default.unit_price;
    v_source := 'default';
  end if;

  -- unit_price/provider_unit_cost vão como texto: jsonb_build_object com um
  -- numeric produz um número json, e o round-trip por JSON (driver do
  -- PostgREST/pg) perde a escala (0.0800 -> 0.08). Como texto, a escala de
  -- numeric(12,4) chega intacta a quem lê.
  v_result := jsonb_build_object(
    'item', _item,
    'unit_price', v_unit_price::text,
    'provider_unit_cost', v_default.provider_unit_cost::text,
    'free_monthly_units', coalesce(v_default.free_monthly_units, 0),
    'exempt', public.billing_tenant_exempt(_tenant),
    'source', v_source
  );

  if auth.uid() is not null and not public.is_super_admin() then
    v_result := v_result - 'provider_unit_cost';
  end if;

  return v_result;
end;
$$;

-- Preço usado nos relatórios internos (ex.: custo do SMS por tenant): nunca
-- redige o custo do fornecedor (não devolve jsonb, só o número), então não
-- reaproveita billing_effective_price. Casa isenta reporta o custo do
-- fornecedor (o que a casa não paga, mas a Betleads paga); sem custo
-- cadastrado, cai no preço padrão.
create or replace function public.billing_report_unit_price(
  _tenant uuid,
  _item text,
  _at timestamptz default now()
)
returns numeric
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_default public.billing_price_book%rowtype;
  v_override public.tenant_price_overrides%rowtype;
  v_unit_price numeric(12,4);
begin
  if _tenant is null
     or (
       not public.has_tenant_access(_tenant)
       and not public.is_super_admin()
       and auth.role() <> 'service_role'
     ) then
    raise exception 'forbidden';
  end if;

  select * into v_default
  from public.billing_price_book
  where item = _item and valid_from <= _at
  order by valid_from desc
  limit 1;

  select * into v_override
  from public.tenant_price_overrides
  where tenant_id = _tenant and item = _item and valid_from <= _at
  order by valid_from desc
  limit 1;

  v_unit_price := coalesce(v_override.unit_price, v_default.unit_price);

  if public.billing_tenant_exempt(_tenant) then
    return coalesce(v_default.provider_unit_cost, v_unit_price);
  end if;

  return v_unit_price;
end;
$$;

-- Nova vigência de preço padrão a partir de agora. Só superadmin.
create or replace function public.admin_set_price(
  _item text,
  _unit_price numeric,
  _provider_unit_cost numeric default null,
  _free_monthly_units integer default 0
)
returns public.billing_price_book
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.billing_price_book;
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;

  insert into public.billing_price_book (item, valid_from, unit_price, provider_unit_cost, free_monthly_units, created_by)
  values (_item, now(), _unit_price, _provider_unit_cost, _free_monthly_units, auth.uid())
  returning * into v_row;

  return v_row;
end;
$$;

-- Nova vigência de exceção de preço para uma casa a partir de agora. Só superadmin.
create or replace function public.admin_set_tenant_price(
  _tenant uuid,
  _item text,
  _unit_price numeric
)
returns public.tenant_price_overrides
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.tenant_price_overrides;
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;

  insert into public.tenant_price_overrides (tenant_id, item, valid_from, unit_price, created_by)
  values (_tenant, _item, now(), _unit_price, auth.uid())
  returning * into v_row;

  return v_row;
end;
$$;

-- "Limpa" a exceção de uma casa: nova vigência com unit_price nulo, que faz
-- billing_effective_price voltar a usar o preço padrão. Só superadmin.
create or replace function public.admin_clear_tenant_price(
  _tenant uuid,
  _item text
)
returns public.tenant_price_overrides
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row public.tenant_price_overrides;
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;

  insert into public.tenant_price_overrides (tenant_id, item, valid_from, unit_price, created_by)
  values (_tenant, _item, now(), null, auth.uid())
  returning * into v_row;

  return v_row;
end;
$$;

-- Protege tenants.plano: só superadmin ou service_role podem mudá-lo. Criado
-- depois do bloco de dados acima, que precisa escrever plano = 'interno'
-- sem passar por esta guarda.
create or replace function public.guard_tenants_plan()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.plano is distinct from old.plano
     and not public.is_super_admin()
     and auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  return new;
end;
$$;

drop trigger if exists tenants_plan_guard on public.tenants;
create trigger tenants_plan_guard
  before update of plano on public.tenants
  for each row
  when (old.plano is distinct from new.plano)
  execute function public.guard_tenants_plan();

-- Acesso: preços e planos não têm tenant_id, então SELECT é liberado para
-- authenticated (a leitura fina de preço por casa passa pelas funções
-- acima); escrita só pelas RPCs admin_*. tenant_price_overrides carrega
-- preço combinado por casa e só o superadmin lê a tabela direto.
alter table public.billing_plans enable row level security;
create policy billing_plans_authenticated_select on public.billing_plans
  for select to authenticated
  using (true);

alter table public.billing_price_book enable row level security;
create policy billing_price_book_authenticated_select on public.billing_price_book
  for select to authenticated
  using (true);

alter table public.tenant_price_overrides enable row level security;
create policy tenant_price_overrides_superadmin_select on public.tenant_price_overrides
  for select to authenticated
  using (public.is_super_admin());

grant select on public.billing_plans to authenticated, service_role;

-- O custo do fornecedor nunca vai para authenticated, igual ao ledger de SMS.
revoke select on public.billing_price_book from anon, authenticated;
grant select (item, valid_from, unit_price, free_monthly_units, created_by, created_at)
  on public.billing_price_book to authenticated;
grant select on public.billing_price_book to service_role;

grant select on public.tenant_price_overrides to authenticated, service_role;

grant execute on function public.billing_tenant_exempt(uuid) to authenticated, service_role;
grant execute on function public.billing_effective_price(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.billing_report_unit_price(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.admin_set_price(text, numeric, numeric, integer) to authenticated, service_role;
grant execute on function public.admin_set_tenant_price(uuid, text, numeric) to authenticated, service_role;
grant execute on function public.admin_clear_tenant_price(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
