# SEC-01 — Correção intencional de permissões (achados F1–F6 do CON-08)

Data: 15/10/2026. Origem: `docs/CON-08_RLS_REVISAO_SEGURANCA.md`, seção 4. Versão 2: aplica as decisões aprovadas em 15/10 (seção 7).

> **Nada foi aplicado em produção.** A produção foi lida só com `default_transaction_read_only = on` e `statement_timeout = 15s`, e só para contar linhas, listar colunas, ACLs de tabelas e de funções e o corpo das funções. Nenhum valor de tabela de credencial foi lido.
>
> Estado de produção considerado: CON-08 (`20261015090000`) **aplicada**, além de `20261015110000`, `…111000` e `…113000`. ACLs capturadas em `supabase/tests/rls/prod_acl_2026-10-15.json`.
>
> - Migration: `supabase/migrations/20261015100000_fix_rls_privilege_escalation.sql`, gerada por `node supabase/tests/rls/sec01-generate.mjs`. Aborta se a CON-08 não estiver aplicada.
> - Rollback: `supabase/tests/rls/rollback_20261015100000.sql` (Apêndice A).
> - Matriz: `node supabase/tests/rls/sec01-matrix.mjs`, que gera `sec01-matrix-result.json` e `sec01-access-matrix.tsv`.

## 1. Resumo

A CON-08 só mudou desempenho e manteve o acesso idêntico. A SEC-01 **muda o acesso de propósito**. Toda mudança é uma restrição, com uma exceção desejada: cada usuário passa a ler as **próprias** linhas em `user_roles`, o que inclui o admin do tenant ver a própria linha `admin`.

| Achado | O que muda | Quem perde o quê |
|---|---|---|
| F1 crítico | `tenant_sms_credit_balances`, `sms_credit_ledger`, `sms_credit_orders`, `tenant_sms_pricing`, `deposits`, `withdrawals` e `tenant_audit_logs` ficam **só leitura** para usuários de tenant | admin, gestor e member perdem INSERT/UPDATE/DELETE direto via REST. Leitura e super admin não mudam |
| F2 alto | `user_roles`: SELECT só das próprias linhas (ou super admin); escrita só do super admin | Usuários de tenant perdem a escrita direta em vínculos (criar, remover, promover a gestor, mover) e a listagem dos vínculos de colegas via REST |
| F3 alto | Só service_role: `meta_connections`, `meta_oauth_states`, `email_unsubscribe_tokens`. Só super admin: `call_providers`, `email_smtp_configs`, `email_senders`. Colunas fora do SELECT dos clientes: `webhook_configs.secret`, `call_providers.api_key/api_secret/headers_config` | Usuários de tenant perdem leitura e escrita dessas tabelas e a leitura dos segredos. O super admin perde acesso REST a `meta_*` e às colunas secretas |
| CFG (decisão 2) | Só super admin ou admin/gestor do tenant escrevem em `automation_settings`, `dashboard_settings`, `webhook_configs` e `shortio_settings`. SELECT não muda | `member` perde escrita direta nessas 4 tabelas. Nenhuma tela de member grava nelas (seção 3.4) |
| F4 médio | `anon` perde INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER e `authenticated` perde TRUNCATE em todas as tabelas de `public`, **exceto WhatsApp**. Default privileges de `postgres` corrigidos | Nenhum fluxo usa esses privilégios |
| F6 (decisão 5) | EXECUTE revogado de `PUBLIC`/`anon` em 19 funções `SECURITY DEFINER`. Em 2 funções só de serviço, revogado também de `authenticated` | `anon` não chama nenhuma delas. Para usuário logado não muda nada (seção 3.6) |
| F5 | Só documentação. O admin de tenant passa a acessar o drill-down e o CSV de conversão (decisão 3) | — |
| WhatsApp | **Nada muda** (decisão 1). Pendências na seção 3.7 | — |

Matriz de acesso (CON-08 → SEC-01): **2.747 diferenças** em 92.148 operações (120 tabelas). Todas foram classificadas como intencionais e todas estão nas 18 tabelas alvo. Não houve diferença não classificada (0), ampliação fora do previsto (0), diferença nas outras 102 tabelas (0) nem diferença bruta nas tabelas de WhatsApp (0). O EXECUTE das 21 funções ficou como esperado. Reaplicar a migration dá 0 diferenças e o rollback volta ao estado da CON-08 com 0 diferenças brutas.

## 2. Modelo de papéis (verificado)

- `app_role` = `super_admin`, `admin`, `gestor` e `member`. Produção hoje tem 15 vínculos: 2 `super_admin` (`tenant_id` NULL), 5 `admin`, 7 `gestor` e 1 `member`, em 5 tenants.
- Funções auxiliares:
  - `is_super_admin()`: o usuário tem vínculo `super_admin` com `tenant_id IS NULL`.
  - `has_tenant_access(t)`: super admin, ou admin/gestor/member de `t`.
  - `current_tenant_id()`: o tenant do header `x-active-tenant`, validado; sem header, o menor tenant do usuário.
  - `is_tenant_admin(t)`: super admin, ou `admin` de `t`.
  - **Nova:** `managed_tenant_ids()` (uuid[], `STABLE SECURITY DEFINER`, `search_path = public, pg_temp`, EXECUTE só para `authenticated` e `service_role`): tenants onde o usuário é `admin` ou `gestor`. Usada como InitPlan `(select …)`, igual a `accessible_tenant_ids()` da CON-08.
- Na aplicação, a gestão de equipe é feita por admin do tenant ou super admin, sempre checada no servidor e executada com service_role. A edição de jornadas exige admin ou gestor (`requireJourneyDraftEditor`). Fora isso, gestor e member veem as mesmas telas.

Clientes do app, confirmados no código:

| Cliente | Onde | Passa pela RLS? |
|---|---|---|
| `supabase` (`client.ts`, chave publicável + JWT) | browser, depois do `AuthGate` (nenhuma consulta a tabela nem RPC antes do login) | sim, como `authenticated` |
| `context.supabase` (`requireSupabaseAuth`) | server functions com o JWT do usuário | sim, como `authenticated` |
| `supabaseAdmin` (`client.server.ts`) | `*.server.ts`, `api/public/*`, `/u/$token` e trechos das server functions | não (service_role) |

## 3. O que muda, por achado

### 3.1 F1 — cobrança e financeiro: só leitura para o tenant

```sql
CREATE POLICY <t>_tenant_select ON public.<t> AS PERMISSIVE FOR SELECT TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY <t>_super_admin_write ON public.<t> AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin())) WITH CHECK ((select public.is_super_admin()));
```

