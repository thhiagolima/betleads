# Web Push (OneSignal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Canal `webpush` para campanhas: a casa instala pelo assistente do CRM, o jogador aceita o convite no site, e a casa dispara campanhas (todos os inscritos ou filtros do CRM) cobradas a R$ 0,01 por push, com clique rastreado por inscrição.

**Architecture:** Uma app OneSignal por origem (`tenant_webpush_apps`), criada pela API da organização ou colada à mão. Um loader servido pelo CRM inicializa o SDK v16 no site da casa e reporta cada inscrição para `push_subscriptions`; o vínculo com o jogador fica no nosso banco e os envios usam `include_subscription_ids`. Campanhas em `webpush_campaigns` são disparadas por um tick deps-injetado no molde de `processSmsCampaignTick`, com carteira (`wallet_reserve` item `webpush`) e `link_dispatches` por inscrição.

**Tech Stack:** TanStack Start (`createServerFn`, rotas `createFileRoute` em `src/routes/api/public`), Supabase Postgres (migrações + PGlite `*.db.test.ts`), vitest, OneSignal REST API (`https://api.onesignal.com`) e Web SDK v16.

**Spec:** `docs/superpowers/specs/2026-11-05-web-push-onesignal-design.md`

## Global Constraints

- Arquivo do service worker: caminho fixo `/push/onesignal/OneSignalSDKWorker.js`, conteúdo exato `importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");` (com quebra de linha final).
- SDK: `serviceWorkerPath: "push/onesignal/OneSignalSDKWorker.js"`, `serviceWorkerParam: { scope: "/push/onesignal/" }`, slidedown de push com `delay: { pageViews: 1, timeDelay: 0 }`, backoff padrão (não sobrescrever).
- Toda chamada à OneSignal leva `OneSignal-Usage: Betleads | Partner Integration`; app key no cabeçalho `Authorization: Key <key>`.
- Chaves de app só criptografadas com `encryptProviderCredentials` (`src/lib/secret-box.server.ts`, env `PROVIDER_CREDENTIALS_ENCRYPTION_KEY`); nunca voltam ao navegador.
- Preço: item de cobrança `webpush`, R$ 0,01 por push aceito pela OneSignal, `provider_unit_cost` 0. Nenhuma tela da casa mostra custo por inscrito ou custo da OneSignal.
- Não chamar `OneSignal.login`; envios só por `include_subscription_ids`.
- Lote de envio: no máximo 1.000 inscrições por chamada à OneSignal.
- Trava de rajada: por app, (enviados nos últimos 15 min + lote) ≤ 5 × inscrições ativas da app.
- Tags OneSignal: uma única tag `blk` = `push_subscriptions.click_key`.
- Novas tabelas: RLS ligado, sem policy (só `service_role`); server fns checam acesso e usam `supabaseAdmin`.
- Migrações novas começam em `20261210100000` (a maior em main é `20261201100100`).
- Casa demo: nada sai (guards `assertTenantNotDemo` / `assertTenantNotDemoForSend`, claim pula `is_demo_tenant`).
- Textos de UI em pt-BR. Envs novas: `ONESIGNAL_ORG_API_KEY`, `ONESIGNAL_ORG_ID` (só para o caminho automático).
- Verificação final de cada task: `npm run typecheck` e os testes da task; ao fim, `npm run lint`, `npm test`, `npm run build` (o build pega vazamento de `*.server` para o cliente).

## Review Focus

1. **Variações de origem** (`https://www.x.com` vs `https://x.com`, barra final, `http://`, caminho colado): `normalizeOrigin` aceita só https e devolve `https://host[:porta]`; o loader casa por `location.origin` exato; inscrição vinda de origem não cadastrada é recusada (403). → testes na Task 5 e Task 8.
2. **OneSignal aceita só parte do lote** (`errors.invalid_player_ids`): cobra só os aceitos, marca os recusados `inativa`, dispatches recusados `failed`. → teste na Task 11.
3. **Tick cai no meio do lote e roda de novo**: mesma `idempotency_key` na OneSignal e na carteira, nenhum push nem cobrança duplicada (`webpush_send_logs` único por campanha+inscrição). → teste na Task 11.
4. **Tag `blk` ausente ou Liquid não renderizada** (`{{ blk }}` literal, vazio, lixo): o clique redireciona para o link da campanha sem 404 e sem registrar clique. → teste na Task 9.
5. **`playerId` lixo vindo da página** (`""`, `"undefined"`, `"null"`, `"0"`, número, > 128 chars, ID inexistente): inscrição fica anônima, nenhum jogador é criado. → teste na Task 8.

---

## File Structure

- `supabase/migrations/20261210100000_webpush_core.sql` — tabelas, RPCs de claim/lote, `link_dispatches.channel`, rate limit, cron.
- `supabase/migrations/20261210100100_webpush_billing_item.sql` — item `webpush` no catálogo e na carteira.
- `supabase/migrations/20261210100200_audience_player_ids.sql` — `playerIds` opcional no RPC de público.
- `src/lib/webpush/onesignal.server.ts` — cliente HTTP da OneSignal.
- `src/lib/webpush/shared.ts` — puro, sem `.server`: `normalizeOrigin`, `WORKER_FILE_CONTENT`, `WORKER_PATH`, validações de texto, `PromptConfig`.
- `src/lib/webpush/worker-check.server.ts` — verificação do arquivo no site da casa.
- `src/lib/webpush/apps.server.ts` — leitura/gravação de apps, settings e inscrições (service role).
- `src/lib/webpush/webpush.functions.ts` — server fns da área de integração (casa e super admin).
- `src/lib/webpush/loader-script.ts` — gera o JS do loader (puro).
- `src/lib/webpush/subscriptions.server.ts` — `recordSubscription`.
- `src/lib/webpush/links.server.ts` — dispatches por inscrição e resolução do clique.
- `src/lib/webpush/campaigns.functions.ts` — criar/listar/cancelar campanhas, contar público.
- `src/lib/webpush/campaign-dispatch.server.ts` — `processWebpushCampaignTick` e `runScheduledWebpushCampaigns`.
- `src/routes/api/public/push/loader[.]js.ts`, `.../push/worker[.]js.ts`, `.../push/subscribe.ts`, `.../push/c.$campaignId.$key.ts` — rotas públicas.
- `src/components/webpush/*` — assistente, bloco do super admin, aba Convite.
- Modificados: `src/routes/webhooks.tsx` (aba), composer/hub/relatório de campanhas, listas de item de cobrança, `hooks/dispatch.ts`, `src/integrations/supabase/types.ts`.

