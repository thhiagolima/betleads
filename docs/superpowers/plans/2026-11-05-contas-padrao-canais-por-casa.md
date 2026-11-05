# Conta padrão escolhível + canais por casa — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Super admin escolhe a conta padrão de cada canal, faz CRUD completo de contas de provedor e liga/desliga canais por casa; canal desligado some do painel da casa, pula passos de jornada e mostra um aviso "Ciente" ao pessoal da casa.

**Architecture:** Duas tabelas novas lidas pelo snapshot já existente de `provider-accounts.server.ts` (`platform_channel_defaults`) e por um módulo novo `tenant-channels.server.ts` (`tenant_channels`, ausência de linha = padrão sms/email/voice ligados, webpush desligado). O bloqueio de envio fica nos pontos únicos de envio (antes de reservar crédito) e no motor de jornada (pula com `skipped`/`provider:"channel_disabled"`). O painel da casa recebe `enabled_channels` pelo `getTenantSwitcherFor` (cliente de serviço, sem RLS nova).

**Tech Stack:** TypeScript, TanStack Start (`createServerFn`), React + react-query, Supabase Postgres, vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-contas-padrao-canais-por-casa-design.md`

Worktree: `C:\Users\Carol\Desktop\betleads-canais`, branch `feat/contas-padrao-canais` (base origin/main 26ea8c0).

## Global Constraints

- Toda UI e mensagens em pt-BR, tom das telas atuais.
- Canais: `ProviderChannel = "sms" | "email" | "voice" | "webpush"` (`src/lib/provider-accounts.server.ts:18`; lista client-safe `PROVIDER_CHANNELS` em `src/lib/provider-accounts.shared.ts`).
- Padrão dos canais por casa sem linha: `sms`, `email`, `voice` ligados; `webpush` desligado.
- Sem fallback entre contas: conta indisponível continua falhando como `misconfigured`.
- E-mails sem casa (`platform-email.server.ts`, `billing/billing-emails.server.ts`) continuam na conta env Infobip; o ramo `!tenantId` de `resolveChannelAccount` não muda.
- Desligar o e-mail da casa bloqueia só envios a players; e-mails para a equipe (fatura, alerta, convite) continuam (eles já não passam `tenantId`).
- Checagem de canal desligado sempre ANTES de reservar crédito (`reserveForDelivery`/`reserveUsage`).
- Migração aplicada em prod só com ok explícito do usuário. App antigo precisa continuar funcionando com a migração aplicada.
- Comandos: `npm test -- <arquivo>`, `npm run typecheck`, `npm run lint`, `npm run build` (obrigatório antes de mergear: vazamento de `*.server` no bundle).
- Commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Trocar a padrão de um canal enquanto o snapshot falha ao ler (erro de banco): resolver usa o último snapshot; sem nenhum, a conta env — nunca lança. (teste na Task 2)
2. Casa com conta própria desativada no canal + canal desligado: o envio é pulado como canal desligado, não vira `misconfigured`/hold de 30 min na jornada. (teste na Task 6)
3. Desligar canal com campanha SMS `enviando` ou web push com lote `pendente`: nenhum lote novo sai e o crédito reservado de lote não enviado volta. (teste na Task 6)
4. Jornada antiga com passo de canal desligado continua salvável sem mudar o passo; só passos novos/alterados do canal são recusados. (teste na Task 7)
5. Super admin entrando numa casa com canal desligado não recebe o aviso "Ciente" e o aviso do usuário comum reaparece após religar e desligar de novo. (teste na Task 10)

---

### Task 1: Migração

**Files:**
- Create: `supabase/migrations/20261215100000_platform_defaults_tenant_channels.sql`
- Modify: `src/integrations/supabase/types.ts` (tabelas novas)
- Test: `src/lib/tenant-channels.db.test.ts` (seguir o formato de `src/lib/webpush/webpush-provider-accounts.db.test.ts`; roda só com banco local, como os outros `*.db.test.ts`)

**Interfaces:**
- Produces: tabelas `platform_channel_defaults(channel text PK CHECK in 4 canais, provider_account_id uuid NOT NULL FK provider_accounts, updated_by uuid, updated_at timestamptz)`, `tenant_channels(tenant_id uuid FK tenants ON DELETE CASCADE, channel text CHECK, enabled boolean NOT NULL, disabled_at timestamptz, updated_by uuid, updated_at timestamptz, PK(tenant_id, channel))`, `tenant_channel_notice_acks(user_id uuid, tenant_id uuid FK tenants ON DELETE CASCADE, channel text, disabled_at timestamptz, acked_at timestamptz default now(), PK(user_id, tenant_id, channel, disabled_at))`.

- [ ] **Step 1:** Escrever a migração no formato de `20261108100000_provider_accounts.sql` (cabeçalho O QUE / COMPATIBILIDADE / ROLLBACK, `SET LOCAL lock_timeout = '5s'`, RLS ligada sem políticas, `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, `GRANT ... TO service_role`). Conteúdo:
  - `platform_channel_defaults` com trigger `platform_channel_defaults_check` (conta atende o canal e `status='active'`; atualiza `updated_at`). Seed: `sms→…a001`, `email→…a002`, `voice→…a002`, `webpush→…a003`, `ON CONFLICT DO NOTHING`.
  - `tenant_channels` (sem seed: ausência = padrão). CHECK `enabled OR disabled_at IS NOT NULL`.
  - `tenant_channel_notice_acks`.
  - Backfill: `UPDATE tenant_domains SET provider_account_id='…a002' WHERE provider_account_id IS NULL AND kind='email'`; `UPDATE tenant_webpush_apps SET provider_account_id='…a003' WHERE provider_account_id IS NULL`. Comentar que o app antigo trata NULL e a002/a003 igual.
  - Renomear rótulos: a001 → `Short Brasil (ambiente)`, a002 → `Infobip (ambiente)`, a003 → `OneSignal (ambiente)` (só onde o rótulo ainda é o original `… (padrão)`).
