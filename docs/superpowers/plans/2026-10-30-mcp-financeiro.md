# MCP do Financeiro — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A remote MCP server inside the CRM that lets selected admins read and (with preview + confirm) write the finance area of their houses and groups from Claude (claude.ai, Desktop, Code), connecting via OAuth.

**Architecture:** OAuth 2.1 (PKCE, dynamic client registration, opaque hashed tokens) implemented in-app; a stateless Streamable HTTP MCP endpoint at `/api/mcp` whose tools only call the existing permission-checked `*For(ctx, data)` finance functions with `ctx.userId` from the token. Writes are two-step: `preparar_*` stores a validated input + "before" snapshot under a single-use code; `confirmar_alteracao` re-checks and applies it.

**Tech Stack:** TanStack Start (file routes with `server.handlers`, `createServerFn`), Supabase (service-role `supabaseAdmin`), zod 4, `@modelcontextprotocol/sdk` (new dep, ≥1.32 — Web Standard Streamable HTTP transport), Vitest + PGlite (`*.db.test.ts`) + `createFakeDb` (`src/lib/sms-bulk.test-support.ts`).

**Spec:** `docs/superpowers/specs/2026-10-30-mcp-financeiro-design.md`

## Global Constraints

- Every MCP read/write goes through an existing `*For` function (or the new list-only `listFinanceScopesFor`); no MCP code queries `tenant_finance_*`, `tenant_goals` or `finance_*` RPCs directly, except the read-only "before" snapshots in Task 7, which run **after** `requirePermission`.
- Access level is read from the DB on every call (`mcp_access`), never from the token.
- Tool names, descriptions and user-facing errors in pt-BR. Money in/out as JSON number in reais (`12345.00`); previews also show pt-BR format (`R$ 12.345,00`).
- No player data and no user e-mails in any tool output (`viewers` stripped).
- Limits (constants in `src/lib/mcp/config.server.ts`): access token 3600 s; refresh token 30 days; auth code 10 min; preview code 10 min, single use; 31 day entries per call; 60 calls/min per connection; 30 confirmations/hour per user.
- Flag `MCP_ENABLED` (exactly `"true"` turns it on, default off): off → every MCP/OAuth/well-known route returns 404 and the UI hides the feature. Add `MCP_ENABLED=false` to `.env.example`.
- New tables: RLS enabled, `revoke all ... from anon, authenticated`, only service_role.
- Migration file: `supabase/migrations/20261121100000_mcp_financeiro.sql` (next after `20261120100000`).
- Out of scope: rates, viewers, billing actions, Pix, wallet/invoice reads, non-Claude clients.
- `npm run build` must pass before merge (catches `*.server` leaks into the client bundle).

## Review Focus

1. **Group id passed where a house id is expected (and vice-versa), or a house id outside the user's scope typed directly by Claude** → refused with "Sem permissão", never a partial read. Test in Task 6 (`mes_da_casa` with a foreign house id and with a group id).
2. **Claude retries `confirmar_alteracao` after a network error** (the first call already applied) → second call says "já confirmada", nothing written twice. Test in Task 7.
3. **Day entries with the same date twice, a future date, or 32 entries** → schema error in pt-BR at preview time, nothing stored. Test in Task 7.
4. **Refresh token used twice (client retry or theft)** → second use refused and the whole connection revoked. Test in Task 3.
5. **Access revoked between preview and confirm** → confirm refused even with a valid code. Test in Task 7.

---

## File Structure