---

### Task 1: Esquema base do web push

**Files:**
- Create: `supabase/migrations/20261210100000_webpush_core.sql`
- Test: `src/lib/webpush/webpush-core.db.test.ts`

**Interfaces:**
- Produces (tabelas):
  - `tenant_webpush_settings(tenant_id uuid pk → tenants cascade, public_token text unique not null default encode(gen_random_bytes(24),'hex'), prompt_text text not null default 'Quer receber promoções e avisos da casa?', accept_label text not null default 'Permitir', cancel_label text not null default 'Agora não', icon_url text, updated_at timestamptz)`
  - `tenant_webpush_apps(id uuid pk, tenant_id → tenants cascade, origin text not null, onesignal_app_id text not null unique, api_key_encrypted text not null, created_via text check in ('api','manual'), status text check in ('instalando','ativo','legado','desativado') default 'instalando', worker_verified_at, script_seen_at, player_linked_at, test_sent_at timestamptz, created_at, updated_at, unique(tenant_id, origin))`
  - `push_subscriptions(id uuid pk, tenant_id → tenants cascade, app_id → tenant_webpush_apps cascade, subscription_id text not null, player_id uuid → players on delete cascade null, click_key text not null unique default encode(gen_random_bytes(16),'hex'), status text check in ('ativa','inativa') default 'ativa', user_agent text, first_seen_at, last_seen_at, linked_at timestamptz, unique(app_id, subscription_id))`; índices `(tenant_id, status, id)` e `(tenant_id, player_id) where player_id is not null`.
  - `webpush_campaigns(id uuid pk, tenant_id, name, title, body, url, image_url null, audience_kind text check in ('todos','filtro'), audience_criteria jsonb null, target_player_ids uuid[] null, status text check in ('agendada','enviando','enviado','falhou','cancelada','pausada') default 'agendada', scheduled_at timestamptz not null, locked_at, locked_by uuid, sent_cursor uuid null, target_count int default 0, sent_count int default 0, failed_count int default 0, last_error text, created_by uuid, created_at, updated_at)`
  - `webpush_send_logs(id uuid pk, tenant_id, campaign_id → webpush_campaigns cascade, subscription_row_id → push_subscriptions cascade, player_id uuid null, app_id uuid, onesignal_notification_id text null, status text check in ('enviado','recusado'), billing_reference text null, created_at, unique(campaign_id, subscription_row_id))`; índice `(app_id, created_at)`.
- Produces (RPCs, `security definer`, grant só `service_role`):
  - `claim_due_webpush_campaigns(p_limit int) returns setof webpush_campaigns` — mesmo contrato de `claim_due_sms_campaigns` (`20261018110000_demo_tenant_skip_workers.sql:155`): `agendada` vencida ou `enviando` com lock > 5 min, pula casa demo, `FOR UPDATE SKIP LOCKED`, seta `status='enviando', locked_at=now(), locked_by=gen_random_uuid()`.
  - `webpush_campaign_batch(p_campaign uuid, p_after uuid, p_limit int) returns table(subscription_row_id uuid, subscription_id text, player_id uuid, app_id uuid, onesignal_app_id text, click_key text)` — inscrições `ativa` de apps `ativo`/`legado` da casa da campanha, `id > coalesce(p_after, '00000000-…')`, filtro `player_id = any(target_player_ids)` quando `audience_kind='filtro'`, sem as que já têm `webpush_send_logs` na campanha, `order by id limit p_limit`.
  - `webpush_app_sent_last_15m(p_app uuid) returns int` e `webpush_app_active_count(p_app uuid) returns int`.
- Também: `link_dispatches.channel` check passa a `('sms','whatsapp','email','webpush')`; seed em `channel_rate_limits` para provider `onesignal`, channel `webpush`: global 10/s burst 10, tenant_default 5/s burst 5 (mesmas colunas do seed em `20261015110000_journey_dispatch_leases_fairness_rate_limits.sql:421-428`); `cron.schedule('betleads-dispatch-webpush','* * * * *', …'https://betleads.io/api/public/hooks/dispatch?channel=webpush'…)` no padrão de `20261003143000_enable_validated_automation_crons.sql:20`.

- [ ] **Step 1: Write the failing test** — PGlite no estilo de `src/lib/billing/billing-price-book.db.test.ts` (use `createMigratedDb()` de `scripts/demo/test-support/migrated-pglite.mjs` e aplique a migração nova; se o cron/pg_net não existir no PGlite, envolva o `cron.schedule` num `do $$ … exception when undefined_function or invalid_schema_name …` e teste só o resto). Casos:
  - `webpush_campaign_batch` com 3 inscrições (1 inativa, 1 de app `desativado`, 1 ativa de app `legado`) devolve só a ativa da app legado.
  - `audience_kind='filtro'` com `target_player_ids = {p1}` devolve só inscrições de `p1`.
  - inscrição com `webpush_send_logs` na campanha não volta; `p_after` pula ids ≤ cursor.
  - `claim_due_webpush_campaigns(5)` pega campanha `agendada` vencida, ignora futura e casa demo, e retoma `enviando` com `locked_at` de 6 min atrás.
  - inserir `link_dispatches` com `channel='webpush'` passa; `channel='push'` falha.
  - apagar o jogador apaga as inscrições dele.
- [ ] **Step 2:** `npx vitest run src/lib/webpush/webpush-core.db.test.ts` → FAIL (migração não existe).
- [ ] **Step 3:** Escrever a migração.
- [ ] **Step 4:** Mesmo comando → PASS.
- [ ] **Step 5:** Acrescentar as tabelas/RPCs novos em `src/integrations/supabase/types.ts` à mão; `npm run typecheck` passa.
- [ ] **Step 6: Commit** `feat(webpush): core schema, claim and batch RPCs`

---

### Task 2: Item de cobrança `webpush`

**Files:**
- Create: `supabase/migrations/20261210100100_webpush_billing_item.sql`
- Modify: `src/lib/format.ts:42-56`, `src/lib/billing/pricing.server.ts:5,7`, `src/lib/billing/billing.functions.ts:61`, `src/lib/admin.functions.ts:179,219`, `src/lib/billing/wallet.server.ts:27`, `src/lib/finance/types.ts:100`, `src/lib/finance/finance-data.server.ts:324`, `src/lib/finance/kpis.ts:15`, `src/routes/admin.tsx:1086-1088`
- Test: `src/lib/billing/webpush-billing-item.db.test.ts`

