# Tutorial do CRM — Fase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar a infraestrutura de ajuda do CRM: o tour guiado, o painel "?" no cabeçalho, o glossário, os guias com progresso, o estado guardado no servidor e o teste de cobertura. Junto, entregar o conteúdo completo das telas da fase 1 e os 9 ajustes de tela.

**Architecture:**
- O conteúdo fica tipado em `src/help/`: um artigo por tela, guias e glossário.
- Os elementos das telas recebem `data-tour`, aplicado pelo helper `tourAnchor()`. Um teste vitest estático cruza essas âncoras com o conteúdo.
- O tour roda com `driver.js`. Quem decide se e quando ele inicia são funções puras, testáveis sem DOM.
- O estado de "visto" e "pulado" fica em `help_progress`, uma tabela por usuário com RLS, lida e escrita por server functions.
- O `HelpProvider` envolve o `AppLayout` em `__root.tsx`, para funcionar também no onboarding em tela cheia.

**Tech Stack:** TanStack Start/Router, React, Radix/shadcn (`Sheet`, `Tooltip`), Supabase, vitest (testes com `renderToStaticMarkup`, sem jsdom), `driver.js` (MIT).

**Spec:** `docs/superpowers/specs/2026-11-05-tutorial-crm-design.md` (leia antes de começar; os modelos estão em `docs/superpowers/specs/2026-11-05-tutorial-crm-mockups/`).

## Global Constraints

- **Escopo:** telas e partes de super admin ficam fora (`/admin`, `/grupos`, "Domínios removidos", o seletor "Ver:" do Financeiro, as partes de super admin de `/tenants`). Também ficam fora as rotas que só redirecionam, `/whatsapp` e `/alertas`.
- **Texto:**
  - pt-BR simples, segunda pessoa ("você"), frases curtas;
  - toda sigla é explicada na primeira vez que aparece;
  - usar os rótulos exatos que aparecem na tela.
- **Âncoras:**
  - formato `<tela>.<seção>.<elemento>`, em minúsculas, com hífen dentro de cada parte (exemplo: `casa.email.dns-table`);
  - sempre aplicadas com `tourAnchor("…")`, nunca com `data-tour` escrito à mão;
  - em controles que se repetem por linha, a âncora vai só no primeiro item.
- **Cobertura:** todo controle interativo de uma tela coberta tem um item no artigo, inclusive o que fica dentro de diálogos e gavetas.
  - Os controles repetidos por linha são descritos uma vez.
  - Os números só de leitura (KPIs, gráficos, colunas) são explicados em grupo.
  - Os estados vazios, de erro e de bloqueio entram em `states`.
- **Tour:**
  - de 5 a 8 passos por tela ou por aba;
  - nunca abre um diálogo sozinho e nunca troca de aba sozinho;
  - passo com alvo ausente ou invisível é pulado em silêncio;
  - visual escuro (o CRM só tem tema escuro);
  - no celular, o balão fica embaixo em largura total.
- **Início automático:** acontece só na primeira visita de cada usuário a cada tela ou aba, para **todos os usuários**, inclusive os antigos.
  - Não acontece se houver um diálogo aberto ou se o usuário tiver ligado "Não mostrar tours automaticamente".
  - Fica desligado quando `help_progress` não pode ser lido.
- **Migração:** `supabase/migrations/20261203100000_help_progress.sql`.
  - **Não aplicar em produção** sem o ok explícito do usuário.
  - Antes de fazer o commit, confira se a numeração ainda está livre em `origin/main`.
- **Carregamento:** os artigos são carregados sob demanda (`import()` por tela). O painel não entra no bundle inicial.
- **Build:** rode `npm run build` antes de declarar uma tarefa pronta, quando ela tocar server functions. O build pega vazamentos de `*.server` para o cliente.

## Review Focus

1. **Elementos que aparecem duas vezes** (o seletor de casa em versão celular e desktop, tabela e cartões). O tour deve destacar a cópia visível, nunca a escondida. Teste: `pickVisible` na Task 3.
2. **Tour durante o onboarding em tela cheia.** O tour da tela de baixo não pode começar por trás do assistente. Teste: `shouldAutoStart` com `overlayActive: true` na Task 3.
3. **Leitura do progresso falhando** (migração não aplicada, rede, 500). Nada pode começar sozinho, e o painel continua funcionando. Teste: `shouldAutoStart` com `progress: null` na Task 3.
4. **Busca com acento e maiúscula.** "dominio" deve achar "Domínio", e "GGR" deve achar "ggr". Teste: `searchHelp` na Task 4.
5. **Rota com parâmetro e hash.** `/jornadas/abc-123` deve resolver o artigo do editor de jornada, e `/configuracoes/casa#email` deve resolver a aba E-mail. Teste: `resolveHelpScreen` na Task 2.

---

### Task 1: Tabela `help_progress` e server functions

**Files:**
- Create: `supabase/migrations/20261203100000_help_progress.sql`
- Modify: `src/integrations/supabase/types.ts` (adicionar `help_progress` em `Tables`, no mesmo formato das outras)
- Create: `src/lib/help-progress.ts` (puro), `src/lib/help-progress.functions.ts`
- Test: `src/lib/help-progress.test.ts`