```
supabase/migrations/20261121100000_mcp_financeiro.sql   tables + RLS
src/lib/mcp/config.server.ts         flag + constants
src/lib/mcp/crypto.server.ts         random tokens, sha256, PKCE
src/lib/mcp/access.server.ts         level lookup, bearer → identity, connections
src/lib/mcp/oauth.server.ts          DCR, auth codes, token exchange/refresh
src/lib/mcp/oauth.functions.ts       server fns for /mcp/autorizar (requireSupabaseAuth)
src/lib/mcp/write-gate.server.ts     suspended/canceled/billing-lock gate
src/lib/mcp/read-tools.server.ts     read tool handlers
src/lib/mcp/write-actions.server.ts  action registry (schema, snapshot, describe, apply)
src/lib/mcp/preview.server.ts        create/confirm previews
src/lib/mcp/call-log.server.ts       call log + rate limits
src/lib/mcp/server.server.ts         McpServer factory (tool registration)
src/lib/mcp/mcp.functions.ts         server fns for the two screens
src/lib/finance/finance-scopes.server.ts   listFinanceScopesFor
src/routes/api/mcp.ts                MCP endpoint
src/routes/api/mcp.oauth.register.ts / mcp.oauth.token.ts
src/routes/[.]well-known/oauth-protected-resource.ts / oauth-authorization-server.ts
src/routes/mcp.autorizar.tsx         consent screen (client route)
src/routes/mcp.tsx                   "Conectar ao Claude"
src/components/admin/mcp-access-panel.tsx
```

Modified: `src/lib/finance.functions.ts` (ctx `auditMetadata`, export schemas), `src/routes/admin.tsx` (tab), `src/routes/__root.tsx` (consent screen without app layout), `src/components/app-sidebar.tsx` (entry), `package.json`, `.env.example`.

---

### Task 1: Migration — MCP tables

**Files:**
- Create: `supabase/migrations/20261121100000_mcp_financeiro.sql`
- Test: `src/lib/mcp/mcp-schema.db.test.ts`

**Interfaces — Produces (tables, all `public.`):**
- `mcp_access(user_id uuid pk, level text check in ('read','write'), granted_by uuid, updated_at timestamptz default now())` — no row = sem acesso.
- `mcp_oauth_clients(id text pk, client_name text, redirect_uris text[] not null, created_at)`
- `mcp_auth_codes(code_hash text pk, client_id text fk, user_id uuid, redirect_uri text, code_challenge text, expires_at timestamptz, used_at timestamptz null)`
- `mcp_connections(id uuid pk default gen_random_uuid(), user_id uuid, client_id text fk, created_at, last_used_at timestamptz null, revoked_at timestamptz null)`
- `mcp_tokens(token_hash text pk, connection_id uuid fk on delete cascade, kind text check in ('access','refresh'), expires_at timestamptz, used_at timestamptz null)` — `used_at` marks a rotated refresh token.
- `mcp_previews(code_hash text pk, user_id uuid, connection_id uuid fk, action text, tenant_id uuid, input jsonb, snapshot jsonb, expires_at timestamptz, confirmed_at timestamptz null, result jsonb null)`
- `mcp_call_log(id bigint identity pk, user_id uuid, connection_id uuid, tool text, tenant_id uuid null, ok boolean, error text null, duration_ms int, preview_code_hash text null, created_at timestamptz default now())`, index `(connection_id, created_at)` and `(user_id, tool, created_at)`.

- [ ] **Step 1: Write the failing test** (`mcp-schema.db.test.ts`, PGlite with `SCHEMA` from `src/lib/billing/billing-db-test-support.ts` + `readMigration`):
  - `"every mcp table has RLS enabled"`: `select relname from pg_class where relname like 'mcp_%' and relkind='r' and not relrowsecurity` → `[]`.
  - `"anon and authenticated have no privileges on mcp tables"`: `has_table_privilege('authenticated', 'public.mcp_tokens', 'select')` → `false` (same for `anon`, `mcp_access`, `mcp_previews`).
  - `"mcp_access.level only accepts read or write"`: insert `level='admin'` → throws.
- [ ] **Step 2: Run** `npx vitest run src/lib/mcp/mcp-schema.db.test.ts` → FAIL (file missing).
- [ ] **Step 3: Write the migration** with a header comment in pt-BR (style of `20261116100000_meta_mb0_hardening.sql`).
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit** `feat(mcp): tables for access, OAuth, previews and call log`

---

### Task 2: Config, crypto and access lookup