**Interfaces:**
- Produces: `ReserveUsageArgs.item` aceita `"webpush"`; `BILLING_ITEM_LABEL.webpush = "Web Push"`.

- [ ] **Step 1: Write the failing test** (PGlite com `SCHEMA`/`SEED` de `src/lib/billing/billing-db-test-support.ts` + migrações de billing + a nova):
  - `billing_effective_price(<NORMAL>, 'webpush', now())` = `0.01`.
  - `wallet_reserve(<NORMAL>, 'webpush', 3, 'webpush_campaign', 'r1', 'k1')` debita 0,03; casa `INTERNO` sai isenta.
  - `wallet_summary` da casa inclui uma linha `webpush`.
  - `tenant_price_overrides` aceita item `webpush`.
- [ ] **Step 2:** `npx vitest run src/lib/billing/webpush-billing-item.db.test.ts` → FAIL.
- [ ] **Step 3:** Migração: trocar os checks de item de `billing_price_book` e `tenant_price_overrides` para `('sms','voice_30s','email','webpush')`; recriar `wallet_reserve` com o corpo idêntico ao de `20261022100100_billing_wallet.sql:223`, mudando só a lista da linha 258; recriar `wallet_summary` idêntico a `20261024100100_billing_wallet_alerts.sql:201`, acrescentando `('webpush')` no `values` da linha 252; `insert into billing_price_book (item, valid_from, unit_price, provider_unit_cost, free_monthly_units) values ('webpush','2026-11-01',0.01,0,0)`.
- [ ] **Step 4:** Atualizar as listas TS de item e o `SelectItem` do admin. `npm run typecheck` e o teste → PASS; `npx vitest run src/lib/billing src/lib/finance` continua verde.
- [ ] **Step 5: Commit** `feat(billing): webpush usage item at R$ 0,01`

---

### Task 3: Público com ids de jogadores

**Files:**
- Create: `supabase/migrations/20261210100200_audience_player_ids.sql`
- Modify: `src/lib/sms-audience-selection.server.ts:258` (`resolveAudienceForTenant`), `rpcAudience`
- Test: `src/lib/sms-audience-selection.server.test.ts` (existente, acrescentar casos) e `src/lib/webpush/audience-player-ids.db.test.ts`

**Interfaces:**
- Produces: `resolveAudienceForTenant(db, tenantId, rawCriteria, expertScope?, opts?: { includePlayerIds?: boolean }): Promise<ResolvedSmsAudience & { playerIds?: string[] }>`.

- [ ] **Step 1: Write the failing tests:**
  - db: `resolve_sms_audience_v2(_tenant, '{"…critério com 2 jogadores…","includePlayerIds":true}')` devolve `playerIds` com os 2 ids; sem a flag, a chave não existe (payload do SMS não cresce).
  - unit: com `opts.includePlayerIds`, regra → repassa a flag no `_criteria` do RPC e devolve `playerIds`; seleção → `playerIds` = ids carregados (após filtro de afiliado do expert).
- [ ] **Step 2:** rodar os dois → FAIL.
- [ ] **Step 3:** Migração recria `resolve_sms_audience_v2` a partir da definição mais recente (`20261126100000_expert_campaigns.sql:449`), idêntica, acrescentando ao objeto final (perto da linha 613) `'playerIds'` = `array_agg(id)` de `matched` só quando `coalesce((_criteria->>'includePlayerIds')::boolean,false)`. Garantir que `normalizeOrPermanent` não remove a flag (passar a flag fora do critério normalizado, juntando no objeto enviado ao RPC).
- [ ] **Step 4:** testes → PASS; `npx vitest run src/lib/sms-audience` verde.
- [ ] **Step 5: Commit** `feat(audience): optional player ids in audience resolution`

---

### Task 4: Cliente OneSignal

**Files:**
- Create: `src/lib/webpush/onesignal.server.ts`
- Test: `src/lib/webpush/onesignal.server.test.ts`

**Interfaces:**
- Produces:
  - `createOneSignalApp(input: { siteName: string; origin: string; iconUrl?: string | null }): Promise<{ appId: string }>` — `POST /apps` com `ONESIGNAL_ORG_API_KEY` (`Authorization: Key …`), `chrome_web_origin`, `site_name`, `chrome_web_default_notification_icon`, `organization_id` de `ONESIGNAL_ORG_ID` se definido.
  - `createOneSignalAppKey(appId: string): Promise<{ apiKey: string }>` — `POST /apps/{appId}/auth/tokens`, `name: "betleads"`.
  - `updateOneSignalAppIcon(appId: string, iconUrl: string): Promise<void>` — `PUT /apps/{appId}` com a chave da org; no caminho manual (sem org key) não faz nada.
  - `sendOneSignalPush(input: { appId; apiKey; subscriptionIds: string[]; title; body; url; imageUrl?; iconUrl?; idempotencyKey: string }): Promise<OneSignalSendResult>`
  - `type OneSignalSendResult = { ok: true; notificationId: string; invalidSubscriptionIds: string[] } | { ok: false; temporary: boolean; status: number; error: string }`
  - `deleteOneSignalSubscription(input: { appId; apiKey; subscriptionId }): Promise<void>` — `DELETE /apps/{appId}/subscriptions/{subscriptionId}`; 404 conta como sucesso (utilitário LGPD, sem tela).
  - `deterministicUuid(input: string): Promise<string>` — SHA-256 do texto formatado como UUID v4-like (`xxxxxxxx-xxxx-4xxx-8xxx-…`).
  - Erros de configuração (`ONESIGNAL_ORG_API_KEY` ausente) lançam `Error("OneSignal não configurado")`.

