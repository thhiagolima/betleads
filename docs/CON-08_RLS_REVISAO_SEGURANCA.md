# CON-08 — RLS avaliado uma vez por query: revisão de segurança

Data: 15/10/2026. Origem: `ESCOPO_ESCALA_TRACKING_ATRIBUICAO_2026-10-14.md` (Fase B, CON-08) e `BASELINE_BANCO_2026-10-14.md` (seções 4.1, 5, 6.1, 7.1).

> **Nada foi aplicado em produção.** O inventário foi lido com uma sessão `default_transaction_read_only = on` e `statement_timeout = 15s`. A migration `supabase/migrations/20261015090000_consolidate_tenant_rls.sql` está pronta, mas não foi executada.

## 1. Resumo

| Item | Resultado |
|---|---|
| Tabelas cujas políticas chamam `has_tenant_access` / `current_tenant_id` / `is_super_admin` / `is_tenant_owner` / `auth.uid()` / `user_roles` | **120** (não só as 5 do baseline) |
| Políticas reescritas | 316 antes → **130** depois (89 políticas RESTRICTIVE removidas, porque a nova expressão já as contém) |
| Funções chamadas por linha depois da migration | **0**. Toda chamada fica em `(select …)` e vira InitPlan |
| Matriz de acesso antes × depois | **0 diferenças** em 91.938 operações (120 tabelas × 9 personas × 5 headers × SELECT/INSERT/UPDATE/DELETE); reaplicar: 0; rollback × antes: 0 |
| Header `x-active-tenant` forjado | **Não** dá acesso a outro tenant. `current_tenant_id()` valida o vínculo (seção 3) |
| Achados de segurança | 1 crítico (créditos SMS graváveis por qualquer membro), 2 altos, 2 médios e 2 baixos (seção 4). Nenhum foi corrigido em silêncio: a migration só preserva o comportamento atual. As correções estão propostas na seção 4 |

## 2. Inventário antes (produção, 14/10/2026)

O snapshot completo está em `supabase/tests/rls/prod_snapshot_2026-10-14.json`. Ele contém `pg_policies`, flags de RLS e FORCE, grants de `anon`/`authenticated` e o `pg_get_functiondef` das funções auxiliares. As políticas originais das 120 tabelas estão em `supabase/tests/rls/before_policies.sql`.

- 326 políticas no schema `public`, distribuídas em 123 tabelas. Em 3 tabelas a RLS está ligada sem política nenhuma (`conversion_report_audit_events`, `sms_flow_daily_usage`, `sms_suppressions`), o que bloqueia o acesso de clientes. Essas tabelas não mudam.
- O padrão dominante, em 55 tabelas (`players`, `deposits`, `sms_send_logs`, `webhook_logs`, `activation_runs`…), combina três políticas:
  - `<t>_tenant_isolation`: PERMISSIVE ALL, `tenant_id = current_tenant_id() OR is_super_admin()`;
  - `tenant_access_base`: PERMISSIVE ALL, `has_tenant_access(tenant_id)`;
  - `tenant_isolation_guard`: **RESTRICTIVE** ALL, `tenant_id = current_tenant_id() OR is_super_admin()`. O baseline descreve as três como permissivas. **Na verdade, `tenant_isolation_guard` é restritiva**, e isso muda a semântica, como a seção 3 mostra.
- Nenhuma dessas chamadas está em `(select …)`. Por isso, `current_tenant_id()` (plpgsql com bloco `EXCEPTION`, o que abre uma subtransação a cada chamada), `is_super_admin()` e `has_tenant_access()` rodam até 4 vezes por linha. Cada execução faz um seq scan em `user_roles`, o que explica os 143,5 milhões de seq scans.
- Grants: `anon` e `authenticated` têm `SELECT, INSERT, UPDATE, DELETE` em 116 tabelas. A RLS é a única barreira.

Formatos de política encontrados (assinatura exata) e regra resultante:

| Formato atual | Tabelas | Regra efetiva hoje = regra depois |
|---|---|---|
| trio `isolation` + `tenant_access_base` + `guard` (R) | 55 | `sa OR tenant_id = cur` |
| config "só super admin" + `tenant_access_base` + `guard` (R) | 7 (`antiban_settings`, `call_providers`, `email_senders`, `email_smtp_configs`, `send_window_settings`, `tenant_sms_pricing`, `whatsapp_proxies`) | `sa OR tenant_id = cur` (ver F3) |
| só `isolation` | 7 (`journeys`, `journey_*`, `dashboard_settings`) | `sa OR tenant_id = cur` |
| catálogo de IA (`ai_intents`, `ai_synonyms`, `ai_training_examples`) | 3 | `sa OR tenant_id = cur` |
| `has_tenant_access` em P e em R | 5 (`tracked_links`, `link_dispatches`, `link_click_snapshots`, `link_tracking_sync_runs`, `shortio_settings`) | `sa OR tenant_id ∈ meus tenants` |
| só `has_tenant_access` (ALL) | 2 (`channel_consents`, `voice_contact_policies`) | `sa OR tenant_id ∈ meus tenants` |
| só `has_tenant_access` (SELECT) | 7 | SELECT `sa OR tenant_id ∈ meus tenants` |
| `tenant_id = current_tenant_id()` sem super admin | 5 (`*_template_versions` SELECT; `sms_templates`, `journey_voice_assets` ALL) | `tenant_id = cur` |
| EXISTS em `user_roles` com `role='admin'` | `conversion_attribution_issues`, `conversion_experiment_assignments`, escrita de `conversion_experiments` | **só super admin** (ver F5) |
| duplicadas, com papel `{public}`, `service_only` e `block_client_*` | 12 | `sa OR tenant_id = cur` (as políticas que não usam as funções ficam intactas) |
| especiais | `campaign_drafts`, `platform_pricing`, `sms_credit_packages`, `sms_credit_settings`, `tenants`, `user_roles`, `admin_audit_logs`, `dispatcher_runs`, `dispatch_rate_state` | reescritas comando a comando, com os mesmos nomes |

Notação: `sa` = `is_super_admin()`; `cur` = `current_tenant_id()`; "meus tenants" = tenants onde o usuário é `admin`, `gestor` ou `member`.

## 3. Semântica das funções

Definições lidas de `pg_get_functiondef`. Todas são `STABLE SECURITY DEFINER SET search_path = public`, pertencem a `postgres` (que tem BYPASSRLS) e só `authenticated` e `service_role` podem executá-las.

- `is_super_admin(_user_id default auth.uid())`: existe linha em `user_roles` com `role='super_admin'` e `tenant_id IS NULL`.
- `has_tenant_access(_tenant, _user default auth.uid())`: `is_super_admin(_user)` **ou** o usuário tem `admin`, `gestor` ou `member` naquele tenant.
- `current_tenant_id()` (plpgsql):
  1. sem `auth.uid()`, retorna NULL (vale para `anon`);
  2. lê `current_setting('request.headers')::jsonb ->> 'x-active-tenant'`, que vem do header HTTP repassado pelo PostgREST;
  3. **valida** o valor com `has_tenant_access(v_tenant, v_uid)`. Se o usuário não pertence ao tenant, o header é ignorado. Se o valor não é um uuid, a exceção é engolida e o header também é ignorado;
  4. sem header válido, devolve o menor `tenant_id` entre os vínculos `admin`, `gestor` e `member` do usuário (`ORDER BY tenant_id LIMIT 1`). Super admin sem vínculo recebe NULL.

  **Conclusão:** o tenant vem do header, e nunca de um claim do JWT, mas o vínculo é validado. **Não é um achado de segurança:** um header forjado (`x-active-tenant` = tenant B para um usuário do A) cai no tenant padrão do usuário. A matriz confirma isso nas colunas `hdr_B` e `hdr_garbage`. A migration preserva esse comportamento chamando a mesma função, agora como InitPlan.

- Efeito combinado do trio. Permissivas `(cur OR sa) OR (sa OR t ∈ meus)` **AND** restritiva `(t = cur OR sa)` = **`sa OR t = cur`**, porque `cur` é sempre um tenant do usuário. Ou seja:
  - **Usuário comum, inclusive com mais de um tenant:** vê e escreve **apenas o tenant ativo**, nunca todos os seus tenants. O `tenant_access_base` não acrescenta nada.
  - **Super admin:** vê todos os tenants, em qualquer header.
  - **Usuário sem vínculo e `anon`:** nada.
  - **Linhas com `tenant_id NULL`:** só o super admin acessa.
- Inconsistência preservada: nas 14 tabelas `has_tenant_access` (link tracking, consentimentos e outras), um usuário com vários tenants vê **todos** os seus tenants, e não só o ativo.

## 4. Achados de segurança (preservados na migration, correção proposta)

A migration CON-08 é **somente de performance**: a matriz antes × depois é idêntica. As correções abaixo mudam quem acessa o quê. Por isso ficam para uma migration própria, depois que o time decidir o comportamento desejado e verificar o uso no app.

**F1 — CRÍTICO: qualquer membro do tenant ativo grava em tabelas de cobrança de SMS.** `tenant_sms_credit_balances`, `sms_credit_ledger`, `sms_credit_orders` e `tenant_sms_pricing` têm `tenant_access_base` (PERMISSIVE ALL). A política foi criada para "membros leem", mas cobre também INSERT, UPDATE e DELETE. Somada aos grants de DML de `authenticated`, ela permite que um `member` faça `PATCH /rest/v1/tenant_sms_credit_balances?tenant_id=eq.<seu>` com `balance_credits=999999`, ou altere o próprio preço por SMS. A matriz mostra `member_A` com UPDATE, INSERT e DELETE `ok` nessas tabelas. Hoje existem 4 tenants com saldo.
*Correção proposta:* nessas 4 tabelas, SELECT `sa OR tenant_id = cur` e escrita só `sa` (o service_role ignora a RLS), mais `REVOKE INSERT, UPDATE, DELETE … FROM authenticated`.

