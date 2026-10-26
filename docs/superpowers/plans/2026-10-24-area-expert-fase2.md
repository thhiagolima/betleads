# Área do Expert — Fase 2 (ficha do lead e ações) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O expert abre a ficha de um lead que pode ver, entende a situação dele (dados, benefícios, linha do tempo) e age: gera um link rastreado a partir do link de bônus do backoffice, abre o WhatsApp com mensagem pronta, registra o contato, agenda retorno, assume o lead (se for de acesso total) e pede sugestão de abordagem à IA.

**Architecture:** Toda leitura e escrita da ficha passa por server functions. Cada uma chama `requireExpertContext` e depois um guard único, `loadVisibleLead`, que confirma que o lead pertence à casa e ao alcance do expert (restrito: ID de afiliado dele; total: qualquer lead da casa). Só então lê com `supabaseAdmin`, selecionando colunas explícitas. A RLS do expert continua limitada a `players`, `deposits` e `withdrawals` (fase 1). Os dados novos ficam em tabelas próprias do expert: links, contatos, retornos, lead assumido e modelos. Essas tabelas são escritas só pelo service role. Os links reaproveitam o pipeline de rastreamento existente (`tracked_links`, `link_dispatches`, redirect first-party) com `source_type = 'expert'` e canal `whatsapp`.

**Tech Stack:** TanStack Start (createServerFn + zod), React + react-query, Supabase Postgres, Short.io, Vercel `ai` SDK via o gateway já usado em `src/lib/ai.functions.ts`, Vitest + PGlite.

**Spec:** `docs/superpowers/specs/2026-10-23-area-expert-design.md` (seção 5; seção 8 para os modelos de mensagem)

## Decisões que este plano toma (o spec deixa em aberto)

- **Ação 6 ("Colocar num fluxo dele") fica para a fase 4.** Ela depende de fluxos com dono, que só existem na fase 4 da ordem de entrega do spec. Nesta fase o botão não aparece.
- **Contatos e retornos em tabelas novas, sem estender `lead_followups`.** `lead_followups` é da casa, tem outra semântica (`acao` = canal) e não tem data de retorno.
- **Modelos de mensagem entram nesta fase**, porque a ação 2 depende deles. São modelos do próprio expert, mais os `sms_templates` da casa só para leitura, com "copiar para os meus" (spec §8).
- **Assumir lead:** só o expert de acesso total. Se outro expert tem o lead assumido e o prazo não venceu, o pedido é recusado com quem e até quando. O mesmo expert pode renovar. Mandar link ou mensagem nunca é bloqueado; o aviso aparece na ficha.
- **Encurtador:** se a casa tem Short.io configurado, o link sai encurtado. Se não tem, sai o link first-party rastreado, sem encurtar. Nos dois casos o clique é registrado.
- **Situação e nível** vêm dos helpers que a casa já usa: `playerSituation` (`src/lib/player-situation.ts`) e `levelForTotal` (`src/lib/player-level.ts`), com as configurações da casa.

## Global Constraints

- Todo texto de interface e mensagem de erro para o usuário em pt-BR.
- Migrations com timestamp ≥ `20261027100000`. A última existente é `20261026100000_purge_stale_selection_audiences.sql`.
- Tabelas novas: RLS ligada, `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ... FROM anon, authenticated`, escrita só via `supabaseAdmin` nas server functions. SELECT para membros da casa: `is_super_admin() OR tenant_id = current_tenant_id()`, para o admin poder ver na fase 3. Experts não têm política nelas; leem só via server functions.
- Funções SQL novas: `SECURITY DEFINER`, `SET search_path = public, pg_temp`, só para service_role.
- Toda server function do expert: `requireExpertContext(ctx.userId, ctx.activeTenantId)` e depois `loadVisibleLead(expert, playerId)` antes de qualquer leitura ou escrita sobre o lead. Nunca confiar em `tenantId` vindo do cliente.
- O expert nunca vê CPF, e-mail, saldos de carteira ou notas e contatos de outros experts. Ele só vê que outro expert assumiu o lead (nome e prazo).
- Antes de qualquer chamada externa (Short.io, IA): `assertTenantCanSendExternally(tenantId)`. A casa demo é bloqueada.
- Resultados de contato: `chamei` | `respondeu` | `prometeu_depositar` | `sem_interesse`. Rótulos: "Chamei", "Respondeu", "Prometeu depositar", "Sem interesse". Nota: até 1000 caracteres.
- Prazo de "assumir" = `experts.assumir_prazo_dias` (padrão 3, já existe na fase 1).
- Link de oferta: URL `http`/`https` com até 2048 caracteres. Nome da oferta: 2 a 60 caracteres.
- Modelo de mensagem do expert: nome de 2 a 60 caracteres, conteúdo de 1 a 1000. Variáveis renderizadas por `buildPlayerVariables` + `renderTemplate` (`src/lib/template-vars.server.ts`), com `{link}` = o link rastreado gerado.
- Telefone para `wa.me`: `normalizeBrazilianPhone` (`src/lib/phone-normalization.ts`) sem o `+`. Sem telefone válido, o botão fica desabilitado com "Lead sem telefone válido.".
- Não usar `git stash` (pilha compartilhada entre sessões).
- Verificação final: `npm run typecheck`, `npm run lint` (0 erros), `npm test`, `npm run build` passam.

