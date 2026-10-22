# Onboarding e configuração da casa — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O admin da casa configura URL da casa, URLs rápidas, domínios de encurtador, domínios de e-mail e remetentes — com cadastro automático na Short.io/Infobip, DNS exibido, verificação automática — via assistente no primeiro acesso + checklist no Início + página permanente; e campanhas/jornadas passam a escolher domínio, URL rápida e remetente.

**Architecture:** Uma tabela `tenant_domains` (tipo `shortener`/`email`) é a fonte única de domínios por casa, alimentada por dois clientes de provedor (`shortio-domains.server.ts`, `infobip-domains.server.ts`) atrás de um serviço `tenant-domains.server.ts`. Um cron (pg_cron → rota pública) reverifica domínios pendentes. No envio, `resolveShortenerDomain` substitui o `shortio_settings.domain` (fallback = `SHORTIO_DOMAIN`, o encurtador padrão do CRM) e `resolveSender` passa a aceitar só remetentes de domínio de e-mail verificado da casa. URLs rápidas viram variáveis `{link_<chave>}` resolvidas em `buildPlayerVariables`.

**Tech Stack:** TypeScript (TanStack Start, `createServerFn` + `requireSupabaseAuth` + zod), Supabase/Postgres (migrations em `supabase/migrations`, pg_cron + pg_net + Vault `betleads_cron_secret`), Vitest (+ PGlite em `*.db.test.ts`), React + shadcn/ui + sonner.

**Spec:** `docs/superpowers/specs/2026-10-21-onboarding-configuracao-casa-design.md`

## Global Constraints

- Contas **centrais** Betleads: chaves globais `SHORTIO_API_KEY`, `INFOBIP_BASE_URL`, `INFOBIP_API_KEY`. Nada de credencial por casa.
- Short.io: base `https://api.short.io`, header `authorization: <key>` (sem Bearer). Criar `POST /domains {hostname, linkType:"random"}`; ler `GET /domains/{id}`; listar `GET /api/domains?pattern=<hostname>`. Sem endpoint de verificação — status = campo `state`; só `configured` conta como verificado. 409 = domínio já existe na conta.
- DNS Short.io (fixo, não vem da API): subdomínio → `CNAME <label> → cname.short.io`; domínio raiz → `A @ → ${SHORTIO_A_RECORD_IP ?? "207.174.61.1"}`.
- Infobip: header `Authorization: App <key>`. `POST /email/1/domains {domainName, dkimKeyLength:2048, targetedDailyTraffic:1000}`; `GET /email/1/domains/{name}`; `POST /email/1/domains/{name}/verify` (202, assíncrono). Verificado = `active === true` **e** todo `dnsRecords[].verified === true`. Registros DNS exibidos exatamente como `recordType/name/expectedValue` da API.
- Remetente de sistema: `PLATFORM_EMAIL_FROM` (default `no-reply@betleads.io`), nome `Betleads`. Só para e-mail de instruções de DNS; nunca para campanhas.
- Sem limite de quantidade de domínios. Não aplicar limite; não criar coluna de limite.
- Um hostname pertence a no máximo uma casa (único global, inclusive removidos).
- **Remover** = `removed_at` + sai dos envios; **não** chama delete no provedor.
- E-mail da casa **bloqueado** sem remetente de domínio verificado: código de erro estável `EMAIL_DOMAIN_NOT_VERIFIED`. Nunca cair em `email_smtp_configs` para casas.
- Links sem domínio próprio verificado saem por `SHORTIO_DOMAIN` (comportamento atual), com aviso na UI: `Seu domínio personalizado ainda não foi verificado — os links estão saindo pelo encurtador padrão do CRM.`
- Edição: `requireTenantAdmin` (owner/admin/super admin). Leitura: qualquer membro (`has_tenant_access`). Escritas chamam `assertTenantNotDemo(tenantId)`.
- Casas existentes na data da migration: `onboarding_completed_at = now()` (não veem assistente). `shortio_settings.domain` não nulo vira linha `tenant_domains` `shortener`, `verified`, padrão.
- Textos em pt-BR. Tema dark only (shell atual).
- Migrations novas com prefixo `20261021…` (posterior a `20261020120000`). Terminar com `notify pgrst, 'reload schema';`. Atualizar `src/integrations/supabase/types.ts` à mão para as tabelas/colunas novas.
- Escrita em produção (aplicar migration, setar env) exige autorização explícita do usuário no momento.

## Review Focus

1. Domínio de encurtador igual ao host da URL da casa (ex.: casa `suacasa.bet.br`, encurtador `suacasa.bet.br`) → apontar DNS derrubaria o site; deve rejeitar com `Esse é o domínio do site da casa — use um subdomínio, ex.: go.suacasa.bet.br`. Teste na Task 2.
2. Hostname digitado "sujo" (`https://Go.SuaCasa.bet.br/`, `go.suacasa.bet.br.`, com espaços) → normaliza para `go.suacasa.bet.br`; IP, `localhost`, sem ponto ou com caracteres inválidos → rejeita. Teste na Task 2.
3. Hostname já de outra casa → `Esse domínio já está em uso por outra conta`; 409 da Short.io sem dono no banco → adota o domínio existente na conta central (caso `bmkt.click`). Teste na Task 5.
4. Copy com `{link_promo}` cuja URL rápida foi apagada, ou casa sem `site_url` → nunca enviar chaves literais: `{link_*}` desconhecido cai para `site_url`; sem `site_url`, mantém o valor legado atual. Teste na Task 9.
5. Campanha agendada/jornada ativa com domínio que depois foi removido ou deixou de verificar → no envio cai para o padrão da casa (ou CRM), sem erro; remetente cujo domínio perdeu verificação → envio bloqueado com `EMAIL_DOMAIN_NOT_VERIFIED`, nada enviado. Testes nas Tasks 7 e 8.