**Files:**
- Create: `src/lib/mcp/config.server.ts`, `src/lib/mcp/crypto.server.ts`, `src/lib/mcp/access.server.ts`
- Modify: `.env.example`
- Test: `src/lib/mcp/crypto.server.test.ts`, `src/lib/mcp/access.server.test.ts` (fake db via `vi.mock("@/integrations/supabase/client.server")`, as in `finance.functions.test.ts`)

**Interfaces — Produces:**
- `isMcpEnabled(): boolean`; constants `ACCESS_TOKEN_TTL_S = 3600`, `REFRESH_TOKEN_TTL_S = 2_592_000`, `AUTH_CODE_TTL_S = 600`, `PREVIEW_TTL_S = 600`, `MAX_DAY_ENTRIES = 31`, `CALLS_PER_MINUTE = 60`, `CONFIRMS_PER_HOUR = 30`.
- `randomToken(bytes = 32): string` (base64url, Web Crypto), `sha256Hex(value: string): Promise<string>`, `verifyPkceS256(verifier: string, challenge: string): Promise<boolean>`.
- `type McpLevel = "none" | "read" | "write"`; `getMcpLevel(userId: string): Promise<McpLevel>`.
- `type McpIdentity = { userId: string; connectionId: string; clientId: string; level: Exclude<McpLevel, "none"> }`.
- `resolveBearer(token: string): Promise<McpIdentity | null>` — null when hash unknown, kind ≠ access, expired, connection revoked, or level `none`; on success updates `mcp_connections.last_used_at`.

- [ ] **Step 1: Write failing tests:**
  - `verifyPkceS256` with the RFC 7636 vector (verifier `dBjftJeZ4CVP-mJ92s9UVB4M8BIwlJoNPSsvBGAZ7tc`, challenge `E9cpRQGJxD2vHFaTD7wKHo7qwHuyTmVvjaZqRxDBhNg`) → `true`; wrong verifier → `false`.
  - `isMcpEnabled`: `true` for `"true"` and `" TRUE "` (trim + lowercase, as `sms-bulk.server.ts:141`); `false` for unset, `""`, `"1"`, `"yes"`.
  - `resolveBearer`: valid → identity; expired → null; revoked connection → null; `mcp_access` row deleted → null; level changed write→read → identity with `level: "read"`; refresh token used as bearer → null.
- [ ] **Step 2: Run** `npx vitest run src/lib/mcp/` → FAIL.
- [ ] **Step 3: Implement** the three files; add `MCP_ENABLED=false` with a pt-BR comment to `.env.example`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mcp): config, token crypto and bearer resolution`

---

### Task 3: OAuth server (DCR, codes, tokens) + well-known + consent screen

**Files:**
- Create: `src/lib/mcp/oauth.server.ts`, `src/lib/mcp/oauth.functions.ts`, `src/routes/api/mcp.oauth.register.ts`, `src/routes/api/mcp.oauth.token.ts`, `src/routes/[.]well-known/oauth-protected-resource.ts`, `src/routes/[.]well-known/oauth-authorization-server.ts`, `src/routes/mcp.autorizar.tsx`
- Modify: `src/routes/__root.tsx` (path `/mcp/autorizar` renders `<AuthGate><Outlet/></AuthGate>` without `AppLayout`/`OnboardingGate`)
- Test: `src/lib/mcp/oauth.server.test.ts`

**Interfaces:**
- Consumes: Task 2 crypto, constants, `getMcpLevel`.
- Produces:
  - `isAllowedRedirectUri(uri: string): boolean` — allows exactly `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, and `http://localhost:<port>/<path>` / `http://127.0.0.1:<port>/<path>`; everything else false.
  - `registerClient(body: unknown): Promise<{ client_id: string; client_name: string; redirect_uris: string[]; token_endpoint_auth_method: "none" }>` — throws `OAuthError("invalid_redirect_uri")` if any URI not allowed.
  - `issueAuthCode(args: { userId; clientId; redirectUri; codeChallenge; codeChallengeMethod }): Promise<string>` — requires `codeChallengeMethod === "S256"`, client registered with that redirect, `getMcpLevel(userId) !== "none"` (else `OAuthError("access_denied", "Seu usuário não tem acesso ao MCP. Peça ao super admin.")`).
  - `exchangeToken(form: URLSearchParams): Promise<{ access_token; refresh_token; token_type: "Bearer"; expires_in: number }>` — grants `authorization_code` (code unused, unexpired, same client + redirect, PKCE ok → mark used, create connection, issue pair) and `refresh_token` (unused + unexpired → mark used, issue new pair on same connection; **already used → revoke the connection** and `invalid_grant`).
  - `class OAuthError extends Error { code: string }` → routes render RFC 6749 JSON errors (400).
  - Server fns (`requireSupabaseAuth`): `getMcpAuthorizationInfo({ clientId, redirectUri })` → `{ clientName, level, scopes: { houses: string[]; groups: string[] } }`; `approveMcpAuthorization({ clientId, redirectUri, codeChallenge, codeChallengeMethod, state })` → `{ redirectTo: string }` (redirect URI + `code` + `state`).
