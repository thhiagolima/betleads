# Tenant de demonstração — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar um tenant demo, clone anonimizado e congelado do Sorte Alta, onde nada entra, nada sai e nada pode ser conectado a algo real.

**Architecture:** Uma coluna `tenants.is_demo` protegida por trigger. Uma trava única no servidor (`assertTenantCanSendExternally`, fail-closed) chamada imediatamente antes de cada chamada a provedor. Uma segunda camada nos workers/RPCs que nunca reivindicam trabalho do demo. Bloqueio no servidor das ações de integração (`assertTenantNotDemo`). Script de clone anonimizado com varredura de PII que reverte se achar algo. Script de logins demo.

**Tech Stack:** TypeScript (TanStack Start, server functions), Supabase/Postgres (migrations em `supabase/migrations`), Vitest (+ PGlite para testes SQL, padrão `*.db.test.ts`), scripts Node `.mjs` com service role.

**Spec:** `docs/superpowers/specs/2026-10-16-tenant-demo-design.md`

## Global Constraints

- Tenant de origem: `03b73a96-aef7-414d-94fc-93a996f8256b` (slug `pixpgf`). Demo: nome `Casa Demo`, slug `demo`.
- Códigos de erro estáveis: `DEMO_SEND_BLOCKED` (envio/IA) e `DEMO_ACTION_BLOCKED` (ações de integração/equipe/config).
- Toda trava de envio é **fail-closed**: tenant nulo/indefinido/desconhecido → bloqueia.
- A trava fica **imediatamente antes** da chamada de rede ao provedor, não só na função de alto nível.
- Nada é gravado como enviado quando a trava bloqueia (sem `sms_send_logs`, débito de crédito, `link_dispatches`, `email_send_logs`, `call_history`).
- `is_demo` só muda via `service_role`. Usuário com `app_metadata.is_demo_user = true` só pode ter `user_roles` em tenant demo, e nunca `admin`/`super_admin`.
- Telefones falsos: `+55 11 90000-XXXX` (prefixo `5511900`, não roteável). E-mails falsos: `@example.com`. Domínio neutro de links: `https://demo.betleads.invalid`.
- Textos de UI: banner `Ambiente de demonstração — nenhuma mensagem é enviada e nada aqui é real`; envio bloqueado `Ambiente de demonstração: nenhum envio é feito`; estado vazio `Nenhum dado neste ambiente de demonstração`; IA `Indisponível no ambiente de demonstração`.
- Qualquer escrita em produção (migrations, clone `--apply`, logins) exige autorização explícita do usuário **no momento**.
- Migrations novas com prefixo `20261018…` (posterior a `20261017110000`).

## Review Focus

1. Chamador que chega ao provedor sem `tenantId` (call-flows SMS sem `playerId`, voz sem tenant) → deve bloquear, não enviar. Teste na Task 3 e Task 4.
2. Instância Evolution sem linha em `whatsapp_sessions` (ex.: criada fora do sistema) → `evolutionFetch` bloqueia `/message/*` e `/instance/*`. Teste na Task 5.
3. Lote de SMS com jogadores de tenant normal e flag virada para demo no meio do processo → o lote do demo não sai; cache de status tem TTL ≤ 5 s. Teste na Task 2.
4. Re-rodar o clone sobre um demo editado por prospects → resultado idêntico ao da primeira carga (idempotência), nenhuma linha órfã. Teste na Task 12.
5. Texto livre com PII fora das colunas estruturadas (nome do jogador no `content` do SMS, telefone em `metadata`) → a varredura pega e o script reverte. Teste na Task 12.

---

### Task 1: Flag `is_demo`, proteção da flag e trava de papéis demo (SQL)

**Files:**
- Create: `supabase/migrations/20261018100000_demo_tenant_flag.sql`
- Test: `src/lib/demo-tenant-flag.db.test.ts`