**Interfaces:**
- Produces:
  - `type HelpProgressStatus = "done" | "skipped" | "off"`
  - `type HelpProgressMap = Record<string, HelpProgressStatus>`
  - `const AUTO_TOURS_OFF_KEY = "prefs:auto-tours"`
  - `tourKey(route: string, tab?: string | null): string` devolve `tour:<route>` ou `tour:<route>#<tab>`.
  - `rowsToProgressMap(rows: { key: string; status: string }[]): HelpProgressMap` ignora status inválido.
  - `getHelpProgress` (GET, sem input): devolve `{ progress: HelpProgressMap }`.
  - `setHelpProgress` (POST, input `{ key: string (1–200), status: HelpProgressStatus | null }`): `null` apaga a linha; devolve `{ ok: true }`.

- [ ] **Step 1: Escrever a migração.**
  - Tabela `public.help_progress`:
    - `user_id uuid not null references auth.users(id) on delete cascade`
    - `key text not null check (char_length(key) between 1 and 200)`
    - `status text not null check (status in ('done','skipped','off'))`
    - `updated_at timestamptz not null default now()`
    - `primary key (user_id, key)`
  - `enable row level security`.
  - Políticas de select, insert, update e delete com `user_id = (select auth.uid())`. No insert e no update, a mesma condição vai em `with check`.
  - `grant select, insert, update, delete on public.help_progress to authenticated`.
  - Sem acesso para `anon`.
- [ ] **Step 2: Escrever o teste que falha** (`help-progress.test.ts`):

```ts
it("tourKey com e sem aba", () => {
  expect(tourKey("/configuracoes/casa")).toBe("tour:/configuracoes/casa");
  expect(tourKey("/configuracoes/casa", "email")).toBe("tour:/configuracoes/casa#email");
});
it("rowsToProgressMap ignora status inválido", () => {
  expect(rowsToProgressMap([{ key: "a", status: "done" }, { key: "b", status: "x" }])).toEqual({ a: "done" });
});
```

- [ ] **Step 3:** Rodar `npx vitest run src/lib/help-progress.test.ts`. Esperado: FAIL, porque o módulo ainda não existe.
- [ ] **Step 4: Implementar `help-progress.ts` e `help-progress.functions.ts`.**
  - Os dois usam `.middleware([requireSupabaseAuth])` e `context.supabase`, o cliente do usuário. É o RLS que restringe os dados; não usar `supabaseAdmin`.
  - O `user_id` vem de `context.userId`.
  - A gravação é um `upsert` em `(user_id, key)`.
  - Com `null`, a função faz `delete`.
- [ ] **Step 5:** Rodar o teste: PASS. Rodar `npm run build`: sem erro.
- [ ] **Step 6: Commit** `feat(ajuda): tabela help_progress e server functions`.

### Task 2: Modelo de conteúdo, resolução de tela, âncoras e teste de cobertura

**Files:**
- Create:
  - `src/help/types.ts`
  - `src/help/anchor.ts`
  - `src/help/registry.ts`
  - `src/help/resolve.ts`
  - `src/help/glossary.ts`
  - `src/help/coverage-config.ts`
- Modify: `src/lib/navigation.ts`, para exportar `patternMatches`.
- Test: `src/help/resolve.test.ts`, `src/help/-coverage.test.ts`

**Interfaces:**
- Produces (`types.ts`):

```ts
export type HelpRole = "admin" | "gestor" | "member" | "expert";
export type HelpItem = { anchor?: string; label: string; what: string; when?: string; notes?: string; roles?: HelpRole[] };
export type HelpSection = { id: string; title: string; tab?: string; intro?: string; items: HelpItem[] };
export type HelpState = { id: string; title: string; what: string; action?: string };
export type TourStep = { anchor: string; title: string; body: string; articleSection?: string };
export type HelpScreen = {
  id: string; route: string; title: string; purpose: string; roles: HelpRole[];
  sections: HelpSection[]; states: HelpState[];
  tours: Record<string, TourStep[]>; // chave "default" ou o valor da aba (hash)
  terms?: string[]; // ids do glossário usados na tela
};
export type GlossaryTerm = { id: string; term: string; short: string; long?: string };
```

- Produces (demais arquivos):
  - `tourAnchor(id: string): { "data-tour": string }` (`anchor.ts`).
  - `HELP_SCREEN_LOADERS: Record<string, () => Promise<{ default: HelpScreen }>>`, chaveado pela rota (`registry.ts`).
  - `resolveHelpScreen(pathname: string, hash: string): { route: string; tab: string | null } | null` (`resolve.ts`). Usa `patternMatches` contra as chaves de `HELP_SCREEN_LOADERS`. A aba é o hash sem `#`, ou `null` se vazio.
  - `GLOSSARY: GlossaryTerm[]` (`glossary.ts`).
  - Em `coverage-config.ts`:
    - `EXCLUDED_ROUTES: string[]`: super admin, redirects, `/whatsapp`, `/alertas`, `/u/$token`, `/mcp/autorizar`.
    - `PENDING_ROUTES: string[]`: as telas das fases 2 a 4, conforme a seção 5 do spec. Também aceita pendência de uma aba só, no formato `"/rota#aba"`: a rota tem artigo, mas aquela aba ainda não tem seção nem tour.
    - `VIRTUAL_SCREENS = ["onboarding", "shell"] as const`: artigos que não correspondem a uma rota de `ROUTE_META`. Esses artigos não são resolvidos por `resolveHelpScreen`; o painel os carrega direto.
    - `ANCHORS_PENDING_ARTICLE: string[]`: começa vazia (ver a Task 7).