- [ ] **Step 1: Write the failing tests** (`vi.stubGlobal("fetch", …)`, restaurar env no `afterEach`, estilo `src/lib/domain-providers/infobip-domains.server.test.ts`):
  - `sendOneSignalPush` faz `POST https://api.onesignal.com/notifications?c=push` com body `{ app_id, include_subscription_ids, target_channel: "push", headings: {en: title, pt: title}, contents: {en: body, pt: body}, url, chrome_web_image, chrome_web_icon, idempotency_key }` e cabeçalhos `Authorization: Key <apiKey>` e `OneSignal-Usage: Betleads | Partner Integration`.
  - resposta `200 {id:"n1", errors:{invalid_player_ids:["s2"]}}` → `{ok:true, notificationId:"n1", invalidSubscriptionIds:["s2"]}`.
  - `200 {id:"", errors:["All included players are not subscribed"]}` → `{ok:true, notificationId:"", invalidSubscriptionIds: <todos>}`.
  - 429 e 503 → `temporary:true`; 400 → `temporary:false`; erro de rede → `temporary:true`, sem throw.
  - `deterministicUuid("a")` estável e diferente de `deterministicUuid("b")`, casa `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/`.
  - `createOneSignalApp` sem env lança "OneSignal não configurado"; com env devolve `appId` de `{id}`.
- [ ] **Step 2:** `npx vitest run src/lib/webpush/onesignal.server.test.ts` → FAIL.
- [ ] **Step 3:** Implementar (timeout `AbortSignal.timeout(20_000)`, env lida a cada chamada).
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(webpush): OneSignal REST client`

---

### Task 5: Utilitários puros e verificação do arquivo

**Files:**
- Create: `src/lib/webpush/shared.ts`, `src/lib/webpush/worker-check.server.ts`
- Test: `src/lib/webpush/shared.test.ts`, `src/lib/webpush/worker-check.server.test.ts`

**Interfaces:**
- Produces (`shared.ts`):
  - `WORKER_PATH = "/push/onesignal/OneSignalSDKWorker.js"`, `WORKER_FILE_CONTENT` (Global Constraints).
  - `normalizeOrigin(input: string): string | null` — trim; aceita com ou sem esquema (`bravabet365.com` → `https://bravabet365.com`); recusa `http://`, IP, `localhost`, host sem ponto; descarta caminho, query, barra; minúsculas; mantém `www.` como digitado.
  - `type PromptConfig = { promptText: string; acceptLabel: string; cancelLabel: string; iconUrl: string | null }` e `validatePromptConfig(input): PromptConfig` (texto 1–90, botões 1–15, ícone https ou null; lança `Error` com mensagem pt-BR).
  - `validateCampaignContent({title, body, url, imageUrl}): {...}` — título 1–64, mensagem 1–240, link https obrigatório, imagem https opcional.
  - `cleanPlayerId(raw: unknown): string | null` — string trim 1–128, recusa `""`, `"undefined"`, `"null"`, `"0"`, `"nan"` (case-insensitive) e não-string.
- Produces (`worker-check.server.ts`): `checkWorkerFile(origin: string): Promise<{ ok: true } | { ok: false; reason: "nao_encontrado" | "html" | "tipo_errado" | "conteudo_errado" | "inacessivel" }>` — GET `origin + WORKER_PATH` sem seguir redirect para outro host, timeout 10 s.

- [ ] **Step 1: Write the failing tests:**
  - `normalizeOrigin`: `"https://bravabet365.com/"` → `"https://bravabet365.com"`; `"bravabet365.com/promo?x=1"` → `"https://bravabet365.com"`; `"HTTPS://WWW.Bravabet365.com"` → `"https://www.bravabet365.com"`; `"http://bravabet365.com"`, `"localhost:3000"`, `"10.0.0.1"`, `""` → `null`.
  - `cleanPlayerId` para cada lixo da Review Focus 5 → `null`; `" 12345 "` → `"12345"`; 129 chars → `null`.
  - `validateCampaignContent` recusa link `http://` e título de 65 chars.
  - `checkWorkerFile`: 200 + `application/javascript` + conteúdo → ok; 404 → `nao_encontrado`; 200 `text/html` → `html`; 200 `text/plain` com conteúdo certo → `tipo_errado`; 200 JS sem `OneSignalSDK.sw.js` → `conteudo_errado`; fetch rejeita → `inacessivel`; 301 para outro host → `inacessivel`.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(webpush): origin, content validation and worker file check`

---

### Task 6: Apps da casa e ativação pelo super admin

**Files:**
- Create: `src/lib/webpush/apps.server.ts`, `src/lib/webpush/webpush.functions.ts`
- Test: `src/lib/webpush/apps.server.test.ts`

**Interfaces:**
- Consumes: Task 4 (`createOneSignalApp`, `createOneSignalAppKey`), Task 5 (`normalizeOrigin`), `encryptProviderCredentials`/`decryptProviderCredentials`, `assertSuperAdmin` (`src/lib/provider-governance.server.ts:7`), `assertTenantNotDemo`.
- Produces (`apps.server.ts`, recebem `db` = `supabaseAdmin` para teste com `createFakeDb()`):
  - `activateWebpushOrigin(db, input: { tenantId; origin; mode: "api" } | { tenantId; origin; mode: "manual"; appId: string; apiKey: string }): Promise<WebpushAppRow>` — normaliza; origem inválida → `Error("Endereço do site inválido")`; já existe para a casa → `Error("Este endereço já está ativado")`; garante linha em `tenant_webpush_settings`; grava `api_key_encrypted = encryptProviderCredentials({ apiKey })`.
  - `setWebpushAppStatus(db, { tenantId; appRowId; status: "legado" | "desativado" | "ativo" }): Promise<void>`
  - `loadAppCredentials(db, appRowId): Promise<{ appId: string; apiKey: string }>`
  - `type WebpushAppRow = { id; tenantId; origin; onesignalAppId; status; createdVia; workerVerifiedAt; scriptSeenAt; playerLinkedAt; testSentAt }` (sem chave).
- Produces (`webpush.functions.ts`, todas `createServerFn({method:"POST"}).middleware([requireSupabaseAuth])`): `activateWebpushOriginFn({ tenantId, origin, mode, appId?, apiKey? })` e `setWebpushAppStatusFn({ tenantId, appRowId, status })`, ambas com `assertSuperAdmin(context.userId)` e `assertTenantNotDemo(tenantId)`.

- [ ] **Step 1: Write the failing tests** (`createFakeDb()`, mock de `./onesignal.server`):
  - modo `api`: chama `createOneSignalApp({siteName: <nome da casa>, origin: "https://bravabet365.com"})` e `createOneSignalAppKey`, grava `created_via='api'`, `status='instalando'`, `api_key_encrypted` diferente da chave em claro e `loadAppCredentials` devolve a chave original.
  - modo `manual`: não chama a OneSignal, grava `created_via='manual'`.
  - segunda origem da mesma casa (`https://www.bravabet365.com`) cria outra linha; a mesma origem de novo lança "Este endereço já está ativado".
  - `WebpushAppRow` nunca contém `apiKey`/`api_key_encrypted`.