**F2 — ALTO: escalonamento dentro do tenant via `user_roles`.** A regra efetiva é `sa OR (tenant_id = cur AND role NOT IN ('admin','super_admin'))` em **todos** os comandos. Com isso, um `member` pode se promover a `gestor`, criar vínculos `gestor`/`member` no próprio tenant para qualquer `user_id` e apagar vínculos de colegas que não são admin (colunas `PROMOTE_GESTOR`, `INSERT` e `DELETE` da matriz). Efeito colateral da mesma regra: tenant admins **não conseguem ler a própria linha `admin`**.
*Correção proposta:* `authenticated` passa a ter SELECT das próprias linhas e escrita apenas por funções de servidor (service_role) que validem `is_tenant_owner`.

**F3 — ALTO: segredos e configurações "só super admin" ou "só service_role" ficam visíveis e graváveis por membros.** O `tenant_access_base` anula a intenção das políticas `*_super_admin_*`, `*_service_only` e `unsub_tokens_no_client_access`. Tabelas afetadas: `meta_connections` (`access_token`/`encrypted_access_token`; **1 linha exposta hoje**), `meta_oauth_states` (nonce), `email_unsubscribe_tokens` (1 linha), `call_providers` (`api_key`/`api_secret`), `email_smtp_configs` e `whatsapp_proxies` (`password_encrypted`), `email_senders`, `antiban_settings`, `send_window_settings` e o catálogo de IA. Nas quatro tabelas de credenciais ainda não há linha com `tenant_id` preenchido, então hoje a exposição real se limita a `meta_connections` e `email_unsubscribe_tokens`. `webhook_configs.secret` é configuração do próprio tenant e fica exposta por desenho.
*Correção proposta:* remover o acesso de tenant (`sa` só para config; nenhuma política de cliente para `meta_*` e para tokens) e/ou trocar a leitura por uma view sem as colunas secretas.

**F4 — MÉDIO: `anon` tem grants de DML em 116 tabelas, e algumas políticas valem para `{public}`.** Hoje as funções devolvem falso ou dão `permission denied` para `anon`, então não há vazamento. Mesmo assim, é a única barreira. Depois da migration, todas as políticas reescritas valem só `TO authenticated`, e `anon` fica sem política nessas tabelas (negado). *Proposta:* `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon`, com exceções explícitas.

**F5 — MÉDIO (funcional): as políticas "admin do tenant" nunca valem para admins.** O `EXISTS (SELECT 1 FROM user_roles ur WHERE … role='admin')` roda como o chamador, então passa pela RLS de `user_roles`, e a restritiva `user_roles_block_tenant_admin_escalation` esconde as linhas `admin` de quem não é super admin. O efeito real em `conversion_attribution_issues`, `conversion_experiment_assignments` (SELECT) e na escrita de `conversion_experiments` é **só super admin**. A matriz detectou isso: a primeira versão da migration usava um helper `SECURITY DEFINER` e liberava os admins, gerando 60 diferenças. **A migration preserva o comportamento atual (só super admin).** Se o acesso de admin for desejado, a correção é um helper definer `admin_tenant_ids()`.

**F6 — BAIXO: higiene de funções.** As funções `SECURITY DEFINER` usam `search_path = public` sem `pg_temp` no fim. **A migration corrige isso** nas 4 funções das políticas (`ALTER FUNCTION … SET search_path = public, pg_temp`), sem mudar o comportamento. Outras funções (`is_tenant_admin`, `admin_*`) podem ser executadas por `PUBLIC`/`anon`. Elas verificam `is_super_admin()` e falham, mas o ideal é revogar.

**F7 — BAIXO: fora do escopo.** As políticas de `storage.objects` (buckets `call-audios`, `email-images`, `whatsapp-media`) e de `realtime.messages` também chamam `current_tenant_id()` e `is_super_admin()` por linha. Fica como follow-up, porque são schemas gerenciados pelo Supabase.

## 5. Política depois

Helper novo: `public.accessible_tenant_ids() RETURNS uuid[]`. É `STABLE SECURITY DEFINER SET search_path = public, pg_temp`, com `REVOKE ALL FROM PUBLIC, anon` e `GRANT EXECUTE TO authenticated, service_role`. Ele aplica a mesma regra de vínculo do `has_tenant_access`. `current_tenant_id()` e `is_super_admin()` continuam como estão (só ganham `pg_temp` no fim do search_path).

Formas usadas (sempre `TO authenticated`):

```sql
-- 89 tabelas (padrão)
USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
-- 14 tabelas has_tenant_access
USING ((select public.is_super_admin()) OR tenant_id = any ((select public.accessible_tenant_ids())::uuid[]))
-- user_roles: 1 permissiva + as 2 restritivas anti-escalonamento, com (select …)
```

O cast `::uuid[]` é necessário: sem ele, `= any ((select …))` é interpretado como subquery e falha com `uuid = uuid[]`. Uma política por comando, ou `FOR ALL` quando USING = WITH CHECK. As políticas que não usam as funções (`anyone authed can read pricing`, `*_service_only`, `cashback_payments_block_client_*`, `unsub_tokens_no_client_access`) ficam intactas. A lista completa por regra está no cabeçalho da migration.

A migration é gerada por `supabase/tests/rls/con08-generate.mjs` a partir do snapshot. Cada tabela é classificada pela **assinatura exata** das suas políticas, e um formato desconhecido aborta a geração. É transacional (`BEGIN … COMMIT`, `SET LOCAL lock_timeout = '5s'`) e idempotente (`DROP POLICY IF EXISTS` + `CREATE OR REPLACE`). A matriz reaplica a migration duas vezes e o resultado não muda.

Índice `user_roles (user_id)`: **não foi criado**. `user_roles_user_tenant_role_uniq (user_id, …)` e `user_roles_one_membership_per_tenant (user_id, tenant_id)` já começam por `user_id`. Os seq scans vinham do volume de chamadas por linha numa tabela de 11 linhas, e esse volume desaparece com o InitPlan.

## 6. Matriz de acesso antes × depois

Script: `node supabase/tests/rls/con08-matrix.mjs` (PGlite, Postgres em memória). Ele recria as 120 tabelas com:

- as funções de produção copiadas literalmente;
- stubs de `auth.uid()`/`auth.role()` idênticos aos do Supabase (leem `request.jwt.claims`);
- os grants e as flags RLS/FORCE de produção;
- os papéis `anon`, `authenticated` e `service_role`.

Personas: `super_admin`, `admin_A`, `gestor_A`, `member_A`, `gestor_B`, `admin_B`, `multi_mA_aC` (member de A e admin de C), `no_role` e `anon`. Headers: nenhum, `A`, `B` (forjado para os usuários de A), `C` e `not-a-uuid`. Operações por tabela:

- SELECT, listando as linhas visíveis entre A, A_sent, B, C e NULL;
- INSERT em A, B, C, NULL e em A com `created_by` de outro usuário;
- UPDATE e DELETE de cada linha;
- mover uma linha de A para B e de B para A;
- em `user_roles`: INSERT por papel × tenant, promoção a gestor ou admin, troca de tenant e DELETE de cada vínculo.

Cada operação roda numa transação desfeita com `SET LOCAL ROLE`, como no PostgREST.

**Resultado (2026-10-15T03:05:28.962Z):** 5.040 células, 91.938 operações. Diferenças antes × depois: **0**. Diferenças brutas, sem normalizar as classes de negação: **0**. Reaplicação × depois: **0**. Rollback × antes: **0**. O script sai com código ≠ 0 se houver qualquer diferença.

As classes de negação são equivalentes entre si: "0 linhas afetadas", "∅" e `ERR:42501` (violação de RLS ou falta de privilégio). Os resultados brutos também coincidiram, então nem o tipo de erro mudou.

Verificação de controle: a primeira versão da migration trocava o EXISTS de admin por um helper `SECURITY DEFINER`. A matriz acusou 60 diferenças, todas de admins de tenant ganhando escrita em `conversion_experiments`. Esse caso deu origem ao achado F5 e foi corrigido para preservar o comportamento atual. Ou seja, o teste detecta mudanças reais de acesso.

Amostra (antes; a linha "depois" é igual em todas). Colunas a partir de `insert_ok` = operações permitidas:

```
table	persona	header	fase	select_visíveis	insert_ok	update_ok	delete_ok	move_ok	promote_gestor	promote_admin
players	super_admin	none	before	A,A_sent,B,C,NULL	A,B,C,NULL,A_by_other	A,A_sent,B,C,NULL	A,A_sent,B,C,NULL	B:A,A:B	-	-
players	super_admin	none	after(=)	A,A_sent,B,C,NULL	A,B,C,NULL,A_by_other	A,A_sent,B,C,NULL	A,A_sent,B,C,NULL	B:A,A:B	-	-
players	super_admin	hdr_B	before	A,A_sent,B,C,NULL	A,B,C,NULL,A_by_other	A,A_sent,B,C,NULL	A,A_sent,B,C,NULL	B:A,A:B	-	-
players	super_admin	hdr_B	after(=)	A,A_sent,B,C,NULL	A,B,C,NULL,A_by_other	A,A_sent,B,C,NULL	A,A_sent,B,C,NULL	B:A,A:B	-	-
players	super_admin	hdr_C	before	A,A_sent,B,C,NULL	A,B,C,NULL,A_by_other	A,A_sent,B,C,NULL	A,A_sent,B,C,NULL	B:A,A:B	-	-
players	super_admin	hdr_C	after(=)	A,A_sent,B,C,NULL	A,B,C,NULL,A_by_other	A,A_sent,B,C,NULL	A,A_sent,B,C,NULL	B:A,A:B	-	-
players	member_A	none	before	A,A_sent	A,A_by_other	A,A_sent	A,A_sent	-	-	-
players	member_A	none	after(=)	A,A_sent	A,A_by_other	A,A_sent	A,A_sent	-	-	-
players	member_A	hdr_B	before	A,A_sent	A,A_by_other	A,A_sent	A,A_sent	-	-	-
players	member_A	hdr_B	after(=)	A,A_sent	A,A_by_other	A,A_sent	A,A_sent	-	-	-
players	member_A	hdr_C	before	A,A_sent	A,A_by_other	A,A_sent	A,A_sent	-	-	-
players	member_A	hdr_C	after(=)	A,A_sent	A,A_by_other	A,A_sent	A,A_sent	-	-	-
players	gestor_B	none	before	B	B	B	B	-	-	-
players	gestor_B	none	after(=)	B	B	B	B	-	-	-
players	gestor_B	hdr_B	before	B	B	B	B	-	-	-
players	gestor_B	hdr_B	after(=)	B	B	B	B	-	-	-
players	gestor_B	hdr_C	before	B	B	B	B	-	-	-
players	gestor_B	hdr_C	after(=)	B	B	B	B	-	-	-
players	multi_mA_aC	none	before	A,A_sent	A,A_by_other	A,A_sent	A,A_sent	-	-	-
players	multi_mA_aC	none	after(=)	A,A_sent	A,A_by_other	A,A_sent	A,A_sent	-	-	-
players	multi_mA_aC	hdr_B	before	A,A_sent	A,A_by_other	A,A_sent	A,A_sent	-	-	-
players	multi_mA_aC	hdr_B	after(=)	A,A_sent	A,A_by_other	A,A_sent	A,A_sent	-	-	-
players	multi_mA_aC	hdr_C	before	C	C	C	C	-	-	-
players	multi_mA_aC	hdr_C	after(=)	C	C	C	C	-	-	-
players	no_role	none	before	∅	-	-	-	-	-	-
players	no_role	none	after(=)	∅	-	-	-	-	-	-
players	no_role	hdr_B	before	∅	-	-	-	-	-	-
players	no_role	hdr_B	after(=)	∅	-	-	-	-	-	-
players	no_role	hdr_C	before	∅	-	-	-	-	-	-
players	no_role	hdr_C	after(=)	∅	-	-	-	-	-	-
players	anon	none	before	∅	-	-	-	-	-	-
players	anon	none	after(=)	∅	-	-	-	-	-	-
tenant_sms_credit_balances	member_A	none	before	A,A_sent	A,A_by_other	A,A_sent	A,A_sent	-	-	-
tenant_sms_credit_balances	member_A	none	after(=)	A,A_sent	A,A_by_other	A,A_sent	A,A_sent	-	-	-
user_roles	admin_A	none	before	gestor_A:gestor,member_A:member,multi_mA_aC:member	member@A,gestor@A	gestor_A:gestor,member_A:member,multi_mA_aC:member	gestor_A:gestor,member_A:member,multi_mA_aC:member	-	gestor_A:gestor,member_A:member,multi_mA_aC:member	-
user_roles	admin_A	none	after(=)	gestor_A:gestor,member_A:member,multi_mA_aC:member	member@A,gestor@A	gestor_A:gestor,member_A:member,multi_mA_aC:member	gestor_A:gestor,member_A:member,multi_mA_aC:member	-	gestor_A:gestor,member_A:member,multi_mA_aC:member	-
user_roles	member_A	none	before	gestor_A:gestor,member_A:member,multi_mA_aC:member	member@A,gestor@A	gestor_A:gestor,member_A:member,multi_mA_aC:member	gestor_A:gestor,member_A:member,multi_mA_aC:member	-	gestor_A:gestor,member_A:member,multi_mA_aC:member	-
user_roles	member_A	none	after(=)	gestor_A:gestor,member_A:member,multi_mA_aC:member	member@A,gestor@A	gestor_A:gestor,member_A:member,multi_mA_aC:member	gestor_A:gestor,member_A:member,multi_mA_aC:member	-	gestor_A:gestor,member_A:member,multi_mA_aC:member	-
conversion_experiments	admin_A	none	before	A,A_sent	-	-	-	-	-	-
conversion_experiments	admin_A	none	after(=)	A,A_sent	-	-	-	-	-	-
conversion_experiments	multi_mA_aC	none	before	A,A_sent,C	-	-	-	-	-	-
conversion_experiments	multi_mA_aC	none	after(=)	A,A_sent,C	-	-	-	-	-	-
```

O que a amostra mostra:

- `member_A` com header B forjado continua vendo só A.
- `multi_mA_aC` vê A sem header e C com header C.
- `super_admin` vê tudo, inclusive `NULL`.
- `member_A` grava em `tenant_sms_credit_balances` (F1) e promove vínculos a gestor (F2).
- `admin_A` não grava em `conversion_experiments` (F5).

Saídas: `supabase/tests/rls/con08-access-matrix.tsv` (uma linha por tabela × persona × header, antes e depois) e `supabase/tests/rls/con08-matrix-result.json` (resumo e lista de diferenças).

## 7. Evidência de EXPLAIN

`supabase/tests/rls/con08-explain.txt`: PGlite, `players` com 20.000 linhas no tenant A e 10.000 no B, persona `member_A` e `super_admin`, header A.

| Consulta | Persona | Antes | Depois |
|---|---|---|---|
| `count(*)` só RLS | member_A | 2626.524 ms (Seq Scan; `Filter` chama `current_tenant_id()`/`has_tenant_access()`/`is_super_admin()` por linha; 110.255 buffers) | **32.081 ms** (`InitPlan 1`/`InitPlan 2` uma vez; `Filter: ((InitPlan 1).col1 OR (tenant_id = (InitPlan 2).col1))`; 393 buffers) |
| `count(*)` só RLS | super_admin | 2801.300 ms | **26.473 ms** (`InitPlan 2` nem executa) |
| `count(*)` + `tenant_id = A` (código) | member_A | 1891.878 ms (Index Only Scan, mas o filtro por linha continua) | **20.019 ms** (Index Only Scan `players_tenant_id_idx` + InitPlans) |
| `count(*)` + `tenant_id = A` (código) | super_admin | 1999.122 ms | **19.391 ms** |

Os tempos absolutos são do PGlite (WASM), mais lento que o servidor. O que vale é a forma do plano e a razão: cerca de 80× a 130× menos tempo, e de 110 mil para menos de 400 buffers. As contagens são idênticas antes e depois (20.001 e 30.001).

Em produção, depois de aplicar, repetir como `authenticated` numa transação desfeita:
```sql
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"<uid>","role":"authenticated"}', true),
       set_config('request.headers', '{"x-active-tenant":"<tenant>"}', true);
SET LOCAL ROLE authenticated;
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM public.players;
ROLLBACK;
```
O critério de aceite é: `InitPlan` com `current_tenant_id`/`is_super_admin` uma única vez, nenhum `SubPlan` por linha e < 100 ms.

## 8. Código (filtro explícito de tenant)

O padrão do projeto foi mantido: o tenant vem do RPC `current_tenant_id()`, o mesmo que `tenant-access.server.ts` e `players-list.functions.ts` já usam. Não foi criado nenhum mecanismo novo de autenticação.