- [ ] **Step 1: Escrever os testes que falham.**

`resolve.test.ts` (Review Focus 5), registrando no teste loaders fictícios para `/jornadas/$journeyId` e `/configuracoes/casa`:

```ts
expect(resolveHelpScreen("/jornadas/abc-123", "")).toEqual({ route: "/jornadas/$journeyId", tab: null });
expect(resolveHelpScreen("/configuracoes/casa", "#email")).toEqual({ route: "/configuracoes/casa", tab: "email" });
expect(resolveHelpScreen("/rota-inexistente", "")).toBeNull();
```

`-coverage.test.ts` lê o código com `fs` e importa os artigos de `HELP_SCREEN_LOADERS`. Os testes:

```ts
it("toda rota de ROUTE_META tem artigo, está excluída ou pendente")
it("toda âncora citada em artigo/tour/guia existe como tourAnchor(\"…\") em src/")
it("todo tourAnchor(\"…\") em src/ é citado por algum artigo")
it("todo <Term id> e todo screen.terms existe no GLOSSARY")
it("nenhuma rota está ao mesmo tempo com artigo e em PENDING/EXCLUDED")
it("todo passo de tour tem anchor e body não vazios; cada tour tem de 1 a 8 passos")
```

  - Regex das âncoras no código: `/tourAnchor\("([^"]+)"\)/g`. Também é preciso proibir o atributo cru: o teste falha se achar `data-tour=` fora de `src/help/anchor.ts`.
  - Regex dos termos: `/<Term\s+id="([^"]+)"/g`.
  - Os arquivos `*.test.*` ficam fora da varredura.
- [ ] **Step 2:** Rodar `npx vitest run src/help`. Esperado: FAIL, porque os módulos não existem.
- [ ] **Step 3: Implementar os módulos.**
  - Comece com `HELP_SCREEN_LOADERS` vazio e `PENDING_ROUTES` contendo **todas** as rotas da fase 1. As Tasks 9 a 15 removem cada rota de `PENDING_ROUTES` ao entregar o artigo dela.
  - Popule `GLOSSARY` com os termos que já têm definição em `src/components/finance/definitions.ts` e no "Como ler" de Resultados (`src/components/crm-results/`). Use os mesmos textos; só trocar o import nesses lugares fica para quando as fases 3 e 4 tocarem essas telas.
  - Acrescente: `dns`, `subdominio`, `registro-dns`, `remetente`, `encurtador`, `ftd`, `grupo-de-controle`, `reentrada`, `gatilho`, `segmento-sms`.
- [ ] **Step 4:** Rodar `npx vitest run src/help`: PASS.
- [ ] **Step 5: Commit** `feat(ajuda): modelo de conteúdo, resolução de tela e teste de cobertura`.

### Task 3: Motor do tour (lógica pura e wrapper do driver.js)

**Files:**
- Modify: `package.json`, para adicionar `driver.js` (última 1.x).
- Create: `src/help/tour-logic.ts` (puro), `src/help/tour-runner.ts` (DOM e driver.js), `src/help/tour.css` (tema escuro e balão embaixo no celular).
- Test: `src/help/tour-logic.test.ts`

**Interfaces:**
- Consumes: `HelpProgressMap`, `AUTO_TOURS_OFF_KEY` e `tourKey` (Task 1); `TourStep` (Task 2).
- Produces:
  - `shouldAutoStart(input: { key: string; progress: HelpProgressMap | null; dialogOpen: boolean; overlayActive: boolean; hasSteps: boolean }): boolean`
  - `pickVisible<T>(candidates: T[], isVisible: (c: T) => boolean): T | null`
  - `filterAvailableSteps(steps: TourStep[], findVisible: (anchor: string) => unknown | null): TourStep[]`
  - `runTour(steps: TourStep[], opts: { onFinish: (result: "done" | "skipped") => void; onLearnMore: (step: TourStep) => void }): void` (`tour-runner.ts`)
  - `highlightAnchor(anchor: string): boolean` destaca um único elemento. Devolve `false` se ele não estiver visível.
  - `findVisibleAnchor(anchor: string): HTMLElement | null` usa `pickVisible` sobre `document.querySelectorAll('[data-tour="…"]')`, com `el.getClientRects().length > 0` como teste de visibilidade.

- [ ] **Step 1: Escrever o teste que falha** (Review Focus 1, 2 e 3):

```ts
const base = { key: "tour:/campanhas", progress: {}, dialogOpen: false, overlayActive: false, hasSteps: true };
expect(shouldAutoStart(base)).toBe(true);
expect(shouldAutoStart({ ...base, progress: null })).toBe(false);
expect(shouldAutoStart({ ...base, progress: { "tour:/campanhas": "skipped" } })).toBe(false);
expect(shouldAutoStart({ ...base, progress: { "tour:/campanhas": "done" } })).toBe(false);
expect(shouldAutoStart({ ...base, progress: { "prefs:auto-tours": "off" } })).toBe(false);
expect(shouldAutoStart({ ...base, dialogOpen: true })).toBe(false);
expect(shouldAutoStart({ ...base, overlayActive: true })).toBe(false);
expect(shouldAutoStart({ ...base, hasSteps: false })).toBe(false);
expect(pickVisible(["hidden", "shown"], (c) => c === "shown")).toBe("shown");
expect(pickVisible(["hidden"], () => false)).toBeNull();
expect(filterAvailableSteps([{ anchor: "a", title: "", body: "x" }, { anchor: "b", title: "", body: "y" }], (a) => (a === "b" ? {} : null)).map((s) => s.anchor)).toEqual(["b"]);
```

