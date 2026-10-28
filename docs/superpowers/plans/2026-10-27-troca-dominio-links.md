# Trocar domínio nos links — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ferramenta em "Configurar casa" que encontra URLs escritas à mão com o domínio antigo da casa (jornadas, templates de SMS/e-mail, links rápidos, domínios permitidos do rastreio) e troca só o host pelo domínio novo, com prévia e confirmação.

**Architecture:** Uma função pura de troca (`replaceLinkDomain`) e um planejador puro (`planLinkDomainChange`) decidem tudo; o servidor só carrega as linhas do tenant, chama o planejador e aplica o resultado por uma RPC transacional (`apply_link_domain_change`, service role) que também grava o audit log. A UI é um diálogo de 2 passos aberto por botão ou automaticamente após salvar um `site_url` com host diferente.

**Tech Stack:** TypeScript, TanStack Start (`createServerFn`), React Query, Supabase/Postgres (plpgsql RPC), Vitest, PGlite para testes de SQL.

**Spec:** `docs/superpowers/specs/2026-10-27-troca-dominio-links-design.md`

## Global Constraints

- Toda a UI e mensagens de erro em pt-BR.
- Escopo por tenant em toda leitura e escrita; nunca cross-tenant (nem para super admin — usa o tenant atual).
- Guard: `requireHouseAdmin(context)` de `src/lib/house-config.functions.ts` (admin da casa + `assertTenantNotDemo`).
- Casamento só de URLs `http(s)://` cujo host, sem `www.`, é **exatamente** o domínio antigo. Subdomínios não são trocados. Só o host muda; `www.` original é preservado.
- Jornadas: `draft`, `active`, `paused` (nunca `archived`), atualizadas **no lugar** (sem `save_journey_draft`, sem revisão).
- Templates: SMS `is_active = true`; e-mail `lifecycle_status <> 'archived'`.
- Limites: `sms_templates.content` ≤ 480; SMS de jornada (`content`, cada variante, `template_snapshot.content`) ≤ 1600; `template_snapshot.subject` ≤ 255; `tenant_quick_links.path` ≤ 500.
- Rastreio: lista não vazia sem o domínio novo → **adiciona** o novo, mantém o antigo. Lista vazia → nada.
- Audit: `tenant_audit_logs.action = 'house.link_domain_changed'`, `entity_type = 'tenant'`, `entity_id = tenantId`.
- `npm run build` antes do merge (memória do projeto: pega `*.server` vazando para o client).

## Review Focus

- Domínio antigo como sufixo de outro (`casa.com` vs `minhacasa.com`, `casa.com.br`, `casa.combo.net`) → nada é trocado. (Task 1)
- URL colada com esquema/caminho/maiúsculas no campo de domínio (`https://WWW.Casa-Antiga.com/promo`) → é normalizada para `casa-antiga.com`. (Task 1)
- Domínio antigo == novo (após normalizar) → erro pt-BR "Os dois domínios são iguais.", nada é procurado. (Task 2)
- Item editado entre a prévia e a aplicação → aplicação recalcula do banco; se agora estoura limite, a operação inteira falha com mensagem e nada muda. (Task 4)
- Id de outra casa enviado no `apply` → ignorado/rejeitado, nunca alterado (RPC filtra por `_tenant`). (Task 3)

---

## File Structure

- Create `src/lib/link-domain.ts` — pure: normalização, `replaceLinkDomain`, `countSubdomainLinks`. Client+server safe.
- Create `src/lib/link-domain-plan.ts` — pure: tipos de fonte/prévia e `planLinkDomainChange`.
- Create `supabase/migrations/20261104100000_apply_link_domain_change.sql` — RPC.
- Create `src/lib/link-domain.server.ts` — `loadLinkDomainSources(tenantId)` (supabaseAdmin).
- Create `src/lib/link-domain.functions.ts` — `previewLinkDomainChange`, `applyLinkDomainChange`.
- Modify `src/lib/house-links.server.ts` — export `invalidateHouseLinks(tenantId)`.
- Modify `src/lib/house-config.functions.ts:489-503` — `saveHouseSite` retorna `previousSiteUrl` e invalida o cache.
- Create `src/components/house-config/link-domain-dialog.tsx` — diálogo de 2 passos.
- Modify `src/components/house-config/house-site-section.tsx` — botão + abertura automática.
- Tests: `src/lib/link-domain.test.ts`, `src/lib/link-domain-plan.test.ts`, `src/lib/link-domain.db.test.ts`, `src/components/house-config/link-domain-dialog.test.tsx`.