---

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20261021100000_tenant_house_config.sql` | Tabelas/colunas novas, RLS, backfill |
| `supabase/migrations/20261021100100_tenant_domains_verify_cron.sql` | pg_cron do verificador |
| `src/lib/house-config.ts` | Helpers puros: hostname, URL, chave de URL rápida, checklist, agenda de verificação |
| `src/lib/domain-providers/shortio-domains.server.ts` | Cliente Short.io de domínios |
| `src/lib/domain-providers/infobip-domains.server.ts` | Cliente Infobip de domínios |
| `src/lib/tenant-domains.server.ts` | Serviço: adicionar, atualizar status, padrão, remover, uso |
| `src/lib/house-config.functions.ts` | Server functions da casa (config, domínios, remetentes, onboarding, opções para composers) |
| `src/lib/platform-email.server.ts` | E-mail de sistema (instruções de DNS) |
| `src/routes/api/public/tenant-domains/verify.ts` | Rota do cron |
| `src/lib/house-links.server.ts` | Carrega URL da casa + URLs rápidas para variáveis |
| `src/routes/configuracoes.casa.tsx` + `src/components/house-config/*` | Página permanente e seções reutilizadas pelo assistente |
| `src/components/onboarding/*` | Assistente, gate, checklist do Início, aviso de verificado |

---

### Task 1: Modelo de dados

**Files:**
- Create: `supabase/migrations/20261021100000_tenant_house_config.sql`
- Modify: `src/integrations/supabase/types.ts`
- Test: `src/lib/house-config.db.test.ts` (PGlite, padrão de `src/lib/crm-results.db.test.ts`)

**Interfaces:**
- Produces (SQL):
  - `tenants.site_url text null`, `tenants.onboarding_completed_at timestamptz null`, `tenants.onboarding_skipped_at timestamptz null`.
  - `tenant_quick_links(id uuid pk default gen_random_uuid(), tenant_id uuid not null fk tenants on delete cascade, key text not null check (key ~ '^[a-z0-9_]{1,30}$'), label text not null, path text not null, position int not null default 0, created_at, updated_at)`, `unique(tenant_id, key)`.
  - `tenant_domains(id uuid pk, tenant_id uuid not null fk, kind text not null check (kind in ('shortener','email')), hostname text not null, status text not null default 'pending' check (status in ('pending','verified','failed')), provider_domain_id text null, provider_state text null, dns_records jsonb not null default '[]', is_default boolean not null default false, last_checked_at timestamptz, verified_at timestamptz, verified_notice_seen_at timestamptz, last_error text, removed_at timestamptz, created_by uuid, created_at, updated_at)`. Índices: `unique (lower(hostname))`; `unique (tenant_id, kind) where is_default and removed_at is null`; `(status, last_checked_at) where removed_at is null`.
  - `email_senders.domain_id uuid null references tenant_domains(id)`.
  - `sms_campaigns.short_domain_id uuid null references tenant_domains(id) on delete set null`; `email_campaigns.sender_id uuid null references email_senders(id) on delete set null`; `email_campaigns.short_domain_id uuid null references tenant_domains(id) on delete set null`.
  - `dns_records` item: `{type: string, name: string, value: string, verified: boolean | null}`.

- [ ] **Step 1: Escrever o teste PGlite** que aplica a migration e verifica: (a) inserir dois `tenant_domains` com `hostname` `Go.X.com` e `go.x.com` falha por unicidade; (b) dois `is_default=true` do mesmo `(tenant, kind)` ativos falha, mas um removido + um ativo passa; (c) `tenant_quick_links.key = 'Login'` falha no check; (d) backfill: tenant com `shortio_settings.domain='bmkt.click'` gera `tenant_domains(kind='shortener', hostname='bmkt.click', status='verified', is_default=true, verified_at not null)`; (e) tenants existentes ficam com `onboarding_completed_at` não nulo.
- [ ] **Step 2: Rodar** `npx vitest run src/lib/house-config.db.test.ts` — esperado FAIL (arquivo de migration não existe).
- [ ] **Step 3: Escrever a migration.** RLS nas duas tabelas novas no padrão `shortio_settings_tenant_rls` de `20261015090000_consolidate_tenant_rls.sql:960` para SELECT (`is_super_admin() or tenant_id = any(accessible_tenant_ids())`); escrita só via `service_role` (as server functions validam admin e escrevem com `supabaseAdmin`). Trigger `updated_at` como em `shortio_settings`. Backfill de `shortio_settings.domain` (copiando `domain_id` para `provider_domain_id` quando houver) e `update tenants set onboarding_completed_at = now() where onboarding_completed_at is null`. Grants `select` para `authenticated`, `all` para `service_role`.
- [ ] **Step 4: Rodar o teste** — esperado PASS.
- [ ] **Step 5: Atualizar `types.ts`** com as tabelas/colunas novas e rodar `npm run typecheck` — esperado sem erros.
- [ ] **Step 6: Commit** `feat(db): tenant house config, quick links and domains`.

### Task 2: Helpers puros da configuração da casa

**Files:**
- Create: `src/lib/house-config.ts`
- Test: `src/lib/house-config.test.ts`

**Interfaces:**
- Produces:
  - `type DomainKind = "shortener" | "email"`; `type DomainStatus = "pending" | "verified" | "failed"`; `type DnsRecord = {type: string; name: string; value: string; verified: boolean | null}`.
  - `normalizeHostname(input: string): {ok: true; hostname: string} | {ok: false; error: string}`
  - `validateShortenerHostname(hostname: string, siteUrl: string | null): string | null` (mensagem de erro ou null)
  - `normalizeSiteUrl(input: string): {ok: true; url: string} | {ok: false; error: string}` (força `https://`, sem barra final, sem query/hash)
  - `quickLinkKeyFromLabel(label: string): string` (slug `[a-z0-9_]`, máx. 30, sem acento)
  - `buildQuickLinkUrl(siteUrl: string, path: string): string` (path relativo `/login` ou URL absoluta mantida)
  - `isDomainDueForCheck(d: {status: DomainStatus; created_at: string; last_checked_at: string | null}, now: Date): boolean`
  - `type SetupItemState = "done" | "pending_dns" | "todo"`; `computeSetupChecklist(input: {siteUrl: string | null; shortenerStatuses: DomainStatus[]; emailStatuses: DomainStatus[]; hasVerifiedSender: boolean}): {items: {id: "house" | "shortener" | "email"; state: SetupItemState}[]; complete: boolean}`

- [ ] **Step 1: Escrever os testes:**
  - `normalizeHostname("https://Go.SuaCasa.bet.br/promo ")` → `{ok:true, hostname:"go.suacasa.bet.br"}`; `"go.suacasa.bet.br."` → `go.suacasa.bet.br`; `"192.168.0.1"`, `"localhost"`, `"semponto"`, `"go_casa.com"`, `""` → `ok:false`.
  - `validateShortenerHostname("suacasa.bet.br", "https://suacasa.bet.br")` → `"Esse é o domínio do site da casa — use um subdomínio, ex.: go.suacasa.bet.br"`; `("www.suacasa.bet.br", "https://www.suacasa.bet.br")` → mesma mensagem, sugerindo `go.suacasa.bet.br` (a sugestão usa o host do site sem `www.`); `("go.suacasa.bet.br", "https://suacasa.bet.br")` → `null`; `(qualquer, null)` → `null`.
  - `normalizeSiteUrl("suacasa.bet.br/")` → `https://suacasa.bet.br`; `"http://x.com/?a=1#b"` → `https://x.com`; `"nada"` → erro.
  - `quickLinkKeyFromLabel("Depósito PIX")` → `deposito_pix`.
  - `buildQuickLinkUrl("https://x.com", "/login")` → `https://x.com/login`; `("https://x.com", "login")` → `https://x.com/login`; `("https://x.com", "https://outra.com/a")` → `https://outra.com/a`.
  - `isDomainDueForCheck`: `verified` checado há 23h → false, há 25h → true; `pending` criado há 1h e checado há 9 min → false, há 11 min → true; `pending` criado há 10h checado há 50 min → false, há 61 min → true; `pending`/`failed` criado há 4 dias checado há 23h → false, 25h → true; `last_checked_at` null → true.
  - `computeSetupChecklist`: sem nada → 3 `todo`, `complete:false`; site + shortener `["pending"]` + email `["verified"]` com remetente → `[done, pending_dns, done]`; email verificado sem remetente → `email: todo`; tudo verificado + remetente → `complete:true`.
- [ ] **Step 2: Rodar** `npx vitest run src/lib/house-config.test.ts` — FAIL.
- [ ] **Step 3: Implementar.** Agenda de `isDomainDueForCheck`: verificado → a cada 24h; pendente/falho com idade < 6h → 10 min; < 72h → 60 min; depois → 24h.
- [ ] **Step 4: Rodar** — PASS.
- [ ] **Step 5: Commit** `feat(house-config): pure helpers for hostnames, quick links and setup checklist`.

### Task 3: Clientes de domínio dos provedores

**Files:**
- Create: `src/lib/domain-providers/shortio-domains.server.ts`, `src/lib/domain-providers/infobip-domains.server.ts`
- Test: `src/lib/domain-providers/shortio-domains.server.test.ts`, `src/lib/domain-providers/infobip-domains.server.test.ts` (mock de `globalThis.fetch` via `vi.spyOn`)

**Interfaces:**
- Consumes: `DnsRecord`, `DomainStatus` (Task 2).
- Produces:
  - `type ProviderDomain = {providerDomainId: string; providerState: string; status: DomainStatus; dnsRecords: DnsRecord[]}`
  - `class DomainProviderError extends Error { code: "ALREADY_EXISTS" | "INVALID" | "UNAVAILABLE" | "NOT_FOUND"; status: number }`
  - Short.io: `createShortioDomain(hostname: string): Promise<ProviderDomain>`, `getShortioDomain(id: string, hostname: string): Promise<ProviderDomain>`, `findShortioDomainByHostname(hostname: string): Promise<ProviderDomain | null>`, `shortioDnsRecords(hostname: string, configured: boolean): DnsRecord[]`.
  - Infobip: `createInfobipDomain(domainName: string): Promise<ProviderDomain>`, `getInfobipDomain(domainName: string): Promise<ProviderDomain>`, `requestInfobipVerification(domainName: string): Promise<void>`.

- [ ] **Step 1: Testes Short.io:** `createShortioDomain("go.x.com")` faz `POST https://api.short.io/domains` com header `authorization` = `SHORTIO_API_KEY` e body `{hostname:"go.x.com", linkType:"random"}`; resposta `{id:12345, state:"not_configured"}` → `{providerDomainId:"12345", status:"pending", dnsRecords:[{type:"CNAME", name:"go", value:"cname.short.io", verified:false}]}`; `state:"configured"` → `status:"verified"` e registros `verified:true`; raiz `x.com` → `[{type:"A", name:"@", value:"207.174.61.1"}]` (e `SHORTIO_A_RECORD_IP` sobrescreve); 409 → `DomainProviderError` `ALREADY_EXISTS`; 402/5xx → `UNAVAILABLE`; `findShortioDomainByHostname` chama `GET /api/domains?pattern=go.x.com` e devolve só o item com `hostname` exato. Raiz = hostname com exatamente 2 rótulos **ou** sufixo público composto de 3 rótulos terminando em `.bet.br`/`.com.br` (ex.: `suacasa.bet.br` é raiz).
- [ ] **Step 2: Testes Infobip:** `createInfobipDomain("mail.x.com")` faz `POST ${INFOBIP_BASE_URL}/email/1/domains` com `Authorization: App <key>` e body `{domainName:"mail.x.com", dkimKeyLength:2048, targetedDailyTraffic:1000}`; resposta `{domainId:7, active:false, dnsRecords:[{recordType:"TXT", name:"x._domainkey.mail.x.com", expectedValue:"k=rsa...", verified:false}]}` → `{providerDomainId:"7", status:"pending", dnsRecords:[{type:"TXT", name:..., value:"k=rsa...", verified:false}]}`; `active:true` + todos `verified:true` → `verified`; `active:true` com um registro `verified:false` → `pending`; `requestInfobipVerification` faz `POST .../verify` e aceita 202; 400 com "already exists" no texto → `ALREADY_EXISTS`; 404 no GET → `NOT_FOUND`.
- [ ] **Step 3: Rodar** os dois testes — FAIL.
- [ ] **Step 4: Implementar** ambos. Mapear `state`: `configured` → `verified`; `not_registered` → `failed`; demais → `pending`. Infobip `blocked:true` → `failed`.
- [ ] **Step 5: Rodar** — PASS.
- [ ] **Step 6: Commit** `feat(domains): Short.io and Infobip domain clients`.

### Task 4: Serviço de domínios da casa

**Files:**
- Create: `src/lib/tenant-domains.server.ts`
- Test: `src/lib/tenant-domains.server.test.ts` (mocks `vi.hoisted` de `@/integrations/supabase/client.server` e dos clientes da Task 3, no estilo de `email-send-consent.server.test.ts`)

**Interfaces:**
- Consumes: Tasks 2 e 3.
- Produces:
  - `type TenantDomain = {id: string; tenant_id: string; kind: DomainKind; hostname: string; status: DomainStatus; is_default: boolean; dns_records: DnsRecord[]; provider_domain_id: string | null; last_checked_at: string | null; verified_at: string | null; last_error: string | null; removed_at: string | null; created_at: string}`
  - `addTenantDomain(input: {tenantId: string; kind: DomainKind; rawHostname: string; userId: string}): Promise<TenantDomain>`
  - `refreshTenantDomain(domainId: string, opts?: {requestVerify?: boolean}): Promise<TenantDomain>`
  - `setDefaultTenantDomain(tenantId: string, domainId: string): Promise<void>` (só `verified`; erro `Só domínios verificados podem ser padrão`)
  - `findDomainUsages(tenantId: string, domainId: string): Promise<{campaigns: {id: string; name: string}[]; journeys: {id: string; name: string}[]}>`
  - `removeTenantDomain(tenantId: string, domainId: string): Promise<void>`
  - `listTenantDomains(tenantId: string, kind?: DomainKind): Promise<TenantDomain[]>` (sem removidos)
  - `purgeTenantDomain(domainId: string): Promise<void>` — só superadmin; exige `removed_at` não nulo; chama delete no provedor (Short.io `POST /domains/delete/{id}`, Infobip `DELETE /email/1/domains/{name}`; adicionar `deleteShortioDomain(id)`/`deleteInfobipDomain(name)` aos clientes da Task 3) e apaga a linha

- [ ] **Step 1: Testes:**
  - add `shortener` com hostname de outra casa no banco → erro `Esse domínio já está em uso por outra conta`, provedor não chamado.
  - add `shortener` igual ao host do `site_url` → erro da Task 2.
  - add com Short.io respondendo `ALREADY_EXISTS` e hostname sem dono no banco → chama `findShortioDomainByHostname` e grava com o id encontrado.
  - add `email` → chama `createInfobipDomain` e em seguida `requestInfobipVerification`.
  - refresh que passa de `pending` para `verified` sem outro padrão verificado do mesmo tipo → vira `is_default=true` e grava `verified_at`.
  - refresh que passa de `verified` para `pending` num domínio padrão → perde `is_default`, e o próximo `verified` mais antigo do mesmo tipo vira padrão.
  - refresh com erro do provedor → mantém status, grava `last_error` e `last_checked_at`.
  - remove → grava `removed_at`, `is_default=false`, promove outro verificado a padrão; nenhum delete no provedor é chamado.
  - purge de domínio não removido → erro `Remova o domínio antes de apagá-lo no provedor`; purge de removido → chama o delete do provedor e apaga a linha.
  - `findDomainUsages` retorna campanhas `sms_campaigns`/`email_campaigns` agendadas (status de agendado) com `short_domain_id` e jornadas ativas cujo `config.short_domain_id` aponta o domínio (para `email`, remetentes desse domínio em `email_campaigns.sender_id` e `config.sender_id`).
- [ ] **Step 2: Rodar** — FAIL.
- [ ] **Step 3: Implementar** com `supabaseAdmin`. Para `email` sem `provider_domain_id`, o identificador no provedor é o próprio hostname.
- [ ] **Step 4: Rodar** — PASS.
- [ ] **Step 5: Commit** `feat(domains): tenant domain service with auto-default and soft removal`.

### Task 5: Server functions da casa + e-mail de instruções

**Files:**
- Create: `src/lib/house-config.functions.ts`, `src/lib/platform-email.server.ts`
- Test: `src/lib/platform-email.server.test.ts`, `src/lib/house-config.functions.test.ts` (só os helpers puros exportados)

**Interfaces:**
- Consumes: Tasks 2–4; `requireSupabaseAuth`, `resolveOperationalTenantId`, `requireTenantAdmin`, `assertTenantNotDemo` de `src/lib/tenant-access.server.ts`; `callInfobipEmail` de `src/lib/infobip-email.server.ts:53`.
- Produces (todas `createServerFn` + `requireSupabaseAuth` + zod; escrita = admin + não demo):
  - `getHouseConfig()` → `{tenantName; siteUrl; quickLinks: {id; key; label; path; url}[]; domains: TenantDomain[]; senders: {id; fromName; fromEmail; replyTo; domainId; isDefault; domainVerified}[]; canEdit: boolean; onboarding: {completedAt; skippedAt}}`
  - `saveHouseSite({siteUrl})`, `saveQuickLinks({links: {id?; label; key?; path}[]})` (substitui o conjunto; `key` derivada do label se ausente; chaves reservadas `login`/`deposito` permitidas)
  - `addHouseDomain({kind, hostname})`, `refreshHouseDomain({domainId})` (com `requestVerify:true`), `setDefaultHouseDomain({domainId})`, `getHouseDomainUsages({domainId})`, `removeHouseDomain({domainId})`
  - `saveEmailSenderForHouse({id?; domainId; localPart; fromName; replyTo?; isDefault?})` — `fromEmail = localPart@hostname`; domínio deve ser `email` da casa; remetente pode ser criado com domínio pendente
  - `removeEmailSenderForHouse({id})`
  - `purgeHouseDomain({domainId})` — `assertSuperAdmin(context.userId)`; exposto na página como `Apagar no provedor` só para superadmin em domínios removidos (Task 10 lista removidos só para superadmin)
  - `sendDnsInstructions({domainId; to})`
  - `getHouseSetupStatus()` → `{checklist: ReturnType<typeof computeSetupChecklist>; showWizard: boolean; newlyVerified: {id; hostname; kind}[]}` — `showWizard` = admin da casa, não super admin, `onboarding_completed_at` e `onboarding_skipped_at` nulos
  - `completeOnboarding()`, `skipOnboarding()`, `markVerifiedNoticeSeen({domainIds})`
  - `getComposerOptions()` → `{siteUrl; quickLinks: {key; label; url}[]; shortDomains: {id; hostname; isDefault}[] (só verified); shortenerPending: boolean; senders: {id; label; isDefault}[] (só domínio verified)}`
  - `renderDnsInstructionsEmail(input: {tenantName: string; hostname: string; kind: DomainKind; records: DnsRecord[]}): {subject: string; html: string}`
  - `sendPlatformEmail(input: {to: string; subject: string; html: string}): Promise<void>`

- [ ] **Step 1: Testes** de `renderDnsInstructionsEmail`: subject `Registros DNS para go.x.com — <tenantName>`; html contém uma linha por registro com tipo, nome e valor escapados (`<` vira `&lt;`); `kind:"email"` menciona "e-mail". `sendPlatformEmail` chama `callInfobipEmail` com `from:"no-reply@betleads.io"`, `fromName:"Betleads"` (e `PLATFORM_EMAIL_FROM` sobrescreve); lança se `ok:false`.
- [ ] **Step 2: Rodar** — FAIL.
- [ ] **Step 3: Implementar** os helpers e as server functions. `saveEmailSenderForHouse` grava em `email_senders` com `tenant_id`, `domain`, `domain_id`; um padrão por casa. `sendDnsInstructions` valida e-mail com zod e limita a 5 envios por domínio por hora (contagem simples em memória por `domainId` é suficiente).
- [ ] **Step 4: Rodar** testes + `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(house-config): server functions and DNS instructions email`.

### Task 6: Verificação automática (cron)

**Files:**
- Create: `src/routes/api/public/tenant-domains/verify.ts`, `supabase/migrations/20261021100100_tenant_domains_verify_cron.sql`
- Test: `src/lib/tenant-domains-verify.migrations.test.ts` (asserções de texto, padrão `demo-workers-skip.migrations.test.ts`)

**Interfaces:**
- Consumes: `isDomainDueForCheck` (Task 2), `refreshTenantDomain` (Task 4), `requireSharedSecret(request, "CRON_SECRET")` de `src/lib/cron-auth.server.ts`, `startJobRun` de `@/lib/observability/job-monitor.server`.

- [ ] **Step 1: Teste da migration:** contém `cron.unschedule` do job `betleads-tenant-domains-verify` antes do `cron.schedule`, agenda `'*/10 * * * *'`, chama `https://betleads.io/api/public/tenant-domains/verify` com Bearer lido do Vault `betleads_cron_secret`, como em `20261014193000_accelerate_shortio_click_sync.sql:14-29`.
- [ ] **Step 2: Rodar** — FAIL.
- [ ] **Step 3: Implementar** a migration e a rota `POST`: seleciona `tenant_domains` com `removed_at is null` de tenants `not is_demo`, filtra por `isDomainDueForCheck`, processa no máximo 50 por execução em sequência; `refreshTenantDomain(id, {requestVerify: kind === "email" && status !== "verified"})`; erros de um domínio não param os outros; retorna `{checked, verified, failed}`.
- [ ] **Step 4: Rodar** teste + typecheck — PASS.
- [ ] **Step 5: Commit** `feat(domains): periodic DNS verification job`.