- Metadata (both well-known routes, and `/.well-known/oauth-protected-resource/api/mcp`): `resource = ${VITE_PUBLIC_APP_URL}/api/mcp`, `authorization_endpoint = /mcp/autorizar`, `token_endpoint = /api/mcp/oauth/token`, `registration_endpoint = /api/mcp/oauth/register`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `token_endpoint_auth_methods_supported: ["none"]`.
- Consent copy: title "Conectar o Claude ao financeiro", body "**{clientName}** quer acessar o financeiro de: {casas e grupos}", level line "Nível: leitura" / "Nível: leitura e escrita", buttons "Permitir" / "Cancelar" (Cancelar redirects with `error=access_denied`).

- [ ] **Step 1: Write failing tests** (`oauth.server.test.ts`):
  - `isAllowedRedirectUri`: claude.ai callback ✓, `http://localhost:33418/callback` ✓, `https://evil.com/api/mcp/auth_callback` ✗, `https://claude.ai.evil.com/...` ✗, `http://localhost.evil.com/` ✗.
  - full happy path register → issueAuthCode → exchangeToken(code) → tokens resolve via `resolveBearer`.
  - wrong `code_verifier` → `invalid_grant`; code reused → `invalid_grant`; code after 10 min (fake timers) → `invalid_grant`; different `redirect_uri` at exchange → `invalid_grant`.
  - `codeChallengeMethod: "plain"` → refused.
  - user without `mcp_access` → `access_denied`.
  - refresh rotation: new pair works, old refresh reused → `invalid_grant` **and** the new access token now resolves to null (Review Focus 4).
- [ ] **Step 2: Run** `npx vitest run src/lib/mcp/oauth.server.test.ts` → FAIL.
- [ ] **Step 3: Implement** `oauth.server.ts`, routes (404 when `!isMcpEnabled()`; token route reads `application/x-www-form-urlencoded`), server fns, consent route (reads query params `client_id, redirect_uri, code_challenge, code_challenge_method, state`; validates via `getMcpAuthorizationInfo` before showing buttons), `__root.tsx` branch. Confirm the TanStack file name for `/.well-known/...` resolves (`[.]well-known`) with `npm run dev` + `curl http://localhost:3000/.well-known/oauth-authorization-server`.
- [ ] **Step 4: Run** tests → PASS; `npm run typecheck` → no errors.
- [ ] **Step 5: Commit** `feat(mcp): OAuth 2.1 with PKCE, dynamic registration and consent screen`

---

### Task 4: Audit metadata pass-through in finance writes

**Files:**
- Modify: `src/lib/finance.functions.ts` (`ServerContext` at :58; `auditTenant` calls in `saveFinanceDaysFor`, `setMonthlyGgrFor`, `saveOtherCostFor`, `deleteOtherCostFor`, `setTenantGoalFor`; export `saveDaysInput`, `setGoalInput`)
- Test: `src/lib/finance.functions.test.ts` (extend)