**Interfaces:**
- Produces: coluna `public.tenants.is_demo boolean not null default false`; função `public.is_demo_tenant(_tenant uuid) returns boolean` (stable, security definer, `search_path=public`; `true` só para tenant existente com `is_demo`; `null`/inexistente → `false`, porque é usada como filtro nos workers da Task 9 e linhas legadas com `tenant_id` nulo não podem sumir das filas. O fail-closed fica na trava TS da Task 2); trigger `trg_tenants_protect_is_demo` (BEFORE UPDATE OF is_demo: se `current_setting('request.jwt.claim.role', true)` ≠ `service_role` e `current_user` ≠ `postgres` → raise `DEMO_FLAG_PROTECTED`); trigger `trg_user_roles_demo_user_guard` (BEFORE INSERT/UPDATE em `user_roles`: se o usuário tem `raw_app_meta_data->>'is_demo_user' = 'true'` em `auth.users`, exige `tenant_id is not null`, `public.is_demo_tenant(tenant_id)` e `role in ('gestor','member')`, senão raise `DEMO_USER_ROLE_BLOCKED`). Também: `public.tenants_demo_ids() returns setof uuid`.

- [ ] **Step 1: Escrever o teste** (PGlite, schema mínimo `tenants`, `user_roles`, `auth.users`, seguindo `src/lib/tenant-backfill.db.test.ts`): `is_demo_tenant` retorna `true` para demo, `false` para normal, `false` para UUID inexistente e para `null`; UPDATE de `is_demo` com role `authenticated` falha com `DEMO_FLAG_PROTECTED`; com `service_role` passa; insert de `user_roles` de demo user em tenant normal falha com `DEMO_USER_ROLE_BLOCKED`; em tenant demo com `admin` falha; com `gestor` passa; usuário normal não é afetado.
- [ ] **Step 2:** `npx vitest run src/lib/demo-tenant-flag.db.test.ts` → FAIL (migration ausente).
- [ ] **Step 3:** Escrever a migration.
- [ ] **Step 4:** Rodar o teste → PASS.
- [ ] **Step 5:** Commit `feat(demo): tenant is_demo flag with protected updates and demo-user role guard`.

### Task 2: Travas de servidor `assertTenantCanSendExternally` / `assertTenantNotDemo`

**Files:**
- Modify: `src/lib/tenant-access.server.ts`
- Create: `src/lib/demo-tenant.ts` (erros e helpers sem dependência de servidor, para a UI importar)
- Test: `src/lib/demo-tenant-guard.test.ts`

**Interfaces:**
- Produces (em `src/lib/demo-tenant.ts`): `class DemoTenantBlockedError extends Error { code: "DEMO_SEND_BLOCKED" | "DEMO_ACTION_BLOCKED" }`; `isDemoBlockedError(e: unknown): e is DemoTenantBlockedError` (também reconhece mensagem serializada contendo o código, pois erros de server function chegam ao cliente como texto); constantes de texto da Global Constraints.
- Produces (em `tenant-access.server.ts`): `getTenantStatus` passa a selecionar `id,status,is_demo`; `assertTenantCanSendExternally(tenantId: string | null | undefined): Promise<void>` (nulo → `DemoTenantBlockedError("DEMO_SEND_BLOCKED")`; tenant inexistente → mesmo erro; `is_demo` → mesmo erro; suspenso/cancelado → erro atual de `assertTenantCanOperate`); `assertTenantNotDemo(tenantId: string): Promise<void>` (lança `DEMO_ACTION_BLOCKED`); `listDemoTenantIds(): Promise<string[]>`. Cache em memória por tenant com TTL de 5 s.

- [ ] **Step 1: Teste** com mock de `supabaseAdmin` (padrão de `call-flows.tenant.test.ts`): `assertTenantCanSendExternally(null)` e `(undefined)` rejeitam com `code === "DEMO_SEND_BLOCKED"`; tenant demo rejeita; inexistente rejeita; suspenso rejeita com a mensagem atual; normal resolve; após virar `is_demo` e avançar o relógio 6 s (`vi.useFakeTimers`), rejeita; `assertTenantNotDemo` rejeita com `DEMO_ACTION_BLOCKED`; `isDemoBlockedError(new Error("... DEMO_SEND_BLOCKED ..."))` é `true`.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar → PASS; `npm run typecheck` limpo.
- [ ] **Step 5:** Commit `feat(demo): fail-closed external send guard and demo action guard`.

### Task 3: Trava em SMS, e-mail, webhook externo, Short.io e ElevenLabs