### Task 7: Domínio do encurtador no envio

**Files:**
- Modify: `src/lib/shortio.server.ts` (`LinkTrackingContext` :28-45, `settingsForTenant` :91-120, `getOrCreateTrackedLink` :330-360, `prepareTrackedText` :468, `prepareTrackedEmailHtml` :547, `prepareTrackedTextBatch` :1185)
- Modify: `src/lib/sms.functions.ts` (`sendBulkSms` :1076, `scheduleBulkSms` :2052, `sendSmsInternal` :710), `src/lib/sms-dispatcher.server.ts` (:911, :940), `src/lib/sms-bulk.server.ts` (:723), `src/lib/journeys.server.ts` (:780, :837), `src/lib/journeys.shared.ts` (:13-40)
- Test: `src/lib/shortio-domain-resolution.server.test.ts`

**Interfaces:**
- Produces:
  - `LinkTrackingContext.shortDomainId?: string | null`
  - `resolveShortenerDomain(tenantId: string, requestedDomainId?: string | null): Promise<{hostname: string | null; domainId: string | null; usingCrmFallback: boolean}>`
  - Zod de jornada sms e email: `short_domain_id?: z.string().uuid().nullable()`
  - `sendBulkSms`/`scheduleBulkSms` input: `shortDomainId?: string | null` (gravado em `sms_campaigns.short_domain_id`)