**Interfaces — Produces:** `type ServerContext = { userId: string; auditMetadata?: Record<string, unknown> }`; each listed function merges `ctx.auditMetadata` into the `metadata` it passes to `auditTenant` (existing keys win on conflict). `saveDaysInput`, `setGoalInput` exported.

- [ ] **Step 1: Write failing test** `"writes carry ctx.auditMetadata into tenant_audit_logs"`: for each of the 5 functions, called with `{ userId: ADMIN_A, auditMetadata: { origem: "mcp", connectionId: "c1" } }` → the inserted `tenant_audit_logs` row has `metadata.origem === "mcp"` and `metadata.connectionId === "c1"`; without `auditMetadata` the row's metadata equals what it is today.
- [ ] **Step 2: Run** `npx vitest run src/lib/finance.functions.test.ts` → new test FAILS, old ones pass.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → all PASS.
- [ ] **Step 5: Commit** `feat(finance): optional audit metadata on finance writes`

---

### Task 5: Scope listing and write gate

**Files:**
- Create: `src/lib/finance/finance-scopes.server.ts`, `src/lib/mcp/write-gate.server.ts`
- Test: `src/lib/finance/finance-scopes.server.test.ts`, `src/lib/mcp/write-gate.server.test.ts`

**Interfaces:**
- Produces:
  - `type FinanceScopes = { superAdmin: boolean; houses: Array<{ id: string; nome: string; isDemo: boolean; status: string | null }>; groups: Array<{ id: string; nome: string; isDemo: boolean }> }`
  - `listFinanceScopesFor(userId: string): Promise<FinanceScopes>` — super admin: every tenant (demo/inactive marked) and every group. Others: candidate tenants = `user_roles` memberships ∪ `tenant_finance_viewers` ∪ houses of `managedGroupIds(userId)`, kept only where `can("finance_can_view", userId, id)`; groups = `managedGroupIds(userId)`. Sorted by `nome` (`localeCompare(…, "pt-BR")`).
  - `assertMcpCanWrite(tenantId: string, userId: string): Promise<void>` — if not super admin and `getTenantStatus(tenantId).status` ∈ {suspended, canceled} → throw `"Casa suspensa ou cancelada: só leitura pelo MCP."`; if `isBillingLockedFor(tenantId, userId)` → throw `"Casa bloqueada por cobrança: só leitura pelo MCP."`.
- Consumes: `can`, `managedGroupIds`, `getTenantStatus` (`tenant-access.server.ts:305`), `isBillingLockedFor` (`billing-state.server.ts:116`).

- [ ] **Step 1: Write failing tests:**
  - scopes: super admin sees HOUSE_A, HOUSE_B, DEMO (isDemo true) and G1, G2; ADMIN_A sees only HOUSE_A and no groups; G1_MANAGER sees G1 and its houses; MEMBER_A without `finance_can_view` sees nothing.
  - gate: suspended house + admin → throws the suspended message; same + super admin → resolves; billing-locked + admin → throws the billing message; active house → resolves.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mcp): finance scope listing and write gate for blocked houses`

---

### Task 6: Read tools

**Files:**
- Create: `src/lib/mcp/read-tools.server.ts`
- Test: `src/lib/mcp/read-tools.server.test.ts`

**Interfaces:**
- Consumes: `listFinanceScopesFor`, `getFinanceDashboardFor`, `getTenantFinanceMonthFor`, `getTenantGoalsFor`, `McpIdentity`.
- Produces (each takes `(identity: McpIdentity, args)` and returns a plain JSON object):
  - `listarEscopos(identity)` → `FinanceScopes & { nivel: "leitura" | "leitura e escrita" }`
  - `resumoFinanceiro(identity, { escopo: { tipo: "casa"; id } | { tipo: "grupo"; id } | { tipo: "todas" }, periodo: { preset?: PeriodPreset; inicio?: string; fim?: string }, comparar?: CompareMode })` → `getFinanceDashboardFor` result, shaped compactly (totals, per-house rows, pendingDates, goals); money as numbers.
  - `mesDaCasa(identity, { casa: string; mes: "YYYY-MM" })` → `getTenantFinanceMonthFor` without `viewers` and without any e-mail field.
  - `metasDaCasa(identity, { casa: string })` → `getTenantGoalsFor`.
  - All map the escopo/args to the existing input schemas and let the `*For` permission check throw.

- [ ] **Step 1: Write failing tests:**
  - `"resumoFinanceiro totals equal getFinanceDashboardFor"` for a house and a group scope, same range.
  - `"mesDaCasa never returns viewers or e-mails"`: `JSON.stringify(result)` contains no `@` and no `viewers` key, even for a user with `finance_can_manage_viewers`.
  - Review Focus 1: `mesDaCasa` with HOUSE_B for ADMIN_A → rejects `"Sem permissão"`; `mesDaCasa` with a group id → rejects; `resumoFinanceiro` `{tipo:"todas"}` for ADMIN_A → rejects.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mcp): read tools over the finance panel functions`