**Files:**
- Modify: `src/lib/sms.functions.ts` (`sendSmsInternal`, junto do `assertTenantCanOperate` em ~:744-749; e `callShortBrasilSmsBulk` se mantido exportado), `src/lib/sms-bulk.server.ts` (`sendSmsBatch` ~:597 e `postBulk` :227), `src/lib/email-send.server.ts` (`sendInfobipEmail` após :80), `src/lib/whatsapp-external.server.ts` (`postWithRetry` :197 recebe `tenantId`; `sendExternalTriggerEvent` :244), `src/lib/shortio.server.ts` (`createShortioLink` :266, `createShortioLinksBulk` :964, `syncShortioMetrics` por tenant), `src/lib/calls.server.ts` (`callElevenLabs` :167 recebe `tenantId`), `src/lib/call-flows.server.ts:798` (passar `tenantId` ao SMS)
- Test: `src/lib/demo-send-guard.channels.test.ts`

**Interfaces:**
- Consumes: `assertTenantCanSendExternally` (Task 2).
- Produces: `postBulk`, `postWithRetry`, `createShortioLink`, `createShortioLinksBulk`, `callElevenLabs` ganham parâmetro obrigatório `tenantId: string`. A trava roda **antes** de qualquer insert de log/ledger em `sendSmsInternal`/`sendSmsBatch`/`sendInfobipEmail`, e também imediatamente antes do `fetch`.

- [ ] **Step 1: Teste** com `globalThis.fetch = vi.fn()` e tenant demo: para cada caminho (`sendSmsInternal`, `sendSmsBatch` com bulk ligado e desligado, `sendInfobipEmail`, `sendExternalTriggerEvent`, `createShortioLink`, `createShortioLinksBulk`, `callElevenLabs`) o resultado é rejeição/erro `DEMO_SEND_BLOCKED`, `fetch` tem `0` chamadas, e nenhum insert em `sms_send_logs`, `sms_credit_ledger`, `email_send_logs`, `link_dispatches`. Caso extra: `sendSmsInternal` sem `tenantId` e sem `playerId` → bloqueia (Review Focus 1). Caso controle: tenant normal chega ao `fetch`.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar e ajustar chamadores para passar `tenantId`.
- [ ] **Step 4:** Rodar o teste novo e `npm test` inteiro → PASS; typecheck limpo.
- [ ] **Step 5:** Commit `feat(demo): block SMS, email, external webhook, Short.io and ElevenLabs for demo tenants`.

### Task 4: Trava em voz (Infobip)

**Files:**
- Modify: `src/lib/infobip-voice.server.ts:71` (`InfobipVoiceOptions.tenantId` vira obrigatório), `src/lib/calls.server.ts:348` (`item.tenant_id`), `src/lib/calls.functions.ts:718` (`tenantId`), `src/lib/call-flows.server.ts:284` (`flowTenantId`), `src/lib/journeys.server.ts:929` (já passa)
- Test: `src/lib/demo-send-guard.voice.test.ts`

**Interfaces:**
- Consumes: `assertTenantCanSendExternally`.
- Produces: `callInfobipVoice(to: string, content: InfobipVoiceContent, options: InfobipVoiceOptions & { tenantId: string })`.

- [ ] **Step 1: Teste:** tenant demo → `DEMO_SEND_BLOCKED`, `fetch` 0 chamadas; `tenantId: ""` → bloqueia; normal → chama `fetch`.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar; o typecheck guia os chamadores.
- [ ] **Step 4:** Teste + `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat(demo): require tenant on voice calls and block demo tenants`.

### Task 5: Trava no transporte do WhatsApp (`evolutionFetch`)

**Files:**
- Modify: `src/lib/evolution.server.ts:18` (e `setEvolutionProxy` :143); `src/lib/whatsapp.functions.ts` (chamadas diretas a `fetch` para Evolution em :1729-1825, se enviam algo para a instância — passar pela mesma checagem)
- Test: `src/lib/demo-send-guard.whatsapp.test.ts`

**Interfaces:**
- Consumes: `assertTenantCanSendExternally`.
- Produces: `evolutionFetch(path, init)` — para paths que começam com `/message/`, `/instance/` (exceto `/instance/fetchInstances` usado no diagnóstico de super-admin), `/webhook/`, `/proxy/`, `/chat/`, extrai o nome da instância do último segmento do path, busca `whatsapp_sessions.tenant_id` por `instance_name` e chama `assertTenantCanSendExternally(tenantId)`. Instância sem linha → bloqueia. Para `/instance/create`, o nome vem de `init.body.instanceName`; a Task 7 bloqueia antes, aqui é a rede de segurança.