- [ ] **Step 2:** Teste db: inserir default com conta que não atende o canal falha; inserir com conta `disabled` falha; seed tem 4 linhas.
- [ ] **Step 3:** Atualizar `types.ts` com as 3 tabelas. Rodar `npm run typecheck` → sem erros.
- [ ] **Step 4:** Commit `feat(db): platform channel defaults, tenant channels and notice acks`.

### Task 2: Resolver usa a padrão escolhida

**Files:**
- Modify: `src/lib/provider-accounts.server.ts` (Snapshot L156-243, `defaultAccountFor` L308, `resolveChannelAccount` L342, `resolveOneSignalAccount` L367, `envAccountFor`)
- Test: `src/lib/provider-accounts.server.test.ts`

**Interfaces:**
- Produces: `Snapshot.defaults: Map<ProviderChannel, string>`; `export async function platformDefaultAccountId(channel: ProviderChannel): Promise<string>` (id da padrão; env id quando sem snapshot/linha); `export const ENV_ACCOUNT_IDS: ReadonlySet<string>` (a001/a002/a003).
- Os ids `DEFAULT_*_ACCOUNT_ID` continuam exportados e passam a significar "conta env" — os usos em `email-automations.server.ts:901`, `email-send.server.ts:454`, `tenant-domains*.server.ts`, `sms-provider-breaker.server.ts` identificam a conta env, não "a padrão", e ficam como estão (comentar isso no topo do módulo).

- [ ] **Step 1: Testes que falham** (estender o mock mínimo para a tabela `platform_channel_defaults`):
  - `tenant sem override usa a padrão escolhida`: defaults `webpush → <id conta db OneSignal ativa>`; `resolveOneSignalAccount("t1")` → `id === <id>`.
  - `sms padrão em conta Infobip db`: defaults `sms → <infobip db com sms>`; `resolveChannelAccount("t1","sms")` → `provider === "infobip"`.
  - `envio sem casa ignora a padrão`: defaults `email → <infobip db>`; `resolveChannelAccount(null,"email")` → `id === DEFAULT_INFOBIP_ACCOUNT_ID`.
  - `padrão desativada não cai na env`: linha default aponta para conta `disabled` → rejeita com `ProviderAccountUnavailableError`.
  - `falha de leitura sem snapshot usa env`: `failReads=true` → `resolveChannelAccount("t1","sms")` → `id === DEFAULT_SHORT_BRASIL_ACCOUNT_ID`.
  - `override da casa vence a padrão`.
