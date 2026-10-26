-- Área do Expert — Fase 1, Task 3: aposentar o modelo CRM_EXPERT.
--
-- Experts agora vivem dentro da própria casa (Task 1/2); as casas separadas
-- em modelo CRM_EXPERT (um tenant inteiro por expert, alimentado pelo
-- espelhamento do webhook) deixam de fazer sentido e são arquivadas aqui.
--
-- Para cada casa não-demo com crm_model = 'CRM_EXPERT':
--   * a casa de origem é metadata->>'source_tenant_id', com fallback para
--     '00000000-0000-0000-0000-000000000001' (mesmo default que o
--     espelhamento do webhook usava em webhook-process.server.ts);
--   * cada id em metadata->'expert_affiliate_ids' que ainda não existe em
--     expert_affiliates da casa de origem é ligado a um expert de nome
--     regexp_replace(nome, '^CRM Expert - ', ''), reaproveitando o expert
--     desse nome se já existir na casa de origem (senão cria um, do tipo
--     'restrito' por padrão);
--   * a casa CRM_EXPERT é arquivada: status = 'canceled',
--     metadata || {archived_at, archived_reason: 'crm_expert_retired'};
--   * os fluxos dela (sms_flows, email_flows, call_flows) ficam inativos.
--
-- Casas demo (is_demo) são deixadas intocadas — são snapshots congelados.
--
-- Os guards existentes no webhook, no orquestrador e no cashback que ainda
-- olham crm_model = 'CRM_EXPERT' continuam como estão: como a casa arquivada
-- fica com status 'canceled', eles mantêm a casa arquivada inerte sem
-- precisar de nenhuma mudança adicional.

begin;

do $retire$
declare
  house record;
  source_tenant uuid;
  expert_name text;
  v_expert_id uuid;
  raw_id text;
  aff_id text;
begin
  for house in
    select id, nome, metadata
    from public.tenants
    where crm_model = 'CRM_EXPERT'
      and is_demo = false
  loop
    source_tenant := coalesce(
      (house.metadata ->> 'source_tenant_id')::uuid,
      '00000000-0000-0000-0000-000000000001'::uuid
    );
    expert_name := btrim(regexp_replace(house.nome, '^CRM Expert - ', ''));

    if expert_name <> '' and jsonb_typeof(house.metadata -> 'expert_affiliate_ids') = 'array' then
      for raw_id in
        select jsonb_array_elements_text(house.metadata -> 'expert_affiliate_ids')
      loop
        aff_id := btrim(raw_id);
        if aff_id = '' then
          continue;
        end if;

        -- Já ligado a algum expert desta casa de origem: nada a fazer (é o
        -- caso de produção hoje, onde os dois affiliate ids já pertencem ao
        -- expert Queiroz).
        if exists (
          select 1 from public.expert_affiliates
          where tenant_id = source_tenant and affiliate_id = aff_id
        ) then
          continue;
        end if;

        select id into v_expert_id
        from public.experts
        where tenant_id = source_tenant
          and lower(btrim(nome)) = lower(expert_name);

        if v_expert_id is null then
          insert into public.experts (tenant_id, nome)
          values (source_tenant, expert_name)
          returning id into v_expert_id;
        end if;

        insert into public.expert_affiliates (tenant_id, expert_id, affiliate_id)
        values (source_tenant, v_expert_id, aff_id)
        on conflict (tenant_id, affiliate_id) do nothing;
      end loop;
    end if;

    update public.tenants
    set status = 'canceled',
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'archived_at', now(),
          'archived_reason', 'crm_expert_retired'
        )
    where id = house.id;

    update public.sms_flows set is_active = false where tenant_id = house.id;
    update public.email_flows set active = false where tenant_id = house.id;
    update public.call_flows set is_active = false where tenant_id = house.id;
  end loop;
end
$retire$;

commit;