## Review Focus

1. **Expert restrito pedindo a ficha ou agindo sobre um lead de outro afiliado** (ou de outra casa, passando o `playerId` direto): recebe "Lead não encontrado." e nada é gravado. Teste nas Tasks 2, 3 e 5.
2. **Link colado inválido ou perigoso** (`javascript:`, sem esquema, gigante): recusado com mensagem pt-BR, sem chamar o Short.io. Teste na Task 3.
3. **Casa sem Short.io configurado ou com Short.io fora do ar:** com encurtador ausente, sai o link first-party rastreado. Com falha do Short.io, aparece "Não foi possível encurtar o link agora. Tente de novo." e não fica registro de link órfão. Teste na Task 3.
4. **Dois experts de acesso total assumindo o mesmo lead ao mesmo tempo:** só um vence; o outro recebe "Lead já assumido por {nome} até {dd/mm}.". Teste na Task 1, na função SQL atômica.
5. **Lead sem telefone, sem depósitos ou sem nenhum evento:** a ficha abre com zeros, "Sem depósito" e linha do tempo vazia ("Nada por aqui ainda."), sem quebrar. Teste na Task 2.

---

### Task 1: Tabelas do expert e função de assumir lead

**Files:**
- Create: `supabase/migrations/20261027100000_expert_lead_sheet.sql`
- Test: `src/lib/expert-lead-sheet.db.test.ts`

**Interfaces:**
- Produces (SQL):
  - `expert_links`: `id uuid PK`, `tenant_id → tenants ON DELETE CASCADE`, `expert_id → experts ON DELETE CASCADE`, `player_id → players ON DELETE CASCADE`, `link_dispatch_id uuid NULL → link_dispatches ON DELETE SET NULL`, `oferta text NOT NULL CHECK (char_length(btrim(oferta)) BETWEEN 2 AND 60)`, `original_url text NOT NULL`, `sent_url text NOT NULL`, `shortened boolean NOT NULL`, `created_at`. Índice `(tenant_id, player_id, created_at desc)` e `(tenant_id, expert_id, created_at desc)`.
  - `expert_lead_contacts`: `id`, `tenant_id`, `expert_id`, `player_id`, `resultado text NOT NULL CHECK (resultado IN ('chamei','respondeu','prometeu_depositar','sem_interesse'))`, `nota text NULL CHECK (char_length(nota) <= 1000)`, `created_at`. Mesmas FKs e índices de `expert_links`.
  - `expert_lead_followups`: `id`, `tenant_id`, `expert_id`, `player_id`, `due_date date NOT NULL`, `nota text NULL CHECK (char_length(nota) <= 1000)`, `done_at timestamptz NULL`, `created_at`. Índice `(tenant_id, expert_id, due_date) WHERE done_at IS NULL`.
  - `expert_lead_claims`: `tenant_id`, `player_id`, `expert_id`, `claimed_at timestamptz NOT NULL DEFAULT now()`, `expires_at timestamptz NOT NULL`, `PRIMARY KEY (tenant_id, player_id)`. Uma linha por lead; renovar ou trocar faz update.
  - `expert_message_templates`: `id`, `tenant_id`, `expert_id`, `nome text CHECK 2..60 após btrim`, `conteudo text CHECK 1..1000`, `created_at`, `updated_at`. Índice único `(expert_id, lower(btrim(nome)))`.
  - Trigger em todas as tabelas acima: o `tenant_id` da linha precisa ser o mesmo do `experts.tenant_id` e do `players.tenant_id` (quando a tabela tem `player_id`). Senão, `RAISE 'expert_lead_tenant_mismatch'`.
  - RLS e grants conforme as Global Constraints.
  - `claim_expert_lead(_tenant uuid, _expert_id uuid, _player_id uuid) RETURNS TABLE(expert_id uuid, expert_nome text, expires_at timestamptz, claimed boolean)`:
    - Lê `assumir_prazo_dias` do expert e exige `tipo='total'` e `ativo`. Senão, `RAISE 'expert_claim_not_allowed'`.
    - Faz `INSERT ... ON CONFLICT (tenant_id, player_id) DO UPDATE` só quando a linha existente é do mesmo expert ou está vencida (`expires_at <= now()`).
    - Se outro expert tem o lead dentro do prazo, devolve a linha atual com `claimed=false`, sem erro.
    - Se conseguiu assumir, devolve `claimed=true` e o novo `expires_at = now() + prazo dias`.
  - `release_expert_lead(_tenant uuid, _expert_id uuid, _player_id uuid) RETURNS void`: apaga a linha só se for do mesmo expert.