- [ ] **Step 1: Testes** de `resolveShortenerDomain`: pedido = domínio `verified` da casa → ele; pedido de outra casa, removido ou `pending` → padrão verificado da casa; sem padrão → `SHORTIO_DOMAIN` com `usingCrmFallback:true`; sem env → `hostname:null`. E `prepareTrackedText` com `shortDomainId` usa o hostname resolvido no link criado e no filtro de `isShortioEligibleUrl`.
- [ ] **Step 2: Rodar** — FAIL.
- [ ] **Step 3: Implementar.** `settingsForTenant` deixa de ler `shortio_settings.domain`; o domínio vem de `resolveShortenerDomain` (cache de 60 s por `tenantId:requestedId` como os outros caches do arquivo). Campanhas passam `sms_campaigns.short_domain_id` ao contexto; jornadas passam `step.config.short_domain_id`. Lote (`prepareTrackedTextBatch`) agrupa por `tenantId + domínio resolvido`.
- [ ] **Step 4: Rodar** testes + `npx vitest run src/lib/shortio.server.test.ts src/lib/sms` — PASS.
- [ ] **Step 5: Commit** `feat(shortio): per-send short domain with verified-domain fallback`.

### Task 8: Remetente de e-mail só de domínio verificado

**Files:**
- Modify: `src/lib/email-send.server.ts` (`resolveSender` :185-229), `src/lib/email.functions.ts` (:93, :568-660, :868), `src/lib/email-automations.server.ts` (:418), `src/lib/journeys.server.ts` (:832), `src/lib/journeys.functions.ts` (:551-557)
- Test: `src/lib/email-sender-resolution.server.test.ts`