- [ ] **Step 2:** `npm test -- src/lib/provider-accounts.server.test.ts` → FAIL.
- [ ] **Step 3:** `loadSnapshot` faz um terceiro select (`platform_channel_defaults: channel, provider_account_id`). Novo `tenantDefaultAccount(snap, channel)`: sem snapshot ou sem linha → env do canal (comportamento de hoje); com linha → `accountFromRow(row, channel)` (linha de conta ausente → `ProviderAccountUnavailableError`). Ramo `!tenantId` continua `defaultAccountFor(channel)` (env). Mesmo para `resolveOneSignalAccount`.
- [ ] **Step 4:** Rodar o arquivo e `src/lib/webpush/apps.server.test.ts src/lib/provider-accounts-admin.server.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(providers): tenants without override use the chosen default account`.

### Task 3: tenant-channels (servidor)

**Files:**
- Create: `src/lib/tenant-channels.shared.ts`, `src/lib/tenant-channels.server.ts`
- Test: `src/lib/tenant-channels.server.test.ts` (fake DB `createFakeDb` de `src/lib/sms-bulk.test-support.ts`)

**Interfaces:**
- Produces (shared): `DEFAULT_ENABLED_CHANNELS: Record<ProviderChannel, boolean>` (`{sms:true,email:true,voice:true,webpush:false}`); `CHANNEL_DISABLED_MESSAGE(channel): string` → `"O canal ${PROVIDER_CHANNEL_LABEL[channel]} está desabilitado para esta casa."`; `STEP_TYPE_CHANNEL: Partial<Record<string, ProviderChannel>>` (`sms→sms, email→email, voice→voice`).
- Produces (server): `getTenantChannels(tenantId: string): Promise<Record<ProviderChannel, { enabled: boolean; disabledAt: string | null }>>` (cache 30 s por casa, igual `PROVIDER_ACCOUNTS_CACHE_MS`; erro de leitura → último valor; sem nenhum → padrão); `isChannelEnabled(tenantId: string | null, channel: ProviderChannel): Promise<boolean>` (`null` → `true`); `class ChannelDisabledError extends Error { channel }`; `assertChannelEnabled(tenantId: string | null, channel): Promise<void>`; `invalidateTenantChannelsCache(tenantId?: string)`; `__resetTenantChannelsCacheForTests`.

- [ ] **Step 1: Testes:** casa sem linhas → webpush `false`, sms `true`; linha `voice enabled=false` → `isChannelEnabled(t,"voice") === false`; `assertChannelEnabled` lança `ChannelDisabledError` com `message === "O canal Voz está desabilitado para esta casa."` (usar o rótulo real de `PROVIDER_CHANNEL_LABEL`); `tenantId null` → `true`; erro de leitura após uma leitura boa → mantém valor anterior.
- [ ] **Step 2:** Rodar → FAIL. **Step 3:** Implementar. **Step 4:** Rodar → PASS.
- [ ] **Step 5:** Commit `feat(channels): per-house channel state with cache`.

### Task 4: Admin — padrão por canal e CRUD de contas

**Files:**
- Modify: `src/lib/provider-accounts-admin.server.ts`, `src/lib/provider-accounts.shared.ts`, `src/lib/provider-accounts.functions.ts`
- Test: `src/lib/provider-accounts-admin.server.test.ts`

**Interfaces:**
- Consumes: `platformDefaultAccountId`, `ENV_ACCOUNT_IDS` (Task 2); `getTenantChannels` (Task 3).
- Produces:
  - `ProviderAccountView`: troca `platformDefault` por `envAccount: boolean` e `defaultFor: ProviderChannel[]`; `houses` passa a contar, para cada canal em `defaultFor`, também as casas sem override **com o canal ligado**.
  - `adminListProviderAccountsFor` passa a retornar também `defaults: Record<ProviderChannel, string>` e `verifiedEmailDomainsOnDefault: number`; `TenantProvidersView` ganha `channels: Record<ProviderChannel, boolean>`.
  - Inputs em shared: `setPlatformDefaultInput {channel, accountId: dbUuid()}`, `deleteProviderAccountInput {id: dbUuid()}`.
  - `adminSetPlatformDefaultFor(ctx, {channel, accountId}): Promise<{ emailDomains: Array<{ tenantId: string; tenantNome: string; hostname: string; status: string; error: string | null }> }>`
  - `adminDeleteProviderAccountFor(ctx, {id}): Promise<void>`
  - Server fns `adminSetPlatformDefault`, `adminDeleteProviderAccount` em `provider-accounts.functions.ts`, no padrão das existentes.