---

### Task 7: Write actions, preview and confirm

**Files:**
- Create: `src/lib/mcp/write-actions.server.ts`, `src/lib/mcp/preview.server.ts`
- Test: `src/lib/mcp/preview.server.test.ts`

**Interfaces:**
- Consumes: Task 4 schemas/`*For`/`auditMetadata`, `requirePermission`, `assertTenantNotDemo`, `assertMcpCanWrite`, `getMcpLevel`, crypto, `PREVIEW_TTL_S`, `MAX_DAY_ENTRIES`.
- Produces:
  - `type WriteActionName = "lancamento_dias" | "ggr_mensal" | "custo" | "exclusao_custo" | "meta"`
  - `type WriteAction<I> = { schema: ZodType<I>; permission: "finance_can_edit_values" | "finance_can_manage_goals"; snapshot(tenantId: string, input: I): Promise<Json>; describe(before: Json, input: I, houseName: string): { linhas: string[]; avisos: string[] }; apply(ctx: ServerContext, input: I): Promise<unknown> }`; registry `WRITE_ACTIONS: Record<WriteActionName, WriteAction<any>>`. Schemas: `saveDaysInput` with `.max(MAX_DAY_ENTRIES)`, `setMonthlyGgrInput`, `saveOtherCostInput`, `deleteOtherCostInput`, `setGoalInput`. Permissions: goals → `finance_can_manage_goals`, others → `finance_can_edit_values`.
  - `createPreview(identity: McpIdentity, action: WriteActionName, rawInput: unknown): Promise<{ codigo_confirmacao: string; expira_em: string; linhas: string[]; avisos: string[] }>` — order: level must be `write` (else `"Seu acesso ao MCP é só leitura."`) → parse schema → `requirePermission` → `assertTenantNotDemo` → `assertMcpCanWrite` → snapshot → store row (hash of code) → return.
  - `confirmPreview(identity: McpIdentity, code: string): Promise<{ ok: true; resultado: unknown; ja_confirmada?: true }>` — row must match `identity.userId` and `identity.connectionId`, be unexpired; if `confirmed_at` set → return stored `result` with `ja_confirmada: true` (Review Focus 2); re-check level `write` via `getMcpLevel`, `requirePermission`, `assertMcpCanWrite`; recompute snapshot and compare (deep equal) → mismatch `"Os valores mudaram desde a prévia. Gere uma nova."`; mark `confirmed_at` **before** `apply` with a conditional update (`confirmed_at is null`) so concurrent confirms apply once; `apply` with `{ userId, auditMetadata: { origem: "mcp", connectionId, clientId, previewCode: <hash> } }`; store `result`.
  - Line format: `"15/10 Pixreals — GGR: R$ 12.000,00 → R$ 12.345,00"`; empty value shown as `"vazio"`; warnings `"Vai apagar o valor de Anúncios de 15/10"` (null on an existing value) and `"Sobrescreve um valor existente"`.