**Interfaces:**
- Produces:
  - `resolveSender(input: {tenantId: string; senderId?: string | null}): Promise<{fromEmail: string; fromName: string; replyTo: string | null; senderId: string} | null>`
  - `class EmailDomainNotVerifiedError extends Error { code = "EMAIL_DOMAIN_NOT_VERIFIED" }` com mensagem `Configure e verifique um domínio de e-mail da casa para enviar e-mails.`
  - `saveEmailCampaign` input: `senderId?: string | null` (gravado em `email_campaigns.sender_id`) e `shortDomainId?: string | null`

- [ ] **Step 1: Testes:** `senderId` da casa com domínio `verified` → ele; `senderId` de outra casa ou com domínio `pending` → cai no padrão verificado da casa; nenhum remetente verificado → `null`; remetente com `domain_id` nulo (legado) → ignorado; `email_smtp_configs` nunca consultado. Na campanha (:868) e na jornada (:832), `null` → lança `EmailDomainNotVerifiedError` antes de `sendInfobipEmail` e nada é enviado nem logado como enviado.
- [ ] **Step 2: Rodar** — FAIL.
- [ ] **Step 3: Implementar.** Join `email_senders` → `tenant_domains` (`status='verified' and removed_at is null and tenant_id = tenantId`). Chamadores passam `email_campaigns.sender_id`, `step.config.sender_id`, `block.smtp_config_id` (automação: tratar como `senderId`). `saveJourney` valida `sender_id` contra `email_senders` da casa (não mais `email_smtp_configs`).
- [ ] **Step 4: Rodar** + `npx vitest run src/lib/email` — PASS.
- [ ] **Step 5: Commit** `feat(email): send only from verified house domains`.