- [ ] **Step 1: Testes:**
  - `define padrão`: conta OneSignal db ativa → `defaults.webpush === id`, auditoria `provider_account.set_default` com before/after, cache invalidado (`resolveOneSignalAccount("t1")` devolve a nova).
  - `recusa padrão desativada / canal não suportado` (mensagens "Esta conta está desativada." / "Esta conta não atende este canal.").
  - `padrão de e-mail move domínios`: casa A sem override com domínio de e-mail ativo, casa B com override → `refreshTenantDomain` (mock) chamado só para o domínio de A, `requestVerify: true`; retorno lista A.
  - `não desativa padrão`: `adminSetProviderAccountStatusFor({id: padrão, status:"disabled"})` lança `"Esta conta é a padrão de SMS. Escolha outra padrão antes."`.
  - `conta env pode ser desativada se não for padrão`; `conta env: salvar só altera label e channels` (credenciais e `credentials_source` intactos).
  - `exclui conta livre`: linha some, auditoria `provider_account.delete`.
  - `não exclui`: env (`"Contas do ambiente não podem ser excluídas."`), padrão, usada em `tenant_channel_providers`, em `tenant_domains` (removed_at null), em `tenant_webpush_apps` — cada uma com mensagem dizendo onde está em uso.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar. `PLATFORM_ACCOUNT_IDS` vira `ENV_ACCOUNT_IDS`; `adminSetTenantChannelProviderFor` mantém: escolher a padrão atual ou uma env NÃO normaliza mais para null — `accountId: null` é o único jeito de "usar a padrão". `adminSaveProviderAccountFor` para conta env aceita só `label` e `channels` (validados contra `SUPPORTED_CHANNELS` e uso por casas, como hoje), mantém `credentials_source='env'`. Na troca de padrão de e-mail: invalidar cache antes de mover os domínios; casas = sem linha em `tenant_channel_providers(channel='email')`; reutilizar o laço de `refreshTenantDomain` já existente (extrair helper `moveEmailDomains(tenantIds)` compartilhado com `adminSetTenantChannelProviderFor`).
- [ ] **Step 4:** Rodar → PASS. `npm run typecheck`.
- [ ] **Step 5:** Commit `feat(providers): choosable default per channel, delete accounts, editable env accounts`.

### Task 5: Admin — ligar/desligar canal da casa

**Files:**
- Create: `src/lib/tenant-channels-admin.server.ts`
- Modify: `src/lib/tenant-channels.shared.ts` (inputs), `src/lib/provider-accounts.functions.ts` (wrappers)
- Test: `src/lib/tenant-channels-admin.server.test.ts`

**Interfaces:**
- Produces:
  - `setTenantChannelInput {tenantId: dbUuid(), channel, enabled: boolean}`, `tenantChannelImpactInput {tenantId, channel}`.
  - `adminTenantChannelImpactFor(ctx, {tenantId, channel}): Promise<{ activeJourneys: number; scheduledCampaigns: number }>` — jornadas `active` da casa com passo `is_enabled` do canal (via `STEP_TYPE_CHANNEL`); campanhas `agendada|pausada|enviando` (sms/webpush), `agendada|enviando|pausada` (email), itens `call_queue` em `pending_audio|audio_ready|queued|paused` (voice).
  - `adminSetTenantChannelFor(ctx, {tenantId, channel, enabled}): Promise<{ cancelled: number }>`.
  - Server fns `adminTenantChannelImpact`, `adminSetTenantChannel`.