Nenhum código grava nessas tabelas com o JWT do usuário. Para chegar a isso, busquei `.from("<t>")` e `.from<T>("<t>")` em `src/` e `supabase/functions/`, e cruzei cada uso com o cliente do arquivo:

| Tabela | Escritas no app | Leituras com JWT (continuam) |
|---|---|---|
| `tenant_sms_credit_balances` | RPC `apply_sms_credit_mutation` (DEFINER) | RPCs `sms_credit_summary`, `dashboard_summary_v2` |
| `sms_credit_ledger` | `apply_sms_credit_mutation` (exige super admin ou service_role) | `getSmsCreditPortal` |
| `sms_credit_orders` | `create_sms_credit_checkout` (checa `has_tenant_access`), `admin_mark_sms_credit_order_paid` (super admin) | `getSmsCreditPortal`, `adminSmsCreditConsole` |
| `tenant_sms_pricing` | `admin_set/clear_tenant_sms_pricing` (super admin) | RPC `sms_effective_pricing` |
| `deposits`, `withdrawals` | webhooks com service_role | `/`, `/alertas`, `/players`, detalhe do jogador, IA, realtime |
| `tenant_audit_logs` | sempre `supabaseAdmin` | histórico |

As funções que tocam essas tabelas são `SECURITY DEFINER`, pertencem a `postgres` (BYPASSRLS) e validam o chamador. A única `INVOKER` (`get_players_alert_ids`) só lê.

Já estavam corretas e não mudam: `cashback_payments`, `platform_pricing`, `sms_credit_packages` e `sms_credit_settings`.

### 3.2 F2 — `user_roles`

Duas políticas novas:

- `user_roles_select_own`: SELECT quando `sa OR user_id = (select auth.uid())`;
- `user_roles_super_admin_write`: ALL, só `sa`.

As restritivas anti-escalonamento saem. Elas eram redundantes com a escrita restrita ao super admin e escondiam do admin a própria linha.

Leituras com JWT, todas da própria linha:

- `use-is-super-admin.ts`;
- `sms-credits.functions.ts` `resolveTenantId`: o portal de créditos **passa a funcionar para admin de tenant**;
- `conversion-report` / `conversion-p2` `requireAdmin` (seção 3.5).

Todas as escritas (`tenants.functions.ts`, `admin.functions.ts`) usam `supabaseAdmin` depois da checagem no servidor.

### 3.3 F3 — segredos e configuração da plataforma

| Tabela | Linhas em prod | Segredos | Uso no app | Decisão |
|---|---|---|---|---|
| `meta_connections` | 1 | `access_token`, `encrypted_access_token` | só `supabaseAdmin` (incluindo embeds `meta_connections!inner(...)`) | só service_role: sem política de cliente e `REVOKE ALL` de anon/authenticated. `meta_connections_service_only` fica |
| `meta_oauth_states` | 2 | `nonce` | nenhum uso com JWT | só service_role |
| `email_unsubscribe_tokens` | 1 | `token`, `email` | `/u/$token` e envio, com `supabaseAdmin` | só service_role. Os grants já não existiam desde 06/2026, então muda só a política (0 diferenças na matriz) |
| `call_providers` | 0 | `api_key`, `api_secret`, `headers_config` | nenhum | só super admin + colunas secretas fora do SELECT |
| `email_smtp_configs` | 0 | `password_encrypted` (texto puro) | `/email`, com `assertSuperAdmin` em todas as funções | só super admin. O super admin continua lendo a senha na tela (follow-up na seção 8) |
| `email_senders` | 1 | — | `/email`, com `assertSuperAdmin` | só super admin |
| `webhook_configs` | 0 | `secret` | nenhum uso direto; RPC `get_webhook_config_secret` (checa `is_tenant_admin`) | coluna `secret` fora do SELECT; escrita só admin/gestor (seção 3.4) |

Sobre colunas: os `REVOKE SELECT (col)` de 24/06/2026 não tinham efeito, porque o SELECT da tabela inteira continuava concedido. Agora é `REVOKE SELECT ON <tabela>` seguido de `GRANT SELECT (<colunas não secretas>) TO authenticated`. A lista de colunas vem do catálogo, então o bloco é idempotente.

### 3.4 CFG — configurações do tenant: escrita só admin/gestor (decisão 2)

Regra: SELECT continua `sa OR tenant ativo` (ou `sa OR meus tenants` em `shortio_settings`). INSERT/UPDATE/DELETE passam a exigir `sa OR (tenant ativo AND tenant ∈ managed_tenant_ids())`. Em `shortio_settings`, que é da família `has_tenant_access`, a exigência é `sa OR tenant ∈ managed_tenant_ids()`.

Antes de restringir, verifiquei cada caminho de escrita:

| Tabela | Caminho de escrita | Quem o servidor deixa gravar | Decisão |
|---|---|---|---|
| `shortio_settings` | `saveShortioSettings` (JWT) em `/links/configuracoes` | `requireTenantAdmin` → só admin (ou super admin) | **restringida**. Admin passa; gestor também passaria no banco |
| `automation_settings` | `setPaused`, `setChannelPaused` (`assertSuperAdmin`) e `updateLimits`, todas com `supabaseAdmin` | sem escrita com JWT | **restringida** (fecha só o REST direto) |
| `dashboard_settings` | `resetDashboards`: `has_role(admin)` + `supabaseAdmin` | sem escrita com JWT | **restringida** |
| `webhook_configs` | nenhuma | — | **restringida** |
| `journey_contact_limits` | `saveJourneyContactLimits` com `supabaseAdmin`, depois de `requireJourneyDraftEditor` (admin/gestor) | `authenticated` já não tinha grant nenhum | nada a mudar |
| `send_window_settings` | `updateSendWindow` (JWT), `send-window-card` | **qualquer membro**, sem checagem | **mantida sem restrição**. Restringir faria o UPDATE de um member afetar 0 linhas sem erro, e a tela diria "salvo" sem salvar |
| `marketing_integrations` | `saveMarketingIntegration` (JWT), `/midia-ltv` | qualquer membro | mantida |
| `gamification_settings` | `saveGamificationSettings` (JWT), `/gamificacao` | qualquer membro | mantida |
| `dispatch_pause_state` | `setDispatchPause` (JWT), `providers-paused-banner` | qualquer membro | mantida (é operacional) |
| `ai_intents`, `ai_synonyms`, `ai_training_examples` | `/treino-ia` grava direto do browser (menu "Configurar IA" visível para todos); `ai-feedback.tsx` insere exemplos a partir do feedback de qualquer usuário | qualquer membro | mantidas |
| `ai_feedback` | `ai-feedback.tsx` | qualquer membro | log operacional; mantida |

