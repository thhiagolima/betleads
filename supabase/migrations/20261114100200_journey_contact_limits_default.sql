-- Limite global de contatos por jogador (jornadas) passa a nascer com a casa.
--
-- Sem linha em journey_contact_limits a reserva não aplica teto nenhum: casas
-- criadas depois de 16/10 (betgreen, bravabet365, laelebet) dispararam até 19
-- SMS por jogador em 36h. O padrão é o mesmo já usado nas casas antigas:
-- 2 mensagens em 24h e 14 em 7 dias. A casa continua podendo alterar pela tela.

create or replace function public.journey_contact_limits_on_tenant_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.journey_contact_limits (tenant_id, max_messages_24h, max_messages_7d)
  values (new.id, 2, 14)
  on conflict (tenant_id) do nothing;
  return null;
end;
$$;

revoke all on function public.journey_contact_limits_on_tenant_insert() from public, anon, authenticated;

drop trigger if exists tenants_journey_contact_limits on public.tenants;
create trigger tenants_journey_contact_limits
  after insert on public.tenants
  for each row
  execute function public.journey_contact_limits_on_tenant_insert();

-- Carga inicial (idempotente): casas que ainda não têm limite recebem o padrão.
-- Não altera limites já configurados.
insert into public.journey_contact_limits (tenant_id, max_messages_24h, max_messages_7d)
select t.id, 2, 14
from public.tenants t
where not exists (select 1 from public.journey_contact_limits l where l.tenant_id = t.id)
on conflict (tenant_id) do nothing;