- [ ] **Step 1: Testes:**
  - desligar grava `enabled=false, disabled_at=now`, audita `tenant_channel.disable`, invalida cache (`isChannelEnabled` → false).
  - desligar SMS cancela `sms_campaigns` `agendada`/`pausada` da casa via `cancelSmsCampaignRow` com `lastError: "Canal SMS desabilitado para a casa."`; outra casa intacta.
  - desligar webpush cancela `agendada`/`pausada` via `cancelWebpushCampaign`; e-mail: `email_campaigns` `agendada` → `pausada` com `blocked_reason='channel_disabled'`; voz: `call_queue` pendentes → `cancelled`.
  - religar grava `enabled=true, disabled_at=null` e NÃO reativa nada cancelado.
  - desligar canal já desligado é no-op (não muda `disabled_at`, sem auditoria nova).
  - não super admin → `"Acesso restrito à administração da plataforma."`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar (`assertSuperAdmin` de `provider-governance.server.ts`, `auditAdminAction`). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(channels): super admin toggles a house channel and cancels its pending sends`.

### Task 6: Envio e jornada respeitam canal desligado

**Files:**
- Modify: `src/lib/sms.functions.ts` (`sendSmsInternal`, antes da reserva em ~L950), `src/lib/sms-bulk.server.ts` (`sendSmsBatch` ~L621, antes de reservar em ~L885), `src/lib/email-send.server.ts` (`sendInfobipEmail`, antes de ~L291, só quando há `tenantId`), `src/lib/infobip-voice.server.ts` (`callInfobipVoice`, antes de resolver a conta ~L157), `src/lib/rate-limit/provider-errors.server.ts` (`classifyProviderFailure` ~L142), `src/lib/journeys.server.ts` (pool handler ~L1735-1762, `executeEnrollment` ~L432), `src/lib/sms-campaign-dispatch.server.ts` (`processSmsCampaignTick` ~L271), `src/lib/email.functions.ts` (`runCampaignSend` ~L967), `src/lib/webpush/campaign-dispatch.server.ts` (`processWebpushCampaignTick` ~L467), `src/lib/calls.server.ts` (`runVoiceQueueDispatcher` ~L361)
- Test: `src/lib/journeys.dispatcher.test.ts`, `src/lib/email-send.billing.test.ts`, `src/lib/infobip-voice.billing.test.ts`, SMS: o teste existente de `sendSmsInternal`/`sms-bulk.server.test.ts`, webpush: `src/lib/webpush/campaign-dispatch.server.test.ts` (criar se não existir)

**Interfaces:**
- Consumes: `isChannelEnabled`, `STEP_TYPE_CHANNEL` (Task 3).
- Produces: `ProviderErrorKind` ganha `"channel_disabled"`; `classifyProviderFailure` mapeia para `{ kind: "fail", reason: "channel_disabled" }` e `journeyPlatformFailure` NÃO trata como hold.

- [ ] **Step 1: Testes:**
  - jornada: casa com `voice` desligado, enrollment no passo voice posição 2 → execução `status:"skipped", provider:"channel_disabled"`, enrollment `current_position: 3`, evento `step_skipped` com `reason: "channel_disabled"`, nenhuma chamada a `reserveDelivery`/`admitClaimedItem`/`callInfobipVoice`.
  - jornada: casa com conta própria de voz desativada E canal desligado → mesmo resultado (pulado, sem hold).
  - `sendInfobipEmail` com casa sem e-mail → `errorKind:"channel_disabled"`, `reserveUsage` não chamado; sem `tenantId` → envia normalmente.
  - `sendSmsInternal` e `callInfobipVoice`: idem, sem reserva.
  - SMS campanha `enviando` com canal desligado: o tick não envia lote, marca `cancelada` com `last_error "Canal SMS desabilitado para a casa."`.
  - webpush: campanha `enviando` com lote `pendente` e crédito reservado, canal desligado → lote não enviado, `refundOrThrow` chamado para o lote, campanha `cancelada`.
  - e-mail `runCampaignSend` com canal desligado → `pausada`, `blocked_reason='channel_disabled'`, nada enviado.
  - voz `runVoiceQueueDispatcher` → item `cancelled`, sem chamada.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementar. Jornada: no pool handler, se `STEP_TYPE_CHANNEL[item.step_type]` estiver desligado, chamar `executeEnrollment` sem passar por `admitSmsItem`/`admitClaimedItem`; em `executeEnrollment`, logo após carregar o passo (antes do holdout ~L591), copiar o padrão do holdout skip com `provider: "channel_disabled"`. Passo pulado não reenvia ao religar (já é a semântica de avançar posição).
- [ ] **Step 4:** Rodar os arquivos de teste tocados → PASS.
- [ ] **Step 5:** Commit `feat(channels): disabled channel skips journey steps and blocks sends before charging`.

### Task 7: Validação no servidor ao criar/agendar

**Files:**
- Modify: `src/lib/journeys.functions.ts` (`saveJourney` ~L530, `setJourneyStatus` ~L637, `convertLegacyJourney` ~L240, `enrollJourneyManually` ~L846), `src/lib/sms.functions.ts` (`scheduleBulkSms`, `sendBulkSms`, `sendTestSms`, `resendFailedSms`, `triggerSmsFlowNow`), `src/lib/email.functions.ts` (`saveEmailCampaign` quando status ≠ `rascunho`, `updateEmailCampaignStatus` para `agendada|enviando`, `sendEmailCampaignNow`, `sendTestEmail`), `src/lib/calls.functions.ts` (`bulkDispatchCalls`, `dispatchCallQueueItem`), `src/lib/call-flows.functions.ts` (`saveCallFlow`, `enrollPlayerInCallFlow`), `src/lib/sms-flows.functions.ts` (`saveSmsFlow`), `src/lib/email-automations.functions.ts` (`saveEmailFlow`, `triggerEmailFlowTest`), `src/lib/webpush/campaigns.functions.ts` (`scheduleWebpushCampaignFn`), `src/lib/webpush/webpush.functions.ts` (`sendWebpushTestFn`, ativação de origem), `src/lib/expert-campaigns.functions.ts` (`scheduleExpertBulkSms`, `sendExpertBulkSms` e equivalentes e-mail/voz), `src/lib/campaign-drafts.functions.ts` (`submitCampaignDraft`)
- Test: `src/lib/journeys.functions.test.ts` (criar se não existir) e um teste por família onde já houver arquivo de teste

**Interfaces:**
- Consumes: `assertChannelEnabled`, `ChannelDisabledError`, `STEP_TYPE_CHANNEL`.
- Produces: `export function newDisabledChannelSteps(stored: StepLike[], incoming: StepLike[], disabled: Set<ProviderChannel>): StepLike[]` em `src/lib/tenant-channels.shared.ts` — devolve os passos de canal desligado em `incoming` que não existem idênticos em `stored` (identidade: `id` quando ambos têm; senão `step_type` + `JSON.stringify(config)` como multiconjunto).

- [ ] **Step 1: Testes:** `newDisabledChannelSteps`: passo voice antigo inalterado → `[]`; mesmo passo com texto alterado → `[passo]`; passo voice novo → `[passo]`; passo voice removido → `[]`. `saveJourney` com passo novo de canal desligado lança a mensagem de `CHANNEL_DISABLED_MESSAGE`; `scheduleBulkSms` com SMS desligado lança a mesma mensagem; `scheduleWebpushCampaignFn` em casa sem linha (webpush desligado por padrão) lança.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar ao lado de `assertTenantCanOperate`/`assertTenantNotDemoForSend` em cada função. `setJourneyStatus` (publicar) usa `newDisabledChannelSteps` contra a última versão publicada. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(channels): reject new sends and steps on a disabled channel`.