- [ ] **Step 2:** Rodar o teste. Esperado: FAIL.
- [ ] **Step 3: Implementar.**
  - Em `runTour`, filtre os passos com `filterAvailableSteps(steps, findVisibleAnchor)` e saia sem fazer nada se a lista ficar vazia.
  - Configure o driver.js com:
    - os rótulos "Próximo", "Voltar", "Concluir" e "Pular tour";
    - o contador "{{current}} de {{total}}";
    - um botão extra "Saiba mais" que chama `onLearnMore`;
    - `onDestroyed`, que devolve `done` se o usuário chegou ao último passo e `skipped` nos outros casos.
  - Importe `driver.js/dist/driver.css` e `tour.css` só dentro de `tour-runner.ts`, que só é carregado por `import()`.
- [ ] **Step 4:** Rodar o teste: PASS. Rodar `npm run build`: sem erro (confere que o CSS do driver não entra no bundle inicial; veja o chunk gerado).
- [ ] **Step 5: Commit** `feat(ajuda): motor do tour`.

### Task 4: HelpProvider, botão "?" no cabeçalho e painel

**Files:**
- Create:
  - `src/components/help/help-provider.tsx`
  - `src/components/help/help-button.tsx`
  - `src/components/help/help-panel.tsx`
  - `src/help/search.ts` (puro)
- Modify:
  - `src/routes/__root.tsx`: envolver `<AppLayout>` com `<HelpProvider>`, dentro do `AuthGate`.
  - `src/components/app-layout.tsx`: colocar `<HelpButton />` entre `<RealtimeIndicator />` e `<AccountMenu />`.
- Test: `src/help/search.test.ts`, `src/components/help/help-panel.test.tsx`

**Interfaces:**
- Consumes: Tasks 1, 2 e 3.
- Produces:
  - `useHelp(): { openPanel(sectionId?: string): void; startTour(tab?: string | null): void; setOverlayActive(active: boolean): void; setScreenOverride(route: string | null, tab?: string | null): void; progress: HelpProgressMap | null }`
  - `searchHelp(index: SearchEntry[], query: string): SearchEntry[]`, onde `type SearchEntry = { kind: "item" | "term" | "guide"; title: string; text: string; route?: string; sectionId?: string; termId?: string; guideId?: string }`. A busca normaliza o texto: minúsculas, sem acento (NFD sem marcas combinantes). Devolve vazio para consulta com menos de 2 caracteres.
  - `HelpPanelView` (presentacional, testável com `renderToStaticMarkup`), com as props `{ screen: HelpScreen | null; role: HelpRole | null; guides: GuideView[]; glossary: GlossaryTerm[]; query: string; results: SearchEntry[]; autoToursOff: boolean; ... callbacks }`. `GuideView` é definido na Task 6; até lá use `[]`.

- [ ] **Step 1: Escrever os testes que falham.**

`search.test.ts` (Review Focus 4):

```ts
const idx = [{ kind: "item", title: "Adicionar domínio", text: "Digite um subdomínio" }, { kind: "term", title: "GGR", text: "Perdas na casa" }];
expect(searchHelp(idx, "dominio").map((r) => r.title)).toEqual(["Adicionar domínio"]);
expect(searchHelp(idx, "ggr").map((r) => r.title)).toEqual(["GGR"]);
expect(searchHelp(idx, "g")).toEqual([]);
```

`help-panel.test.tsx`:
- Com uma tela de exemplo e `role: "gestor"`, a saída tem os rótulos "Nesta tela", "Fazer o tour desta tela", "Ver todos os botões e campos", "Guias passo a passo" e "Glossário".
- Um item com `roles: ["admin"]` não aparece para `gestor`.
- Um guia com `requiresRole: "admin"` aparece para `gestor` com o texto "só admin".
- Com `screen: null`, aparece "Esta tela ainda não tem ajuda detalhada" e as seções de guias e glossário continuam visíveis.

- [ ] **Step 2:** Rodar os testes. Esperado: FAIL.
- [ ] **Step 3: Implementar.**
  - **HelpProvider**
    - Busca `getHelpProgress` com react-query, chave `["help-progress"]`, `retry: 1`. Se der erro, `progress = null`.
    - A cada mudança de `pathname` ou de hash, chama `resolveHelpScreen` e carrega o artigo por `import()`. `setScreenOverride` tem precedência; o onboarding usa isso.
    - Avalia `shouldAutoStart` 600 ms depois de a tela carregar. `dialogOpen` é `!!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')`.
    - Ao terminar o tour, chama `setHelpProgress({ key, status })` e atualiza o cache de forma otimista.
    - "Saiba mais" abre o painel na `articleSection` do passo.
  - **HelpButton**
    - Ícone `CircleHelp` (lucide), `aria-label="Ajuda"`, `tourAnchor("shell.header.help")`.
    - Mesmo estilo de botão redondo do cabeçalho.
  - **HelpPanel**
    - `Sheet` com `side="right"` no desktop (largura ~480px) e `side="bottom"` abaixo de `md` (altura 85dvh).
    - Ordem do conteúdo: busca; "Nesta tela" (título, propósito, os botões "Fazer o tour desta tela" e "Ver todos os botões e campos", que expande o artigo); guias; glossário; e a chave "Não mostrar tours automaticamente", que grava ou apaga `AUTO_TOURS_OFF_KEY` com status `off`.
    - O artigo expandido mostra as seções e os itens. Cada item com `anchor` tem o link "mostrar na tela", que fecha o painel e chama `highlightAnchor`; se ela devolver `false`, mostra o toast "Este elemento não está visível agora".
    - Quando a tela tem abas, o artigo abre rolado até a primeira seção com `tab` igual à aba atual.
    - O papel vem de `useShellNav().role`. `super_admin` é tratado como `admin`.