- [ ] **Step 1: Teste:** `/message/sendText/inst-demo` com sessão do tenant demo → `DEMO_SEND_BLOCKED`, `fetch` 0; `/message/sendText/inst-desconhecida` → bloqueia (Review Focus 2); `/instance/connect/inst-demo` → bloqueia; `/message/sendText/inst-normal` → chama `fetch`.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar + `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(demo): guard Evolution transport by instance tenant`.

### Task 6: IA bloqueada para demo

**Files:**
- Modify: `src/lib/ai.functions.ts` e `src/lib/email-ai.functions.ts` (antes de criar o provider/gerar), `supabase/functions/ai-player-insights/tenant-scope.ts` (após resolver o tenant, consultar `tenants.is_demo`; demo → resposta 403 `{ error: "DEMO_SEND_BLOCKED" }`)
- Test: `src/lib/demo-ai-block.test.ts`; estender `src/lib/ai-player-insights-tenant.test.ts`

**Interfaces:**
- Consumes: `assertTenantCanSendExternally`.

- [ ] **Step 1: Teste:** cada handler de IA com tenant demo rejeita `DEMO_SEND_BLOCKED` sem chamar o provider (mock do `fetch`/provider com 0 chamadas); a função de escopo da edge function devolve 403 para demo.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar → PASS.
- [ ] **Step 5:** Commit `feat(demo): block AI features for demo tenants`.

### Task 7: Ações de integração, equipe e configuração bloqueadas

**Files:**
- Modify: `src/lib/whatsapp.functions.ts` (`createWhatsappSession` :50, `connectWhatsappSession` :127, disconnect/delete/rename :312-360, `configureEvolutionWebhook` :580, `sendWhatsappMessage` :860, `sendWhatsappMediaInternal` :1014, `sendToLeadFromSession` :1344), `src/lib/whatsapp-proxies.functions.ts` (:38-146), `src/lib/meta.functions.ts` (:268, :453-587), `src/lib/marketing.functions.ts` (:618), `src/lib/sms-credits.functions.ts` (:203), `src/lib/webhooks.functions.ts` (:35, :57, :78, :111), `src/lib/shortio.functions.ts` (:153), `src/lib/whatsapp-external.functions.ts` (:45, :79) e `whatsapp-external.server.ts` (`saveExternalIntegrationFor` :66), `src/lib/tenants.functions.ts` (`updateTenantSettings` :527, `addUserToTenant` :585, `updateTenantUserRole` :683, `removeUserFromTenant` :742)
- Test: `src/lib/demo-action-guard.coverage.test.ts`

**Interfaces:**
- Consumes: `assertTenantNotDemo` (Task 2). Chamar logo após resolver o tenant em cada handler. Super-admin **também** é bloqueado nessas ações no tenant demo (o demo nunca deve ser conectado).

- [ ] **Step 1: Teste de cobertura estático:** para cada par `[arquivo, nome da função exportada]` da lista acima, extrair o corpo do handler do código-fonte e afirmar que contém `assertTenantNotDemo(`. Mais um teste comportamental para `saveExternalIntegrationFor` e `addUserToTenant` com tenant demo → `DEMO_ACTION_BLOCKED`.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar + typecheck → PASS.
- [ ] **Step 5:** Commit `feat(demo): block integration, billing, team and settings actions on demo tenants`.

### Task 8: Entradas fechadas (webhook da casa, espelho Expert, Evolution, scripts)

**Files:**
- Modify: `src/routes/api/public/webhook.$token.$evento.ts` (~:53-87: tenant demo → `403`, sem gravar `webhook_logs`), `src/lib/webhook-process.server.ts:1035-1045` (excluir tenants demo como destino do espelho), `src/lib/evolution-webhook.ts` (~:279: sessão de tenant demo → ignorar com 200), `src/lib/click-tracking.server.ts` (~:518: dispatch de tenant demo → não grava `click_events` nem atualiza contadores; redireciona para página neutra), `src/routes/u.$token.tsx` (token de tenant demo → não grava supressão), `scripts/sync-sortealta-export.mjs`, `scripts/import-sortealta-leads.mjs`, `scripts/sync-sorte-alta-crm-flows.mjs` (abortar se `tenants.is_demo`)
- Test: `src/lib/demo-inbound.test.ts`

