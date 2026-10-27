-- A house may use the same hostname both as its link shortener and as its
-- e-mail sending domain (e.g. bravabet365.online). Uniqueness moves from
-- lower(hostname) to (lower(hostname), kind), while a hostname still belongs
-- to at most ONE house across all kinds — enforced by a trigger, since a
-- plain unique index cannot say "same hostname only within one tenant".
--
-- Safe on prod: existing data already satisfies the old, stricter
-- lower(hostname) index, so it satisfies both new rules.

-- New index first, so there is never a moment without hostname uniqueness.
create unique index if not exists tenant_domains_hostname_kind_lower_idx
  on public.tenant_domains (lower(hostname), kind);

drop index if exists public.tenant_domains_hostname_lower_idx;

-- Rejects a row whose hostname (any case, any kind, removed or not) already
-- belongs to another tenant. The transaction-scoped advisory lock on the
-- hostname serializes concurrent inserts of the same hostname, so two houses
-- cannot both pass the check at the same time (one as shortener, the other
-- as e-mail) under READ COMMITTED. SECURITY DEFINER so the check sees every
-- row regardless of the caller's RLS.
create or replace function public.tenant_domains_hostname_single_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('tenant_domains:' || lower(new.hostname), 0));
  if exists (
    select 1
    from public.tenant_domains d
    where lower(d.hostname) = lower(new.hostname)
      and d.tenant_id <> new.tenant_id
      and d.id <> new.id
  ) then
    raise exception 'Esse domínio já está em uso por outra conta'
      using errcode = '23505',
            detail = format('hostname %s already belongs to another tenant', lower(new.hostname));
  end if;
  return new;
end;
$$;

revoke all on function public.tenant_domains_hostname_single_tenant() from public, anon, authenticated;

drop trigger if exists tenant_domains_hostname_single_tenant on public.tenant_domains;
create trigger tenant_domains_hostname_single_tenant
  before insert or update of hostname, tenant_id on public.tenant_domains
  for each row execute function public.tenant_domains_hostname_single_tenant();

notify pgrst, 'reload schema';