- [ ] **Step 4:** Rodar os testes: PASS. Rodar `npm run build`: sem erro.
- [ ] **Step 5: Commit** `feat(ajuda): painel de ajuda e botão no cabeçalho`.

### Task 5: Componente `<Term>`

**Files:**
- Create: `src/components/help/term.tsx`
- Test: `src/components/help/term.test.tsx`

**Interfaces:**
- Consumes: `GLOSSARY` (Task 2), `InfoTip` (`src/components/crm-results/shared.tsx`) como base visual.
- Produces: `<Term id: string>{children}</Term>`. Renderiza `children` seguido de um "i", que no hover ou no toque mostra `short`. Se houver `long`, mostra também o link "Ver no glossário", que chama `useHelp().openPanel("glossary:" + id)`. Com um `id` desconhecido, renderiza só `children`; nesse caso é o teste de cobertura que falha.

- [ ] **Step 1:** Escrever o teste: `renderToStaticMarkup(<Term id="ftd">FTD</Term>)` contém "FTD" e o `aria-label` "O que é FTD?".
- [ ] **Step 2:** Rodar o teste: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar o teste: PASS.
- [ ] **Step 5: Commit** `feat(ajuda): componente Term`.

### Task 6: Guias com progresso real

**Files:**
- Create:
  - `src/help/guides.ts` (definições e cálculo, puro)
  - `src/lib/help-guides.functions.ts`
  - `src/components/help/guide-list.tsx`
- Modify: `src/components/help/help-panel.tsx`, para usar `GuideList`.
- Test: `src/help/guides.test.ts`

**Interfaces:**
- Produces:
  - `type GuideSignals = { shortenerAdded: boolean; shortenerVerified: boolean; shortenerDefault: boolean; emailDomainAdded: boolean; emailDomainVerified: boolean; verifiedSender: boolean; publishedEmailTemplate: boolean; emailCampaignSent: boolean; journeySaved: boolean; journeyActive: boolean; journeyHasEntries: boolean }`
  - `type GuideStep = { id: string; title: string; route: string; tab?: string; anchor?: string; substeps: string[]; signal: keyof GuideSignals }`
  - `type Guide = { id: string; title: string; requiresRole?: HelpRole; steps: GuideStep[] }`
  - `type GuideView = Guide & { doneCount: number; total: number; stepDone: boolean[] }`
  - `GUIDES: Guide[]`, com os três guias:
    - `encurtador`: os passos `shortenerAdded`, `shortenerVerified` e `shortenerDefault`; `requiresRole: "admin"`.
    - `primeiro-email`: os passos `emailDomainAdded`, `emailDomainVerified`, `verifiedSender`, `publishedEmailTemplate` e `emailCampaignSent`; `requiresRole: "admin"`.
      - O passo de verificação tem como subpassos "Copiar os registros DNS", "Colar no site onde o domínio foi comprado" e "Aguardar a verificação automática".
      - O passo da campanha tem como subpasso "Mandar um envio de teste antes".
    - `primeira-jornada`: os passos `journeySaved` (subpassos: gatilho; público e reentrada; etapas; saída; limites), `journeyActive` e `journeyHasEntries` (subpasso "Acompanhar no relatório").
  - `computeGuideView(guide: Guide, signals: GuideSignals): GuideView`. Se um passo posterior foi feito, os anteriores contam como feitos.
  - `getGuideSignals` (GET): devolve `{ signals: GuideSignals }` para a casa de `resolveOperationalTenantId(context.supabase)`. As consultas, só de contagem ou existência:
    - `listTenantDomains`, para as três flags de encurtador e as duas de domínio de e-mail;
    - a mesma regra de `hasVerifiedSender` de `getHouseSetupStatus`, que deve ser extraída para uma função compartilhada sem duplicar a lógica;
    - `email_templates` com `lifecycle_status = 'published'`;
    - `email_campaigns` com `status in ('agendada','enviando','concluida')`;
    - `journeys` com `status <> 'archived'`, e `status = 'active'`;
    - `journey_enrollments` com pelo menos 1 linha de uma jornada da casa.

- [ ] **Step 1: Escrever o teste que falha.**