- [ ] **Step 1: Teste:** POST no webhook com token do demo → status 403 e 0 inserts em `webhook_logs`; espelho Expert com um tenant demo cujo metadata casa o affiliate → não reprocessa nele; evento Evolution de instância demo → nenhum write; clique num `tracking_token` do demo → 0 inserts em `click_events` e contadores de `link_dispatches` inalterados.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar (scripts: checagem simples após resolver o tenant, sem teste).
- [ ] **Step 4:** Rodar → PASS.
- [ ] **Step 5:** Commit `feat(demo): reject inbound traffic for demo tenants`.

### Task 9: Workers e crons pulam o demo

**Files:**
- Create: `supabase/migrations/20261018110000_demo_tenant_skip_workers.sql`
- Modify (TS): `src/lib/orchestrator.server.ts:450` (sair cedo se demo), `src/lib/automation.server.ts` (`evaluateAllPlayers` :172, `runDispatcher` :465), `src/lib/precall-dispatcher.server.ts:9`, `src/lib/calls.server.ts:264`, `src/lib/call-flows.server.ts:446`, `src/lib/cashback-catchup.server.ts:26`, `src/lib/shortio.server.ts:677`, `src/lib/journeys.server.ts:1385` (e consultas diretas a `journey_enrollments` do dispatcher), `src/lib/journey-crossing.server.ts:164`, `src/lib/infobip-voice-reconciliation.server.ts:148`, `src/lib/meta.functions.ts:941`
- Test: `src/lib/demo-workers-skip.migrations.test.ts`, `src/lib/demo-workers-skip.test.ts`

**Interfaces:**
- Consumes: `public.is_demo_tenant`, `public.tenants_demo_ids()` (Task 1), `listDemoTenantIds()` (Task 2).
- Migration: `create or replace` da **definição mais recente** (a última migration que a define) de cada função abaixo, idêntica exceto pelo filtro `and not public.is_demo_tenant(<alias>.tenant_id)` no conjunto reivindicado/iterado: `claim_call_flow_progress`, `claim_due_email_campaigns`, `claim_due_journey_enrollments`, `claim_due_sms_campaigns`, `claim_email_flow_leads`, `claim_journey_enrollments_leased`, `claim_journey_scan_jobs`, `claim_meta_sync_jobs`, `claim_sms_flow_leads`, `claim_webhook_logs_for_replay`, `process_journey_level_outbox`, `recover_stuck_email_campaigns`, `recover_stuck_email_leads`, `recover_stuck_sms_campaigns`, `recover_stuck_sms_leads`, `refresh_recent_dashboard_metrics_slot`, `refresh_crm_results_recent`, `check_crm_results_recent`. Reagendar `betleads-orchestrate-tenants` com `where not t.is_demo`. `claim_webhook_event` fica de fora (entrada já é recusada na Task 8).
- TS: workers que leem tabelas direto filtram `.not("tenant_id", "in", \`(${ids})\`)` quando `ids.length > 0`.

- [ ] **Step 1: Teste estático** (`*.migrations.test.ts`): para cada nome da lista, achar a última migration (ordem lexical) com `function public.<nome>` e afirmar que o corpo contém `is_demo_tenant`; afirmar que o último `cron.schedule('betleads-orchestrate-tenants'` contém `is_demo`. **Teste comportamental** (PGlite) para `claim_sms_flow_leads`: com uma linha do demo e uma de tenant normal, só a normal é reivindicada. **Teste TS:** `orchestrate` com tenant demo não lê nada além do tenant; `syncShortioMetrics` não chama `fetch` para links do demo.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar migration e TS.
- [ ] **Step 4:** Rodar + `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(demo): workers and crons never claim demo tenant work`.

### Task 10: Demo fora das visões globais

**Files:**
- Modify: as server functions de totais de plataforma em `src/lib/admin.functions.ts` (faturamento/consumo SMS, créditos, saúde), as consultas de "Visão da plataforma" e `src/lib/sms-credits.functions.ts` (:219-421); `getTenantSwitcher` em `src/lib/tenants.functions.ts:377` passa a retornar `is_demo`; lista de tenants do super-admin em `src/routes/tenants.tsx` mostra selo "demo"
- Test: `src/lib/demo-global-views.test.ts`

- [ ] **Step 1: Teste:** cada total global com um tenant demo e um normal no mock soma só o normal; `getTenantSwitcher` devolve `is_demo`.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar (o builder localiza cada agregado global com `grep` por `from("tenants")`/`sms_credit_ledger` sem filtro de tenant em `admin.functions.ts`).
- [ ] **Step 4:** Rodar → PASS.
- [ ] **Step 5:** Commit `feat(demo): exclude demo tenants from platform-wide totals`.