### Task 8: Painel do super admin

**Files:**
- Modify: `src/components/admin/provider-accounts-panel.tsx`
- Test: `src/components/admin/provider-accounts-panel.test.tsx` (padrão `renderToStaticMarkup` + mocks atuais; adicionar `adminSetPlatformDefault`, `adminDeleteProviderAccount`, `adminTenantChannelImpact`, `adminSetTenantChannel` ao mock de `@/lib/provider-accounts.functions`)

**Interfaces:**
- Consumes: views/fns das Tasks 4 e 5.

- [ ] **Step 1: Testes (markup):**
  - conta com `defaultFor:["webpush"]` mostra selo `padrão de Web push` (rótulo de `PROVIDER_CHANNEL_LABEL`) e coluna Casas `todas sem conta própria`; conta sem `defaultFor` mostra a contagem.
  - conta env mostra `Editar` e não mostra `Excluir`; conta db livre mostra `Excluir`; conta padrão não mostra `Desativar`.
  - menu "Tornar padrão" lista só canais em `channels` da conta e que ela ainda não é padrão.
  - `TenantProvidersCard`: por casa e canal, um switch "ligado/desligado" e o select; opção vazia diz `Padrão (<label da conta padrão>)`; casa com webpush desligado mostra o select desabilitado; colSpan da linha vazia = 5.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. Diálogos via `requestConfirmation`:
  - Tornar padrão: `"<Conta> passa a ser a padrão de <Canal> para N casas sem conta própria."` Para e-mail, se `verifiedEmailDomainsOnDefault > 0`, segundo `requestConfirmation` (destrutivo): `"N domínios de e-mail voltam a pendente e essas casas ficam sem enviar e-mail até o DNS ser revalidado na conta nova. E-mails da plataforma (faturas, convites) continuam na conta do ambiente."` Depois, toast/lista do resultado por domínio (mesma UI do `emailDomains` existente).
  - Excluir: confirmação destrutiva.
  - Desligar canal: busca `adminTenantChannelImpact` e confirma `"Desligar <Canal> para <Casa>? N jornadas ativas vão pular esses passos e M envios agendados serão cancelados. O pessoal da casa verá um aviso."`
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(admin): default account per channel, delete accounts, house channel switches`.

### Task 9: Canais da casa no cliente + navegação e páginas de canal

**Files:**
- Modify: `src/lib/tenants.functions.ts` (`getTenantSwitcherFor` ~L597-676: `enabled_channels: ProviderChannel[]` em cada `TenantOption`, lido com `getTenantChannels`), `src/hooks/use-active-tenant.ts` (tipo), `src/lib/navigation.ts` (`NavAccess.requires` ganha `channel?: ProviderChannel`; itens SMS `/sms`, Email `/email`, Voz `/ligacoes` e filhos de "Templates e áudios"), `src/components/shell/use-shell-nav.ts`, `src/components/channels/channel-page.tsx`, `src/components/channels/channel-tabs.ts`, `src/components/channels/channel-workspace-nav.tsx`
- Create: `src/hooks/use-enabled-channels.ts`
- Test: `src/lib/navigation.test.ts` (existente ou criar), `src/hooks/use-enabled-channels.test.ts`

**Interfaces:**
- Produces: `useEnabledChannels(): { isEnabled(channel: ProviderChannel): boolean; enabled: ProviderChannel[]; loading: boolean }` — mesma query key `["active-tenant-switcher"]`, molde de `useIsDemoTenant`; enquanto carrega, `isEnabled` devolve `DEFAULT_ENABLED_CHANNELS[channel]`.
- Produces: `<ChannelDisabledState channel={…} />` em `src/components/channels/channel-disabled-state.tsx` — tela "O canal X está desabilitado para esta casa." usada por rota acessada direto.

- [ ] **Step 1: Verificar** como experts recebem a casa ativa: se `getTenantSwitcherFor` não devolve a casa para o expert (só lê `user_roles`), adicionar o caminho do expert com `enabled_channels` (fonte: `expert_tenant_ids`/tabela de experts usada por `expertHomeFn`). Registrar no commit qual foi o caso.
- [ ] **Step 2: Testes:** `visibleSections` com `enabledChannels: ["sms","email"]` não contém `/ligacoes` nem `/ligacoes#audios`; `getTenantSwitcherFor` devolve `enabled_channels` sem `webpush` para casa sem linhas; super admin recebe os canais da casa (não todos).
- [ ] **Step 3:** FAIL → implementar → PASS. `ChannelPage` com canal desligado renderiza `ChannelDisabledState`.
- [ ] **Step 4:** Commit `feat(channels): house panel knows its enabled channels; nav and channel pages hide disabled ones`.