```ts
const none = Object.fromEntries(Object.keys(EMPTY_SIGNALS).map((k) => [k, false])) as GuideSignals;
const email = GUIDES.find((g) => g.id === "primeiro-email")!;
expect(computeGuideView(email, none).doneCount).toBe(0);
expect(computeGuideView(email, { ...none, verifiedSender: true }).stepDone).toEqual([true, true, true, false, false]);
expect(computeGuideView(email, { ...none, emailCampaignSent: true }).doneCount).toBe(5);
```

  - Exporte `EMPTY_SIGNALS` de `guides.ts`.
- [ ] **Step 2:** Rodar o teste: FAIL.
- [ ] **Step 3: Implementar.**
  - `GuideList` mostra cada guia com:
    - "N de M feitos", ou "concluído ✓" quando está completo;
    - "só admin" quando `requiresRole` não bate com o papel do usuário.
  - Ao expandir, mostra os passos com os subpassos e o botão "Ir para esta etapa". O botão navega para `route#tab`, fecha o painel e chama `highlightAnchor(anchor)` depois que a tela carrega.
  - Se `getGuideSignals` falhar, os guias aparecem sem contagem.
- [ ] **Step 4:** Rodar o teste: PASS. Rodar `npm run build`: sem erro.
- [ ] **Step 5: Commit** `feat(ajuda): guias com progresso real`.

### Task 7: Ajustes no cartão de domínio (itens 1 a 4 da seção 7 do spec)

**Files:**
- Modify:
  - `src/lib/house-config.ts`
  - `src/components/house-config/domain-detail.tsx`
  - `src/components/house-config/domains-section.tsx` (passar `created_at`)
- Test: `src/lib/house-config.test.ts` (o existente, ou criar), `src/components/house-config/domain-detail.test.tsx`

**Interfaces:**
- Produces:
  - `nextDomainCheckAt(d: { status: DomainStatus; created_at: string; last_checked_at: string | null }, now: Date): Date`. Usa os mesmos intervalos de `isDomainDueForCheck`; extraia `domainCheckInterval(d, now): number` e use nas duas funções. Sem `last_checked_at`, devolve `now`.
  - `DomainDetailDomain` ganha `created_at: string`.

- [ ] **Step 1: Escrever os testes que falham.**
  - `nextDomainCheckAt`: domínio pending criado há 1 h e verificado há 4 min dá last + 10 min. Pending criado há 10 h dá last + 60 min. Verified dá last + 24 h.
  - `domain-detail.test.tsx`:
    - Cada registro com `verified: true` mostra "ok"; com `false`, mostra "pendente"; com `null`, mostra "—".
    - `last_error` aparece num elemento com a classe `text-destructive`.
    - Um domínio pending mostra "Próxima verificação automática" (o rótulo; não teste o horário).
    - Com `status: "pending"` e `canEdit`, a saída contém "Disponível depois que o domínio for verificado" (o tooltip do "Definir como padrão").
- [ ] **Step 2:** Rodar os testes: FAIL.
- [ ] **Step 3: Implementar.**
  - Uma coluna "Situação" na tabela DNS.
  - `last_error` aparece num bloco de alerta destrutivo pequeno.
  - Linha "Próxima verificação automática: {hora pt-BR}", calculada por `nextDomainCheckAt`; para domínios verificados, "Próxima checagem: {data}".
  - O tooltip de "Definir como padrão" envolve o botão desabilitado com `Tooltip`, usando o mesmo padrão de `DemoDisabledTooltip`.
  - Âncoras: as do cartão entram aqui, com prefixo `casa.dominio.` (`card`, `status`, `dns-table`, `copy`, `verify`, `send-instructions`, `set-default`, `remove`, `next-check`). O artigo que as cita vem na Task 9. **Até lá, o teste de cobertura falha na regra 3:** faça as Tasks 7 e 9 em sequência, ou registre as âncoras provisoriamente numa lista `ANCHORS_PENDING_ARTICLE` em `coverage-config.ts` e esvazie essa lista na Task 9.
- [ ] **Step 4:** Rodar `npx vitest run src/lib/house-config.test.ts src/components/house-config src/help`: PASS.
- [ ] **Step 5: Commit** `feat(casa): situação por registro DNS, erro destacado e próxima verificação`.

### Task 8: Ajustes de fluxo do e-mail e de permissão (itens 5 a 9 da seção 7)

**Files:**
- Modify:
  - `src/components/house-config/email-senders-section.tsx`
  - a seção de saúde de `/email` (procure "Domínio do remetente" em `src/components/email/`)
  - `src/routes/configuracoes_.casa.tsx`
  - o lugar que emite "Sem permissão para gerenciar este tenant" (procure em `src/lib`)
- Test: os testes dos componentes tocados (`renderToStaticMarkup`)

- [ ] **Step 1: Escrever os testes que falham.**
  - `EmailSendersSection` com um domínio verificado e zero remetentes mostra "Agora crie um remetente".
  - O botão "Remover" de um remetente usa `requestConfirmation`, com o título "Remover remetente?". Teste extraindo a função de handler, ou checando que o markup não chama a remoção direto; escolha a forma que o componente permitir.
  - A saúde do `/email` com "Não configurado" tem um link para `/configuracoes/casa#email`, com o texto "Configurar".
  - `/configuracoes/casa`, quando `canEdit` é false, mostra "Só o administrador da casa pode alterar estas configurações."