Para restringir as tabelas mantidas, primeiro o servidor (ou a UI) precisa passar a exigir admin/gestor. Fica como decisão de produto: se aprovado, entra na próxima migration junto com o ajuste de tela.

### 3.5 F5 — drill-down de conversão para admin (decisão 3: manter)

As políticas "admin" de `conversion_attribution_issues`, `conversion_experiment_assignments` e da escrita de `conversion_experiments` continuam só para o super admin, como a CON-08 deixou.

As checagens de aplicação `requireConversionReportAdmin` e `requireAdmin` leem a própria linha em `user_roles`. Hoje elas sempre recusam o admin do tenant; depois de F2, ele passa. Consequências:

- O admin passa a usar o drill-down e o CSV com PII (nome, e-mail, telefone). **Isso é desejado.** Os dados (`link_dispatches`, `click_events`, `conversion_attributions`, `players`) já eram legíveis por qualquer membro via RLS.
- Em `conversion-p2` (experimentos), o admin passa a checagem de app, mas a RLS continua bloqueando a escrita em `conversion_experiments`. O erro na tela muda de mensagem.
- O registro em `conversion_report_audit_events` continua falhando em silêncio para quem não é super admin, porque a tabela não tem política. Isso já acontece hoje.

### 3.6 F4 e F6 — `anon` e funções

**F4.**

- Antes: `anon` tinha escrita e TRUNCATE em quase todas as tabelas, e `authenticated` tinha TRUNCATE. TRUNCATE ignora a RLS; o PostgREST não o expõe.
- Nenhuma política dá acesso efetivo a `anon`.
- Fluxos sem login não tocam tabelas como `anon`: o `AuthGate` não consulta nada antes da sessão, e `/u/$token` e `api/public/*` usam service_role.
- A revogação é feita tabela a tabela num `DO`, **excluindo** as tabelas `*whatsapp*` e `antiban_settings`.

**F6.** Funções em `public` com `SECURITY DEFINER` e EXECUTE para `PUBLIC`/`anon`, lidas de `pg_proc.proacl`. Ficaram fora as funções de trigger (`assign_conversion_experiment`, `capture_*_version`, `refresh_*_statement`, `refresh_daily_metric_from_row`, `validate_conversion_dispatch_source`); o EXECUTE de trigger só é checado no `CREATE TRIGGER`. Busquei cada nome em `.rpc("…")` e fiz este levantamento:

- nenhuma é chamada antes do login nem por rota pública;
- as do app usam JWT (portal de créditos, console de super admin, dashboard, Short.io, webhooks) ou `supabaseAdmin` (dispatcher de SMS: `reserve/refund_sms_credits`, `claim_due_sms_campaigns`);
- nenhuma é usada em política de RLS;
- `pg_cron` não chama nenhuma delas.

Funções alteradas (21):

| Função | EXECUTE antes (fora service_role) | EXECUTE depois | Uso |
|---|---|---|---|
| `admin_adjust_sms_credits(uuid,integer,text,text)` | PUBLIC, anon, authenticated | authenticated, service_role | console de créditos (super admin) |
| `admin_clear_tenant_sms_pricing(uuid)` | PUBLIC, anon, authenticated | authenticated, service_role | console de créditos (super admin) |
| `admin_list_users_with_usage(timestamp with time zone,timestamp with time zone)` | PUBLIC, anon, authenticated | authenticated, service_role | `/admin` (super admin) |
| `admin_mark_sms_credit_order_paid(uuid,text,text,jsonb)` | PUBLIC, anon, authenticated | authenticated, service_role | console de créditos (super admin) |
| `admin_platform_metrics(timestamp with time zone,timestamp with time zone)` | PUBLIC, anon, authenticated | authenticated, service_role | `/admin` (super admin) |
| `admin_set_sms_credit_settings(numeric,numeric,integer,integer)` | PUBLIC, anon, authenticated | authenticated, service_role | console de créditos (super admin) |
| `admin_set_tenant_sms_pricing(uuid,numeric,numeric)` | PUBLIC, anon, authenticated | authenticated, service_role | console de créditos (super admin) |
| `admin_sms_credit_overview()` | PUBLIC, anon, authenticated | authenticated, service_role | console de créditos (super admin) |
| `apply_sms_credit_mutation(uuid,integer,text,text,text,text,text,jsonb,uuid)` | PUBLIC, anon, authenticated | authenticated, service_role | só dentro de outras DEFINER |
| `create_sms_credit_checkout(uuid,uuid,integer)` | PUBLIC, anon, authenticated | authenticated, service_role | `/creditos-sms` (JWT) |
| `dashboard_totals(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)` | PUBLIC, anon, authenticated | authenticated, service_role | dashboard `/` (browser, JWT) |
| `get_my_webhook_token(uuid)` | PUBLIC, anon, authenticated | authenticated, service_role | sem uso no app |
| `get_tenant_webhook_token(uuid)` | anon, authenticated | authenticated, service_role | sem uso no app |
| `get_webhook_config_secret(uuid)` | anon, authenticated | authenticated, service_role | sem uso no app |
| `is_tenant_admin(uuid)` | PUBLIC, anon, authenticated | authenticated, service_role | Short.io e webhooks (JWT) |
| `refund_sms_credits(uuid,integer,text,text,text,text)` | PUBLIC, anon, authenticated | authenticated, service_role | dispatcher SMS (service_role) |
| `reserve_sms_credits(uuid,integer,text,text,text)` | PUBLIC, anon, authenticated | authenticated, service_role | dispatcher SMS (service_role) |
| `sms_credit_summary(uuid)` | PUBLIC, anon, authenticated | authenticated, service_role | `/creditos-sms`, `/`, `/tenants` |
| `sms_effective_pricing(uuid)` | PUBLIC, anon, authenticated | authenticated, service_role | créditos/tenants (JWT e service_role) |
| `claim_due_sms_campaigns(integer)` | PUBLIC, anon, authenticated | **só service_role** | dispatcher SMS (service_role) |
| `recover_stuck_sms_campaigns()` | PUBLIC, anon, authenticated | **só service_role** | sem uso no app (manutenção) |

Nova função `managed_tenant_ids()`: EXECUTE só para `authenticated` e `service_role`.

`claim_due_sms_campaigns` e `recover_stuck_sms_campaigns` **não checam o chamador** e alteram campanhas de todos os tenants. Qualquer usuário logado podia "reservar" campanhas de outros tenants via RPC. Como só o dispatcher (service_role) as chama, elas perdem também `authenticated`. É o mesmo padrão das funções de `20261015110000`. Para todas as outras, `authenticated` e `service_role` mantêm o EXECUTE.

