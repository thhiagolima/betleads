# Operação: migration 20261019100000_aquisicao_ltv_al1 em produção

**Data:** 19/10/2026
**Autorização:** pedido explícito do responsável pelo produto ("execute a migration").
**Escopo:** [ESCOPO_AQUISICAO_LTV_2026-10-18.md](../ESCOPO_AQUISICAO_LTV_2026-10-18.md), itens AL1-01, AL1-03, AL1-05, AL1-07, AL1-08 e AL1-09.
**Testes:** `src/lib/aquisicao-ltv.db.test.ts` (23 casos, PGlite).

## O que muda

| Objeto | Mudança |
|---|---|
| `marketing_ad_metrics_daily` | colunas `currency` e `link_clicks`; a chave única passa a `NULLS NOT DISTINCT` (`marketing_ad_metrics_daily_unique_day`); `authenticated` perde INSERT, UPDATE e DELETE |
| `meta_ads` | tabela nova (catálogo de anúncios); leitura por casa, escrita só por `service_role` |
| `player_attributions` | novos status `matched_campaign_id`, `ambiguous`, `crm` e `pending`; o default passa a `pending`; backfill da linha de cadastro para jogadores que só tinham UTM em `players` (`raw_payload.source = players_backfill_20261019`) |
| `reconcile_meta_attributions(uuid, boolean)` | reescrita: ID do anúncio > nome único > ID da campanha > nome único da campanha; CRM separado. Só `service_role` executa |
| `reconcile_pending_meta_attributions()` | nova; reconcilia apenas os pendentes |
| `replace_meta_ad_metrics(...)` | nova; substitui a janela importada de uma conta |
| `marketing_overview(uuid, date, date)` | nova; todos os números da tela |

O código já publicado continua funcionando: o upsert antigo acha a chave única, `reconcile_meta_attributions(p_tenant_id)` continua chamável e os status antigos seguem válidos.

## Ensaio (BEGIN … ROLLBACK)

- Migration em cerca de 0,7 s.
- `marketing_overview` da Sorte Alta, 30 dias (18.788 cadastros), em cerca de 0,4 s.
- Atribuições depois do ensaio: Sorte Alta 18.320 `orphan_campaign`, 192 `missing_utm`, 3 `crm`; nenhum `pending`. Nenhuma casa tem gasto sincronizado no modelo atual, então ninguém casa com anúncio ainda.
- Todas as 241 linhas de métrica legadas ficaram com moeda.

## Rollback

Em uma transação, nesta ordem:

```sql
begin;
drop function if exists public.marketing_overview(uuid, date, date);
drop function if exists public.replace_meta_ad_metrics(uuid, text, date, date, jsonb);
drop function if exists public.reconcile_pending_meta_attributions();
drop function if exists public.reconcile_meta_attributions(uuid, boolean);
-- Recriar a função anterior: executar o corpo de
-- supabase/migrations/20261002200000_optimize_meta_attribution_reconciliation.sql (só o create function).

delete from public.player_attributions where raw_payload->>'source' = 'players_backfill_20261019';
update public.player_attributions set match_status = 'orphan_campaign'
  where match_status in ('ambiguous', 'crm', 'pending', 'matched_campaign_id');
alter table public.player_attributions alter column match_status set default 'unmatched';
alter table public.player_attributions drop constraint player_attributions_match_status_check;
alter table public.player_attributions add constraint player_attributions_match_status_check check (
  match_status in ('matched_ad_id','matched_ad_name','matched_campaign_name','orphan_campaign','missing_utm','unmatched'));
drop index if exists public.player_attributions_pending_idx;

drop table if exists public.meta_ads;

alter table public.marketing_ad_metrics_daily drop constraint marketing_ad_metrics_daily_unique_day;
alter table public.marketing_ad_metrics_daily
  add constraint marketing_ad_metrics_daily_tenant_id_provider_metric_date_a_key
  unique (tenant_id, provider, metric_date, ad_account_id, ad_id);
alter table public.marketing_ad_metrics_daily drop column link_clicks, drop column currency;
grant insert, update, delete on public.marketing_ad_metrics_daily to authenticated;

delete from supabase_migrations.schema_migrations where version = '20261019100000';
commit;
notify pgrst, 'reload schema';
```

## Execução

Aplicada em 19/10/2026 pelo pooler (`aws-0-ca-central-1`), em uma transação, com o registro em `supabase_migrations.schema_migrations` dentro dela. Migration em 1,4 s.

Verificação depois do COMMIT, em sessão `read_only`:

- `20261019100000 aquisicao_ltv_al1` registrada.
- As 4 funções existem. Só `marketing_overview` é executável por `authenticated`; as outras três, só por `service_role`.
- `authenticated` ficou com SELECT, REFERENCES e TRIGGER em `marketing_ad_metrics_daily`, sem escrita.
- Chave única `marketing_ad_metrics_daily_unique_day` ativa.
- 8.243 linhas de atribuição criadas pelo backfill; `meta_ads` vazio, à espera do primeiro sync.
- `marketing_overview` da Sorte Alta, 30 dias, em 0,6 s.