- [ ] **Step 1: Write the failing test** `src/lib/expert-lead-sheet.db.test.ts` (PGlite, mesmo SCHEMA de `src/lib/expert-model.db.test.ts`, incluindo `alter default privileges ... grant all on tables to authenticated`; executa as migrations `20261025100000`, `20261025100100` e a nova). Asserts:
  - `it("claim by a total expert sets expires_at = now + assumir_prazo_dias")`
  - `it("second total expert gets claimed=false with the holder's name while the claim is active")`
  - `it("same expert renews the claim")`
  - `it("expired claim can be taken by another expert")` (manipula `expires_at` para o passado)
  - `it("restricted or inactive expert gets expert_claim_not_allowed")`
  - `it("release only removes the caller's own claim")`
  - `it("rows whose tenant differs from the expert's or the player's are rejected")` (`/expert_lead_tenant_mismatch/`)
  - `it("contact resultado outside the allowed set is rejected")`
  - `it("authenticated cannot write any expert lead table nor execute claim_expert_lead")` (`/permission denied/`)

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run src/lib/expert-lead-sheet.db.test.ts`
  Expected: FAIL (migration inexistente)

- [ ] **Step 3: Write the migration**

- [ ] **Step 4: Run test to verify it passes**

  Run: `npx vitest run src/lib/expert-lead-sheet.db.test.ts src/lib/expert-model.db.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit** (`feat(expert): lead sheet tables and atomic lead claim`)

---

### Task 2: Guard de lead visível e dados da ficha

**Files:**
- Create: `src/lib/expert-lead-access.server.ts`
- Create: `src/lib/expert-lead-sheet.ts` (puro: tipos e montagem da linha do tempo)
- Create: `src/lib/expert-lead-sheet.functions.ts`
- Test: `src/lib/expert-lead-access.server.test.ts`, `src/lib/expert-lead-sheet.test.ts`, `src/lib/expert-lead-sheet.functions.test.ts`