---

### Task 1: Função pura de troca de domínio

**Files:**
- Create: `src/lib/link-domain.ts`
- Test: `src/lib/link-domain.test.ts`

**Interfaces:**
- Produces:
  - `normalizeLinkDomain(input: string): { ok: true; domain: string } | { ok: false; error: string }` — usa `normalizeHostname` de `src/lib/house-config.ts` e remove `www.` inicial.
  - `replaceLinkDomain(text: string, from: string, to: string): { text: string; count: number }` — `from`/`to` já normalizados.
  - `countSubdomainLinks(text: string, from: string): number` — URLs cujo host (sem `www.`) termina em `.${from}`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("replaceLinkDomain", () => {
  const r = (t: string) => replaceLinkDomain(t, "casa-antiga.com", "casa-nova.com");
  it("troca só o host e mantém caminho, query e fragmento", () => {
    expect(r("Entre: https://casa-antiga.com/promo?cupom=X#topo")).toEqual({
      text: "Entre: https://casa-nova.com/promo?cupom=X#topo", count: 1 });
  });
  it("preserva www. e http", () => {
    expect(r("http://www.casa-antiga.com/x").text).toBe("http://www.casa-nova.com/x");
  });
  it("casa host com maiúsculas", () => {
    expect(r("https://Casa-Antiga.COM/a").text).toBe("https://casa-nova.com/a");
  });
  it("preserva porta", () => {
    expect(r("https://casa-antiga.com:8443/a").text).toBe("https://casa-nova.com:8443/a");
  });
  it("não toca domínios parecidos", () => {
    const t = "https://minhacasa-antiga.com https://casa-antiga.com.br https://casa-antiga.combo.net";
    expect(r(t)).toEqual({ text: t, count: 0 });
  });
  it("não toca subdomínios", () => {
    expect(r("https://go.casa-antiga.com/a").count).toBe(0);
  });
  it("não toca o domínio sem esquema nem {link}", () => {
    expect(r("casa-antiga.com {link}")).toEqual({ text: "casa-antiga.com {link}", count: 0 });
  });
  it("troca várias URLs e URL no fim de frase", () => {
    expect(r("https://casa-antiga.com, ou https://casa-antiga.com/b.")).toEqual({
      text: "https://casa-nova.com, ou https://casa-nova.com/b.", count: 2 });
  });
  it("funciona dentro de href e mantém &amp;", () => {
    expect(r('<a href="https://casa-antiga.com/a?x=1&amp;y=2">').text)
      .toBe('<a href="https://casa-nova.com/a?x=1&amp;y=2">');
  });
});
describe("normalizeLinkDomain", () => {
  it("normaliza URL colada", () => {
    expect(normalizeLinkDomain("https://WWW.Casa-Antiga.com/promo")).toEqual({ ok: true, domain: "casa-antiga.com" });
  });
  it("rejeita vazio", () => { expect(normalizeLinkDomain(" ").ok).toBe(false); });
});
describe("countSubdomainLinks", () => {
  it("conta subdomínios mas não o domínio exato nem www", () => {
    expect(countSubdomainLinks("https://go.casa-antiga.com https://www.casa-antiga.com https://casa-antiga.com", "casa-antiga.com")).toBe(1);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/link-domain.test.ts` — Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implement in `src/lib/link-domain.ts`**

Regex de URL: `/\bhttps?:\/\/([^\s\/?#"'<>()]+)/gi`; para cada match, separe `host[:porta]`, compare `host.toLowerCase()` sem `www.` com `from`; se igual, reescreva como `(www. se havia)` + `to` + `(:porta)`. Esquema e o resto da string ficam intactos.

- [ ] **Step 4: Run** `npx vitest run src/lib/link-domain.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** — `feat(links): pure link domain replacement`

---

### Task 2: Planejador puro da prévia

**Files:**
- Create: `src/lib/link-domain-plan.ts`
- Test: `src/lib/link-domain-plan.test.ts`

**Interfaces:**
- Consumes: Task 1 (`replaceLinkDomain`, `countSubdomainLinks`, `normalizeLinkDomain`); `countSmsSegments` de `src/lib/sms-segments.ts`.
- Produces:

```ts
export type LinkDomainSources = {
  journeySteps: { id: string; journeyId: string; journeyName: string; journeyStatus: string;
    position: number; stepType: "sms" | "email"; label: string | null; config: Record<string, unknown> }[];
  smsTemplates: { id: string; name: string; content: string }[];
  emailTemplates: { id: string; name: string; subject: string; preheader: string | null;
    body_html: string; body_text: string }[];
  quickLinks: { id: string; label: string; path: string }[];
  trackingHosts: string[] | null;            // null = casa sem shortio_settings
  scheduledCampaigns: { id: string; name: string; channel: "sms" | "email"; text: string }[];
  activeLegacyFlows: { id: string; name: string; text: string }[];   // text = conteúdos concatenados
};
export type LinkDomainItemKind = "journey_step" | "sms_template" | "email_template" | "quick_link";
export type LinkDomainItem = {
  key: string;                    // `${kind}:${id}` — usado na seleção
  kind: LinkDomainItemKind; id: string;
  title: string;                  // nome da jornada / template / link rápido
  detail: string | null;          // ex.: "Etapa 3 · SMS"
  replacements: number;
  sample: { before: string; after: string };  // primeira ocorrência, ~80 chars em volta
  blockedReason: string | null;
  segmentWarning: { before: number; after: number } | null;
  update: Record<string, unknown>; // novos valores: {config} | {content} | {subject,preheader,body_html,body_text} | {path}
  previous: Record<string, unknown>; // mesmos campos de `update`, valores atuais (vai para o audit log)
};
export type LinkDomainPreview = {
  from: string; to: string;
  items: LinkDomainItem[];
  trackingHosts: { current: string[]; next: string[] } | null; // null = nada a fazer
  outOfScope: { scheduledCampaigns: { id: string; name: string; channel: "sms" | "email" }[];
    legacyFlows: { id: string; name: string }[]; subdomainLinks: number };
};
export function planLinkDomainChange(
  sources: LinkDomainSources, fromInput: string, toInput: string,
): { ok: true; preview: LinkDomainPreview } | { ok: false; error: string };
export function hasLinkDomainWork(p: LinkDomainPreview): boolean; // items.length > 0 || trackingHosts !== null
```

- [ ] **Step 1: Write the failing tests** (`from = "casa-antiga.com"`, `to = "casa-nova.com"`, fábrica `sources(overrides)` com listas vazias e `trackingHosts: []`)

```ts
it("erro quando os domínios são iguais", () => {
  expect(planLinkDomainChange(sources(), "www.casa.com", "https://casa.com/x"))
    .toEqual({ ok: false, error: "Os dois domínios são iguais." });
});
it("etapa SMS: troca content, variants e template_snapshot.content no config", () => {
  // config { content: "A https://casa-antiga.com/a", variants: ["B https://casa-antiga.com/b"],
  //   template_snapshot: { id, content: "A https://casa-antiga.com/a", version: 2 }, track_links: true }
  // espera 1 item, replacements 3, update.config com os 3 trocados, version 2 inalterado,
  // detail "Etapa 2 · SMS" (position 1 → exibido 1-based)
});
it("etapa de e-mail: troca template_snapshot.subject e body_html", () => { /* replacements 2 */ });
it("etapa sem ocorrência não vira item", () => {});
it("template SMS acima de 480 fica bloqueado", () => {
  // content com 470 chars + "https://a.co" trocado para domínio longo → blockedReason
  // "O texto passaria de 480 caracteres."
});
it("SMS de jornada acima de 1600 fica bloqueado", () => { /* "O texto passaria de 1600 caracteres." */ });
it("aviso de segmentos só com track_links === false e quando aumenta", () => {
  // track_links false + troca que cruza 160 chars GSM → segmentWarning {before:1, after:2}
  // mesmo texto com track_links true → segmentWarning null
});
it("template de e-mail: troca subject, preheader, body_html, body_text", () => {});
it("link rápido absoluto é trocado; relativo é ignorado", () => {});
it("rastreio: lista vazia → null; lista sem o novo → adiciona mantendo o antigo", () => {
  // ["casa-antiga.com"] → { current: ["casa-antiga.com"], next: ["casa-antiga.com","casa-nova.com"] }
  // ["outra.com"] → next ["outra.com","casa-nova.com"]; ["casa-nova.com"] → null; [] → null; null → null
});
it("outOfScope lista campanhas agendadas e fluxos legados que têm o domínio antigo e conta subdomínios", () => {});
it("hasLinkDomainWork é true só com itens ou rastreio", () => {});
```

Escreva as asserções de cada caso com os valores dos comentários.

- [ ] **Step 2: Run** `npx vitest run src/lib/link-domain-plan.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement `planLinkDomainChange` in `src/lib/link-domain-plan.ts`**

Normaliza com `normalizeLinkDomain` (erro → `{ok:false}` com a mensagem dela). Para cada fonte, aplica `replaceLinkDomain` campo a campo; item só existe se `replacements > 0`. `update.config` é uma cópia profunda do `config` original com só os campos de texto trocados. Mensagem de bloqueio: `` `O texto passaria de ${limite} caracteres.` `` (assunto: `"O assunto passaria de 255 caracteres."`; link rápido: `"O link passaria de 500 caracteres."`). `outOfScope.subdomainLinks` soma `countSubdomainLinks` em todos os textos das fontes em escopo. Ordem dos itens: jornadas (por nome, depois posição), templates SMS, templates e-mail, links rápidos.

- [ ] **Step 4: Run** `npx vitest run src/lib/link-domain-plan.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** — `feat(links): plan link domain change preview`

---

### Task 3: RPC transacional `apply_link_domain_change`

**Files:**
- Create: `supabase/migrations/20261104100000_apply_link_domain_change.sql`
- Test: `src/lib/link-domain.db.test.ts` (PGlite, mesmo padrão de `src/lib/house-config.db.test.ts`: schema mínimo com `tenants`, `journeys(id, tenant_id, status)`, `journey_steps(id, tenant_id, journey_id, config jsonb)`, `sms_templates(id, tenant_id, content, version)` + trigger de version simples, `email_templates`, `tenant_quick_links`, `shortio_settings(tenant_id, allowed_destination_hosts text[])`, `tenant_audit_logs`)

**Interfaces:**
- Produces: `public.apply_link_domain_change(_tenant uuid, _actor uuid, _payload jsonb) returns jsonb` — `security definer`, `set search_path = public`, execute só para `service_role` (revoke de `public, anon, authenticated`).
- `_payload`:

```json
{ "from": "casa-antiga.com", "to": "casa-nova.com",
  "journey_steps": [{ "id": "…", "config": {} }],
  "sms_templates": [{ "id": "…", "content": "…" }],
  "email_templates": [{ "id": "…", "subject": "…", "preheader": null, "body_html": "…", "body_text": "…" }],
  "quick_links": [{ "id": "…", "path": "…" }],
  "tracking_hosts": ["…"] | null,
  "audit_before": {}, "audit_after": {} }
```
- Retorno: `{ "journey_steps": n, "sms_templates": n, "email_templates": n, "quick_links": n, "tracking_hosts": true|false }`.

- [ ] **Step 1: Write the failing tests**

```ts
it("atualiza todas as fontes do tenant e grava um audit log", async () => {
  // espera retorno com contagens 1/1/1/1/true, valores novos nas tabelas,
  // sms_templates.version incrementado pelo trigger,
  // 1 linha em tenant_audit_logs com action 'house.link_domain_changed', entity_type 'tenant',
  // entity_id = tenant, actor_user_id = _actor, metadata {from,to,counts}
});
it("atualiza etapa de jornada ativa no lugar (mesmo id, sem nova jornada)", async () => {});
it("id de outra casa faz a chamada inteira falhar e nada muda", async () => {
  // payload com sms_template de outro tenant → rejects /link_domain_item_not_found/
  // e a etapa de jornada do mesmo payload continua com o config antigo
});
it("tracking_hosts null não mexe em shortio_settings", async () => {});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/link-domain.db.test.ts` — Expected: FAIL (arquivo de migration não existe).

- [ ] **Step 3: Write the migration**

Um bloco `begin; … commit;` como `20261021100000_tenant_house_config.sql`. Para cada array, `update … where id = x and tenant_id = _tenant`; se `not found`, `raise exception 'link_domain_item_not_found'`. `journey_steps` filtra também `journey_id in (select id from journeys where tenant_id = _tenant and status <> 'archived')`. `tracking_hosts` não nulo → `update shortio_settings set allowed_destination_hosts = …, updated_at = now() where tenant_id = _tenant`. Por fim, insert no audit com `before_data = _payload->'audit_before'`, `after_data = _payload->'audit_after'`.

- [ ] **Step 4: Run** `npx vitest run src/lib/link-domain.db.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** — `feat(links): transactional RPC to apply link domain change`

---

### Task 4: Servidor — carregar fontes, prévia e aplicação

**Files:**
- Create: `src/lib/link-domain.server.ts`
- Create: `src/lib/link-domain.functions.ts`
- Modify: `src/lib/house-links.server.ts` (export `invalidateHouseLinks(tenantId: string): void` — `houseLinksCache.delete(tenantId)`)
- Modify: `src/lib/house-config.functions.ts:489-503` (`saveHouseSite`)
- Test: `src/lib/link-domain.functions.test.ts` (só helpers puros, padrão de `house-config.functions.test.ts`)

**Interfaces:**
- Consumes: Task 2 (`LinkDomainSources`, `planLinkDomainChange`, `LinkDomainPreview`), Task 3 (RPC).
- Produces:
  - `loadLinkDomainSources(tenantId: string): Promise<LinkDomainSources>` — queries via `supabaseAdmin`, todas com `.eq("tenant_id", tenantId)`:
    - `journey_steps` com `step_type in ('sms','email')` join `journeys(name,status)` onde `status in ('draft','active','paused')`;
    - `sms_templates` com `is_active = true`; `email_templates` com `lifecycle_status <> 'archived'`;
    - `tenant_quick_links`; `shortio_settings.allowed_destination_hosts` (`maybeSingle`, sem linha → `null`);
    - `sms_campaigns` / `email_campaigns` com `status = 'agendada'` (texto: `content` / `template_snapshot.body_html`);
    - `sms_flows` com `is_active = true` + `sms_flow_steps.content`.
  - `previewLinkDomainChange` — `createServerFn POST`, `requireSupabaseAuth`, input `{ fromDomain: string(1..500), toDomain: string(1..500) }`, retorna `LinkDomainPreview`; erro do planejador → `throw new Error(error)`.
  - `applyLinkDomainChange` — input `{ fromDomain, toDomain, itemKeys: string[] (max 2000), includeTrackingHosts: boolean }`; recarrega as fontes, replaneja, usa só os itens cujo `key` está em `itemKeys`; se algum selecionado agora tem `blockedReason` → `throw new Error("Algum item mudou desde a prévia e não cabe mais. Abra a prévia de novo.")`; se nenhum item e sem rastreio → `throw new Error("Nada selecionado para trocar.")`. Chama a RPC com `_actor = context.userId`, depois `invalidateHouseLinks(tenantId)`. Retorna as contagens da RPC.
  - `buildApplyPayload(preview: LinkDomainPreview, itemKeys: string[], includeTrackingHosts: boolean): ApplyPayload` — puro, exportado de `link-domain.functions.ts`; monta o `_payload` da Task 3. `audit_before`/`audit_after` = `{ [key]: item.previous }` / `{ [key]: item.update }`.
  - `saveHouseSite` passa a retornar `{ siteUrl: string; previousSiteUrl: string | null }` (lê `site_url` antes do update) e chama `invalidateHouseLinks(tenantId)` após salvar.

- [ ] **Step 1: Write failing tests for `buildApplyPayload`**

```ts
it("só inclui itens selecionados, agrupados por tabela", () => {});
it("tracking_hosts = next quando includeTrackingHosts e há mudança; senão null", () => {});
it("audit_before/after usam a key do item", () => {});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/link-domain.functions.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement the files above.**
- [ ] **Step 4: Run** `npx vitest run src/lib/link-domain.functions.test.ts src/lib/house-config.functions.test.ts && npm run typecheck` — Expected: PASS, sem erros de tipo.
- [ ] **Step 5: Commit** — `feat(links): server functions to preview and apply link domain change`

---

### Task 5: Diálogo e integração na seção do site

**Files:**
- Create: `src/components/house-config/link-domain-dialog.tsx`
- Modify: `src/components/house-config/house-site-section.tsx`
- Test: `src/components/house-config/link-domain-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 4 (`previewLinkDomainChange`, `applyLinkDomainChange`, `saveHouseSite` → `previousSiteUrl`), Task 2 (`LinkDomainPreview`, `hasLinkDomainWork`).
- Produces:

```ts
export function LinkDomainDialog(props: {
  open: boolean; onOpenChange: (open: boolean) => void;
  initialFrom?: string; initialTo?: string;
  initialPreview?: LinkDomainPreview;  // abre direto no passo 2
}): JSX.Element;
export function initialSelection(p: LinkDomainPreview): Set<string>; // todos os itens não bloqueados
```

Copy fixa (pt-BR):
- Botão na seção: **"Trocar domínio nos links"** (desabilitado em demo com `DemoDisabledTooltip`, oculto se `!canEdit`).
- Passo 1: labels "Domínio antigo" / "Domínio novo"; botão "Procurar". `initialTo` padrão = host de `config.siteUrl`.
- Passo 2: grupos "Jornadas", "Templates de SMS", "Templates de e-mail", "URLs rápidas", "Domínios permitidos do rastreio"; checkbox por item; item bloqueado desmarcado e desabilitado com o motivo; aviso de segmento: `` `Passa de ${before} para ${after} partes de SMS (rastreio desligado).` ``; seção "Ainda com {from} (não trocados aqui)" quando `outOfScope` não vazio; vazio: `` `Nenhum link com ${from} encontrado.` ``.
- Botão de aplicar: `` `Trocar ${n} itens` `` → `AlertDialog` de confirmação "Trocar o domínio em {n} itens? Isso não pode ser desfeito automaticamente." → toast sucesso `"Domínio trocado nos links"` e `invalidateHouseConfigQueries(qc)`.
- Entrada automática em `house-site-section.tsx`: no `onSuccess` de `saveSite`, se `previousSiteUrl` e os hosts (via `normalizeLinkDomain`) diferem, chama `previewLinkDomainChange`; se `hasLinkDomainWork(preview)`, abre o diálogo com `initialPreview`. Falha da prévia aqui não mostra erro (só `console.warn`) — a URL já foi salva.

- [ ] **Step 1: Write failing tests**

```ts
it("initialSelection marca todos os itens não bloqueados", () => {});
it("passo 2 mostra grupos, desabilita item bloqueado com motivo e conta 'Trocar N itens'", () => {});
it("desmarcar um item atualiza o contador", () => {});
it("mostra a seção de fora do escopo quando há campanhas agendadas", () => {});
it("mostra mensagem de vazio quando não há trabalho", () => {});
```

(renderize com `initialPreview` e mocks de `useServerFn`, como os testes existentes de componentes em `src/components/house-config/`.)

- [ ] **Step 2: Run** `npx vitest run src/components/house-config/link-domain-dialog.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement the dialog and the section changes.**
- [ ] **Step 4: Run** `npx vitest run src/components/house-config` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(links): link domain change dialog in house config`

---

### Task 6: Verificação final

- [ ] **Step 1: Run** `npm test` — Expected: tudo passa (anote falhas pré-existentes, se houver, comparando com `origin/main`).
- [ ] **Step 2: Run** `npm run typecheck` — Expected: sem erros.
- [ ] **Step 3: Run** `npm run build` — Expected: build ok, sem `*.server` no bundle do client.
- [ ] **Step 4: Manual** — rodar o app, casa demo bloqueada; numa casa de teste local: criar template SMS com `https://casa-antiga.com/x`, abrir a ferramenta, conferir prévia, aplicar, conferir audit log.
- [ ] **Step 5: Commit** (se houver ajustes) — `chore(links): fixes from final verification`

Migration `20261104100000_apply_link_domain_change.sql` **não** é aplicada em produção por este plano — requer ok explícito (memória: escritas em prod precisam de aprovação).