### 3.7 WhatsApp — **pendente, não aplicado por decisão (WhatsApp fora do escopo agora)**

A SEC-01 não altera nenhuma tabela de WhatsApp: `whatsapp_*`, `lead_whatsapp_assignments`, `antiban_settings`. A matriz confirma 0 diferenças, inclusive brutas, e inclusive para `anon`. Achados em aberto e correção proposta:

| Achado | Risco | Correção proposta |
|---|---|---|
| `whatsapp_proxies.password_encrypted` legível por qualquer membro do tenant (`select("*")`) e gravado em **texto puro** | vazamento de credencial de proxy | grant de SELECT por coluna sem `password_encrypted`; `whatsapp-proxies.functions.ts` passa a listar colunas explícitas e calcula `has_password` com service_role (ajuste já testado na versão 1 desta SEC-01); criptografar em repouso |
| `whatsapp_external_integrations.url` gravável por qualquer membro (`saveWhatsappExternalIntegration`, sem checagem de papel) | um member aponta os eventos de WhatsApp, com telefone de lead, para um servidor próprio: **exfiltração de telefones** | escrita só admin/gestor (`managed_tenant_ids()`) + checagem no servidor; allowlist de hosts |
| `antiban_settings` gravável por qualquer membro (`saveAntibanSettings`) | o member desliga limites e aquecimento e arrisca banimento dos números | escrita só admin/gestor + checagem no servidor |
| `anon` com escrita e TRUNCATE nas tabelas de WhatsApp | sem acesso efetivo hoje (RLS), mas é a única barreira | incluir no F4 |
| `createWhatsappProxy` não envia `tenant_id` (default `…0001`) | o INSERT falha para outros tenants | enviar o tenant ativo |

## 4. Telas e fluxos verificados (como)

Método:

- busca de `.from("…")`, `.from<T>("…")`, `.rpc("…")`, `postgres_changes` e embeds em `select(...)` para cada tabela e função alvo, em `src/`, `supabase/functions/` e `scripts/`;
- para cada uso, identifiquei o cliente (browser, `context.supabase` ou `supabaseAdmin`) e a checagem de papel no servidor;
- li o corpo das funções do banco envolvidas;
- rodei `npm run typecheck` e `npm test`.

| Tela / fluxo | Resultado |
|---|---|
| `/creditos-sms` (member e admin), checkout | preservado; o admin passa a conseguir abrir |
| Console de créditos do super admin (ajuste, preço, pedido pago, pacotes) | preservado; RPCs mantêm EXECUTE para `authenticated` |
| `/tenants` e `/admin` (equipe, convites, papéis, métricas, usuários) | preservado (service_role; `admin_platform_metrics`/`admin_list_users_with_usage` mantêm `authenticated`) |
| Dashboard `/` (`dashboard_totals`, `sms_credit_summary`), `/alertas`, `/players` | preservado |
| `/links/configuracoes` (Short.io) | preservado para admin (o servidor já exigia admin) |
| Zerar dashboards, pausar automações, limites | preservado (service_role) |
| Webhooks de tenant (`webhooks.functions.ts`, `is_tenant_admin`) | preservado |
| Dispatcher de SMS (reserva, estorno, claim e recuperação de campanhas) | preservado (service_role) |
| Integração Meta, `/u/$token`, envio de e-mail, `/email` (super admin) | preservado |
| Janela de envio, mídia/LTV, gamificação, pausa de disparo, `/treino-ia`, feedback de IA | **sem mudança** (mantidas, seção 3.4) |
| `/whatsapp` (todas as abas) | **sem mudança** (decisão 1) |
| Relatório de conversão (admin) | admin passa a acessar o drill-down (decisão 3) |

## 5. Mudanças de código

**Nenhuma.** A versão 1 alterava `src/lib/whatsapp-proxies.functions.ts`; o arquivo foi revertido com `git checkout` porque a revogação da coluna saiu do escopo. Não foram alterados `scripts/sync-sortealta-export.mjs` nem `src/components/journeys/journey-editor.tsx`.

## 6. Matriz de acesso CON-08 × SEC-01

O script `node supabase/tests/rls/sec01-matrix.mjs` usa o mesmo harness da CON-08:

- PGlite com as funções de produção literais e os grants e flags de RLS do snapshot;
- 120 tabelas, 9 personas e 5 headers;
- uma operação `SELECT_SECRET` nas tabelas com credencial;
- stubs das funções do F6 com as ACLs de produção.

Fases: A = produção + CON-08; B = A + SEC-01; C = SEC-01 reaplicada; D = rollback.

O script falha se encontrar qualquer um destes casos:

- diferença não classificada;
- ampliação além de "ler a própria linha em `user_roles`";
- diferença em tabela fora do alvo;
- qualquer diferença bruta numa tabela de WhatsApp;
- EXECUTE inesperado depois da SEC-01;
- B ≠ C;
- A ≠ D (matriz, privilégios de tabela e EXECUTE).

**Resultado (2026-10-15T13:14:06.835Z):** 5.040 células, 92.148 operações.

| Verificação | Resultado |
|---|---|
| Diferenças CON-08 → SEC-01 (normalizadas) | 2.747 |
| Não classificadas | **0** |
| Ampliações | 15, todas "ler a própria linha em `user_roles`" (fora disso: **0**) |
| Diferenças em tabelas fora do alvo | **0** (brutas, sem anon: 0) |
| Diferenças brutas em tabelas de WhatsApp (todas as personas, inclusive anon) | **0** |
| SEC-01 × reaplicada (bruto) | 0 |
| CON-08 × rollback (bruto) | 0 |
| EXECUTE das funções depois / rollback | inesperados: 0; divergências no rollback: 0 |
| Privilégios de tabela inesperados | 0 |
| `anon` | 0 diferenças normalizadas; 2.678 brutas, todas "0 linhas (RLS)" → "42501 (privilégio)" e todas fora do WhatsApp |
| Tabelas (fora do WhatsApp) com escrita de `anon` | 109/111 → 0 → rollback 109 |
| TRUNCATE `anon` / `authenticated` (fora do WhatsApp) | 110/109 → 0/0 → 110/109 |
| Tabelas de WhatsApp: escrita de `anon` / TRUNCATE | 9/9 → 9/9 (inalterado) |

Diferenças por motivo:

| Motivo | Operações |
|---|---|
| CFG member write on config removed (admin/gestor keep) | 222 |
| F3 secret column hidden | 40 |
| F3 super-admin-only | 591 |
| F1 tenant write removed | 1.029 |
| F3 service-only (no client access) | 569 |
| F2 select = own rows (own admin row now visible) | 15 |
| F2 tenant write removed | 271 |
| F2 select limited to own rows | 10 |

Operações que mudam, por tabela e persona. Personas não listadas não mudam: `admin_*` e `gestor_*` não mudam nas tabelas CFG, e `no_role` e `anon` já eram negados.

| Tabela | Persona: operações que deixam de ser permitidas |
|---|---|
| `automation_settings` | member_A: DELETE,INSERT,UPDATE<br>multi_mA_aC: DELETE,INSERT,UPDATE |
| `call_providers` | super_admin: SELECT_SECRET<br>admin_A: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>gestor_A: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>member_A: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>gestor_B: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>admin_B: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>multi_mA_aC: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE |
| `dashboard_settings` | member_A: DELETE,INSERT,UPDATE<br>multi_mA_aC: DELETE,INSERT,UPDATE |
| `deposits` | admin_A: DELETE,INSERT,UPDATE<br>gestor_A: DELETE,INSERT,UPDATE<br>member_A: DELETE,INSERT,UPDATE<br>gestor_B: DELETE,INSERT,UPDATE<br>admin_B: DELETE,INSERT,UPDATE<br>multi_mA_aC: DELETE,INSERT,UPDATE |
| `email_senders` | admin_A: DELETE,INSERT,SELECT,UPDATE<br>gestor_A: DELETE,INSERT,SELECT,UPDATE<br>member_A: DELETE,INSERT,SELECT,UPDATE<br>gestor_B: DELETE,INSERT,SELECT,UPDATE<br>admin_B: DELETE,INSERT,SELECT,UPDATE<br>multi_mA_aC: DELETE,INSERT,SELECT,UPDATE |
| `email_smtp_configs` | admin_A: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>gestor_A: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>member_A: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>gestor_B: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>admin_B: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>multi_mA_aC: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE |
| `meta_connections` | super_admin: DELETE,INSERT,MOVE_A,MOVE_B,SELECT,SELECT_SECRET,UPDATE<br>admin_A: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>gestor_A: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>member_A: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>gestor_B: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>admin_B: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE<br>multi_mA_aC: DELETE,INSERT,SELECT,SELECT_SECRET,UPDATE |
| `meta_oauth_states` | super_admin: DELETE,INSERT,MOVE_A,MOVE_B,SELECT,UPDATE<br>admin_A: DELETE,INSERT,SELECT,UPDATE<br>gestor_A: DELETE,INSERT,SELECT,UPDATE<br>member_A: DELETE,INSERT,SELECT,UPDATE<br>gestor_B: DELETE,INSERT,SELECT,UPDATE<br>admin_B: DELETE,INSERT,SELECT,UPDATE<br>multi_mA_aC: DELETE,INSERT,SELECT,UPDATE |
| `shortio_settings` | member_A: DELETE,INSERT,UPDATE<br>multi_mA_aC: DELETE,INSERT,UPDATE |
| `sms_credit_ledger` | admin_A: DELETE,INSERT,UPDATE<br>gestor_A: DELETE,INSERT,UPDATE<br>member_A: DELETE,INSERT,UPDATE<br>gestor_B: DELETE,INSERT,UPDATE<br>admin_B: DELETE,INSERT,UPDATE<br>multi_mA_aC: DELETE,INSERT,UPDATE |
| `sms_credit_orders` | admin_A: DELETE,INSERT,UPDATE<br>gestor_A: DELETE,INSERT,UPDATE<br>member_A: DELETE,INSERT,UPDATE<br>gestor_B: DELETE,INSERT,UPDATE<br>admin_B: DELETE,INSERT,UPDATE<br>multi_mA_aC: DELETE,INSERT,UPDATE |
| `tenant_audit_logs` | admin_A: DELETE,INSERT,UPDATE<br>gestor_A: DELETE,INSERT,UPDATE<br>member_A: DELETE,INSERT,UPDATE<br>gestor_B: DELETE,INSERT,UPDATE<br>admin_B: DELETE,INSERT,UPDATE<br>multi_mA_aC: DELETE,INSERT,UPDATE |
| `tenant_sms_credit_balances` | admin_A: DELETE,INSERT,UPDATE<br>gestor_A: DELETE,INSERT,UPDATE<br>member_A: DELETE,INSERT,UPDATE<br>gestor_B: DELETE,INSERT,UPDATE<br>admin_B: DELETE,INSERT,UPDATE<br>multi_mA_aC: DELETE,INSERT,UPDATE |
| `tenant_sms_pricing` | admin_A: DELETE,INSERT,UPDATE<br>gestor_A: DELETE,INSERT,UPDATE<br>member_A: DELETE,INSERT,UPDATE<br>gestor_B: DELETE,INSERT,UPDATE<br>admin_B: DELETE,INSERT,UPDATE<br>multi_mA_aC: DELETE,INSERT,UPDATE |
| `user_roles` | admin_A: DELETE,INSERT,PROMOTE_GESTOR,SELECT,UPDATE<br>gestor_A: DELETE,INSERT,PROMOTE_GESTOR,SELECT,UPDATE<br>member_A: DELETE,INSERT,PROMOTE_GESTOR,SELECT,UPDATE<br>gestor_B: DELETE,INSERT,MOVE_B,PROMOTE_GESTOR,UPDATE<br>admin_B: DELETE,INSERT,MOVE_B,PROMOTE_GESTOR,SELECT,UPDATE<br>multi_mA_aC: DELETE,INSERT,PROMOTE_GESTOR,SELECT,UPDATE |
| `webhook_configs` | super_admin: SELECT_SECRET<br>admin_A: SELECT_SECRET<br>gestor_A: SELECT_SECRET<br>member_A: DELETE,INSERT,SELECT_SECRET,UPDATE<br>gestor_B: SELECT_SECRET<br>admin_B: SELECT_SECRET<br>multi_mA_aC: DELETE,INSERT,SELECT_SECRET,UPDATE |
| `withdrawals` | admin_A: DELETE,INSERT,UPDATE<br>gestor_A: DELETE,INSERT,UPDATE<br>member_A: DELETE,INSERT,UPDATE<br>gestor_B: DELETE,INSERT,UPDATE<br>admin_B: DELETE,INSERT,UPDATE<br>multi_mA_aC: DELETE,INSERT,UPDATE |

Ampliações (SELECT em `user_roles`, uma por header):