### Task 10: Aviso "Ciente"

**Files:**
- Create: `src/lib/tenant-channel-notices.server.ts`, `src/lib/tenant-channel-notices.functions.ts`, `src/components/channels/channel-disabled-notice-gate.tsx`
- Modify: `src/routes/__root.tsx` (montar ao lado de `OnboardingGate`, ~L187-191)
- Test: `src/lib/tenant-channel-notices.server.test.ts`, `src/components/channels/channel-disabled-notice-gate.test.tsx`

**Interfaces:**
- Produces: `getPendingChannelNoticesFor(userId: string, tenantId: string): Promise<Array<{ channel: ProviderChannel; disabledAt: string }>>` — canais com `enabled=false` cujo `(user, tenant, channel, disabled_at)` não está em `tenant_channel_notice_acks`; `[]` para super admin (`is_super_admin`). `ackChannelNoticeFor(userId, {tenantId, channel, disabledAt}): Promise<void>` (upsert idempotente; recusa se o usuário não tem acesso à casa — `has_tenant_access` ou expert da casa). Server fns `getPendingChannelNotices` (GET, casa ativa via `resolveOperationalTenantId`) e `ackChannelNotice`.

- [ ] **Step 1: Testes:** pendente após desligar; vazio depois do ack; reaparece com novo `disabled_at` (religar + desligar); vazio para super admin; ack de casa alheia recusado. Gate: com 1 pendente renderiza `"O canal Voz foi desabilitado para a sua casa"` e botão `Ciente`; sem pendentes não renderiza nada.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. Gate: overlay `fixed inset-0 z-50` como `OnboardingGate`, um canal por vez; texto: `"O canal <Canal> foi desabilitado para a sua casa pela BetLeads. Ele não aparece mais no painel, e os passos desse canal nas jornadas serão pulados."`; `Ciente` chama `ackChannelNotice` e invalida a query. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(channels): one-time "Ciente" notice when a house channel is disabled`.

### Task 11: Esconder o canal nas telas da casa

**Files (cada item: esconder quando `!isEnabled(canal)`):**
- Jornadas: `src/components/journeys/journey-editor.tsx` (dropdown "Adicionar etapa" ~L1182-1190; passo existente de canal desligado mostra selo `"Canal desabilitado — será pulado"` e não abre edição), `src/components/journeys/journeys-hub.tsx` (~L1065-1078, cards de fluxo legado ~L118-120/384/637).
- Campanhas: `src/components/campaigns/channel-campaign-composer.tsx` (`items` ~L1267-1272; substituir o gate ad-hoc de webpush ~L242-248/500-510 por `isEnabled("webpush") && integração ativa`), `src/components/campaigns/campaigns-hub.tsx` (`?newChannel=` ~L160-181, linhas por canal ~L283-343, botão "SMS individual" ~L393), `src/components/campaigns/individual-sms-dialog.tsx`, `src/components/campaigns/expert-campaigns-hub.tsx` (~L57-66), `src/components/experts/expert-campaigns-admin*.tsx`, `src/routes/expert.modelos.tsx`.
- Configuração/integrações: `src/routes/configuracoes_.casa.tsx` (`VIEWS` tab `email`), `src/routes/webhooks.tsx` (`TABS` `webpush`), `src/lib/house-config.ts` `computeSetupChecklist` (item `email` some se e-mail desligado — receber `enabledChannels` como parâmetro), `src/components/onboarding/house-setup-wizard.tsx` (`WIZARD_STEPS` `email`).
- Filtros/relatórios: `src/routes/consentimentos.tsx` (opções ~L375-377), `src/routes/publicos.tsx` (~L455-475), `src/routes/index.tsx` (~L145 "Gasto em SMS"), `src/components/crm-results/overview.tsx`, `health.tsx`, `central-results.tsx`, `src/components/finance/dashboard/sends-block.tsx` (filtrar linhas), `src/components/billing/wallet-usage-panels.tsx` (itens de `BILLING_ITEMS` do canal; `voice_30s` ↔ `voice`), `src/routes/plano-e-creditos.tsx`, `src/components/history/player-contact-history.tsx`, `src/routes/alertas.tsx` ("Abrir SMS").
- Histórico de envios antigos continua no banco; só não aparece enquanto o canal estiver desligado.
- Test: `src/components/journeys/journey-editor.test.tsx`, `src/components/campaigns/channel-campaign-composer.test.tsx` (existentes ou criar, mesmo estilo `renderToStaticMarkup` com mock de `useEnabledChannels`), `src/lib/house-config.test.ts` (checklist).

- [ ] **Step 1: Testes:** editor com voz desligada não tem opção "Voz" no dropdown e mostra o selo no passo voice existente; composer com webpush desligado não lista Web push; checklist sem e-mail não tem item `email`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar todos os itens da lista. **Step 4:** PASS + `npm run typecheck` + `npm run lint`.
- [ ] **Step 5:** Commit `feat(channels): hide disabled channels across the house panel`.

### Task 12: Verificação final

- [ ] **Step 1:** `npm test` → tudo PASS (anotar falhas pré-existentes, se houver, comparando com origin/main).
- [ ] **Step 2:** `npm run typecheck && npm run lint && npm run build` → sem erros.
- [ ] **Step 3:** Atualizar `docs/ESCOPO_PROVEDORES_POR_CASA_2026-10-28.md` com uma seção curta "Conta padrão escolhível e canais por casa" apontando para o spec.
- [ ] **Step 4:** Commit `docs: provider defaults and house channels`. Não aplicar migração nem mergear sem ok do usuário.