### Task 9: URL da casa e URLs rápidas como variáveis

**Files:**
- Create: `src/lib/house-links.server.ts`
- Modify: `src/lib/template-vars.server.ts` (:82-84 e `renderTemplate`), `src/lib/message-variables.ts` (:32-34), chamadores de `buildPlayerVariables` com tenant disponível (`sms-dispatcher.server.ts:421,906`, `journeys.server.ts:585`, `email.functions.ts:111,125,972`, `email-automations.server.ts:439`, `automation.server.ts:740`, `call-flows.server.ts:779`, `precall-dispatcher.server.ts:94`)
- Test: `src/lib/template-vars.server.test.ts` (criar ou estender)

**Interfaces:**
- Produces:
  - `type HouseLinks = {siteUrl: string | null; quickLinks: Record<string, string>}`
  - `loadHouseLinks(tenantId: string): Promise<HouseLinks>` (cache 60 s)
  - `buildPlayerVariables(player, house?: HouseLinks)`

- [ ] **Step 1: Testes:** com `house = {siteUrl:"https://x.com", quickLinks:{login:"https://x.com/login", promo:"https://x.com/promo"}}` → `{link}` = `https://x.com`, `{link_login}` = `https://x.com/login`, `{link_promo}` = `https://x.com/promo`, `{link_deposito}` (sem URL rápida) = `https://x.com`, `{link_apagado}` = `https://x.com`; sem `house` ou `siteUrl:null` → valores legados atuais (`https://betleads.app/depositar` etc.) e `{link_apagado}` permanece literal; `{nome}` continua igual.
- [ ] **Step 2: Rodar** — FAIL.
- [ ] **Step 3: Implementar.** `renderTemplate` recebe o mapa; o fallback de `{link_*}` desconhecido para `siteUrl` acontece só quando `siteUrl` existe. Chamadores carregam `loadHouseLinks(tenantId)` uma vez por lote.
- [ ] **Step 4: Rodar** + `npx vitest run src/lib` — PASS.
- [ ] **Step 5: Commit** `feat(templates): house URL and quick links as message variables`.