- [ ] **Step 2:** Rodar os testes: FAIL.
- [ ] **Step 3: Implementar.**
  - O aviso "Agora crie um remetente" leva ao formulário de remetente: rola até ele e foca o campo Endereço.
  - Trocar "tenant" por "casa" na mensagem de erro, sem mudar a lógica.
- [ ] **Step 4:** Rodar os testes: PASS.
- [ ] **Step 5: Commit** `feat(email): próximo passo do remetente, confirmação e avisos de permissão`.

### Tasks 9 a 15: Artigos e tours da fase 1

**Procedimento comum a cada tarefa de artigo**
1. **Reinventariar a tela a partir do código.** Abra o componente da rota e todos os que ele renderiza, inclusive diálogos, gavetas e sub-diálogos. Liste cada controle interativo, cada estado vazio ou de erro e cada aviso.
2. **Marcar com `tourAnchor()`** todos os controles que o artigo vai citar com `anchor`. No mínimo, todo controle que aparece num passo de tour precisa de âncora.
3. **Escrever `src/help/screens/<id>.ts`** (`export default` com um `HelpScreen`):
   - uma seção por bloco visual da tela, com `tab` nas telas que têm abas;
   - um item por controle, com `roles` quando o controle só aparece para alguns perfis;
   - `states` com os estados da tela;
   - `tours` com uma lista por aba, ou `default` quando não há abas, de 5 a 8 passos cada;
   - `terms` com os termos de jargão da tela, usando `<Term>` neles na tela quando forem rótulos.
4. **Registrar** em `HELP_SCREEN_LOADERS` e **remover a rota de `PENDING_ROUTES`**.
5. **Verificar:** rodar `npx vitest run src/help` (PASS), depois o **teste manual**: subir o app (skill `run`) na casa demo e conferir que o tour de cada aba roda, pula alvos invisíveis, e que "mostrar na tela" funciona no desktop e no celular (largura de 390 px).
6. **Commit:** `docs(ajuda): artigo e tour de <tela>`.

**Os artigos, com o que cada um não pode esquecer**

- **Task 9: `/configuracoes/casa`** (`screens/configuracoes-casa.ts`, abas `casa`, `encurtador` e `email`).
  - **Aba Casa:** URL da casa; URLs rápidas (com o erro "Preencha o nome e o caminho…"); o diálogo "Trocar domínio nos links" nos dois passos e na confirmação "não pode ser desfeito automaticamente"; e o fato de ele abrir sozinho ao trocar a URL.
  - **Abas Encurtador e E-mail:**
    - o cartão de domínio da Task 7;
    - todas as mensagens de erro listadas na seção "Domain configuration" do levantamento (as mesmas strings de `src/lib/house-config.functions.ts` e `src/lib/tenant-domains.server.ts`);
    - **um item dedicado aos registradores**, explicando onde colar no Registro.br, na Cloudflare, na GoDaddy e na Hostinger; o que é "@" e o nome parcial (`go`); a propagação; o calendário de verificação (10 min nas primeiras 6 h, depois de hora em hora até 72 h, depois diário); e o que fazer com "Falhou".
  - **Remetentes:** todos os campos; a diferença entre o "Nome do remetente" do template e o do remetente real; e "Domínio ainda não verificado".
  - **Não-admin:** explicar a leitura sem edição.
  - **Tours:** cada aba ganha o seu.
  - **Fim da tarefa:** esvaziar `ANCHORS_PENDING_ARTICLE`.
- **Task 10: Onboarding** (`screens/onboarding.ts`, route `"onboarding"`; adicione `"onboarding"` à lista de rotas virtuais aceitas pelo teste de cobertura).
  - **Arquivos a modificar:** `src/components/onboarding/house-setup-wizard.tsx`, `onboarding-gate.tsx`.
  - **O "?" do assistente:** colocar um `<HelpButton />` no topo do assistente.
  - **Ao montar o overlay**, o `OnboardingGate` chama:
    - `setOverlayActive(true)`, para o tour da tela de baixo não começar;
    - `setScreenOverride("onboarding", <passo>)`, com `casa`, `encurtador`, `email` ou `pronto`.
  - **Ao desmontar**, volta os dois ao normal. Cada passo do assistente tem um tour próprio, chave `tour:onboarding#<passo>`.
  - Os controles de domínio e de remetente reaproveitam as âncoras da Task 9, que são os mesmos componentes; o artigo do onboarding pode citar as mesmas âncoras.
  - **Itens do artigo:**
    - "Pular configuração", "Fazer depois", "Avançar" e "Concluir";
    - os marcadores de passo, que não são clicáveis;
    - o passo Pronto.
  - **Teste extra:** `shouldAutoStart` já cobre `overlayActive`. Adicione, em `onboarding-gate.test.tsx`, que o gate chama `setOverlayActive(true)` quando mostra o assistente (mock de `useHelp`).
- **Task 11: `/email`** (`screens/email.ts`, abas `visao-geral`, `templates` e `historico`).
  - **Escopo:**
    - KPIs, e "Cliques" sempre "—", com o motivo;
    - Saúde do envio, com o link da Task 8;
    - os cartões de template e o menu "…";
    - a escolha entre os dois editores;
    - o **Editor Rápido** completo (as 5 seções, as 8 cores, a prévia e "Editar no modo avançado");
    - o **Editor Avançado** completo (Templates prontos, Gerar com IA com os 5 campos, Status, HTML avançado, os 5 passos, o modo HTML e os erros);
    - o Histórico (`HistoryShell`, que a Task 13 também cita).
  - **Termos:** CTA, Preheader, Hero, Alt text e `remetente`.