- `src/lib/history.functions.ts` ganhou `resolveTenantReadFilter(sb, userId)`, que chama `is_super_admin` e `current_tenant_id` em paralelo, e `withTenantFilter(query, tenantId)`.
  - **Usuário comum:** recebe `.eq("tenant_id", cur)`, exatamente o que a RLS já impõe, agora visível para o planner.
  - **Super admin, ou falha do RPC:** nenhum filtro. O resultado continua idêntico ao atual, porque hoje a RLS mostra todos os tenants ao super admin.
  - Pontos alterados:
    - histórico dos 4 canais;
    - `call_flow_executions`;
    - `players` por telefone;
    - `deposits` de conversões;
    - `fetchStatusRows` (#2/#4 do baseline);
    - `countConversions`;
    - resumo por fluxo;
    - timeline;
    - WhatsApp do histórico do player.
- `src/lib/send-window.functions.ts`: as 5 leituras de `getSendWindowStatus`, incluindo `sms_send_logs` e `email_send_logs` ordenados por `created_at`.
- `src/lib/players-list.functions.ts`: as consultas a `players` já tinham `.eq("tenant_id", tenantId)`. Faltava `deposits` em `attachDepositCounts`, que agora recebe o tenant. No caminho `players_by_behavior_filters` (RPC `security invoker` sem filtro de tenant, que para super admin pode cruzar tenants) o filtro **não** é aplicado, para não mudar o resultado. A consistência foi checada em produção: 0 `deposits` e 0 `sms_send_logs` com tenant diferente do player.

## 9. Rollout e rollback

1. **Pré-checagem de drift:** rodar de novo o inventário somente leitura, atualizar `prod_snapshot_*.json` e executar `node supabase/tests/rls/con08-generate.mjs`. Se algum formato de política tiver mudado, o gerador aborta. Depois, rodar `node supabase/tests/rls/con08-matrix.mjs`, que deve terminar com exit 0.
2. **Ordem:** o deploy do código (seção 8) pode ir antes ou depois, porque é independente e sem efeito de acesso. Aplicar a migration fora do pico (`supabase db push` feito por um humano). Ela segura um `ACCESS EXCLUSIVE` breve em 120 tabelas dentro de uma transação; com `lock_timeout = 5s`, se não conseguir o lock, falha inteira e não aplica nada pela metade.
3. **Pós-checagem imediata:**
   - `select count(*) from pg_policies where schemaname='public'`: 326 − 316 + 130 = **140**;
   - EXPLAIN da seção 7;
   - smoke test do CRM com um usuário de tenant (players, histórico, SMS) e com um super admin.
4. **Monitoramento por 24 h:**
   - `pg_stat_statements` de `authenticated`;
   - `seq_scan` de `user_roles`, que deve ficar estável;
   - timeouts de 8 s e CPU p95.
5. **Rollback:** executar `supabase/tests/rls/rollback_20261015090000.sql` (apêndice A). Ele recria exatamente as políticas de 14/10 e o `search_path` original. A matriz confirma o rollback com 0 diferenças contra o "antes". O helper `accessible_tenant_ids()` pode ficar no banco: não é usado e não oferece risco.

## 10. Impacto esperado

- `count(*)` de players via `authenticated`: de ~4 s para a ordem dos 10 ms, igual ao valor sem RLS no baseline (8,6 ms). O planner passa a avaliar a política como um filtro constante, e o `.eq("tenant_id")` do código permite index scan em `(tenant_id, …)`.
- Fim do custo por linha de `current_tenant_id()` (subtransação por linha) e dos ~143 milhões de seq scans em `user_roles`.
- `authenticated` respondia por 44% do tempo do banco. A expectativa é que caia para uma fração disso e reduza os timeouts de 8 s e a taxa de rollback (11,4%). A CPU p95 deve ser reavaliada depois.
- Risco de acesso: nenhum, porque a matriz é idêntica. Os riscos abertos são os achados F1–F5, **que continuam em produção até a migration de correção**.

## Apêndice A — SQL de rollback

Arquivo: `supabase/tests/rls/rollback_20261015090000.sql` (gerado).

```sql
-- ROLLBACK of 20261015090000_consolidate_tenant_rls.sql. Generated by con08-generate.mjs.
-- Restores the exact production policies captured on 2026-10-14 (slow, per-row) and the
-- original search_path of the helpers. The new helper functions are left in place (unused, harmless).
SET lock_timeout = '5s';
BEGIN;
DROP POLICY IF EXISTS activation_runs_tenant_rls ON public.activation_runs;
DROP POLICY IF EXISTS activation_runs_tenant_isolation ON public.activation_runs;
DROP POLICY IF EXISTS tenant_access_base ON public.activation_runs;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.activation_runs;
CREATE POLICY activation_runs_tenant_isolation ON public.activation_runs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.activation_runs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.activation_runs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS admin_audit_logs_tenant_rls ON public.admin_audit_logs;
DROP POLICY IF EXISTS admin_audit_logs_super_admin ON public.admin_audit_logs;
CREATE POLICY admin_audit_logs_super_admin ON public.admin_audit_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS ai_feedback_tenant_rls ON public.ai_feedback;
DROP POLICY IF EXISTS ai_feedback_tenant_isolation ON public.ai_feedback;
DROP POLICY IF EXISTS tenant_access_base ON public.ai_feedback;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.ai_feedback;
CREATE POLICY ai_feedback_tenant_isolation ON public.ai_feedback
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.ai_feedback
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.ai_feedback
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS ai_intents_tenant_rls ON public.ai_intents;
DROP POLICY IF EXISTS ai_intents_super_admin_write ON public.ai_intents;
DROP POLICY IF EXISTS ai_intents_tenant_read ON public.ai_intents;
DROP POLICY IF EXISTS tenant_access_base ON public.ai_intents;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.ai_intents;
CREATE POLICY ai_intents_super_admin_write ON public.ai_intents
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY ai_intents_tenant_read ON public.ai_intents
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_super_admin() OR (tenant_id = current_tenant_id())));
CREATE POLICY tenant_access_base ON public.ai_intents
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.ai_intents
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS ai_logs_tenant_rls ON public.ai_logs;
DROP POLICY IF EXISTS ai_logs_tenant_isolation ON public.ai_logs;
DROP POLICY IF EXISTS tenant_access_base ON public.ai_logs;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.ai_logs;
CREATE POLICY ai_logs_tenant_isolation ON public.ai_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.ai_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.ai_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS ai_synonyms_tenant_rls ON public.ai_synonyms;
DROP POLICY IF EXISTS ai_synonyms_super_admin_write ON public.ai_synonyms;
DROP POLICY IF EXISTS ai_synonyms_tenant_read ON public.ai_synonyms;
DROP POLICY IF EXISTS tenant_access_base ON public.ai_synonyms;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.ai_synonyms;
CREATE POLICY ai_synonyms_super_admin_write ON public.ai_synonyms
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY ai_synonyms_tenant_read ON public.ai_synonyms
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_super_admin() OR (tenant_id = current_tenant_id())));
CREATE POLICY tenant_access_base ON public.ai_synonyms
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.ai_synonyms
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS ai_training_examples_tenant_rls ON public.ai_training_examples;
DROP POLICY IF EXISTS ai_training_examples_super_admin_write ON public.ai_training_examples;
DROP POLICY IF EXISTS ai_training_examples_tenant_read ON public.ai_training_examples;
DROP POLICY IF EXISTS tenant_access_base ON public.ai_training_examples;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.ai_training_examples;
CREATE POLICY ai_training_examples_super_admin_write ON public.ai_training_examples
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY ai_training_examples_tenant_read ON public.ai_training_examples
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_super_admin() OR (tenant_id = current_tenant_id())));
CREATE POLICY tenant_access_base ON public.ai_training_examples
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.ai_training_examples
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS antiban_settings_tenant_rls ON public.antiban_settings;
DROP POLICY IF EXISTS antiban_settings_super_admin_read ON public.antiban_settings;
DROP POLICY IF EXISTS antiban_settings_super_admin_write ON public.antiban_settings;
DROP POLICY IF EXISTS tenant_access_base ON public.antiban_settings;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.antiban_settings;
CREATE POLICY antiban_settings_super_admin_read ON public.antiban_settings
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY antiban_settings_super_admin_write ON public.antiban_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY tenant_access_base ON public.antiban_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.antiban_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS automation_settings_tenant_rls ON public.automation_settings;
DROP POLICY IF EXISTS automation_settings_tenant_isolation ON public.automation_settings;
DROP POLICY IF EXISTS tenant_access_base ON public.automation_settings;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.automation_settings;
CREATE POLICY automation_settings_tenant_isolation ON public.automation_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.automation_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.automation_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS call_audio_generations_tenant_rls ON public.call_audio_generations;
DROP POLICY IF EXISTS call_audio_generations_tenant_isolation ON public.call_audio_generations;
DROP POLICY IF EXISTS tenant_access_base ON public.call_audio_generations;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.call_audio_generations;
CREATE POLICY call_audio_generations_tenant_isolation ON public.call_audio_generations
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_audio_generations
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_audio_generations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS call_flow_block_sms_tenant_rls ON public.call_flow_block_sms;
DROP POLICY IF EXISTS call_flow_block_sms_tenant_isolation ON public.call_flow_block_sms;
DROP POLICY IF EXISTS tenant_access_base ON public.call_flow_block_sms;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.call_flow_block_sms;
CREATE POLICY call_flow_block_sms_tenant_isolation ON public.call_flow_block_sms
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flow_block_sms
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flow_block_sms
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS call_flow_blocks_tenant_rls ON public.call_flow_blocks;
DROP POLICY IF EXISTS call_flow_blocks_tenant_isolation ON public.call_flow_blocks;
DROP POLICY IF EXISTS tenant_access_base ON public.call_flow_blocks;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.call_flow_blocks;
CREATE POLICY call_flow_blocks_tenant_isolation ON public.call_flow_blocks
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flow_blocks
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flow_blocks
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS call_flow_executions_tenant_rls ON public.call_flow_executions;
DROP POLICY IF EXISTS call_flow_executions_tenant_isolation ON public.call_flow_executions;
DROP POLICY IF EXISTS tenant_access_base ON public.call_flow_executions;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.call_flow_executions;
CREATE POLICY call_flow_executions_tenant_isolation ON public.call_flow_executions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flow_executions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flow_executions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS call_flow_history_tenant_rls ON public.call_flow_history;
DROP POLICY IF EXISTS call_flow_history_tenant_isolation ON public.call_flow_history;
DROP POLICY IF EXISTS tenant_access_base ON public.call_flow_history;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.call_flow_history;
CREATE POLICY call_flow_history_tenant_isolation ON public.call_flow_history
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flow_history
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flow_history
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS call_flow_post_action_tenant_rls ON public.call_flow_post_action;
DROP POLICY IF EXISTS call_flow_post_action_tenant_isolation ON public.call_flow_post_action;
DROP POLICY IF EXISTS tenant_access_base ON public.call_flow_post_action;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.call_flow_post_action;
CREATE POLICY call_flow_post_action_tenant_isolation ON public.call_flow_post_action
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flow_post_action
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flow_post_action
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS call_flow_progress_tenant_rls ON public.call_flow_progress;
DROP POLICY IF EXISTS call_flow_progress_tenant_isolation ON public.call_flow_progress;
DROP POLICY IF EXISTS tenant_access_base ON public.call_flow_progress;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.call_flow_progress;
CREATE POLICY call_flow_progress_tenant_isolation ON public.call_flow_progress
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flow_progress
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flow_progress
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS call_flow_scripts_tenant_rls ON public.call_flow_scripts;
DROP POLICY IF EXISTS call_flow_scripts_tenant_isolation ON public.call_flow_scripts;
DROP POLICY IF EXISTS tenant_access_base ON public.call_flow_scripts;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.call_flow_scripts;
CREATE POLICY call_flow_scripts_tenant_isolation ON public.call_flow_scripts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flow_scripts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flow_scripts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS call_flows_tenant_rls ON public.call_flows;
DROP POLICY IF EXISTS call_flows_tenant_isolation ON public.call_flows;
DROP POLICY IF EXISTS tenant_access_base ON public.call_flows;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.call_flows;
CREATE POLICY call_flows_tenant_isolation ON public.call_flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_flows
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS call_history_tenant_rls ON public.call_history;
DROP POLICY IF EXISTS call_history_tenant_isolation ON public.call_history;
DROP POLICY IF EXISTS tenant_access_base ON public.call_history;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.call_history;
CREATE POLICY call_history_tenant_isolation ON public.call_history
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_history
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_history
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS call_providers_tenant_rls ON public.call_providers;
DROP POLICY IF EXISTS call_providers_super_admin_read ON public.call_providers;
DROP POLICY IF EXISTS call_providers_super_admin_write ON public.call_providers;
DROP POLICY IF EXISTS tenant_access_base ON public.call_providers;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.call_providers;
CREATE POLICY call_providers_super_admin_read ON public.call_providers
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY call_providers_super_admin_write ON public.call_providers
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY tenant_access_base ON public.call_providers
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_providers
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS call_queue_tenant_rls ON public.call_queue;
DROP POLICY IF EXISTS call_queue_tenant_isolation ON public.call_queue;
DROP POLICY IF EXISTS tenant_access_base ON public.call_queue;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.call_queue;
CREATE POLICY call_queue_tenant_isolation ON public.call_queue
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_queue
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_queue
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS call_script_versions_tenant_rls ON public.call_script_versions;
DROP POLICY IF EXISTS call_script_versions_tenant_select ON public.call_script_versions;
CREATE POLICY call_script_versions_tenant_select ON public.call_script_versions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS call_scripts_tenant_rls ON public.call_scripts;
DROP POLICY IF EXISTS call_scripts_tenant_isolation ON public.call_scripts;
DROP POLICY IF EXISTS tenant_access_base ON public.call_scripts;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.call_scripts;
CREATE POLICY call_scripts_tenant_isolation ON public.call_scripts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.call_scripts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.call_scripts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS campaign_drafts_tenant_select ON public.campaign_drafts;
DROP POLICY IF EXISTS campaign_drafts_tenant_insert ON public.campaign_drafts;
DROP POLICY IF EXISTS campaign_drafts_tenant_update ON public.campaign_drafts;
DROP POLICY IF EXISTS campaign_drafts_tenant_delete ON public.campaign_drafts;
CREATE POLICY campaign_drafts_tenant_delete ON public.campaign_drafts
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((has_tenant_access(tenant_id) AND (status = 'draft'::text)));
CREATE POLICY campaign_drafts_tenant_insert ON public.campaign_drafts
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((has_tenant_access(tenant_id) AND (created_by = auth.uid())));
CREATE POLICY campaign_drafts_tenant_select ON public.campaign_drafts
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY campaign_drafts_tenant_update ON public.campaign_drafts
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((has_tenant_access(tenant_id) AND (status = 'draft'::text)))
  WITH CHECK (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS cashback_payments_tenant_rls ON public.cashback_payments;
DROP POLICY IF EXISTS "tenant members read cashback_payments" ON public.cashback_payments;
DROP POLICY IF EXISTS tenant_access_base ON public.cashback_payments;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.cashback_payments;
CREATE POLICY "tenant members read cashback_payments" ON public.cashback_payments
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.cashback_payments
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.cashback_payments
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS channel_consent_audit_tenant_rls ON public.channel_consent_audit;
DROP POLICY IF EXISTS channel_consent_audit_tenant_read ON public.channel_consent_audit;
CREATE POLICY channel_consent_audit_tenant_read ON public.channel_consent_audit
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS channel_consents_tenant_rls ON public.channel_consents;
DROP POLICY IF EXISTS channel_consents_tenant_access ON public.channel_consents;
CREATE POLICY channel_consents_tenant_access ON public.channel_consents
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS click_events_tenant_rls ON public.click_events;
DROP POLICY IF EXISTS click_events_tenant_select ON public.click_events;
CREATE POLICY click_events_tenant_select ON public.click_events
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS conversion_attribution_issues_tenant_rls ON public.conversion_attribution_issues;
DROP POLICY IF EXISTS conversion_attribution_issues_admin_select ON public.conversion_attribution_issues;
CREATE POLICY conversion_attribution_issues_admin_select ON public.conversion_attribution_issues
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.tenant_id = conversion_attribution_issues.tenant_id) AND (ur.role = 'admin'::app_role))))));

DROP POLICY IF EXISTS conversion_attributions_tenant_rls ON public.conversion_attributions;
DROP POLICY IF EXISTS conversion_attributions_tenant_select ON public.conversion_attributions;
CREATE POLICY conversion_attributions_tenant_select ON public.conversion_attributions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS conversion_experiment_assignments_tenant_rls ON public.conversion_experiment_assignments;
DROP POLICY IF EXISTS conversion_experiment_assignments_tenant_select ON public.conversion_experiment_assignments;
CREATE POLICY conversion_experiment_assignments_tenant_select ON public.conversion_experiment_assignments
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.tenant_id = conversion_experiment_assignments.tenant_id) AND (ur.role = 'admin'::app_role))))));

DROP POLICY IF EXISTS conversion_experiments_tenant_select ON public.conversion_experiments;
DROP POLICY IF EXISTS conversion_experiments_admin_insert ON public.conversion_experiments;
DROP POLICY IF EXISTS conversion_experiments_admin_update ON public.conversion_experiments;
DROP POLICY IF EXISTS conversion_experiments_admin_delete ON public.conversion_experiments;
CREATE POLICY conversion_experiments_admin_delete ON public.conversion_experiments
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.tenant_id = conversion_experiments.tenant_id) AND (ur.role = 'admin'::app_role))))));
CREATE POLICY conversion_experiments_admin_insert ON public.conversion_experiments
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.tenant_id = conversion_experiments.tenant_id) AND (ur.role = 'admin'::app_role))))));
CREATE POLICY conversion_experiments_admin_update ON public.conversion_experiments
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((is_super_admin() OR (EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.tenant_id = conversion_experiments.tenant_id) AND (ur.role = 'admin'::app_role))))))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY conversion_experiments_tenant_select ON public.conversion_experiments
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS dashboard_settings_tenant_rls ON public.dashboard_settings;
DROP POLICY IF EXISTS "dashboard settings tenant isolation" ON public.dashboard_settings;
CREATE POLICY "dashboard settings tenant isolation" ON public.dashboard_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS deposits_tenant_rls ON public.deposits;
DROP POLICY IF EXISTS deposits_tenant_isolation ON public.deposits;
DROP POLICY IF EXISTS tenant_access_base ON public.deposits;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.deposits;
CREATE POLICY deposits_tenant_isolation ON public.deposits
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.deposits
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.deposits
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS dispatch_pause_state_tenant_rls ON public.dispatch_pause_state;
DROP POLICY IF EXISTS pause_tenant_isolation ON public.dispatch_pause_state;
DROP POLICY IF EXISTS tenant_access_base ON public.dispatch_pause_state;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.dispatch_pause_state;
CREATE POLICY pause_tenant_isolation ON public.dispatch_pause_state
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.dispatch_pause_state
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.dispatch_pause_state
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS dispatch_rate_state_tenant_rls ON public.dispatch_rate_state;
DROP POLICY IF EXISTS dispatch_rate_state_super_admin ON public.dispatch_rate_state;
CREATE POLICY dispatch_rate_state_super_admin ON public.dispatch_rate_state
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());

DROP POLICY IF EXISTS dispatcher_runs_tenant_rls ON public.dispatcher_runs;
DROP POLICY IF EXISTS dispatcher_runs_super_admin ON public.dispatcher_runs;
CREATE POLICY dispatcher_runs_super_admin ON public.dispatcher_runs
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());

DROP POLICY IF EXISTS email_automations_tenant_rls ON public.email_automations;
DROP POLICY IF EXISTS email_automations_tenant_isolation ON public.email_automations;
DROP POLICY IF EXISTS tenant_access_base ON public.email_automations;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.email_automations;
CREATE POLICY email_automations_tenant_isolation ON public.email_automations
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_automations
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_automations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS email_campaigns_tenant_rls ON public.email_campaigns;
DROP POLICY IF EXISTS email_campaigns_tenant_isolation ON public.email_campaigns;
DROP POLICY IF EXISTS tenant_access_base ON public.email_campaigns;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.email_campaigns;
CREATE POLICY email_campaigns_tenant_isolation ON public.email_campaigns
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_campaigns
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_campaigns
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS email_flow_blocks_tenant_rls ON public.email_flow_blocks;
DROP POLICY IF EXISTS email_flow_blocks_tenant_isolation ON public.email_flow_blocks;
DROP POLICY IF EXISTS tenant_access_base ON public.email_flow_blocks;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.email_flow_blocks;
CREATE POLICY email_flow_blocks_tenant_isolation ON public.email_flow_blocks
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_flow_blocks
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_flow_blocks
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS email_flow_leads_tenant_rls ON public.email_flow_leads;
DROP POLICY IF EXISTS email_flow_leads_tenant_isolation ON public.email_flow_leads;
DROP POLICY IF EXISTS tenant_access_base ON public.email_flow_leads;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.email_flow_leads;
CREATE POLICY email_flow_leads_tenant_isolation ON public.email_flow_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_flow_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_flow_leads
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS email_flow_logs_tenant_rls ON public.email_flow_logs;
DROP POLICY IF EXISTS email_flow_logs_tenant_isolation ON public.email_flow_logs;
DROP POLICY IF EXISTS tenant_access_base ON public.email_flow_logs;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.email_flow_logs;
CREATE POLICY email_flow_logs_tenant_isolation ON public.email_flow_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_flow_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_flow_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS email_flows_tenant_rls ON public.email_flows;
DROP POLICY IF EXISTS email_flows_tenant_isolation ON public.email_flows;
DROP POLICY IF EXISTS tenant_access_base ON public.email_flows;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.email_flows;
CREATE POLICY email_flows_tenant_isolation ON public.email_flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_flows
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS email_send_logs_tenant_rls ON public.email_send_logs;
DROP POLICY IF EXISTS email_send_logs_tenant_isolation ON public.email_send_logs;
DROP POLICY IF EXISTS tenant_access_base ON public.email_send_logs;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.email_send_logs;
CREATE POLICY email_send_logs_tenant_isolation ON public.email_send_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_send_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_send_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS email_senders_tenant_rls ON public.email_senders;
DROP POLICY IF EXISTS email_senders_super_admin_mutate ON public.email_senders;
DROP POLICY IF EXISTS email_senders_super_admin_select ON public.email_senders;
DROP POLICY IF EXISTS tenant_access_base ON public.email_senders;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.email_senders;
CREATE POLICY email_senders_super_admin_mutate ON public.email_senders
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY email_senders_super_admin_select ON public.email_senders
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY tenant_access_base ON public.email_senders
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_senders
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS email_smtp_configs_tenant_rls ON public.email_smtp_configs;
DROP POLICY IF EXISTS email_smtp_configs_super_admin_mutate ON public.email_smtp_configs;
DROP POLICY IF EXISTS email_smtp_configs_super_admin_select ON public.email_smtp_configs;
DROP POLICY IF EXISTS tenant_access_base ON public.email_smtp_configs;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.email_smtp_configs;
CREATE POLICY email_smtp_configs_super_admin_mutate ON public.email_smtp_configs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY email_smtp_configs_super_admin_select ON public.email_smtp_configs
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY tenant_access_base ON public.email_smtp_configs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_smtp_configs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS email_template_versions_tenant_rls ON public.email_template_versions;
DROP POLICY IF EXISTS email_template_versions_tenant_select ON public.email_template_versions;
CREATE POLICY email_template_versions_tenant_select ON public.email_template_versions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS email_templates_tenant_rls ON public.email_templates;
DROP POLICY IF EXISTS email_templates_tenant_isolation ON public.email_templates;
DROP POLICY IF EXISTS tenant_access_base ON public.email_templates;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.email_templates;
CREATE POLICY email_templates_tenant_isolation ON public.email_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.email_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_templates
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS email_unsubscribe_tokens_tenant_rls ON public.email_unsubscribe_tokens;
DROP POLICY IF EXISTS tenant_access_base ON public.email_unsubscribe_tokens;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.email_unsubscribe_tokens;
CREATE POLICY tenant_access_base ON public.email_unsubscribe_tokens
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.email_unsubscribe_tokens
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS events_tenant_rls ON public.events;
DROP POLICY IF EXISTS events_tenant_isolation ON public.events;
DROP POLICY IF EXISTS tenant_access_base ON public.events;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.events;
CREATE POLICY events_tenant_isolation ON public.events
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.events
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS experts_tenant_rls ON public.experts;
DROP POLICY IF EXISTS experts_tenant_isolation ON public.experts;
DROP POLICY IF EXISTS tenant_access_base ON public.experts;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.experts;
CREATE POLICY experts_tenant_isolation ON public.experts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.experts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.experts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS flow_blocks_tenant_rls ON public.flow_blocks;
DROP POLICY IF EXISTS flow_blocks_tenant_isolation ON public.flow_blocks;
DROP POLICY IF EXISTS tenant_access_base ON public.flow_blocks;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.flow_blocks;
CREATE POLICY flow_blocks_tenant_isolation ON public.flow_blocks
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.flow_blocks
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.flow_blocks
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS flow_leads_tenant_rls ON public.flow_leads;
DROP POLICY IF EXISTS flow_leads_tenant_isolation ON public.flow_leads;
DROP POLICY IF EXISTS tenant_access_base ON public.flow_leads;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.flow_leads;
CREATE POLICY flow_leads_tenant_isolation ON public.flow_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.flow_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.flow_leads
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS flow_logs_tenant_rls ON public.flow_logs;
DROP POLICY IF EXISTS flow_logs_tenant_isolation ON public.flow_logs;
DROP POLICY IF EXISTS tenant_access_base ON public.flow_logs;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.flow_logs;
CREATE POLICY flow_logs_tenant_isolation ON public.flow_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.flow_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.flow_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS flow_templates_tenant_rls ON public.flow_templates;
DROP POLICY IF EXISTS flow_templates_tenant_access ON public.flow_templates;
DROP POLICY IF EXISTS tenant_access_base ON public.flow_templates;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.flow_templates;
CREATE POLICY flow_templates_tenant_access ON public.flow_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.flow_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.flow_templates
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS flows_tenant_rls ON public.flows;
DROP POLICY IF EXISTS flows_tenant_isolation ON public.flows;
DROP POLICY IF EXISTS tenant_access_base ON public.flows;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.flows;
CREATE POLICY flows_tenant_isolation ON public.flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.flows
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS gamification_settings_tenant_rls ON public.gamification_settings;
DROP POLICY IF EXISTS gamification_settings_tenant_isolation ON public.gamification_settings;
DROP POLICY IF EXISTS tenant_access_base ON public.gamification_settings;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.gamification_settings;
CREATE POLICY gamification_settings_tenant_isolation ON public.gamification_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.gamification_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.gamification_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS journey_contact_limits_tenant_rls ON public.journey_contact_limits;
DROP POLICY IF EXISTS journey_contact_limits_tenant_isolation ON public.journey_contact_limits;
CREATE POLICY journey_contact_limits_tenant_isolation ON public.journey_contact_limits
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS journey_enrollments_tenant_rls ON public.journey_enrollments;
DROP POLICY IF EXISTS journey_enrollments_tenant_isolation ON public.journey_enrollments;
CREATE POLICY journey_enrollments_tenant_isolation ON public.journey_enrollments
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS journey_events_tenant_rls ON public.journey_events;
DROP POLICY IF EXISTS journey_events_tenant_isolation ON public.journey_events;
CREATE POLICY journey_events_tenant_isolation ON public.journey_events
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS journey_scan_jobs_tenant_rls ON public.journey_scan_jobs;
DROP POLICY IF EXISTS journey_scan_jobs_tenant_read ON public.journey_scan_jobs;
CREATE POLICY journey_scan_jobs_tenant_read ON public.journey_scan_jobs
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS journey_step_executions_tenant_rls ON public.journey_step_executions;
DROP POLICY IF EXISTS journey_step_executions_tenant_isolation ON public.journey_step_executions;
CREATE POLICY journey_step_executions_tenant_isolation ON public.journey_step_executions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS journey_steps_tenant_rls ON public.journey_steps;
DROP POLICY IF EXISTS journey_steps_tenant_isolation ON public.journey_steps;
CREATE POLICY journey_steps_tenant_isolation ON public.journey_steps
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS journey_voice_assets_tenant_rls ON public.journey_voice_assets;
DROP POLICY IF EXISTS journey_voice_assets_tenant_access ON public.journey_voice_assets;
CREATE POLICY journey_voice_assets_tenant_access ON public.journey_voice_assets
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((tenant_id = current_tenant_id()))
  WITH CHECK ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS journeys_tenant_rls ON public.journeys;
DROP POLICY IF EXISTS journeys_tenant_isolation ON public.journeys;
CREATE POLICY journeys_tenant_isolation ON public.journeys
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS lead_alerts_tenant_rls ON public.lead_alerts;
DROP POLICY IF EXISTS lead_alerts_tenant_isolation ON public.lead_alerts;
DROP POLICY IF EXISTS tenant_access_base ON public.lead_alerts;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.lead_alerts;
CREATE POLICY lead_alerts_tenant_isolation ON public.lead_alerts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.lead_alerts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.lead_alerts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS lead_followups_tenant_rls ON public.lead_followups;
DROP POLICY IF EXISTS lead_followups_tenant_isolation ON public.lead_followups;
DROP POLICY IF EXISTS tenant_access_base ON public.lead_followups;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.lead_followups;
CREATE POLICY lead_followups_tenant_isolation ON public.lead_followups
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.lead_followups
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.lead_followups
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS lead_whatsapp_assignments_tenant_rls ON public.lead_whatsapp_assignments;
DROP POLICY IF EXISTS lead_whatsapp_assignments_tenant_isolation ON public.lead_whatsapp_assignments;
DROP POLICY IF EXISTS tenant_access_base ON public.lead_whatsapp_assignments;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.lead_whatsapp_assignments;
CREATE POLICY lead_whatsapp_assignments_tenant_isolation ON public.lead_whatsapp_assignments
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.lead_whatsapp_assignments
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.lead_whatsapp_assignments
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS link_click_snapshots_tenant_rls ON public.link_click_snapshots;
DROP POLICY IF EXISTS tenant_access_base ON public.link_click_snapshots;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.link_click_snapshots;
CREATE POLICY tenant_access_base ON public.link_click_snapshots
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.link_click_snapshots
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS link_dispatches_tenant_rls ON public.link_dispatches;
DROP POLICY IF EXISTS tenant_access_base ON public.link_dispatches;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.link_dispatches;
CREATE POLICY tenant_access_base ON public.link_dispatches
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.link_dispatches
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS link_tracking_sync_runs_tenant_rls ON public.link_tracking_sync_runs;
DROP POLICY IF EXISTS tenant_access_base ON public.link_tracking_sync_runs;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.link_tracking_sync_runs;
CREATE POLICY tenant_access_base ON public.link_tracking_sync_runs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.link_tracking_sync_runs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS marketing_ad_metrics_daily_tenant_rls ON public.marketing_ad_metrics_daily;
DROP POLICY IF EXISTS marketing_ad_metrics_daily_tenant_isolation ON public.marketing_ad_metrics_daily;
DROP POLICY IF EXISTS tenant_access_base ON public.marketing_ad_metrics_daily;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.marketing_ad_metrics_daily;
CREATE POLICY marketing_ad_metrics_daily_tenant_isolation ON public.marketing_ad_metrics_daily
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.marketing_ad_metrics_daily
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.marketing_ad_metrics_daily
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS marketing_integrations_tenant_rls ON public.marketing_integrations;
DROP POLICY IF EXISTS marketing_integrations_tenant_isolation ON public.marketing_integrations;
DROP POLICY IF EXISTS tenant_access_base ON public.marketing_integrations;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.marketing_integrations;
CREATE POLICY marketing_integrations_tenant_isolation ON public.marketing_integrations
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.marketing_integrations
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.marketing_integrations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS meta_ad_accounts_tenant_rls ON public.meta_ad_accounts;
DROP POLICY IF EXISTS meta_ad_accounts_tenant_select ON public.meta_ad_accounts;
DROP POLICY IF EXISTS meta_ad_accounts_tenant_update ON public.meta_ad_accounts;
DROP POLICY IF EXISTS tenant_access_base ON public.meta_ad_accounts;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.meta_ad_accounts;
CREATE POLICY meta_ad_accounts_tenant_select ON public.meta_ad_accounts
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (has_tenant_access(tenant_id));
CREATE POLICY meta_ad_accounts_tenant_update ON public.meta_ad_accounts
  AS PERMISSIVE FOR UPDATE TO PUBLIC
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.meta_ad_accounts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.meta_ad_accounts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS meta_connections_tenant_rls ON public.meta_connections;
DROP POLICY IF EXISTS tenant_access_base ON public.meta_connections;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.meta_connections;
CREATE POLICY tenant_access_base ON public.meta_connections
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.meta_connections
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS meta_oauth_states_tenant_rls ON public.meta_oauth_states;
DROP POLICY IF EXISTS tenant_access_base ON public.meta_oauth_states;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.meta_oauth_states;
CREATE POLICY tenant_access_base ON public.meta_oauth_states
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.meta_oauth_states
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS meta_sync_jobs_tenant_rls ON public.meta_sync_jobs;
DROP POLICY IF EXISTS meta_sync_jobs_tenant_select ON public.meta_sync_jobs;
CREATE POLICY meta_sync_jobs_tenant_select ON public.meta_sync_jobs
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS meta_sync_runs_tenant_rls ON public.meta_sync_runs;
DROP POLICY IF EXISTS meta_sync_runs_tenant_select ON public.meta_sync_runs;
CREATE POLICY meta_sync_runs_tenant_select ON public.meta_sync_runs
  AS PERMISSIVE FOR SELECT TO PUBLIC
  USING (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS "super admin manages pricing" ON public.platform_pricing;
CREATE POLICY "super admin manages pricing" ON public.platform_pricing
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS player_attributions_tenant_rls ON public.player_attributions;
DROP POLICY IF EXISTS player_attributions_tenant_isolation ON public.player_attributions;
DROP POLICY IF EXISTS tenant_access_base ON public.player_attributions;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.player_attributions;
CREATE POLICY player_attributions_tenant_isolation ON public.player_attributions
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.player_attributions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.player_attributions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS players_tenant_rls ON public.players;
DROP POLICY IF EXISTS players_tenant_isolation ON public.players;
DROP POLICY IF EXISTS tenant_access_base ON public.players;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.players;
CREATE POLICY players_tenant_isolation ON public.players
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.players
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.players
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS precall_campaigns_tenant_rls ON public.precall_campaigns;
DROP POLICY IF EXISTS precall_campaigns_tenant_isolation ON public.precall_campaigns;
DROP POLICY IF EXISTS tenant_access_base ON public.precall_campaigns;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.precall_campaigns;
CREATE POLICY precall_campaigns_tenant_isolation ON public.precall_campaigns
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.precall_campaigns
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.precall_campaigns
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS precall_leads_tenant_rls ON public.precall_leads;
DROP POLICY IF EXISTS precall_leads_tenant_isolation ON public.precall_leads;
DROP POLICY IF EXISTS tenant_access_base ON public.precall_leads;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.precall_leads;
CREATE POLICY precall_leads_tenant_isolation ON public.precall_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.precall_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.precall_leads
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS precall_templates_tenant_rls ON public.precall_templates;
DROP POLICY IF EXISTS precall_templates_tenant_isolation ON public.precall_templates;
DROP POLICY IF EXISTS tenant_access_base ON public.precall_templates;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.precall_templates;
CREATE POLICY precall_templates_tenant_isolation ON public.precall_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.precall_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.precall_templates
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS rules_tenant_rls ON public.rules;
DROP POLICY IF EXISTS rules_tenant_isolation ON public.rules;
DROP POLICY IF EXISTS tenant_access_base ON public.rules;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.rules;
CREATE POLICY rules_tenant_isolation ON public.rules
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.rules
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.rules
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS send_window_settings_tenant_rls ON public.send_window_settings;
DROP POLICY IF EXISTS send_window_settings_super_admin_read ON public.send_window_settings;
DROP POLICY IF EXISTS send_window_settings_super_admin_write ON public.send_window_settings;
DROP POLICY IF EXISTS tenant_access_base ON public.send_window_settings;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.send_window_settings;
CREATE POLICY send_window_settings_super_admin_read ON public.send_window_settings
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY send_window_settings_super_admin_write ON public.send_window_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY tenant_access_base ON public.send_window_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.send_window_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS sessions_tenant_rls ON public.sessions;
DROP POLICY IF EXISTS sessions_tenant_isolation ON public.sessions;
DROP POLICY IF EXISTS tenant_access_base ON public.sessions;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.sessions;
CREATE POLICY sessions_tenant_isolation ON public.sessions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.sessions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sessions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS shortio_settings_tenant_rls ON public.shortio_settings;
DROP POLICY IF EXISTS tenant_access_base ON public.shortio_settings;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.shortio_settings;
CREATE POLICY tenant_access_base ON public.shortio_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.shortio_settings
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS sms_audiences_tenant_rls ON public.sms_audiences;
DROP POLICY IF EXISTS "sms audiences tenant access" ON public.sms_audiences;
CREATE POLICY "sms audiences tenant access" ON public.sms_audiences
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS sms_campaigns_tenant_rls ON public.sms_campaigns;
DROP POLICY IF EXISTS "Tenant members manage sms campaigns" ON public.sms_campaigns;
DROP POLICY IF EXISTS tenant_access_base ON public.sms_campaigns;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.sms_campaigns;
CREATE POLICY "Tenant members manage sms campaigns" ON public.sms_campaigns
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.sms_campaigns
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sms_campaigns
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS sms_credit_ledger_tenant_rls ON public.sms_credit_ledger;
DROP POLICY IF EXISTS sms_credit_ledger_read_own ON public.sms_credit_ledger;
DROP POLICY IF EXISTS tenant_access_base ON public.sms_credit_ledger;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.sms_credit_ledger;
CREATE POLICY sms_credit_ledger_read_own ON public.sms_credit_ledger
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY tenant_access_base ON public.sms_credit_ledger
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sms_credit_ledger
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS sms_credit_orders_tenant_rls ON public.sms_credit_orders;
DROP POLICY IF EXISTS sms_credit_orders_read_own ON public.sms_credit_orders;
DROP POLICY IF EXISTS sms_credit_orders_super_write ON public.sms_credit_orders;
DROP POLICY IF EXISTS tenant_access_base ON public.sms_credit_orders;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.sms_credit_orders;
CREATE POLICY sms_credit_orders_read_own ON public.sms_credit_orders
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY sms_credit_orders_super_write ON public.sms_credit_orders
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY tenant_access_base ON public.sms_credit_orders
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sms_credit_orders
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS sms_credit_packages_read_active ON public.sms_credit_packages;
DROP POLICY IF EXISTS sms_credit_packages_super_write ON public.sms_credit_packages;
CREATE POLICY sms_credit_packages_read_active ON public.sms_credit_packages
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_active OR is_super_admin()));
CREATE POLICY sms_credit_packages_super_write ON public.sms_credit_packages
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS sms_credit_settings_tenant_rls ON public.sms_credit_settings;
DROP POLICY IF EXISTS sms_credit_settings_super_read ON public.sms_credit_settings;
DROP POLICY IF EXISTS sms_credit_settings_super_write ON public.sms_credit_settings;
CREATE POLICY sms_credit_settings_super_read ON public.sms_credit_settings
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY sms_credit_settings_super_write ON public.sms_credit_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS sms_flow_leads_tenant_rls ON public.sms_flow_leads;
DROP POLICY IF EXISTS sms_flow_leads_tenant_isolation ON public.sms_flow_leads;
DROP POLICY IF EXISTS tenant_access_base ON public.sms_flow_leads;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.sms_flow_leads;
CREATE POLICY sms_flow_leads_tenant_isolation ON public.sms_flow_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.sms_flow_leads
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sms_flow_leads
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS sms_flow_steps_tenant_rls ON public.sms_flow_steps;
DROP POLICY IF EXISTS sms_flow_steps_tenant_isolation ON public.sms_flow_steps;
DROP POLICY IF EXISTS tenant_access_base ON public.sms_flow_steps;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.sms_flow_steps;
CREATE POLICY sms_flow_steps_tenant_isolation ON public.sms_flow_steps
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.sms_flow_steps
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sms_flow_steps
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS sms_flows_tenant_rls ON public.sms_flows;
DROP POLICY IF EXISTS sms_flows_tenant_isolation ON public.sms_flows;
DROP POLICY IF EXISTS tenant_access_base ON public.sms_flows;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.sms_flows;
CREATE POLICY sms_flows_tenant_isolation ON public.sms_flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.sms_flows
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sms_flows
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS sms_send_logs_tenant_rls ON public.sms_send_logs;
DROP POLICY IF EXISTS sms_send_logs_tenant_isolation ON public.sms_send_logs;
DROP POLICY IF EXISTS tenant_access_base ON public.sms_send_logs;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.sms_send_logs;
CREATE POLICY sms_send_logs_tenant_isolation ON public.sms_send_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.sms_send_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.sms_send_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS sms_template_versions_tenant_rls ON public.sms_template_versions;
DROP POLICY IF EXISTS sms_template_versions_tenant_select ON public.sms_template_versions;
CREATE POLICY sms_template_versions_tenant_select ON public.sms_template_versions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS sms_templates_tenant_rls ON public.sms_templates;
DROP POLICY IF EXISTS "sms templates tenant access" ON public.sms_templates;
CREATE POLICY "sms templates tenant access" ON public.sms_templates
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((tenant_id = current_tenant_id()))
  WITH CHECK ((tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS suppressed_emails_tenant_rls ON public.suppressed_emails;
DROP POLICY IF EXISTS suppressed_emails_tenant_delete ON public.suppressed_emails;
DROP POLICY IF EXISTS suppressed_emails_tenant_insert ON public.suppressed_emails;
DROP POLICY IF EXISTS suppressed_emails_tenant_update ON public.suppressed_emails;
DROP POLICY IF EXISTS "tenant members can view suppression list" ON public.suppressed_emails;
DROP POLICY IF EXISTS tenant_access_base ON public.suppressed_emails;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.suppressed_emails;
CREATE POLICY suppressed_emails_tenant_delete ON public.suppressed_emails
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id))));
CREATE POLICY suppressed_emails_tenant_insert ON public.suppressed_emails
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id))));
CREATE POLICY suppressed_emails_tenant_update ON public.suppressed_emails
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id))))
  WITH CHECK ((is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id))));
CREATE POLICY "tenant members can view suppression list" ON public.suppressed_emails
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((is_super_admin() OR ((tenant_id IS NOT NULL) AND has_tenant_access(tenant_id))));
CREATE POLICY tenant_access_base ON public.suppressed_emails
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.suppressed_emails
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS system_alerts_tenant_rls ON public.system_alerts;
DROP POLICY IF EXISTS system_alerts_tenant_isolation ON public.system_alerts;
DROP POLICY IF EXISTS tenant_access_base ON public.system_alerts;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.system_alerts;
CREATE POLICY system_alerts_tenant_isolation ON public.system_alerts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_access_base ON public.system_alerts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.system_alerts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS tenant_audit_logs_tenant_rls ON public.tenant_audit_logs;
DROP POLICY IF EXISTS tenant_access_base ON public.tenant_audit_logs;
DROP POLICY IF EXISTS tenant_audit_logs_read_own ON public.tenant_audit_logs;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.tenant_audit_logs;
CREATE POLICY tenant_access_base ON public.tenant_audit_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_audit_logs_read_own ON public.tenant_audit_logs
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.tenant_audit_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS tenant_daily_metrics_tenant_rls ON public.tenant_daily_metrics;
DROP POLICY IF EXISTS "tenant daily metrics read" ON public.tenant_daily_metrics;
CREATE POLICY "tenant daily metrics read" ON public.tenant_daily_metrics
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS tenant_sms_credit_balances_tenant_rls ON public.tenant_sms_credit_balances;
DROP POLICY IF EXISTS sms_credit_balances_read_own ON public.tenant_sms_credit_balances;
DROP POLICY IF EXISTS sms_credit_balances_super_write ON public.tenant_sms_credit_balances;
DROP POLICY IF EXISTS tenant_access_base ON public.tenant_sms_credit_balances;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.tenant_sms_credit_balances;
CREATE POLICY sms_credit_balances_read_own ON public.tenant_sms_credit_balances
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(tenant_id));
CREATE POLICY sms_credit_balances_super_write ON public.tenant_sms_credit_balances
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
CREATE POLICY tenant_access_base ON public.tenant_sms_credit_balances
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.tenant_sms_credit_balances
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS tenant_sms_pricing_tenant_rls ON public.tenant_sms_pricing;
DROP POLICY IF EXISTS tenant_access_base ON public.tenant_sms_pricing;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.tenant_sms_pricing;
DROP POLICY IF EXISTS tenant_sms_pricing_super_read ON public.tenant_sms_pricing;
DROP POLICY IF EXISTS tenant_sms_pricing_super_write ON public.tenant_sms_pricing;
CREATE POLICY tenant_access_base ON public.tenant_sms_pricing
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.tenant_sms_pricing
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY tenant_sms_pricing_super_read ON public.tenant_sms_pricing
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY tenant_sms_pricing_super_write ON public.tenant_sms_pricing
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS tenants_member_select_own ON public.tenants;
DROP POLICY IF EXISTS tenants_super_admin_all ON public.tenants;
CREATE POLICY tenants_member_select_own ON public.tenants
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (has_tenant_access(id));
CREATE POLICY tenants_super_admin_all ON public.tenants
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS tracked_links_tenant_rls ON public.tracked_links;
DROP POLICY IF EXISTS tenant_access_base ON public.tracked_links;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.tracked_links;
CREATE POLICY tenant_access_base ON public.tracked_links
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.tracked_links
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS user_roles_tenant_rls ON public.user_roles;
DROP POLICY IF EXISTS user_roles_block_super_admin_escalation ON public.user_roles;
DROP POLICY IF EXISTS user_roles_block_tenant_admin_escalation ON public.user_roles;
DROP POLICY IF EXISTS "Users read own roles" ON public.user_roles;
DROP POLICY IF EXISTS tenant_access_base ON public.user_roles;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.user_roles;
DROP POLICY IF EXISTS user_roles_owner_manage_tenant ON public.user_roles;
DROP POLICY IF EXISTS user_roles_select_own ON public.user_roles;
DROP POLICY IF EXISTS user_roles_super_admin_all ON public.user_roles;
CREATE POLICY "Users read own roles" ON public.user_roles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));
CREATE POLICY tenant_access_base ON public.user_roles
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.user_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY user_roles_block_super_admin_escalation ON public.user_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((role <> 'super_admin'::app_role) OR is_super_admin(auth.uid())))
  WITH CHECK (((role <> 'super_admin'::app_role) OR is_super_admin(auth.uid())));
CREATE POLICY user_roles_block_tenant_admin_escalation ON public.user_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((role <> 'admin'::app_role) OR is_super_admin(auth.uid())))
  WITH CHECK (((role <> 'admin'::app_role) OR is_super_admin(auth.uid())));
CREATE POLICY user_roles_owner_manage_tenant ON public.user_roles
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id IS NOT NULL) AND is_tenant_owner(tenant_id)))
  WITH CHECK (((tenant_id IS NOT NULL) AND is_tenant_owner(tenant_id)));
CREATE POLICY user_roles_select_own ON public.user_roles
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = auth.uid()) OR is_super_admin()));
CREATE POLICY user_roles_super_admin_all ON public.user_roles
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS voice_contact_policies_tenant_rls ON public.voice_contact_policies;
DROP POLICY IF EXISTS voice_contact_policies_tenant_access ON public.voice_contact_policies;
CREATE POLICY voice_contact_policies_tenant_access ON public.voice_contact_policies
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS webhook_configs_tenant_rls ON public.webhook_configs;
DROP POLICY IF EXISTS tenant_access_base ON public.webhook_configs;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.webhook_configs;
DROP POLICY IF EXISTS webhook_configs_tenant_isolation ON public.webhook_configs;
CREATE POLICY tenant_access_base ON public.webhook_configs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.webhook_configs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY webhook_configs_tenant_isolation ON public.webhook_configs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS webhook_logs_tenant_rls ON public.webhook_logs;
DROP POLICY IF EXISTS tenant_access_base ON public.webhook_logs;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.webhook_logs;
DROP POLICY IF EXISTS webhook_logs_tenant_isolation ON public.webhook_logs;
CREATE POLICY tenant_access_base ON public.webhook_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.webhook_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY webhook_logs_tenant_isolation ON public.webhook_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS whatsapp_chats_tenant_rls ON public.whatsapp_chats;
DROP POLICY IF EXISTS tenant_access_base ON public.whatsapp_chats;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.whatsapp_chats;
DROP POLICY IF EXISTS whatsapp_chats_tenant_isolation ON public.whatsapp_chats;
CREATE POLICY tenant_access_base ON public.whatsapp_chats
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.whatsapp_chats
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY whatsapp_chats_tenant_isolation ON public.whatsapp_chats
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS whatsapp_external_events_tenant_rls ON public.whatsapp_external_events;
DROP POLICY IF EXISTS tenant_access_base ON public.whatsapp_external_events;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.whatsapp_external_events;
DROP POLICY IF EXISTS wee_tenant_isolation ON public.whatsapp_external_events;
CREATE POLICY tenant_access_base ON public.whatsapp_external_events
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.whatsapp_external_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY wee_tenant_isolation ON public.whatsapp_external_events
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS whatsapp_external_integrations_tenant_rls ON public.whatsapp_external_integrations;
DROP POLICY IF EXISTS tenant_access_base ON public.whatsapp_external_integrations;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.whatsapp_external_integrations;
DROP POLICY IF EXISTS wei_tenant_isolation ON public.whatsapp_external_integrations;
CREATE POLICY tenant_access_base ON public.whatsapp_external_integrations
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.whatsapp_external_integrations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY wei_tenant_isolation ON public.whatsapp_external_integrations
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));

DROP POLICY IF EXISTS whatsapp_messages_tenant_rls ON public.whatsapp_messages;
DROP POLICY IF EXISTS tenant_access_base ON public.whatsapp_messages;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.whatsapp_messages;
DROP POLICY IF EXISTS whatsapp_messages_tenant_isolation ON public.whatsapp_messages;
CREATE POLICY tenant_access_base ON public.whatsapp_messages
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.whatsapp_messages
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY whatsapp_messages_tenant_isolation ON public.whatsapp_messages
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS whatsapp_proxies_tenant_rls ON public.whatsapp_proxies;
DROP POLICY IF EXISTS tenant_access_base ON public.whatsapp_proxies;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.whatsapp_proxies;
DROP POLICY IF EXISTS whatsapp_proxies_super_admin_read ON public.whatsapp_proxies;
DROP POLICY IF EXISTS whatsapp_proxies_super_admin_write ON public.whatsapp_proxies;
CREATE POLICY tenant_access_base ON public.whatsapp_proxies
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.whatsapp_proxies
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY whatsapp_proxies_super_admin_read ON public.whatsapp_proxies
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (is_super_admin());
CREATE POLICY whatsapp_proxies_super_admin_write ON public.whatsapp_proxies
  AS PERMISSIVE FOR ALL TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS whatsapp_proxy_logs_tenant_rls ON public.whatsapp_proxy_logs;
DROP POLICY IF EXISTS tenant_access_base ON public.whatsapp_proxy_logs;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.whatsapp_proxy_logs;
DROP POLICY IF EXISTS whatsapp_proxy_logs_tenant_isolation ON public.whatsapp_proxy_logs;
CREATE POLICY tenant_access_base ON public.whatsapp_proxy_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.whatsapp_proxy_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY whatsapp_proxy_logs_tenant_isolation ON public.whatsapp_proxy_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS whatsapp_sessions_tenant_rls ON public.whatsapp_sessions;
DROP POLICY IF EXISTS tenant_access_base ON public.whatsapp_sessions;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.whatsapp_sessions;
DROP POLICY IF EXISTS whatsapp_sessions_tenant_isolation ON public.whatsapp_sessions;
CREATE POLICY tenant_access_base ON public.whatsapp_sessions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.whatsapp_sessions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY whatsapp_sessions_tenant_isolation ON public.whatsapp_sessions
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

DROP POLICY IF EXISTS withdrawals_tenant_rls ON public.withdrawals;
DROP POLICY IF EXISTS tenant_access_base ON public.withdrawals;
DROP POLICY IF EXISTS tenant_isolation_guard ON public.withdrawals;
DROP POLICY IF EXISTS withdrawals_tenant_isolation ON public.withdrawals;
CREATE POLICY tenant_access_base ON public.withdrawals
  AS PERMISSIVE FOR ALL TO authenticated
  USING (has_tenant_access(tenant_id))
  WITH CHECK (has_tenant_access(tenant_id));
CREATE POLICY tenant_isolation_guard ON public.withdrawals
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));
CREATE POLICY withdrawals_tenant_isolation ON public.withdrawals
  AS PERMISSIVE FOR ALL TO authenticated
  USING (((tenant_id = current_tenant_id()) OR is_super_admin()))
  WITH CHECK (((tenant_id = current_tenant_id()) OR is_super_admin()));

ALTER FUNCTION public.current_tenant_id() SET search_path = public;
ALTER FUNCTION public.is_super_admin(uuid) SET search_path = public;
ALTER FUNCTION public.has_tenant_access(uuid, uuid) SET search_path = public;
ALTER FUNCTION public.is_tenant_owner(uuid) SET search_path = public;
COMMIT;
```