### Task 10: Página "Configuração da casa"

**Files:**
- Create: `src/routes/configuracoes.casa.tsx`, `src/components/house-config/house-site-section.tsx`, `src/components/house-config/domains-section.tsx`, `src/components/house-config/domain-detail.tsx`, `src/components/house-config/email-senders-section.tsx`
- Modify: `src/lib/navigation.ts` (`SIDEBAR_FOOTER` :129, `ROUTE_META` :162+), `src/routes/links.configuracoes.tsx` (:59 — trocar o input de domínio por link "Domínios do encurtador → Configuração da casa")
- Test: `src/components/house-config/domain-detail.test.tsx`

**Interfaces:**
- Consumes: server functions da Task 5.
- Produces: seções exportadas `HouseSiteSection`, `DomainsSection({kind})`, `EmailSendersSection` com prop `variant?: "page" | "wizard"`, reutilizadas pela Task 11.

- [ ] **Step 1: Teste** de `DomainDetail`: domínio `pending` mostra selo `Aguardando DNS`, tabela com cada registro (tipo/nome/valor) e botão copiar por linha, `Verificar agora`, `Enviar instruções por e-mail`; `Definir como padrão` desabilitado enquanto não verificado; `canEdit:false` esconde as ações; `verified` mostra `Verificado`.
- [ ] **Step 2: Rodar** — FAIL.
- [ ] **Step 3: Implementar** a rota `/configuracoes/casa` com abas **Casa** (URL + URLs rápidas, sugestões pré-preenchidas `Login /login`, `Depósito /deposito`, `Promo /promo` quando vazio), **Encurtador**, **E-mail** (domínios + remetentes). Remover pede confirmação e lista `getHouseDomainUsages`. Item de menu `Configuração da casa` em `SIDEBAR_FOOTER`, visível a todos os membros da casa.
- [ ] **Step 4: Rodar** teste + `npm run typecheck` + `npm run lint` — PASS.
- [ ] **Step 5: Commit** `feat(house-config): house configuration page`.