- **Task 12: `/campanhas` e `/campanhas/$campaignId/relatorio`** (`screens/campanhas.ts`, `screens/campanha-relatorio.ts`).
  - **Hub:** todos os status; os selos "Bloqueada" e "N não enviados"; Retomar, Ver saldo e Cancelar, explicando que e-mail e voz agendados não têm Cancelar; e os rascunhos.
  - **Compositor:**
    - os 3 canais, com todos os campos de cada um;
    - a lista de números;
    - os chips de variável e de link;
    - o contador GSM/UCS e de segmentos;
    - o remetente desabilitado com o aviso "Configure e verifique…";
    - Quando enviar;
    - cada mensagem do bloco "Falta para enviar" e "Para continuar, corrija";
    - o resumo;
    - a confirmação acima de 1.000 destinatários, em que é preciso digitar o número;
    - "Fechar a campanha?".
  - **Envio de teste:** completo, nos 3 canais.
  - **Relatório:** todos os cartões; os chips do funil; os CSV restritos; a variante de voz; e os termos "último clique em até 7 dias", "receita assistida" e "Retorno x".
- **Task 13: `/automacoes`** (`screens/automacoes.ts`, abas `jornadas`, `mapa`, `fila`, `falhas`, `conflitos`, `leads-mortos` e `fluxos-voz`; confirme os valores reais do hash em `journeys-hub.tsx`).
  - **Escopo:**
    - "Limites de contato" e "Como contamos";
    - os diálogos Pausar, Ativar (com a estimativa) e "Ligar envio imediato?";
    - o menu "…" de cada jornada;
    - as automações legadas;
    - Leads mortos completo;
    - Fluxos de voz completo (blocos Ligação e Delay, saída).
- **Task 14: editor de jornada e relatório** (`screens/jornada-editor.ts` para `/jornadas/nova` e `/jornadas/$journeyId`, registrado nas duas rotas; `screens/jornada-relatorio.ts`).
  - **Editor:**
    - os 23 gatilhos, cada um com uma frase sobre quando usar (leia as opções em `journey-editor.tsx`);
    - os campos condicionais;
    - Público e Reentrada, com as 4 opções e a diferença em relação a "Intervalo entre jornadas";
    - os filtros de entrada;
    - os 4 tipos de etapa;
    - Saída;
    - Janela;
    - Limites e duração, incluindo o grupo de controle;
    - Conflitos (Família, Prioridade, Ao competir);
    - a barra fixa no celular;
    - o aviso de revisão em rascunho;
    - os 3 diálogos.
  - **Relatório:** todos os blocos e as notas de saúde dos dados.
  - **Termos:** `gatilho`, `reentrada`, `grupo-de-controle`, `encurtador`.
- **Task 15: Shell e `/webhooks#links`** (`screens/shell.ts`, route `"shell"`, uma rota virtual sem tour automático; `screens/webhooks.ts`, só a seção da aba `links` nesta fase).
  - **Shell:**
    - o botão de recolher;
    - a trilha;
    - o seletor de casa e o diálogo "Trocar de casa?";
    - o indicador ao vivo;
    - o menu da conta;
    - as faixas BillingBanner, DemoBanner e ProvidersPausedBanner;
    - a barra inferior e a gaveta no celular;
    - o próprio "?".
  - **O artigo shell** aparece no painel como "Sobre o CRM", abaixo de "Nesta tela".
  - **Webhooks:** as abas `plataforma` e `meta` ficam em `PENDING_ROUTES` com a forma `"/webhooks#plataforma"`. O teste de cobertura aceita pendências por aba nesse formato.

### Task 16: Regra de manutenção e verificação final

**Files:**
- Create: `docs/AJUDA_MANUTENCAO.md`
- Modify: `docs/INDEX.md` (adicionar a linha)

- [ ] **Step 1: Escrever `docs/AJUDA_MANUTENCAO.md`.**
  - **A regra:** toda mudança de UI atualiza o artigo da tela em `src/help/screens/` e marca os elementos novos com `tourAnchor()`.
  - **Telas novas:** entram com artigo, ou em `PENDING_ROUTES` com justificativa.
  - **Como rodar o teste:** `npx vitest run src/help`.
  - **Como testar um tour manualmente.**
- [ ] **Step 2:** Rodar `npm test`, `npm run build` e `npx tsc --noEmit` (se houver o script `typecheck`, use-o). Tudo verde.
- [ ] **Step 3: Teste manual completo na casa demo**, no desktop e no celular:
  - O primeiro acesso a cada tela e aba da fase 1 inicia o tour.
  - "Pular tour" não o faz voltar.
  - "Não mostrar tours automaticamente" desliga o início automático em todas as telas.
  - O painel abre, a busca acha "dominio", e os guias mostram o progresso da casa demo.
  - Com a migração **não** aplicada no ambiente, nada começa sozinho e o painel funciona.
- [ ] **Step 4: Commit** `docs(ajuda): regra de manutenção do tutorial`.
- [ ] **Step 5:** Avisar o usuário de que a migração `20261203100000_help_progress.sql` precisa ser aplicada em produção e **pedir autorização**. Sem ela, os tours não começam sozinhos.