**Interfaces:**
- Consumes: `requireExpertContext`, `ExpertContext`, `ExpertAccessError` (`src/lib/expert-access.server.ts`); `playerSituation`, `situationSettingsFromRow`, `SITUATION_LABEL` (`src/lib/player-situation.ts`); `levelForTotal`, `thresholdsFromSettingsRow` (`src/lib/player-level.ts`); as tabelas da Task 1.
- Produces:
  - `loadVisibleLead(expert: ExpertContext, playerId: string): Promise<VisibleLead>` em `expert-lead-access.server.ts`.
    - Lê com `supabaseAdmin` só `id, tenant_id, nome, telefone, affiliate_id, total_depositado, total_sacado, ultimo_deposito, ftd_em, created_at, risco, vip, saldo_bonus, last_cashback_amount, last_cashback_paid_at, total_cashback_paid`, com `.eq("id", playerId).eq("tenant_id", expert.tenantId)`.
    - Para `tipo='restrito'`, exige `btrim(affiliate_id)` em `expert.affiliateIds`.
    - Se o lead não existe ou está fora do alcance: `ExpertAccessError("Lead não encontrado.")`.
    - `export type VisibleLead` = esse recorte de colunas.
  - `export type ExpertTimelineItem = { id: string; kind: "deposito" | "saque" | "cashback" | "sms_casa" | "email_casa" | "link_expert" | "clique" | "contato" | "retorno"; at: string; titulo: string; detalhe: string | null; valor: number | null }`.
  - `buildExpertTimeline(sources: ExpertTimelineSources, limit = 60): ExpertTimelineItem[]` em `expert-lead-sheet.ts`: ordem decrescente por `at`, corte em `limit`. Títulos:
    - "Depósito", "Saque", "Cashback";
    - "SMS da casa" (detalhe = conteúdo truncado em 160) e "E-mail da casa" (detalhe = assunto);
    - "Você enviou o link \"{oferta}\"" e "Clicou no link \"{oferta}\"";
    - "Contato: {Rótulo do resultado}" (detalhe = nota);
    - "Retorno agendado para {dd/mm/aaaa}".
  - `export type ExpertLeadSheet`:
    - `lead: { id; nome; telefone: string | null; nivel: LevelSlug; situacao: PlayerSituation; situacaoLabel: string; diasSemDepositar: number | null; totalDepositado; depositos: number; ticketMedio: number | null; ultimoDeposito: { valor: number; at: string } | null; totalSacado; origemAfiliadoDoExpert: boolean }`
    - `beneficios: { tipo: "cashback" | "bonus"; valor: number; at: string | null }[]` (até 10 cashbacks de `cashback_payments`, mais o saldo de bônus atual se > 0, com `at: null`)
    - `timeline: ExpertTimelineItem[]`
    - `claim: { expertNome: string; expiresAt: string; minha: boolean } | null` (só quando ativo)
    - `retornosPendentes: { id; dueDate; nota }[]` (do próprio expert)
    - `podeAssumir: boolean` (= `tipo==='total'`)
  - `getExpertLeadSheet` (createServerFn POST, `requireSupabaseAuth`, entrada `{ playerId: uuid }`) → `ExpertLeadSheet`. Exportar `getExpertLeadSheetFor(ctx, data)`.
    - Fontes: `deposits` e `withdrawals` (aprovados, últimos 50), `cashback_payments` (10), `sms_send_logs` com `status` enviado ou entregue (20), `email_send_logs` enviados (20).
    - Também: `expert_links` + cliques via `link_dispatches.first_party_first_clicked_at` / `click_events` humanos do `link_dispatch_id`, `expert_lead_contacts` e `expert_lead_followups` **só do próprio expert**, e `expert_lead_claims` do lead.
    - Todas filtradas por `tenant_id = expert.tenantId` e `player_id`.

- [ ] **Step 1: Write the failing tests**
  - `expert-lead-access.server.test.ts` (createFakeDb de `src/lib/sms-bulk.test-support.ts`):
    - `it("restricted expert loads a lead of own affiliate id")` (com espaços no `affiliate_id` gravado)
    - `it("restricted expert gets 'Lead não encontrado.' for another affiliate")`
    - `it("total expert loads any lead of the house")`
    - `it("lead of another house is not found even for total expert")`
    - `it("selects no cpf, email or wallet balances")` (asserta a string do select)
  - `expert-lead-sheet.test.ts`:
    - `it("timeline merges sources newest first and caps at 60")`
    - `it("titles use the pt-BR copy")` (um caso por `kind`)
    - `it("sms detail is truncated to 160 chars")`
    - `it("empty sources give an empty timeline")`
  - `expert-lead-sheet.functions.test.ts`:
    - `it("lead without deposits: depositos 0, ticketMedio null, ultimoDeposito null, situacao from playerSituation")`
    - `it("ticketMedio = totalDepositado / depositos")`
    - `it("only the caller's contacts and followups are read")` (asserta o filtro `expert_id`)
    - `it("claim of another expert shows name and minha=false; expired claim is null")`
    - `it("every query is scoped by tenant_id and player_id")`

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run src/lib/expert-lead-access.server.test.ts src/lib/expert-lead-sheet.test.ts src/lib/expert-lead-sheet.functions.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement the three modules**

- [ ] **Step 4: Run tests to verify they pass** (mesmo comando) — Expected: PASS

- [ ] **Step 5: Commit** (`feat(expert): visible-lead guard and lead sheet data`)

---

### Task 3: Gerar link rastreado para o lead