### Task 11: UI do modo demo

**Files:**
- Create: `src/components/demo-banner.tsx`, `src/hooks/use-is-demo-tenant.ts`
- Modify: layout raiz (onde `TenantStatusGate` é montado) para o banner; `src/routes/whatsapp.tsx` (Nova sessão, QR, proxies), `src/routes/midia-ltv.tsx`, `src/routes/creditos-sms.tsx`, `src/routes/sms.tsx:343`, `src/routes/webhooks.tsx`, `src/routes/links.configuracoes.tsx`, `src/components/whatsapp/external-integration-tab.tsx`, `src/routes/tenants.tsx` (convites/papéis/configurações), telas de IA; tratamento global de erro de server function que mostra toast com o texto de envio bloqueado quando `isDemoBlockedError`; estados vazios das áreas sem dados (WhatsApp, Meta/mídia, IA, pré-call, fluxos)
- Test: `src/components/demo-banner.test.tsx`

**Interfaces:**
- Consumes: `is_demo` de `getTenantSwitcher` (Task 10), `isDemoBlockedError` e textos (Task 2).
- Produces: `useIsDemoTenant(): boolean`.

- [ ] **Step 1: Teste:** banner renderiza o texto exato quando `useIsDemoTenant()` é `true` e nada quando `false`.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar; botões bloqueados ficam `disabled` com tooltip do texto de envio bloqueado.
- [ ] **Step 4:** Rodar + typecheck + `npm run lint` → PASS. Verificar no app local (`/run`) com um tenant demo local.
- [ ] **Step 5:** Commit `feat(demo): demo banner, disabled integration actions and empty states`.

### Task 12: Script de clone anonimizado (também é o reset)

**Files:**
- Create: `scripts/demo/clone-tenant-demo.mjs` (CLI: `--source pixpgf --target demo [--apply]`, dry-run por padrão), `scripts/demo/anonymize.mjs` (funções puras), `scripts/demo/pii-scan.mjs` (varredura), `scripts/demo/placeholders/` (áudio `.mp3` curto neutro e imagem `.png` neutra)
- Test: `scripts/demo/anonymize.test.ts`, `scripts/demo/pii-scan.test.ts`, `scripts/demo/clone-tenant-demo.db.test.ts` (confirmar que o `include` do Vitest pega `scripts/**`; senão colocar os testes em `src/lib/demo-clone/` importando de `scripts/demo/`)

**Interfaces:**
- `anonymize.mjs` exporta: `makeFaker(seed: string)` (determinístico pelo seed = id de origem, garante idempotência); `fakePlayer(sourcePlayer) -> { nome, telefone, email, cpf, data_nascimento, player_external_id, affiliate_id, expert }` (telefone `+5511900` + 6 dígitos, e-mail `@example.com`, CPF com dígitos verificadores válidos, nascimento ±2 anos da original); `remapId(table, sourceId) -> uuid` (UUID v5 com namespace fixo do demo, determinístico); `rewriteText(text, ctx) -> string` (troca nomes/telefones/e-mails dos jogadores do contexto, `Sorte Alta`/`sortealta`/`pixpgf`/domínios da casa e links curtos reais pelos equivalentes do demo); `scrubJson(value, keepKeys: string[]) -> object`.
- `pii-scan.mjs` exporta: `scanTenant(client, tenantId, needles) -> Array<{ table, column, id, needle }>`, onde `needles` contém os telefones, e-mails, CPFs, `player_external_id`s, `provider_message_id`s, `shortio_link_id`s, UUIDs e domínios do Sorte Alta.
- `clone-tenant-demo.mjs`: em **uma transação**: cria/atualiza o tenant demo (`is_demo=true`, `status='active'`, `webhook_token`/`webhook_secret` aleatórios, `webhook_hmac_enforced=true`), apaga todas as linhas `tenant_id = demo` (ordem reversa de FK), copia as tabelas da lista "Clonar" da spec seção 6 aplicando as regras (IDs remapeados, PII falsa, `raw_payload`/`provider_response`/`last_callback`/`metadata`/`evidence` reduzidos às chaves que a UI lê, IDs de provedor/idempotência/hashes regenerados, links reescritos para `https://demo.betleads.invalid/...`, `tracking_token` novo), aponta mídias para os placeholders no Storage, roda `scanTenant` e, havendo **qualquer** acerto, faz `rollback` e sai com código 1. Depois do commit, roda uma vez os refreshes de agregados para o demo (ou copia os agregados de origem com IDs remapeados). Imprime contagens origem × demo por tabela.