- [ ] **Step 2:** `npx vitest run src/lib/webpush/apps.server.test.ts` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(webpush): per-origin OneSignal apps with super admin activation`

---

### Task 7: Estado da integração, convite e push de teste

**Files:**
- Modify: `src/lib/webpush/apps.server.ts`, `src/lib/webpush/webpush.functions.ts`
- Test: `src/lib/webpush/integration-state.server.test.ts`

**Interfaces:**
- Consumes: Task 5 (`checkWorkerFile`, `validatePromptConfig`), Task 4 (`sendOneSignalPush`, `updateOneSignalAppIcon`), Task 6.
- Produces:
  - `getWebpushIntegration` (GET, casa: `resolveOperationalTenantId` + `checkTenantAdmin` → `canEdit`) → `{ enabled: boolean; canEdit: boolean; isSuperAdmin: boolean; loaderSnippet: string; playerSnippet: string; prompt: PromptConfig; apps: Array<WebpushAppRow & { workerUrl: string; activeSubscriptions: number; identifiedSubscriptions: number }>; current: WebpushAppRow | null }`. `current` = app mais recente com status `instalando`/`ativo`. `loaderSnippet` = `<script src="${PUBLIC_APP_URL}/api/public/push/loader.js?t=${public_token}" async></script>`; `playerSnippet` = `<script>window.betleads = { playerId: "ID_DO_JOGADOR" };</script>`.
  - `verifyWebpushWorkerFn({ appRowId })` → `checkWorkerFile`; ok grava `worker_verified_at`.
  - `saveWebpushPromptFn(PromptConfig)` (casa, `requireHouseAdmin`) → grava settings; se `iconUrl` mudou, `updateOneSignalAppIcon` em cada app `instalando`/`ativo` criada via `api`.
  - `listRecentWebpushSubscriptionsFn({ appRowId })` → últimas 10 inscrições `ativa` `{ id, createdAt, userAgent, playerLinked: boolean }`.
  - `sendWebpushTestFn({ subscriptionRowId })` → `sendOneSignalPush` com título `"Teste da Betleads"`, mensagem `"Se você está vendo isto, o push da casa está funcionando."`, url = origem da app, sem cobrança; ok grava `test_sent_at` e `status='ativo'`.
  - Todas validam que app/inscrição pertencem à casa do usuário.

- [ ] **Step 1: Write the failing tests:**
  - `current` ignora app `legado`; `enabled=false` sem nenhuma app.
  - `verifyWebpushWorkerFn` com `checkWorkerFile` mockado `{ok:false, reason:"html"}` não grava data e devolve o motivo.
  - teste de push grava `test_sent_at`, muda `status` para `ativo` e não chama `reserveUsage`.
  - inscrição de outra casa → `Error("Inscrição não encontrada")`.
  - `saveWebpushPromptFn` com botão de 16 chars recusa.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(webpush): integration state, prompt settings and test push`

---

### Task 8: Rotas públicas — loader, arquivo e inscrição

**Files:**
- Create: `src/lib/webpush/loader-script.ts`, `src/lib/webpush/subscriptions.server.ts`, `src/routes/api/public/push/loader[.]js.ts`, `src/routes/api/public/push/worker[.]js.ts`, `src/routes/api/public/push/subscribe.ts`
- Test: `src/lib/webpush/loader-script.test.ts`, `src/lib/webpush/subscriptions.server.test.ts`

**Interfaces:**
- Consumes: Task 5 (`cleanPlayerId`, `WORKER_FILE_CONTENT`), Task 1 tabelas.
- Produces:
  - `buildLoaderScript(config: { token: string; apiBase: string; apps: Array<{ origin: string; appId: string }>; prompt: PromptConfig }): string` — IIFE que: acha a app por `location.origin` (sem app → não faz nada); injeta `https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js` (`defer`); em `OneSignalDeferred.push` chama `init` com os valores de Global Constraints, `promptOptions.slidedown.prompts[0] = { type: "push", autoPrompt: true, text: { actionMessage, acceptButton, cancelButton }, delay }`, `notifyButton.enable=false`, `welcomeNotification.disable=true`; envia `report()` no init e em `PushSubscription` `change`; `report` faz `fetch(apiBase + "/api/public/push/subscribe?t=" + token, { method: "POST", body: JSON.stringify({ subscriptionId, optedIn, playerId: window.betleads?.playerId ?? null }) })` e, na resposta `{ clickKey }`, `OneSignal.User.addTag("blk", clickKey)`. Strings da config entram via `JSON.stringify` (nunca interpoladas cruas).
  - `GET /api/public/push/loader.js?t=` → `Content-Type: application/javascript; charset=utf-8`, `Cache-Control: public, max-age=300`; token desconhecido ou casa sem app → `/* betleads: web push inativo */` com 200.
  - `GET /api/public/push/worker.js` → `WORKER_FILE_CONTENT`, `Content-Type: application/javascript`, `Content-Disposition: attachment; filename="OneSignalSDKWorker.js"`.
  - `recordSubscription(db, input: { token: string; origin: string | null; subscriptionId: string | null; optedIn: boolean; playerId: unknown; userAgent: string | null; now: Date }): Promise<{ status: 200; clickKey: string | null } | { status: 403 | 404 | 400 }>` — token → casa (404); origin normalizada precisa ser de app `instalando`/`ativo` da casa (403); grava `script_seen_at` se nulo; sem `subscriptionId` → `{200, clickKey:null}`; upsert por `(app_id, subscription_id)` atualizando `last_seen_at`, `user_agent`, `status = optedIn ? 'ativa' : 'inativa'`; `cleanPlayerId` → busca `players(tenant_id, player_external_id)`; achou → `player_id`, `linked_at`, `player_linked_at` da app se nulo; não achou → mantém o vínculo anterior (não desfaz) e não cria jogador.
  - `POST /api/public/push/subscribe?t=` → chama `recordSubscription` com `request.headers.get("origin")`; CORS: `Access-Control-Allow-Origin` = a origem só quando aceita; `OPTIONS` 204; limite em memória de 60 req/min por IP (`x-forwarded-for` primeiro valor) → 429.