```
user_roles|admin_A|none SELECT: gestor_A:gestor,member_A:member,multi_mA_aC:member -> admin_A:admin
user_roles|admin_A|hdr_A SELECT: gestor_A:gestor,member_A:member,multi_mA_aC:member -> admin_A:admin
user_roles|admin_A|hdr_B SELECT: gestor_A:gestor,member_A:member,multi_mA_aC:member -> admin_A:admin
user_roles|admin_A|hdr_C SELECT: gestor_A:gestor,member_A:member,multi_mA_aC:member -> admin_A:admin
user_roles|admin_A|hdr_garbage SELECT: gestor_A:gestor,member_A:member,multi_mA_aC:member -> admin_A:admin
user_roles|admin_B|none SELECT: gestor_B:gestor -> admin_B:admin
user_roles|admin_B|hdr_A SELECT: gestor_B:gestor -> admin_B:admin
user_roles|admin_B|hdr_B SELECT: gestor_B:gestor -> admin_B:admin
user_roles|admin_B|hdr_C SELECT: gestor_B:gestor -> admin_B:admin
user_roles|admin_B|hdr_garbage SELECT: gestor_B:gestor -> admin_B:admin
user_roles|multi_mA_aC|none SELECT: gestor_A:gestor,member_A:member,multi_mA_aC:member -> multi_mA_aC:admin,multi_mA_aC:member
user_roles|multi_mA_aC|hdr_A SELECT: gestor_A:gestor,member_A:member,multi_mA_aC:member -> multi_mA_aC:admin,multi_mA_aC:member
user_roles|multi_mA_aC|hdr_B SELECT: gestor_A:gestor,member_A:member,multi_mA_aC:member -> multi_mA_aC:admin,multi_mA_aC:member
user_roles|multi_mA_aC|hdr_C SELECT: ∅ -> multi_mA_aC:admin,multi_mA_aC:member
user_roles|multi_mA_aC|hdr_garbage SELECT: gestor_A:gestor,member_A:member,multi_mA_aC:member -> multi_mA_aC:admin,multi_mA_aC:member
```

## 7. Decisões aprovadas (15/10/2026)

1. WhatsApp fora do escopo agora: nada muda; pendências documentadas (3.7).
2. Configurações graváveis por qualquer membro: restringir a escrita a super admin ou admin/gestor, **sem quebrar tela**. Aplicado onde nenhuma tela de member grava; o resto foi listado (3.4).
3. F5: o admin de tenant acessa drill-down e CSV de conversão. Mantido e documentado.
4. Senha SMTP em texto puro: follow-up.
5. Funções `SECURITY DEFINER`: sem EXECUTE para `PUBLIC`/`anon` (3.6).
6. `sms_effective_pricing` expondo custo: follow-up.

## 8. Comunicação, riscos residuais e follow-ups

**Comunicação** (changelog e suporte):

> "Reforçamos as permissões do banco. Saldos, extratos, pedidos e preços de créditos SMS, depósitos, saques, logs de auditoria e vínculos de equipe só podem ser alterados pelos fluxos oficiais. As configurações de Short.io, webhooks, automação e dashboards só podem ser alteradas por administradores e gestores. A leitura não muda. Credenciais (tokens da Meta, senhas SMTP, chaves de provedores de voz, segredos de webhook) não são mais devolvidas por consultas diretas. Administradores de conta passam a abrir o portal de créditos SMS e o detalhamento de conversão."

Só é afetado quem usa a API REST do Supabase diretamente com o JWT de um usuário. Não há indício disso no repositório (`scripts/` usa service_role).

**Riscos residuais e follow-ups:**

1. WhatsApp: todos os itens da seção 3.7, inclusive a exfiltração de telefones via `whatsapp_external_integrations.url`. **Prioridade alta.**
2. Configurações ainda graváveis por member (3.4): `send_window_settings`, `marketing_integrations`, `gamification_settings`, `dispatch_pause_state` e o catálogo de IA. Para restringir, primeiro o servidor e a UI precisam passar a exigir admin/gestor.
3. Senhas em texto puro em `email_smtp_configs.password_encrypted` (e no proxy de WhatsApp). O super admin vê a senha SMTP na tela `/email`. Proposta: criptografar com chave do servidor, como em `META_TOKEN_ENCRYPTION_KEY`, e nunca devolver ao cliente.
4. `sms_effective_pricing` (e, por ela, `sms_credit_summary`) devolve `provider_cost_per_sms`, ou seja, a margem, a qualquer membro. Proposta: omitir o custo para quem não é super admin.
5. Funções DEFINER que continuam com EXECUTE para `authenticated` e não checam o chamador. Não achei outra além das 2 tratadas, mas convém revisar cada função nova. Os default privileges ainda dão EXECUTE a `anon` em funções novas; proposta: `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM anon`, avaliado à parte.
6. `anon` mantém SELECT (negado pela RLS) e, no PG17, o privilégio MAINTAIN. Os default privileges de `supabase_admin` não podem ser alterados por `postgres`.
7. O rollback restaura grants a partir do snapshot de 15/10. Se uma tabela nova for criada entre agora e o rollback, regenere com `sec01-generate.mjs`.

## 9. Rollout

1. CON-08 já aplicada. A SEC-01 não exige deploy de código.
2. Aplicar a migration. Ela só faz DDL de política, GRANT/REVOKE e cria uma função; `lock_timeout = 5s` evita fila atrás de locks em `deposits`/`withdrawals`. Se o lock não sair, a transação inteira é desfeita.
3. Smoke test:
   - como **member**: `/creditos-sms`, `/`, `/players`, `/whatsapp`, janela de envio e `/treino-ia`;
   - como **admin**: `/creditos-sms`, `/tenants` (convidar e trocar papel), `/links/configuracoes` (salvar) e o relatório de conversão (drill-down);
   - como **super admin**: `/email`, o console de créditos (ajustar o saldo de um tenant de teste), zerar dashboards e pausar automação;
   - conferir que o dispatcher de SMS continua reservando campanhas.

## Apêndice A — SQL de rollback

Arquivo: `supabase/tests/rls/rollback_20261015100000.sql`. Ele volta ao estado da CON-08: a matriz confirma rollback × CON-08 = 0 diferenças, inclusive nos privilégios de tabela e no EXECUTE das funções. **Reabre os achados.**