- [ ] **Step 1: Testes unitários:** `fakePlayer` é determinístico (mesma entrada → mesma saída) e nunca devolve telefone/e-mail/CPF da entrada; telefone casa `/^\+5511900\d{6}$/`; e-mail termina em `@example.com`; CPF passa validação de dígito; `remapId` é estável e diferente do id de origem; `rewriteText("Oi Maria, acesse sortealta.bet/x", ctx)` não contém `Maria`, `sortealta`; `scrubJson` remove tudo fora de `keepKeys`.
- [ ] **Step 2: Teste de varredura:** `scanTenant` acha telefone real dentro de `sms_send_logs.content` e dentro de `metadata` jsonb (Review Focus 5).
- [ ] **Step 3: Teste de integração (PGlite)** com 3 jogadores sintéticos de origem e linhas em `players`, `deposits`, `sms_send_logs`, `tracked_links`, `link_dispatches`, `journey_enrollments`: após o clone, contagens iguais, somas de `deposits.valor` iguais, nenhum needle encontrado; rodar de novo após editar uma linha do demo → estado idêntico ao da primeira carga (Review Focus 4); injetar um telefone real numa coluna não tratada → script reverte e o demo fica como estava.
- [ ] **Step 4:** Rodar → FAIL; implementar; rodar → PASS.
- [ ] **Step 5:** Commit `feat(demo): anonymized, idempotent clone script with PII scan`.

### Task 13: Script de logins demo

**Files:**
- Create: `scripts/demo/create-demo-login.mjs` (`--count N [--label X] [--expires-at ISO]`, `--revoke <email>`)
- Modify: tela de perfil/conta onde há troca de e-mail/senha (ocultar para `app_metadata.is_demo_user`)

**Interfaces:**
- Consumes: trigger `trg_user_roles_demo_user_guard` (Task 1).
- Comportamento: `auth.admin.createUser({ email: "demo+<label>-<8 hex>@betleads.io", password: <24 chars aleatórios>, email_confirm: true, app_metadata: { is_demo_user: true, demo_expires_at } })`; insere `user_roles(user_id, tenant_id=<demo>, role='gestor')`; imprime e-mail e senha. `--revoke`: `auth.admin.updateUserById(id, { ban_duration: "876000h" })` e remove o `user_roles`. Recusa rodar se o tenant `demo` não tiver `is_demo = true`.

- [ ] **Step 1:** Rodar contra Supabase local: criar 1 login, entrar no app, confirmar banner e que só o tenant demo aparece no seletor; tentar inserir `user_roles` desse usuário em outro tenant via SQL → `DEMO_USER_ROLE_BLOCKED`; `--revoke` → login falha.
- [ ] **Step 2:** Commit `feat(demo): demo login generator and revoke`.

### Task 14: Implantação em produção (cada passo exige autorização explícita do usuário)

- [ ] **Step 1:** `npm test`, `npm run typecheck`, `npm run lint` verdes na branch; revisão final da branch.
- [ ] **Step 2:** Com OK do usuário: aplicar `20261018100000` e `20261018110000` em produção (`scripts/run-supabase-migrations.ps1`), deploy do app e da edge function `ai-player-insights`.
- [ ] **Step 3:** Rodar o clone em dry-run contra produção e mostrar as contagens ao usuário.
- [ ] **Step 4:** Com OK do usuário: `--apply`. Esperado: varredura limpa, contagens do demo iguais às de origem nas tabelas clonadas.
- [ ] **Step 5:** Com OK do usuário: gerar os logins pedidos.
- [ ] **Step 6: Verificação manual com um login demo:** banner visível; tentar envio de teste SMS/e-mail/voz/WhatsApp → mensagem de bloqueio; tentar Nova sessão WhatsApp, token Meta, checkout de crédito, ver token do webhook, convidar usuário → bloqueados; após 10 minutos, consultar (somente leitura) que não há linha nova do demo em `sms_send_logs`, `email_send_logs`, `call_history`, `link_dispatches`, `journey_step_executions`, `webhook_logs`, `dispatcher_runs`.
- [ ] **Step 7:** Atualizar a memória do projeto com o id do tenant demo e o comando de reset.