**Files:**
- Modify: `src/lib/shortio.server.ts` (exportar um helper novo, sem alterar o comportamento dos existentes)
- Create: `src/lib/expert-links.functions.ts`
- Test: `src/lib/shortio-recipient-link.test.ts`, `src/lib/expert-links.functions.test.ts`

**Interfaces:**
- Consumes: `getOrCreateTrackedLink`, `persistDispatch`, `markTrackedDispatchesSent`, `resolveShortenerDomain`, `deterministicToken`, `buildFirstPartyClickUrl` (internos de `shortio.server.ts` e `click-tracking.server.ts`); `loadVisibleLead` (Task 2); `assertTenantCanSendExternally`; `expert_links` (Task 1).
- Produces:
  - Em `shortio.server.ts`: `createTrackedLinkForRecipient(input: { tenantId: string; originalUrl: string; channel: "whatsapp"; sourceType: "expert"; sourceId: string; recipientPlayerId: string; deliveryKey: string }): Promise<{ sentUrl: string; dispatchId: string; trackingToken: string; shortened: boolean }>`.
    - Monta o redirect first-party com o token, igual ao que `prepareTrackedText` faz.
    - Se a casa tem Short.io habilitado e um domínio resolvido, encurta via `getOrCreateTrackedLink` e devolve `shortened: true`. Senão, devolve o link first-party com `shortened: false`.
    - Grava o `link_dispatches` (`persistDispatch`, `message_log_type = 'expert_links'`) e marca como enviado (`markTrackedDispatchesSent`).
    - **Não** passa pelo filtro de `enabled_channels` (é uma geração manual).
    - Uma falha do Short.io lança `ShortenerUnavailableError`, exportada, sem gravar o dispatch.
  - `generateExpertLink` (createServerFn POST, entrada `{ playerId: uuid; url: string; oferta: string }`) → `{ id: string; sentUrl: string; shortened: boolean }`. Exportar `generateExpertLinkFor(ctx, data)`.
    - Validação: `new URL(url)` com protocolo `http:` ou `https:` e no máximo 2048 caracteres. Senão: "Cole um link válido começando com http:// ou https://.". `oferta` com btrim entre 2 e 60. Senão: "Dê um nome à oferta (2 a 60 caracteres).".
    - Ordem: `requireExpertContext` → `loadVisibleLead` → `assertTenantCanSendExternally` → `createTrackedLinkForRecipient` (`sourceId = expert.expertId`, `deliveryKey = expert_links:{uuid novo}`) → insert em `expert_links`.
    - `ShortenerUnavailableError` → "Não foi possível encurtar o link agora. Tente de novo.".

- [ ] **Step 1: Write the failing tests**
  - `shortio-recipient-link.test.ts` (mocks no estilo dos testes existentes de `shortio.server`):
    - `it("shortens when the house has Short.io enabled")`
    - `it("returns the first-party tracked URL when Short.io is disabled")`
    - `it("ignores enabled_channels for manual whatsapp generation")`
    - `it("Short.io failure throws ShortenerUnavailableError and persists no dispatch")`
    - `it("marks the dispatch as sent with source_type expert and recipient_player_id")`
  - `expert-links.functions.test.ts`:
    - `it("rejects javascript:, relative and >2048-char urls before any provider call")`
    - `it("rejects a lead outside the restricted expert's reach and writes nothing")`
    - `it("demo house is refused by assertTenantCanSendExternally")`
    - `it("records expert_links with oferta trimmed and returns sentUrl")`
    - `it("maps ShortenerUnavailableError to the pt-BR message")`