### Task 11: Assistente de primeiro acesso, checklist e aviso de verificado

**Files:**
- Create: `src/components/onboarding/house-setup-wizard.tsx`, `src/components/onboarding/onboarding-gate.tsx`, `src/components/onboarding/house-setup-checklist.tsx`, `src/components/onboarding/domain-verified-notice.tsx`
- Modify: `src/routes/__root.tsx` (envolver o conteúdo após `AuthGate`/`TenantStatusGate`, :168), `src/routes/index.tsx` (antes da grade de KPIs, ~:395)
- Test: `src/components/onboarding/house-setup-checklist.test.tsx`, `src/components/onboarding/house-setup-wizard.test.tsx`

**Interfaces:**
- Consumes: `getHouseSetupStatus`, `completeOnboarding`, `skipOnboarding`, `markVerifiedNoticeSeen` (Task 5); seções da Task 10 com `variant="wizard"`.

- [ ] **Step 1: Testes:** checklist com `[done, pending_dns, todo]` mostra `1 de 3`, rótulos `URL da casa e URLs rápidas`, `Domínio do encurtador · aguardando DNS`, `Domínio e remetente de e-mail` com link para `/configuracoes/casa`; `complete:true` não renderiza nada. Assistente: passos `Casa → Encurtador → E-mail → Pronto`; `Fazer depois` avança sem salvar; no último passo `Concluir` chama `completeOnboarding`; `Pular configuração` (visível em todos os passos) chama `skipOnboarding`.
- [ ] **Step 2: Rodar** — FAIL.
- [ ] **Step 3: Implementar.** `OnboardingGate` renderiza o assistente em tela cheia quando `showWizard`; senão, os filhos. Checklist no Início para qualquer membro da casa enquanto `complete:false`. `DomainVerifiedNotice` no Início: banner `Domínio go.x.com verificado — já está sendo usado nos seus envios.` para `newlyVerified`, fechado via `markVerifiedNoticeSeen`.
- [ ] **Step 4: Rodar** testes + typecheck — PASS.
- [ ] **Step 5: Commit** `feat(onboarding): first-access wizard, home checklist and verified notice`.

### Task 12: Seletores nos composers de campanha e jornada

**Files:**
- Create: `src/components/house-config/link-insert-menu.tsx`, `src/components/house-config/short-domain-select.tsx`, `src/components/house-config/email-sender-select.tsx`
- Modify: `src/components/campaigns/channel-campaign-composer.tsx` (SMS :542-570, e-mail :571-595), `src/components/journeys/journey-editor.tsx` (tipos :36-40, serialização :347-400), `src/components/journeys/journey-editor-config.ts` (:4)
- Test: `src/components/house-config/link-insert-menu.test.tsx`, `src/components/journeys/journey-editor-config.test.ts` (estender)

**Interfaces:**
- Consumes: `getComposerOptions` (Task 5); `shortDomainId`/`senderId` das Tasks 7 e 8; chaves de variável da Task 9.

- [ ] **Step 1: Testes:** `LinkInsertMenu` lista `URL da casa` (insere `{link}`) e cada URL rápida (insere `{link_<key>}`) na posição do cursor; sem `siteUrl` mostra `Cadastre a URL da casa` com link para a configuração. Serialização da jornada preserva `short_domain_id` no sms e grava `sender_id` + `short_domain_id` no email.
- [ ] **Step 2: Rodar** — FAIL.
- [ ] **Step 3: Implementar.** SMS (campanha e passo de jornada): `ShortDomainSelect` (padrão pré-selecionado; vazio quando não há verificado) + `LinkInsertMenu`; se `shortenerPending` ou sem domínio verificado, aviso da Global Constraints. E-mail (campanha e passo): `ShortDomainSelect` + `LinkInsertMenu` também (links do HTML são encurtados), e `EmailSenderSelect` substitui `smtp: "Remetente padrão"`; sem remetente verificado, botão de envio/agendar desabilitado com `Configure e verifique um domínio de e-mail da casa para enviar e-mails.` e link para a configuração. Passar `shortDomainId`/`senderId` para `sendBulkSms`, `scheduleBulkSms`, `saveEmailCampaign` e para o config dos passos.
- [ ] **Step 4: Rodar** `npm test` + `npm run typecheck` + `npm run lint` — PASS.
- [ ] **Step 5: Commit** `feat(composers): short domain, quick links and sender pickers`.

---

## Deploy (fora das tasks, com autorização do usuário no momento)

1. Setar env em produção: `PLATFORM_EMAIL_FROM=no-reply@betleads.io` (opcional), `SHORTIO_A_RECORD_IP` (opcional).
2. Cadastrar e verificar `betleads.io` **diretamente no console da Infobip** (NÃO pelo fluxo do app — o app recusa domínios reservados da plataforma: `betleads.io`, `betleads.app`, o domínio de `PLATFORM_EMAIL_FROM`, o host de `SHORTIO_DOMAIN` e seus subdomínios) antes de usar "Enviar instruções por e-mail".
3. Aplicar as duas migrations `20261021…` em produção.