- [ ] **Step 1: Write the failing tests:**
  - loader: com 2 apps, o JS contém os dois `appId` mapeados por origem, `serviceWorkerPath":"push/onesignal/OneSignalSDKWorker.js"`, `"scope":"/push/onesignal/"`, e um `promptText` com `"</script><script>alert(1)` aparece escapado (sem `</script>` literal).
  - `recordSubscription`: origem `https://evil.com` → 403; app `legado` → 403; `playerId` para cada valor de Review Focus 5 → inscrição sem `player_id` e nenhum insert em `players`; `playerId` existente → liga e grava `player_linked_at`; segunda chamada com `optedIn:false` → `inativa`; chamada sem `subscriptionId` só grava `script_seen_at`; devolve o mesmo `clickKey` em chamadas repetidas.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar lib e rotas (padrão `createFileRoute(...)({ server: { handlers } })` de `src/routes/api/public/sms-webhook.ts:323`; arquivos com `[.]` como `src/routes/[.]well-known/oauth-authorization-server.ts`).
- [ ] **Step 4:** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(webpush): public loader, worker download and subscription endpoint`

---

### Task 9: Links rastreados por inscrição e rota de clique

**Files:**
- Create: `src/lib/webpush/links.server.ts`, `src/routes/api/public/push/c.$campaignId.$key.ts`
- Modify: `src/lib/shortio.server.ts` (exportar `getOrCreateFirstPartyTrackedLink`), `src/lib/shortio.server.ts:21` (`LinkTrackingChannel` += `"webpush"`)
- Test: `src/lib/webpush/links.server.test.ts`

**Interfaces:**
- Consumes: `getOrCreateFirstPartyTrackedLink(tenantId, url)`, `buildFirstPartyClickUrl(token)` (`src/lib/click-tracking.server.ts:138`), `assertDestinationAllowed`.
- Produces:
  - `campaignPushUrl(apiBase: string, campaignId: string): string` → `${apiBase}/api/public/push/c/${campaignId}/{{ blk | default: "x" }}`.
  - `prepareWebpushDispatches(db, input: { tenantId; campaignId; url; recipients: Array<{ subscriptionRowId: string; playerId: string | null }> }): Promise<void>` — um `tracked_links` first-party por campanha (`getOrCreateFirstPartyTrackedLink(tenantId, url)`), upsert em lote em `link_dispatches` com `channel='webpush'`, `source_type='campaign'`, `source_id=campaignId`, `idempotency_key = webpush:<campaignId>:<subscriptionRowId>:0`, `recipient_player_id` ou `recipient_hash = sha256hex("webpush:" + subscriptionRowId)`, `original_url = url`, `sent_url = campaignPushUrl(...)`, `send_status='prepared'`, `ignoreDuplicates`.
  - `markWebpushDispatches(db, { tenantId; campaignId; sentIds: string[]; failedIds: string[]; sentAt: Date }): Promise<void>` — por `subscriptionRowId`: `sent` + `sent_at` / `failed`.
  - `resolveWebpushClick(db, { campaignId: string; key: string }): Promise<string>` — URL de destino do 302: `key` que casa `/^[0-9a-f]{32}$/` e acha inscrição + dispatch `sent` da campanha → `buildFirstPartyClickUrl(tracking_token)`; caso contrário → `webpush_campaigns.url`; campanha inexistente → `PUBLIC_APP_URL`.
  - Rota `GET /api/public/push/c/$campaignId/$key` → `Response.redirect(url, 302)`; `HEAD` → 204.

- [ ] **Step 1: Write the failing tests:**
  - `prepareWebpushDispatches` com 1 identificada e 1 anônima → 2 linhas, uma com `recipient_player_id`, outra com `recipient_hash`; chamada repetida não duplica.
  - `resolveWebpushClick` com chave válida e dispatch `sent` → URL do clique first-party do token.
  - Review Focus 4: chave `"x"`, `""`, `"{{ blk }}"`, `"%7B%7B%20blk%20%7D%7D"`, hex de 32 chars desconhecido, e dispatch ainda `prepared` → URL da campanha.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** → PASS; `npx vitest run src/lib/shortio src/lib/click-tracking` verde.
- [ ] **Step 5: Commit** `feat(webpush): per-subscription tracked links and click redirect`

---

### Task 10: Criação, listagem e público das campanhas

**Files:**
- Create: `src/lib/webpush/campaigns.functions.ts`
- Test: `src/lib/webpush/campaigns.server.test.ts`

**Interfaces:**
- Consumes: Task 3 (`resolveAudienceForTenant(..., { includePlayerIds: true })`), Task 5 (`validateCampaignContent`), `assertDestinationAllowed`, `assertTenantCanOperate`, `assertTenantNotDemoForSend`, `resolveCurrentTenantId`.
- Produces (server fns com `requireSupabaseAuth`):
  - `type WebpushAudience = { kind: "todos" } | { kind: "filtro"; criteria: unknown }`
  - `countWebpushAudienceFn({ audience }) → { subscriptions: number; players: number | null; unitPrice: number; estimatedCost: number }` — `todos`: inscrições `ativa` de apps `ativo`/`legado`; `filtro`: inscrições ativas dos `playerIds`; `unitPrice` de `billing_effective_price(tenant,'webpush',now())` (0 se isenta).
  - `scheduleWebpushCampaignFn({ name; title; body; url; imageUrl?; audience; scheduledAt: string | null }) → { id }` — `scheduledAt` nulo = agora; futuro ≥ 60 s; sem app ativa → `Error("Web Push não instalado nesta casa")`; `filtro` grava `audience_criteria` e `target_player_ids` resolvidos na criação; `todos` grava `target_player_ids = null`.
  - `listWebpushCampaignsFn() → Array<{ id; name; status; scheduledAt; targetCount; sentCount; failedCount; createdAt }>`
  - `cancelWebpushCampaignFn({ id })` — só `agendada`/`pausada`.

- [ ] **Step 1: Write the failing tests:** link `http://` recusado; casa sem app → erro; `filtro` grava ids de jogadores e `todos` grava null; agendar 30 s no futuro recusa; `countWebpushAudienceFn` em casa `INTERNO` devolve `unitPrice: 0`; cancelar `enviado` recusa.
- [ ] **Step 2:** → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(webpush): campaign scheduling, listing and audience count`

---

### Task 11: Disparo das campanhas

**Files:**
- Create: `src/lib/webpush/campaign-dispatch.server.ts`
- Modify: `src/routes/api/public/hooks/dispatch.ts` (ramo `channel === "webpush"`), `src/lib/dispatch-rate.server.ts:7` (`Channel` += `"webpush"`)
- Test: `src/lib/webpush/campaign-dispatch.server.test.ts`

**Interfaces:**
- Consumes: Task 1 RPCs, Task 4 (`sendOneSignalPush`, `deterministicUuid`), Task 6 (`loadAppCredentials`), Task 9 (`prepareWebpushDispatches`, `markWebpushDispatches`, `campaignPushUrl`), `reserveUsage`/`refundUsage`, `acquire` de `src/lib/rate-limit/channel-budget.server.ts`.
- Produces:
  - `type WebpushCampaignRow` = linha de `webpush_campaigns` (de `src/integrations/supabase/types.ts`, Task 1).
  - `type WebpushDispatchDeps = { now(): Date; nextBatch(c, after, limit); appStats(appId): Promise<{ sentLast15m: number; active: number }>; credentials(appRowId); prepareDispatches; markDispatches; reserve(args: ReserveUsageArgs); refund(args: RefundUsageArgs); send(input): Promise<OneSignalSendResult>; deactivate(subscriptionRowIds: string[]); writeLogs(rows); updateCampaign(c, patch): Promise<boolean>; acquireBudget(tenantId): Promise<boolean> }`
  - `processWebpushCampaignTick(c: WebpushCampaignRow, deps: WebpushDispatchDeps, opts: { deadline: number; batchSize?: number /* 1000 */ }): Promise<{ status: string; sent: number; failed: number }>`
  - `canSendWithinBurstLimit(sentLast15m: number, batch: number, active: number): boolean` → `sentLast15m + batch <= 5 * active`.
  - `runScheduledWebpushCampaigns({ limit }): Promise<{ claimed: number; results: … }>` — `rpc("claim_due_webpush_campaigns")` e deps reais.
- Algoritmo por lote (o que os testes fixam):
  1. `nextBatch(c, c.sent_cursor, 1000)`; vazio → `enviado` (ou `falhou` se `sent_count = 0` e `failed_count > 0`), limpa lock.
  2. Agrupar por `app_id`. Por grupo: `canSendWithinBurstLimit` falso ou `acquireBudget(tenantId)` falso → para o tick sem mudar status (próximo minuto continua).
  3. `prepareDispatches`; `reserve({ item: "webpush", units: n, referenceType: "webpush_campaign", referenceId: "webpush:<campanha>:<primeiro subscriptionRowId>", idempotencyKey: igual })`; `Saldo insuficiente` → `pausada`, `last_error = "Saldo insuficiente"`.
  4. `send({ …, url: campaignPushUrl(...), idempotencyKey: await deterministicUuid(referenceId) })`.
  5. `ok:false, temporary` → `refund` e para o tick (cursor não anda). `ok:false` permanente → `refund`, todos `recusado`, segue.
  6. `ok:true` → recusados = `invalidSubscriptionIds`; se houver: `refund` e nova `reserve` com `units = aceitos`, `idempotencyKey = referenceId + ":ajuste"` (pula se aceitos = 0); `deactivate(recusados)`; `writeLogs` (`enviado`/`recusado`, `billing_reference`); `markDispatches`.
  7. Checkpoint `{ sent_cursor: último id do lote, sent_count, failed_count, locked_at: now }`; repete até `deadline`.

- [ ] **Step 1: Write the failing tests** (deps em memória, estilo `src/lib/sms-campaign-dispatch.server.test.ts`):
  - 2.500 inscrições → 3 chamadas de `send` (1.000/1.000/500), status final `enviado`, `sent_count = 2500`.
  - Review Focus 2: lote de 3 com `invalidSubscriptionIds:["s2"]` → `reserve` 3, `refund`, `reserve` 2 com chave `:ajuste`; `deactivate(["<row s2>"])`; logs 2 `enviado` + 1 `recusado`.
  - Review Focus 3: tick que lança depois do `send` e antes do checkpoint, rodado de novo com o mesmo estado → `send` recebe a mesma `idempotencyKey` e `reserve` a mesma chave (a carteira devolve `idempotent:true`); `writeLogs` não duplica.
  - `Saldo insuficiente` → `pausada` e `send` nunca chamado.
  - 429 → `refund`, cursor inalterado, status `enviando`.
  - `canSendWithinBurstLimit(4000, 1000, 1000)` = true; `(4001, 1000, 1000)` = false; trava falsa → nenhum `send`, status inalterado.
  - Inscrições de duas apps no mesmo lote → uma chamada por app com a credencial certa.
- [ ] **Step 2:** `npx vitest run src/lib/webpush/campaign-dispatch.server.test.ts` → FAIL.
- [ ] **Step 3:** Implementar e ligar o ramo `webpush` em `hooks/dispatch.ts` (`result = await runScheduledWebpushCampaigns({ limit: 10 })`) com `recordRun`.
- [ ] **Step 4:** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(webpush): campaign dispatcher with wallet, burst guard and idempotency`