- [ ] **Step 2: Run tests to verify they fail**

  Run: `npx vitest run src/lib/shortio-recipient-link.test.ts src/lib/expert-links.functions.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement the helper and the server function**

- [ ] **Step 4: Run tests** (os dois novos, mais `npx vitest run src/lib/shortio` para checar que nada regrediu) — Expected: PASS

- [ ] **Step 5: Commit** (`feat(expert): tracked short link per lead for external WhatsApp`)

---

### Task 4: Modelos de mensagem e texto pronto para o WhatsApp

**Files:**
- Create: `src/lib/expert-templates.functions.ts`
- Test: `src/lib/expert-templates.functions.test.ts`

**Interfaces:**
- Consumes: `requireExpertContext`, `loadVisibleLead`, `buildPlayerVariables`, `renderTemplate`, `loadHouseLinks`, `expert_message_templates` (Task 1), `sms_templates`.
- Produces:
  - `export type ExpertTemplate = { id: string; nome: string; conteudo: string; origem: "meu" | "casa" }`
  - `listExpertTemplates()` → `{ meus: ExpertTemplate[]; casa: ExpertTemplate[] }`. `casa` = `sms_templates` ativos da casa (`is_active`), mapeando `name`/`content`, só leitura.
  - `saveExpertTemplate({ id?: uuid; nome; conteudo })` → `{ id }`. Só edita modelo do próprio expert (`expert_id`). Erros:
    - nome repetido → "Você já tem um modelo com esse nome.";
    - modelo de outro expert ou inexistente → "Modelo não encontrado.".
  - `deleteExpertTemplate({ id })`
  - `copyHouseTemplate({ smsTemplateId })` → `{ id }`. Copia para os modelos do expert com o nome "{nome} (cópia)", cortado em 60.
  - `renderExpertMessage({ playerId: uuid; conteudo: string (1..1000); link?: string })` → `{ texto: string; faltaLink: boolean }`.
    - Usa `loadVisibleLead` → `buildPlayerVariables(lead, house)` com `link` = o `link` recebido.
    - `faltaLink = true` quando o conteúdo tem `{link}` e nenhum link foi passado. Nesse caso o `{link}` fica literal no texto.
    - O `link` recebido precisa ser um `sent_url` de `expert_links` do próprio expert para aquele lead. Senão: "Gere o link da oferta antes de usar {link}.". Isso impede colar no texto um link sem rastreio.
  - Todas com a variante `…For(ctx, data)` exportada.

- [ ] **Step 1: Write the failing test** `expert-templates.functions.test.ts`:
  - `it("lists own templates and the house's active sms templates as read-only")`
  - `it("save refuses editing another expert's template")`
  - `it("duplicate name maps to the pt-BR message")`
  - `it("copy creates '{nome} (cópia)' capped at 60 chars")`
  - `it("render fills {nome}, {primeiro_nome}, {dias_sem_depositar} and {link}")`
  - `it("render with {link} and no link returns faltaLink=true")`
  - `it("render refuses a link that is not one of the expert's links for this lead")`
  - `it("render refuses a lead outside reach")`

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run src/lib/expert-templates.functions.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS

- [ ] **Step 5: Commit** (`feat(expert): message templates and ready-to-send WhatsApp text`)

---

### Task 5: Contato, retorno e assumir lead

**Files:**
- Create: `src/lib/expert-lead-actions.functions.ts`
- Test: `src/lib/expert-lead-actions.functions.test.ts`

**Interfaces:**
- Consumes: `requireExpertContext`, `loadVisibleLead`, `claim_expert_lead` e `release_expert_lead` (Task 1).
- Produces (cada uma com `…For(ctx, data)` exportada):
  - `export const CONTATO_RESULTADOS = ["chamei","respondeu","prometeu_depositar","sem_interesse"] as const;` e `CONTATO_LABEL: Record<…, string>` com os rótulos das Global Constraints. Ficam num módulo puro, `src/lib/expert-lead-labels.ts`, para a UI importar.
  - `logExpertContact({ playerId; resultado; nota? })` → `{ id }`.
  - `scheduleExpertFollowup({ playerId; dueDate: "YYYY-MM-DD"; nota? })` → `{ id }`. `dueDate` não pode ser anterior a hoje no fuso `America/Sao_Paulo`. Senão: "Escolha hoje ou uma data futura.".
  - `completeExpertFollowup({ id })`: só retorno do próprio expert. Grava `done_at = now()`.
  - `listExpertFollowupsDue()` → `{ id; playerId; nome; dueDate; nota; atrasado: boolean }[]`.
    - Retornos do expert com `done_at IS NULL` e `due_date <= hoje` (fuso São Paulo), ordenados por data.
    - Para restrito, só leads ainda visíveis: refiltra pelo `affiliate_id` atual dos leads.
  - `claimExpertLead({ playerId })` → `{ claimed: boolean; expertNome: string; expiresAt: string }`.
    - `claimed=false` vira erro "Lead já assumido por {nome} até {dd/mm}.".
    - Expert restrito → "Só experts com acesso total podem assumir leads.".
  - `releaseExpertLead({ playerId })`.

- [ ] **Step 1: Write the failing test** `expert-lead-actions.functions.test.ts`:
  - `it("logs a contact for a visible lead and rejects an out-of-reach lead")`
  - `it("rejects resultado outside the set and nota over 1000 chars")`
  - `it("followup in the past (São Paulo date) is refused")` (fixa o relógio em 2026-10-24T02:00Z, que é dia 23 em São Paulo, e `dueDate` 2026-10-23 é aceito)
  - `it("due list shows today and overdue, flags atrasado, hides leads no longer visible")`
  - `it("complete only affects the caller's own followup")`
  - `it("claim conflict maps to 'Lead já assumido por Ana até 26/10.'")`
  - `it("restricted expert cannot claim")`

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run src/lib/expert-lead-actions.functions.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS

- [ ] **Step 5: Commit** (`feat(expert): contact log, follow-ups and lead claim actions`)

---

### Task 6: Sugestão de abordagem (IA)

**Files:**
- Create: `src/lib/expert-ai.functions.ts`
- Test: `src/lib/expert-ai.functions.test.ts`

**Interfaces:**
- Consumes: `getExpertLeadSheetFor` (Task 2), o provider e o modelo de `src/lib/ai.functions.ts` (`createLovableAiGatewayProvider` + o mesmo id de modelo; reaproveitar sem duplicar a configuração), `assertTenantCanSendExternally`.
- Produces: `suggestExpertApproach({ playerId: uuid })` → `{ oferta: string; mensagem: string }`. Exportar `suggestExpertApproachFor(ctx, data, deps?)`, com `deps.generate` injetável para teste.
  - O prompt (pt-BR) leva só: situação, nível, dias sem depositar, total depositado, número de depósitos, ticket médio, benefícios recentes, as últimas 10 entradas da linha do tempo (títulos e datas) e o resultado do último contato do expert.
  - Nunca leva telefone, nome completo, CPF ou e-mail. Usa só o primeiro nome.
  - Pede uma resposta em JSON `{oferta, mensagem}` com `mensagem` de no máximo 400 caracteres, que pode conter `{link}`.
  - Resposta que não é JSON válido → "A IA não conseguiu sugerir agora. Tente de novo.".

- [ ] **Step 1: Write the failing test** `expert-ai.functions.test.ts`:
  - `it("prompt contains the lead summary and never the phone or full name")`
  - `it("parses {oferta, mensagem} and truncates mensagem to 400")`
  - `it("invalid model output maps to the pt-BR retry message")`
  - `it("demo house is refused before calling the model")`
  - `it("lead outside reach is refused before calling the model")`

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx vitest run src/lib/expert-ai.functions.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run test to verify it passes** — Expected: PASS

- [ ] **Step 5: Commit** (`feat(expert): AI approach suggestion for a lead`)

---

### Task 7: Tela da ficha do lead

**Files:**
- Create: `src/routes/expert.leads.$playerId.tsx`
- Create: `src/components/expert/lead-sheet-header.tsx`, `src/components/expert/lead-timeline.tsx`, `src/components/expert/lead-actions.tsx` (link + WhatsApp + IA), `src/components/expert/lead-contact-panel.tsx` (contato + retorno + assumir)
- Modify: `src/routes/expert.leads.tsx` (cada linha leva à ficha), `src/lib/navigation.ts` (`ROUTE_META["/expert/leads/$playerId"] = { section: "Expert", title: "Ficha do lead" }`, mantendo "Leads" ativo no menu)
- Modify: `src/routeTree.gen.ts` (regenerado pelo build)

**Interfaces:**
- Consumes: Tasks 2–6 (`getExpertLeadSheet`, `generateExpertLink`, `listExpertTemplates`, `renderExpertMessage`, `logExpertContact`, `scheduleExpertFollowup`, `completeExpertFollowup`, `claimExpertLead`, `releaseExpertLead`, `suggestExpertApproach`, `CONTATO_LABEL`); `expertAccessErrorMessage` (`src/lib/expert-access-message.ts`; "Lead não encontrado." aparece como está); `normalizeBrazilianPhone`.
- Produces: a ficha, com o layout do mockup aprovado no brainstorm.
  - **Esquerda:**
    - cabeçalho (nome, telefone, origem "Afiliado seu" quando for o caso, badge de nível, badge de situação);
    - cartões (Sem depositar, Total depositado, Depósitos, Ticket médio, Último depósito, Saques);
    - "Benefícios já recebidos";
    - linha do tempo, com estado vazio "Nada por aqui ainda.".
  - **Direita:**
    - **Link da oferta:** campos URL e nome da oferta, botão "Gerar link" e, depois, o link com "Copiar". Quando o link não foi encurtado: "Encurtador não configurado; o link é rastreado mesmo assim.".
    - **Mensagem:** seletor de modelo (meus e da casa), texto editável, botão "Abrir no WhatsApp" (abre `https://wa.me/{numero}?text=…` em nova aba) e "Copiar texto". Com `{link}` sem link gerado: "Gere o link da oferta para preencher {link}.".
    - **Sugestão da IA:** botão "Sugerir abordagem"; o resultado traz o botão "Usar esta mensagem".
    - **Registrar contato:** 4 botões de resultado e uma nota opcional.
    - **Agendar retorno:** data e nota; abaixo, a lista de retornos pendentes deste lead com "Concluir".
    - **Assumir lead:** só aparece para expert total. Mostra "Em atendimento por {nome} até {dd/mm}" quando outro expert tem o lead, e "Você assumiu até {dd/mm} · Liberar" quando é do próprio expert.
  - Depois de cada ação, invalida a query da ficha.