- [ ] **Step 1: Write failing tests** (`preview.server.test.ts`):
  - happy path for each of the 5 actions: preview stores nothing in finance tables; confirm writes and the audit row has `origem: "mcp"`.
  - preview line text for days exactly `"15/10 Pixreals — GGR: R$ 12.000,00 → R$ 12.345,00"`.
  - read-level identity → preview and confirm both reject `"Seu acesso ao MCP é só leitura."`.
  - another user / another connection with the same code → reject; after 10 min (fake timers) → reject.
  - double confirm → second returns `ja_confirmada: true`, `saveFinanceDaysFor` called once.
  - value changed between preview and confirm → reject with the "mudaram" message.
  - `mcp_access` deleted between preview and confirm → reject (Review Focus 5).
  - demo house → reject at preview; suspended house for admin → reject; for super admin → ok.
  - Review Focus 3: duplicated date, future date, 32 entries → reject at preview, no `mcp_previews` row.
- [ ] **Step 2: Run** `npx vitest run src/lib/mcp/preview.server.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mcp): write actions with server-side preview and confirm`

---

### Task 8: MCP endpoint, call log and rate limits

**Files:**
- Create: `src/lib/mcp/call-log.server.ts`, `src/lib/mcp/server.server.ts`, `src/routes/api/mcp.ts`
- Modify: `package.json` (`npm i @modelcontextprotocol/sdk@^1.32`)
- Test: `src/lib/mcp/server.server.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 6, 7.
- Produces:
  - `checkRateLimit(identity: McpIdentity, tool: string): Promise<void>` — counts `mcp_call_log` rows: > `CALLS_PER_MINUTE` for the connection in the last 60 s → `"Muitas chamadas. Aguarde um minuto."`; for `confirmar_alteracao`, ok rows of the user in the last hour ≥ `CONFIRMS_PER_HOUR` → `"Limite de confirmações por hora atingido."`.
  - `logCall(entry: { identity; tool; tenantId?: string | null; ok: boolean; error?: string; durationMs: number; previewCodeHash?: string }): Promise<void>` — never throws.
  - `createMcpServer(identity: McpIdentity): McpServer` — registers 10 tools: `listar_escopos`, `resumo_financeiro`, `mes_da_casa`, `metas_da_casa`, `preparar_lancamento_dias`, `preparar_ggr_mensal`, `preparar_custo`, `preparar_exclusao_custo`, `preparar_meta`, `confirmar_alteracao`. Each handler: rate limit → run → log → return `{ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }`; errors → `isError: true` with the pt-BR message. `preparar_*` description must say: "Mostre a prévia ao usuário e só chame confirmar_alteracao depois que ele aprovar." Tool annotations: read tools `readOnlyHint: true`; `confirmar_alteracao` `destructiveHint: true`.
  - Route `/api/mcp` POST/GET/DELETE: `!isMcpEnabled()` → 404; missing/invalid bearer → 401 with `WWW-Authenticate: Bearer resource_metadata="<app>/.well-known/oauth-protected-resource/api/mcp"`; else Web Standard Streamable HTTP transport, stateless (`sessionIdGenerator: undefined`), JSON responses.

- [ ] **Step 1: Write failing tests** (`server.server.test.ts`, using the SDK's in-memory client/transport pair against `createMcpServer`):
  - `listTools` returns exactly the 10 names above.
  - `listar_escopos` for ADMIN_A returns HOUSE_A; a call row exists in `mcp_call_log` with `ok: true`.
  - 61st call in a minute → `isError` with the rate message.
  - 31st confirmation in an hour → `isError` with the confirmation limit message.
  - a thrown "Sem permissão" becomes `isError: true`, logged with `ok: false`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; check the transport export path in the installed SDK (`node_modules/@modelcontextprotocol/sdk/package.json` exports) before wiring the route.
- [ ] **Step 4: Run** tests → PASS. Manual: `MCP_ENABLED=true npm run dev`; `curl -i -X POST localhost:3000/api/mcp` → 401 with `WWW-Authenticate`; with flag off → 404.
- [ ] **Step 5: Commit** `feat(mcp): /api/mcp endpoint with finance tools, call log and rate limits`

---

### Task 9: Screens — super admin access + "Conectar ao Claude"

**Files:**
- Create: `src/lib/mcp/mcp.functions.ts`, `src/components/admin/mcp-access-panel.tsx`, `src/routes/mcp.tsx`
- Modify: `src/routes/admin.tsx` (`ADMIN_VIEWS` at :136 add `{ value: "mcp", label: "MCP", hash: "mcp" }` + panel), `src/components/app-sidebar.tsx` (entry "Conectar ao Claude" → `/mcp`, visible when `getMyMcpStatus().enabled && level !== "none"`)
- Test: `src/lib/mcp/mcp.functions.test.ts`, `src/components/admin/mcp-access-panel.test.tsx`

**Interfaces — Produces** (all `requireSupabaseAuth`; admin ones also check `is_super_admin` like `billing.functions.ts:64`. Each admin change writes one `mcp_call_log` row via `logCall` with the super admin as `user_id` and `tool` = `"admin.set_access"` or `"admin.revoke_connection"`; `tenant_audit_logs` is per house and does not fit):
- `getMyMcpStatus()` → `{ enabled: boolean; level: McpLevel; mcpUrl: string; connections: Array<{ id; clientName; createdAt; lastUsedAt }> }`
- `revokeMyConnection({ connectionId })` — only own connections.
- `adminListMcpAccess()` → `Array<{ userId; nome; email; level: McpLevel; connections: Array<{ id; clientName; createdAt; lastUsedAt }> }>` — candidates: super admins, `user_roles` with role in (admin, owner, gestor), `tenant_finance_viewers`, `tenant_group_managers`.
- `adminSetMcpAccess({ userId, level: McpLevel })` — `none` deletes the row and revokes all connections.
- `adminRevokeConnection({ connectionId })`.
- `/mcp` page copy: URL in a copy field; three short sections "claude.ai" (Configurações → Conectores → Adicionar conector personalizado → colar a URL), "Claude Desktop" (mesmo caminho), "Claude Code" (`claude mcp add --transport http financeiro <URL>`); list of connections with "Desconectar".

- [ ] **Step 1: Write failing tests:** non-super-admin calling `adminSetMcpAccess` → rejects; `adminSetMcpAccess(level:"none")` revokes connections (their tokens stop resolving); `revokeMyConnection` with another user's connection → rejects; panel renders a user row and changing the select calls `adminSetMcpAccess` with `"write"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**, following `src/components/billing/admin/*` for table/dialog style.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(mcp): super admin access panel and Conectar ao Claude page`

---

### Task 10: End-to-end check and docs

**Files:**
- Modify: `docs/INDEX.md` (link the spec and plan), spec status line → "implementado (branch feat/mcp-financeiro)".

- [ ] **Step 1:** `npm run typecheck` → 0 errors; `npm run lint` → 0 errors; `npm test` → all pass; `npm run build` → success.
- [ ] **Step 2: Manual smoke (local):** `MCP_ENABLED=true npm run dev`; grant yourself `write` in Admin → MCP; `claude mcp add --transport http financeiro http://localhost:3000/api/mcp`; log in through the consent screen; ask "liste meus escopos", "resumo de outubro da casa demo", then "lança GGR 100 no dia de ontem na casa demo" → expect the demo refusal at preview; on a non-demo local house expect preview → confirm → row in `tenant_audit_logs` with `origem: "mcp"`.
- [ ] **Step 3: Commit** `docs: finance MCP spec status and index`

Deploy notes for the handoff (not a task): apply the migration in prod, set `MCP_ENABLED=true` and confirm `VITE_PUBLIC_APP_URL` is the public HTTPS origin (claude.ai must reach `/api/mcp` and `/.well-known/*`).