---

### Task 12: Área de integração (assistente) e bloco do super admin

**Files:**
- Create: `src/components/webpush/webpush-integration-panel.tsx`, `src/components/webpush/webpush-setup-wizard.tsx`, `src/components/webpush/webpush-prompt-form.tsx`, `src/components/webpush/webpush-super-admin-block.tsx`
- Modify: `src/routes/webhooks.tsx:57-60` (aba `{ value: "webpush", label: "Web Push" }`)
- Test: `src/components/webpush/webpush-setup-wizard.test.tsx`

**Interfaces:**
- Consumes: Task 6 e 7 server fns, `getWebpushIntegration`, `useIsSuperAdmin()`.
- Comportamento:
  - Sem app: casa vê "O Web Push ainda não foi ativado para esta casa. Fale com a Betleads."; super admin vê o bloco de ativação (campo endereço do site pré-preenchido com `tenants.site_url`, opção "Criar app automaticamente" ou "Colar App ID e chave", botões Ativar). O bloco também lista as origens com status e ações "Marcar como antigo (domínio bloqueado)" e "Desativar", e "Adicionar novo domínio".
  - Com `current`: assistente de 4 etapas (mockup A) com indicador de etapa; botão "Próxima etapa" desabilitado até a etapa estar verificada (etapa 3 tem "Pular por enquanto"); o progresso vem de `worker_verified_at`, `script_seen_at`, `player_linked_at`, `test_sent_at`.
    1. Arquivo: passos numerados (baixar sem renomear; criar a pasta `push/onesignal` na raiz do site; colocar o arquivo; abrir o endereço e ver uma linha de texto), botão "Baixar OneSignalSDKWorker.js" (link para `/api/public/push/worker.js`), endereço completo copiável, "Verificar agora" com mensagem por motivo: `nao_encontrado` "Não encontramos o arquivo nesse endereço. Confira se a pasta é push/onesignal e o nome do arquivo não mudou."; `html` "O site devolveu uma página em vez do arquivo. Confira se o arquivo foi enviado para a pasta certa."; `tipo_errado` "O arquivo está lá, mas o servidor não o entrega como JavaScript. Peça para servir .js como application/javascript."; `conteudo_errado` "O arquivo foi alterado. Baixe de novo e envie sem editar."; `inacessivel` "Não conseguimos acessar o site agora. Tente de novo em alguns minutos.".
    2. Script: `loaderSnippet` com Copiar, instrução "cole no <head> de todas as páginas do site", "Já colei, verificar" (refaz a query).
    3. Jogador: `playerSnippet` com Copiar e explicação (mesmo ID enviado nos webhooks, definido antes do script, só quando logado).
    4. Teste: "Abra o site da casa neste navegador e aceite as notificações"; lista `listRecentWebpushSubscriptionsFn` com "Enviar teste".
  - Com tudo concluído: resumo por origem (inscritos ativos, identificados, status) e botão "Refazer verificação".
  - Aba "Convite" (`webpush-prompt-form`): campos do `PromptConfig` com pré-visualização da caixinha; salvar desabilitado se `!canEdit`.