- [ ] **Step 1: Implement the route and components** seguindo os padrões de `src/routes/expert.leads.tsx` (react-query + `useServerFn`, `PageHeader`, Card) e o layout dark e mobile do shell. No mobile, as colunas viram uma só, com a coluna de ações primeiro.

- [ ] **Step 2: Verify**

  Run: `npm run build` (regenera o route tree), `npm run typecheck`, `npx eslint` nos arquivos tocados, `npx vitest run src/lib/navigation.test.ts`
  Expected: tudo passa; o route tree contém `/expert/leads/$playerId`

- [ ] **Step 3: Commit** (`feat(expert): lead sheet screen with actions`)

---

### Task 8: Modelos de mensagem (tela) e "Para chamar hoje"

**Files:**
- Create: `src/routes/expert.modelos.tsx`
- Modify: `src/routes/expert.index.tsx` (cartão "Para chamar hoje")
- Modify: `src/lib/navigation.ts` (`EXPERT_SECTIONS` e `EXPERT_MOBILE_TABS` ganham "Modelos" → `/expert/modelos`; `ROUTE_META["/expert/modelos"] = { section: "Expert", title: "Modelos de mensagem" }`), `src/lib/navigation.test.ts` (atualizar "expert sees only the expert section" para `["/expert", "/expert/leads", "/expert/modelos"]`)