```sql
-- ROLLBACK of 20261015100000_fix_rls_privilege_escalation.sql (SEC-01).
-- Restores the state left by CON-08 (20261015090000) as captured read-only in production on
-- 2026-10-15 (supabase/tests/rls/prod_acl_2026-10-15.json) — i.e. it REOPENS F1–F4/F6.
-- Use only if a legitimate flow broke and cannot be fixed forward. Checked by
-- supabase/tests/rls/sec01-matrix.mjs (rollback × CON-08 = 0 differences).
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS tenant_sms_credit_balances_tenant_select ON public.tenant_sms_credit_balances;
DROP POLICY IF EXISTS tenant_sms_credit_balances_super_admin_write ON public.tenant_sms_credit_balances;
DROP POLICY IF EXISTS tenant_sms_credit_balances_tenant_rls ON public.tenant_sms_credit_balances;
CREATE POLICY tenant_sms_credit_balances_tenant_rls ON public.tenant_sms_credit_balances
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS sms_credit_ledger_tenant_select ON public.sms_credit_ledger;
DROP POLICY IF EXISTS sms_credit_ledger_super_admin_write ON public.sms_credit_ledger;
DROP POLICY IF EXISTS sms_credit_ledger_tenant_rls ON public.sms_credit_ledger;
CREATE POLICY sms_credit_ledger_tenant_rls ON public.sms_credit_ledger
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS sms_credit_orders_tenant_select ON public.sms_credit_orders;
DROP POLICY IF EXISTS sms_credit_orders_super_admin_write ON public.sms_credit_orders;
DROP POLICY IF EXISTS sms_credit_orders_tenant_rls ON public.sms_credit_orders;
CREATE POLICY sms_credit_orders_tenant_rls ON public.sms_credit_orders
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS tenant_sms_pricing_tenant_select ON public.tenant_sms_pricing;
DROP POLICY IF EXISTS tenant_sms_pricing_super_admin_write ON public.tenant_sms_pricing;
DROP POLICY IF EXISTS tenant_sms_pricing_tenant_rls ON public.tenant_sms_pricing;
CREATE POLICY tenant_sms_pricing_tenant_rls ON public.tenant_sms_pricing
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS deposits_tenant_select ON public.deposits;
DROP POLICY IF EXISTS deposits_super_admin_write ON public.deposits;
DROP POLICY IF EXISTS deposits_tenant_rls ON public.deposits;
CREATE POLICY deposits_tenant_rls ON public.deposits
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS withdrawals_tenant_select ON public.withdrawals;
DROP POLICY IF EXISTS withdrawals_super_admin_write ON public.withdrawals;
DROP POLICY IF EXISTS withdrawals_tenant_rls ON public.withdrawals;
CREATE POLICY withdrawals_tenant_rls ON public.withdrawals
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS tenant_audit_logs_tenant_select ON public.tenant_audit_logs;
DROP POLICY IF EXISTS tenant_audit_logs_super_admin_write ON public.tenant_audit_logs;
DROP POLICY IF EXISTS tenant_audit_logs_tenant_rls ON public.tenant_audit_logs;
CREATE POLICY tenant_audit_logs_tenant_rls ON public.tenant_audit_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS user_roles_select_own ON public.user_roles;
DROP POLICY IF EXISTS user_roles_super_admin_write ON public.user_roles;
DROP POLICY IF EXISTS user_roles_tenant_rls ON public.user_roles;
DROP POLICY IF EXISTS user_roles_block_super_admin_escalation ON public.user_roles;
DROP POLICY IF EXISTS user_roles_block_tenant_admin_escalation ON public.user_roles;
CREATE POLICY user_roles_tenant_rls ON public.user_roles
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));
CREATE POLICY user_roles_block_super_admin_escalation ON public.user_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((role <> 'super_admin'::public.app_role) OR (select public.is_super_admin()))
  WITH CHECK ((role <> 'super_admin'::public.app_role) OR (select public.is_super_admin()));
CREATE POLICY user_roles_block_tenant_admin_escalation ON public.user_roles
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((role <> 'admin'::public.app_role) OR (select public.is_super_admin()))
  WITH CHECK ((role <> 'admin'::public.app_role) OR (select public.is_super_admin()));

DROP POLICY IF EXISTS meta_connections_tenant_rls ON public.meta_connections;
CREATE POLICY meta_connections_tenant_rls ON public.meta_connections
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS meta_oauth_states_tenant_rls ON public.meta_oauth_states;
CREATE POLICY meta_oauth_states_tenant_rls ON public.meta_oauth_states
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS email_unsubscribe_tokens_tenant_rls ON public.email_unsubscribe_tokens;
CREATE POLICY email_unsubscribe_tokens_tenant_rls ON public.email_unsubscribe_tokens
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS call_providers_super_admin_all ON public.call_providers;
DROP POLICY IF EXISTS call_providers_tenant_rls ON public.call_providers;
CREATE POLICY call_providers_tenant_rls ON public.call_providers
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS email_senders_super_admin_all ON public.email_senders;
DROP POLICY IF EXISTS email_senders_tenant_rls ON public.email_senders;
CREATE POLICY email_senders_tenant_rls ON public.email_senders
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS email_smtp_configs_super_admin_all ON public.email_smtp_configs;
DROP POLICY IF EXISTS email_smtp_configs_tenant_rls ON public.email_smtp_configs;
CREATE POLICY email_smtp_configs_tenant_rls ON public.email_smtp_configs
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS automation_settings_tenant_select ON public.automation_settings;
DROP POLICY IF EXISTS automation_settings_manager_write ON public.automation_settings;
DROP POLICY IF EXISTS automation_settings_tenant_rls ON public.automation_settings;
CREATE POLICY automation_settings_tenant_rls ON public.automation_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS dashboard_settings_tenant_select ON public.dashboard_settings;
DROP POLICY IF EXISTS dashboard_settings_manager_write ON public.dashboard_settings;
DROP POLICY IF EXISTS dashboard_settings_tenant_rls ON public.dashboard_settings;
CREATE POLICY dashboard_settings_tenant_rls ON public.dashboard_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS webhook_configs_tenant_select ON public.webhook_configs;
DROP POLICY IF EXISTS webhook_configs_manager_write ON public.webhook_configs;
DROP POLICY IF EXISTS webhook_configs_tenant_rls ON public.webhook_configs;
CREATE POLICY webhook_configs_tenant_rls ON public.webhook_configs
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = (select public.current_tenant_id()));

DROP POLICY IF EXISTS shortio_settings_tenant_select ON public.shortio_settings;
DROP POLICY IF EXISTS shortio_settings_manager_write ON public.shortio_settings;
DROP POLICY IF EXISTS shortio_settings_tenant_rls ON public.shortio_settings;
CREATE POLICY shortio_settings_tenant_rls ON public.shortio_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING ((select public.is_super_admin()) OR tenant_id = any ((select public.accessible_tenant_ids())::uuid[]))
  WITH CHECK ((select public.is_super_admin()) OR tenant_id = any ((select public.accessible_tenant_ids())::uuid[]));

-- managed_tenant_ids() is left in place (unused after rollback, harmless).

-- Table privileges of anon/authenticated exactly as before SEC-01 (production, 2026-10-15).
-- Tables that do not exist are skipped. Extra column-level SELECT grants left by SEC-01 on
-- call_providers/webhook_configs are covered by the table-level SELECT restored here.
DO $
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('activation_runs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('activation_runs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('admin_audit_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('admin_audit_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_feedback', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_feedback', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_intents', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_intents', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_synonyms', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_synonyms', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_training_examples', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('ai_training_examples', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('automation_settings', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('automation_settings', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_audio_generations', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_audio_generations', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_block_sms', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_block_sms', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_blocks', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_blocks', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_executions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_executions', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_history', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_history', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_post_action', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_post_action', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_progress', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_progress', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_scripts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flow_scripts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flows', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_flows', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_history', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_history', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_providers', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_providers', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_queue', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_queue', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_script_versions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_script_versions', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_scripts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('call_scripts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('campaign_drafts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('campaign_drafts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('cashback_payments', 'anon', 'SELECT, TRUNCATE, REFERENCES, TRIGGER'),
      ('cashback_payments', 'authenticated', 'SELECT, TRUNCATE, REFERENCES, TRIGGER'),
      ('channel_consent_audit', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('channel_consent_audit', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('channel_consents', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('channel_consents', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('click_events', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('click_events', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_attribution_issues', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_attribution_issues', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_attributions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_attributions', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_experiment_assignments', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_experiment_assignments', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_experiments', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_experiments', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_report_audit_events', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('conversion_report_audit_events', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dashboard_settings', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dashboard_settings', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('deposits', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('deposits', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dispatch_pause_state', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dispatch_pause_state', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dispatch_rate_state', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dispatch_rate_state', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dispatcher_runs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('dispatcher_runs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_automations', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_automations', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_campaigns', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_campaigns', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flow_blocks', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flow_blocks', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flow_leads', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flow_leads', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flow_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flow_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flows', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_flows', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_send_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_send_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_senders', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_senders', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_smtp_configs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_smtp_configs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_template_versions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_template_versions', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_templates', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('email_templates', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('events', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('events', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('experts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('experts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('financial_webhook_attempts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('financial_webhook_attempts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_blocks', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_blocks', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_leads', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_leads', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_templates', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flow_templates', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flows', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('flows', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('gamification_settings', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('gamification_settings', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_contact_limits', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_enrollments', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_enrollments', 'authenticated', 'SELECT, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_events', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_events', 'authenticated', 'SELECT, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_scan_jobs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_scan_jobs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_step_executions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_step_executions', 'authenticated', 'SELECT, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_steps', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_steps', 'authenticated', 'SELECT, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_voice_assets', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journey_voice_assets', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journeys', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('journeys', 'authenticated', 'SELECT, TRUNCATE, REFERENCES, TRIGGER'),
      ('lead_alerts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('lead_alerts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('lead_followups', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('lead_followups', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('link_click_snapshots', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('link_click_snapshots', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('link_dispatches', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('link_dispatches', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('link_tracking_sync_runs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('link_tracking_sync_runs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('marketing_ad_metrics_daily', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('marketing_ad_metrics_daily', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('marketing_integrations', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('marketing_integrations', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_ad_accounts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_ad_accounts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_connection_audit', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_connection_audit', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_connections', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_connections', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_oauth_states', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_oauth_states', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_sync_jobs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_sync_jobs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_sync_runs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('meta_sync_runs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('platform_pricing', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('platform_pricing', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('player_attributions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('player_attributions', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('players', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('players', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('precall_campaigns', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('precall_campaigns', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('precall_leads', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('precall_leads', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('precall_templates', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('precall_templates', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('rules', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('rules', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('send_window_settings', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('send_window_settings', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sessions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sessions', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('shortio_settings', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('shortio_settings', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_audiences', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_audiences', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_campaigns', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_campaigns', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_ledger', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_ledger', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_orders', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_orders', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_packages', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_packages', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_settings', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_credit_settings', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flow_daily_usage', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flow_daily_usage', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flow_leads', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flow_leads', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flow_steps', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flow_steps', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flows', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_flows', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_send_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_send_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_template_versions', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_template_versions', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_templates', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('sms_templates', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('suppressed_emails', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('suppressed_emails', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('system_alerts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('system_alerts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_audit_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_audit_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_daily_metrics', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_daily_metrics', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_sms_credit_balances', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_sms_credit_balances', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_sms_pricing', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenant_sms_pricing', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenants', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tenants', 'authenticated', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tracked_links', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('tracked_links', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('user_roles', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('user_roles', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('voice_contact_policies', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('voice_contact_policies', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('webhook_configs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('webhook_configs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('webhook_event_receipts', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('webhook_event_receipts', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('webhook_logs', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('webhook_logs', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('withdrawals', 'anon', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
      ('withdrawals', 'authenticated', 'INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    ) AS v(tbl, grantee, privs)
  LOOP
    IF to_regclass(format('public.%I', r.tbl)) IS NOT NULL THEN
      EXECUTE format('GRANT %s ON public.%I TO %I', r.privs, r.tbl, r.grantee);
    END IF;
  END LOOP;
END $;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT TRUNCATE ON TABLES TO authenticated;

-- Function EXECUTE exactly as before SEC-01.
GRANT EXECUTE ON FUNCTION public.admin_adjust_sms_credits(uuid,integer,text,text) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_clear_tenant_sms_pricing(uuid) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_users_with_usage(timestamp with time zone,timestamp with time zone) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_mark_sms_credit_order_paid(uuid,text,text,jsonb) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_platform_metrics(timestamp with time zone,timestamp with time zone) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_sms_credit_settings(numeric,numeric,integer,integer) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_tenant_sms_pricing(uuid,numeric,numeric) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_sms_credit_overview() TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_sms_credit_mutation(uuid,integer,text,text,text,text,text,jsonb,uuid) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_sms_credit_checkout(uuid,uuid,integer) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_totals(uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_webhook_token(uuid) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_tenant_webhook_token(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_webhook_config_secret(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_tenant_admin(uuid) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_sms_credits(uuid,integer,text,text,text,text) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_sms_credits(uuid,integer,text,text,text) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sms_credit_summary(uuid) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sms_effective_pricing(uuid) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_sms_campaigns(integer) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stuck_sms_campaigns() TO PUBLIC, anon, authenticated;
COMMIT;
```