- [ ] **Step 1: Write the failing test** (Testing Library, server fns mockadas): sem `worker_verified_at` mostra a etapa 1 com "Próxima etapa" desabilitado; resposta `html` mostra a mensagem de `html`; com `worker_verified_at` e `script_seen_at` abre na etapa 3 e "Pular por enquanto" leva à 4; casa sem app e usuário não super admin vê a mensagem de não ativado e nenhum botão Ativar.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar (padrão de seções de `src/components/house-config/*`, `PageTabs` já usado em `webhooks.tsx`).
- [ ] **Step 4:** → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(webpush): integration wizard, prompt settings and super admin block`

---

### Task 13: Canal no composer, hub e relatório

**Files:**
- Modify: `src/components/campaigns/channel-campaign-composer.tsx:124,138` e blocos de formulário/submit, `src/components/campaigns/campaigns-hub.tsx:100,126,141,151,163-176,233-284`, `src/components/campaigns/campaign-send-confirmation.ts:6,67`, `src/components/identity/identity.ts:86`, `src/lib/conversion-report.functions.ts:290-413`
- Create: `src/components/campaigns/webpush-campaign-fields.tsx`
- Test: `src/components/campaigns/campaign-send-confirmation.test.ts` (existente, acrescentar), `src/lib/conversion-report.functions.test.ts` (ou o teste existente do relatório)

**Interfaces:**
- Consumes: Task 10 server fns.
- Comportamento:
  - `Channel` += `"webpush"`, `channelMeta.webpush = { label: "Web Push", icon: Bell }`. O canal só aparece quando `getWebpushIntegration().enabled`.
  - `webpush-campaign-fields`: título, mensagem, link, imagem opcional, pré-visualização estilo notificação do Chrome; seletor de público "Todos os inscritos" | "Filtros do CRM" (o segundo reusa o seletor de público existente do composer); contagem via `countWebpushAudienceFn`.
  - Submit `webpush` → `scheduleWebpushCampaignFn`; sem rascunho (`campaign_drafts` não ganha o canal) e sem ramo de expert.
  - `campaignSendLabel` com `channel: "webpush"` → "Enviar para N inscritos · custo estimado R$ X" (ou "isento" quando `unitPrice` 0).
  - Hub: query `listWebpushCampaignsFn`, linhas com `ChannelBadge` "Web Push", filtro `?newChannel=webpush`, ação cancelar.
  - Relatório: `getCampaignReportDetails` procura também em `webpush_campaigns` e devolve `channel: "webpush"`, enviados = `sent_count`, recusados = `failed_count`; cliques e depósitos vêm dos `link_dispatches` como nos outros canais; sem "entregue".

- [ ] **Step 1: Write the failing tests:** `campaignSendLabel({channel:"webpush", recipients: 1200, cost: 12, …})` contém "1.200 inscritos" e "R$ 12,00"; `getCampaignReportDetails` com id de `webpush_campaigns` devolve `channel: "webpush"` e os contadores.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** → PASS; `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- [ ] **Step 5: Commit** `feat(webpush): web push channel in campaigns hub, composer and report`

---

### Task 14: Validação manual com a conta real (piloto Bravabet)

Precisa da conta OneSignal Growth criada e das envs `ONESIGNAL_ORG_API_KEY`/`ONESIGNAL_ORG_ID` (ou do caminho manual). Nada de código novo, exceto ajustes que a validação exigir.

- [ ] **Step 1:** Ativar uma origem de teste (domínio da Betleads com o arquivo publicado) pelo bloco do super admin; anotar se `POST /apps` funciona no Growth. Se falhar, usar "Colar App ID e chave" e registrar em `docs/` o resultado.
- [ ] **Step 2:** Percorrer as 4 etapas do assistente no Chrome desktop e Android; confirmar a caixinha com o texto da casa e o backoff ao clicar "Agora não".
- [ ] **Step 3:** Disparar uma campanha para "Todos os inscritos" e conferir na notificação recebida que o link aberto é `/api/public/push/c/<id>/<32 hex>` (a Liquid `{{ blk }}` renderizou). Se vier literal ou vazio, trocar para a alternativa (b) do design (5.5) antes de seguir.
- [ ] **Step 4:** Conferir: débito de R$ 0,01 por push na carteira, `link_dispatches` `sent`, clique em `click_events`, e um depósito de jogador identificado atribuído à campanha.
- [ ] **Step 5:** Só então ativar `https://bravabet365.com` e entregar o assistente à casa.