**Interfaces:**
- Consumes: Task 4 (`listExpertTemplates`, `saveExpertTemplate`, `deleteExpertTemplate`, `copyHouseTemplate`), Task 5 (`listExpertFollowupsDue`, `completeExpertFollowup`).
- Produces:
  - `/expert/modelos`:
    - lista "Meus modelos" (editar, excluir com confirmação, novo);
    - lista "Modelos da casa" só para leitura, com "Copiar para os meus";
    - ajuda com as variáveis disponíveis, a partir do catálogo `MESSAGE_VARIABLES` / `variablesForChannel` de `src/lib/message-variables.ts`;
    - limites de nome e conteúdo validados no cliente, com dicas pt-BR, como na tela Experts.
  - Cartão **"Para chamar hoje"** em `/expert`:
    - os retornos de hoje e os atrasados (badge "Atrasado"), cada um levando à ficha, com "Concluir";
    - vazio: "Nenhum retorno para hoje.".

- [ ] **Step 1: Write the failing navigation test update**, then implement the screen, the card and the menu entries.

- [ ] **Step 2: Verify**

  Run: `npm run build`, `npm run typecheck`, `npx eslint` nos arquivos tocados, `npx vitest run src/lib/navigation.test.ts`
  Expected: PASS

- [ ] **Step 3: Commit** (`feat(expert): message templates screen and today's follow-ups`)

---

### Task 9: Verificação completa e produção

- [ ] **Step 1:** `npm run typecheck && npm run lint && npm test && npm run build`. Tudo passa; registrar a saída.
- [ ] **Step 2:** Pedir autorização explícita à usuária para aplicar `20261027100000_expert_lead_sheet.sql` em produção (pooler; registrar em `supabase_migrations.schema_migrations`). Depois, verificação só leitura: as 5 tabelas, a função `claim_expert_lead` e os grants sem escrita para `authenticated`.
- [ ] **Step 3:** Integrar via superpowers:finishing-a-development-branch (merge em `main` e push, que dispara o deploy), com autorização da usuária.
