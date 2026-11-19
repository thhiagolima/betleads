# Auditoria de design e front-end do CRM — mobile primeiro (2026-11-19)

Varredura feita por 6 frentes em paralelo (visão de designer UI/UX + engenheiro front-end), cobrindo as 64 rotas e os ~320 componentes do CRM. **Nada foi alterado no código.**

**Método e limite:** leitura do código, com larguras calculadas a partir das classes (tela de 360px → ~328px úteis no `<main>`, ~296px dentro de um card). Não há navegador automatizado no projeto, então nenhum item foi visto num aparelho. Os itens marcados *(provável)* dependem do comportamento do navegador e precisam de confirmação num celular. Os P0 mais críticos foram reconferidos à mão: tour, `<main>`, diálogos, Alertas, Inbox do WhatsApp, cadastro de expert, "Copiar texto" do expert e paginação de Mídia.

Gravidade:
- **P0:** quebrado, inutilizável, perde dado ou mostra informação falsa.
- **P1:** claramente ruim no celular ou visivelmente inconsistente.
- **P2:** acabamento.

---

## 1. Resumo executivo

O CRM tem duas "gerações" de telas:

- **Telas já redesenhadas.** Funcionam bem no celular: cards no lugar de tabelas, `flex-wrap`, alvos de toque de 40–44px e escala de texto respeitada. São elas: Início (em boa parte), Jogadores, Ficha do jogador, Públicos, Campanhas e compositor, páginas de canal (SMS, E-mail, Voz, Push), Popups, Consentimentos (aba Base), Eventos e Ficha do lead do expert.
- **Telas antigas e telas novas que não tratam o celular.** Concentram quase todos os problemas: WhatsApp inteiro, editores de e-mail, diálogos de Ligações, Treino IA, Financeiro, Grupo, Alertas, Mídia/LTV, tabelas do Expert e de Rendimento.

**A maior parte do que está quebrado vem de 6 defeitos em peças compartilhadas.** Corrigir essas 6 peças (seção 2) resolve dezenas de telas de uma vez. Na sequência vêm os P0 específicos de cada tela (seção 3).

| Gravidade | Qtde (aprox.) | Principais |
|---|---|---|
| P0 | 17 | Tour, diálogos que saem da tela, Inbox do WhatsApp, barras "fixas" que não fixam, estados de erro que mostram "vazio", cópia no iPhone, ID de afiliado perdido, Alertas misturando casas |
| P1 | ~60 | Tabelas sem versão mobile, tooltips que não abrem no toque, valores R$ vazando dos cards, zoom do iOS em campos, calendário cortado, header espremido |
| P2 | ~70 | Texto < 12px (≈140 ocorrências), cores fixas fora dos tokens (≈330), alvos de toque de 32–36px, padrões de página duplicados, código morto |

---

## 2. Defeitos na raiz (corrigir uma vez → conserta muitas telas)

### S1 — `<main>` quebra tudo que é `sticky` e `fixed` dentro da página · **P0**
- **Onde:** [app-layout.tsx:122](../src/components/app-layout.tsx#L122) e [styles.css:213](../src/styles.css#L213).
- **Causa 1:** `overflow-x-hidden` faz o `overflow-y` virar `auto`. O `<main>` vira um contêiner de rolagem que nunca rola (quem rola é o documento), e assim **todo `position: sticky` da página deixa de grudar**.
- **Causa 2:** a animação `.animate-fade-in` usa `fill-mode: both`. Ela termina com `transform: translateY(0)` aplicado para sempre, e isso faz do `<main>` o **bloco de referência para todo `position: fixed`** que está dentro dele.
- **O que o usuário vê:**
  - Barra "Salvar/Ativar" do editor de jornada ([journey-editor.tsx:1690](../src/components/journeys/journey-editor.tsx#L1690)): só aparece no fim da página. No celular o Salvar do cabeçalho está escondido (`hidden md:flex`), então para salvar é preciso rolar a jornada inteira.
  - Barra de ações da seleção de contas Meta ([account-selection.tsx:163](../src/components/integrations/meta/account-selection.tsx#L163)), além do editor de popup, Origens, Jogadores e Mídia: nenhuma dessas barras gruda.
  - Wizard de onboarding ([onboarding-gate.tsx:92](../src/components/onboarding/onboarding-gate.tsx#L92)) e aviso de canal desligado ([channel-disabled-notice-gate.tsx:69](../src/components/channels/channel-disabled-notice-gate.tsx#L69)): cobrem só a área do conteúdo, não a tela. Header e tab bar continuam clicáveis por cima, e a parte de baixo do wizard (~61px) fica atrás da tab bar.
  - Tudo que estoura a largura é **cortado sem barra de rolagem**: o usuário vê "faltando pedaço".
- **Correção:**
  - Trocar `overflow-x-hidden` por `overflow-x-clip`.
  - Fazer a animação de entrada mexer só na opacidade, ou usar `fill-mode: backwards`.
  - Opcional: renderizar os gates com `createPortal(document.body)`.

### S2 — Diálogos sem altura máxima, sem rolagem e sem margem no celular · **P0**
- **Onde:** [ui/dialog.tsx:41](../src/components/ui/dialog.tsx#L41) e [ui/alert-dialog.tsx:37](../src/components/ui/alert-dialog.tsx#L37).
- **Causa:** o diálogo fica centralizado com `translate(-50%)`, sem `max-h` e sem `overflow-y-auto`. **55 dos 73 diálogos do app não compensam isso.**
- **O que o usuário vê:** em telefone baixo, ou com o teclado aberto, o topo e o **botão de confirmar** saem da tela e não há como rolar até eles. Os casos mais graves:
  - assistente "Conta própria de provedor" ([own-provider-tab.tsx:268](../src/components/integrations/own-provider-tab.tsx#L268)), usado pelo admin da casa;
  - "Nova casa" ([tenants.tsx:1487](../src/routes/tenants.tsx#L1487));
  - "Acessos de {email}" ([admin.tsx:511](../src/routes/admin.tsx#L511)), que cresce sem limite;
  - "Conta de provedor" ([provider-accounts-panel.tsx:554](../src/components/admin/provider-accounts-panel.tsx#L554));
  - "Limites de contato" e "Ativar jornada" das jornadas;
  - Pix ([pix-payment-dialog.tsx](../src/components/billing/pix-payment-dialog.tsx));
  - Proxy do WhatsApp;
  - template de SMS.
- **Problemas secundários:**
  - Abaixo de 640px o diálogo encosta nas bordas da tela, com cantos retos.
  - O × tem ~16px de área de toque, e o rótulo para leitor de tela está em inglês ("Close").
  - No `DialogFooter` e no `SheetFooter` ([dialog.tsx:63](../src/components/ui/dialog.tsx#L63), [sheet.tsx:84](../src/components/ui/sheet.tsx#L84)), os botões ficam empilhados e colados, sem `gap`.
- **Correção no componente base:**
  - `w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg`;
  - × com `size-10` e rótulo "Fechar";
  - rodapé com `flex-col-reverse gap-2 sm:flex-row sm:justify-end`.
  - O mesmo vale para `SheetContent`: `overflow-y-auto`, e `max-h` na variante bottom.

### S3 — Explicações em Tooltip, que não abre com toque · **P1**
- **Onde:**
  - `InfoTip` ([crm-results/shared.tsx:12](../src/components/crm-results/shared.tsx#L12), 8 usos);
  - `StatCell hint` ([reports/report-parts.tsx:58](../src/components/reports/report-parts.tsx#L58));
  - `JourneyMetric` ([journeys-hub.tsx:1245](../src/components/journeys/journeys-hub.tsx#L1245));
  - `DemoDisabledTooltip` (explica por que um botão está desabilitado);
  - vários `title=`: conversion-report, report-funnel, team-ranking, experts, midia-ltv.
- **O que o usuário vê:** no celular as definições das métricas ("Recuperado", "Em andamento", colunas de Origens, Visão geral) e os motivos de botão desabilitado simplesmente não existem.
- **Causa:** o Tooltip do Radix não abre ao tocar. O próprio [help/term.tsx:23](../src/help/term.tsx#L23) documenta isso e usa Popover.
- **Detalhe:** hoje há 3 implementações diferentes (`Term`, `TermTooltip`, `InfoTip`).
- **Correção:** um único `InfoHint`, baseado em Popover (hover no desktop, toque no mobile), com alvo de 40px. Substituir os Tooltips com informação e os `title=` essenciais.

### S4 — Erro e carregamento aparecem como "vazio" ou "carregando para sempre" · **P0**
O padrão `data ?? []` ou `if (isLoading || !data) return <Skeleton/>`, sem checar `isError`, mostra informação **falsa**:

| Tela | O que mostra quando a consulta falha |
|---|---|
| Alertas ([alertas.tsx:92-124](../src/routes/alertas.tsx#L92), [:851](../src/routes/alertas.tsx#L851)) | "Fila zerada. Todos os leads críticos já receberam tentativa." |
| Início do expert ([expert.index.tsx:198](../src/routes/expert.index.tsx#L198)) | "Nada para hoje. Bom trabalho!" |
| Leads do expert ([expert.leads.tsx:542](../src/routes/expert.leads.tsx#L542)) | "Nenhum lead encontrado" |
| Jornadas ([journeys-hub.tsx:529](../src/components/journeys/journeys-hub.tsx#L529), [:602](../src/components/journeys/journeys-hub.tsx#L602)) | "Nenhuma jornada ainda" / "Fila de envio vazia" |
| Experts ([experts.tsx:433](../src/routes/experts.tsx#L433), [:475](../src/routes/experts.tsx#L475)) | "Nenhum expert cadastrado" (inclusive *enquanto carrega*) |
| Extrato de crédito ([credit-statement.tsx:119](../src/components/rendimento/credit-statement.tsx#L119)) | "Nenhum crédito no período" |
| Treino IA ([treino-ia.tsx](../src/routes/treino-ia.tsx)) | "Nenhum exemplo ainda"; além disso, ações ignoram o erro e mostram sucesso |
| MCP, Grupo/casa, Outros custos, Config. financeiro, Metas, Pessoas do grupo ([mcp.tsx:121](../src/routes/mcp.tsx#L121), [grupo_.casa.tsx:45](../src/routes/grupo_.casa.tsx#L45), [finance-other-costs.tsx:448](../src/components/finance/finance-other-costs.tsx#L448), [finance-settings-panel.tsx:85](../src/components/finance/finance-settings-panel.tsx#L85), [group-goals-editor.tsx:156](../src/components/group/group-goals-editor.tsx#L156), [group-people.tsx:67](../src/components/group/group-people.tsx#L67)) | skeleton infinito |
| Rendimento sem casa ativa ([report-view.tsx:195](../src/components/rendimento/report-view.tsx#L195)) | "Carregando…" infinito |

**Correção:** separar os estados carregando / erro (mensagem + "Tentar novamente") / vazio, no padrão já usado em [portfolio-table.tsx:277](../src/components/rendimento/portfolio-table.tsx#L277), [dead-leads-panel.tsx:313](../src/components/journeys/dead-leads-panel.tsx#L313) e em `eventos.tsx`.

### S5 — Tabelas largas sem versão mobile · **P1**
- **O padrão certo já existe** em [reports/recipient-list.tsx:92](../src/components/reports/recipient-list.tsx#L92): lista `md:hidden` e tabela `hidden md:block`. Também em Jogadores e Consentimentos (aba Base).
- **Onde falta:**
  - **Expert:** leads ([expert.leads.tsx:505](../src/routes/expert.leads.tsx#L505)), carteira (7 colunas), extrato (8), ranking (9), lista de experts (9 colunas com até 5 botões).
  - **Resultados:** Origens (coluna fixa `min-w-56` deixa ~100px para 7 métricas), Comparar casas (a coluna "Métrica" não fica fixa ao rolar), Cohorts, Por origem, Teste de controle.
  - **Mídia/LTV:** 4 tabelas, sendo que a de criativos tem 3 rolagens aninhadas.
  - **Grupo:** Metas (campos dentro da tabela, ~560px de largura), Pessoas, Placar.
  - **Outras telas:** Equipe da casa (tenants), Registros DNS, Leads mortos (`min-w-[960px]`, com o botão "Reativar" fora da tela), Push (7 colunas), Consentimentos > Histórico, Fila de ligações, Histórico.
- **Agravante:** a rolagem horizontal fica escondida, sem nenhuma pista visual.
- **Correção:**
  - Criar um componente comum `ResponsiveTable` (cards abaixo de `md`).
  - Nas tabelas de admin, basta fixar a 1ª coluna (`sticky left-0`) e agrupar as ações em "⋯".

### S6 — Componentes base com alvos de toque e fontes que não servem para celular · **P1/P2**
- **`Button`** ([ui/button.tsx:21-25](../src/components/ui/button.tsx#L21)): os tamanhos default, `sm` e `icon` têm 36px. As telas novas compensam caso a caso com `h-10 sm:h-9` ou `IconButton`; as antigas, não.
  - **Correção no componente:** `sm`: `h-10 sm:h-9`; `icon`: `size-10 sm:size-9`.
- **Outros componentes abaixo de 40px:**
  - `Switch` (20×36px, [ui/switch.tsx:12](../src/components/ui/switch.tsx#L12));
  - `ToggleGroup sm` (32px);
  - `PageTabs` e seletores segmentados (36px);
  - abas do `Tabs` antigo (~28px);
  - dias do calendário (32px);
  - itens do menu mobile (`h-9`);
  - botões de ajuda e de tempo real (32px).
- **Zoom do iOS ao focar** (fonte < 16px em campo): `CommandInput` ([ui/command.tsx:47](../src/components/ui/command.tsx#L47), `text-sm`), além de ~25 lugares que sobrescrevem a fonte do `Input`/`Textarea` sem prefixo `md:`. Exemplos: editores de e-mail, roteiro de ligação, busca da Inbox, CSV de consentimentos, wizard de push, wizard de provedor, webhooks, admin, Pix, `<select>` nativo do Treino IA e busca de Origens.
- **Popover base** ([ui/popover.tsx:22](../src/components/ui/popover.tsx#L22)): sem `max-h` e sem `max-w`.
  - O seletor de jogador (`w-[380px]`, [lead-selector.tsx:72](../src/components/ligacoes/lead-selector.tsx#L72)) passa da tela de 360px.
  - O calendário com `numberOfMonths={2}` empilha 2 meses no celular (~560–650px de altura) e é cortado, sem rolagem: seletor de período do Início/Histórico ([home/period-picker.tsx](../src/components/home/period-picker.tsx)) e [dashboard-date-range-picker.tsx:40](../src/components/dashboard-date-range-picker.tsx#L40).
  - **Correção:** `max-w-[calc(100vw-1rem)] max-h-(--radix-popover-content-available-height) overflow-y-auto`, e 1 mês no celular.
- **Toasts** ([ui/sonner.tsx](../src/components/ui/sonner.tsx)) *(provável)*: sem `theme="dark"`. O sonner usa tema claro por padrão e o CSS próprio dele vence as classes do Tailwind, então os avisos devem aparecer **brancos num app escuro**. No celular também ficam em cima da tab bar.
  - **Correção:** `theme="dark"`, `position="top-center"` (ou um offset acima da tab bar), e variáveis `--normal-bg`/`--normal-text` ligadas aos tokens.

---

## 3. P0 por tela (fora os defeitos de raiz)

| # | Tela | Problema | Onde | Correção |
|---|---|---|---|---|
| 1 | **Tour guiado** (seu print) | "2 de 7" + 4 botões numa linha sem quebra. Os rótulos quebram dentro dos botões e o contador é espremido. Botões com ~24px de altura | [tour-runner.ts:115-133](../src/help/tour-runner.ts#L115), [tour.css](../src/help/tour.css) (o driver.js 1.10 usa `flex` sem wrap e `all:unset` sem `nowrap`) | No `@media (<768px)`: footer com `flex-wrap`, progresso em linha própria, botões `nowrap` com `min-height:40px`. Melhor: tirar "Pular tour" da linha (o × já faz isso) e transformar "Saiba mais" em link no corpo do balão |
| 2 | **Tour guiado** | No celular o balão fica sempre embaixo e **cobre o elemento destacado** quando ele está na metade de baixo da tela. Título longo passa por baixo do × | [tour.css:88-97](../src/help/tour.css#L88) | Escolher topo ou base conforme a posição do elemento (`getBoundingClientRect`), `max-height:60dvh` com rolagem, `padding-right` no título |
| 3 | **Inbox do WhatsApp** | Lista e chat empilhados no mesmo contêiner com `overflow-hidden`. Tocar numa conversa "não faz nada", porque o chat fica cortado embaixo. Não há "voltar" | [inbox.tsx:592-593](../src/components/whatsapp/inbox.tsx#L592) | Mestre-detalhe no mobile: com conversa aberta, esconder a lista e mostrar botão "Voltar" |
| 4 | **Inbox do WhatsApp** | Campo de mensagem e botão Enviar ficam **atrás da tab bar** (a altura `100dvh-4rem` ignora os 76px da barra e os banners) | [whatsapp.tsx:306](../src/routes/whatsapp.tsx#L306) | `h-[calc(100dvh-3.5rem-76px)] md:h-[calc(100dvh-3.5rem)]`, ou esconder a tab bar nessa rota |
| 5 | **WhatsApp → Integração externa** | 3 botões numa linha sem quebra (~470px). "Enviar todos os eventos" fica fora da tela e não dá para tocar | [external-integration-tab.tsx:174](../src/components/whatsapp/external-integration-tab.tsx#L174) | `flex-wrap` ou `flex-col sm:flex-row` |
| 6 | **Expert → Ficha do lead → "Copiar texto"** *(provável no iPhone)* | O texto é buscado no servidor e só depois copiado. O Safari recusa a cópia fora do momento do toque: "Não foi possível copiar." Não há plano B | [lead-actions.tsx:177](../src/components/expert/lead-actions.tsx#L177), [:42](../src/components/expert/lead-actions.tsx#L42) | `navigator.clipboard.write([new ClipboardItem({"text/plain": promessa})])` chamado ainda no toque. Como plano B, `execCommand`; se nada funcionar, mostrar o texto num campo selecionável. Criar um utilitário `copyToClipboard` único |
| 7 | **Cadastro de expert** | O ID de afiliado só é aceito com **Enter**. No celular, quem digita e toca "Salvar" cria o expert **sem ID**: ele não recebe leads e não aparece nenhum aviso | [expert-form-dialog.tsx:306-322](../src/components/experts/expert-form-dialog.tsx#L306), salvar em [:178](../src/components/experts/expert-form-dialog.tsx#L178) | Botão "Adicionar", e também incluir o texto pendente ao sair do campo e ao salvar |
| 8 | **Alertas** | Mostra "Fila zerada" quando a consulta falha (ver S4) | [alertas.tsx:92-124](../src/routes/alertas.tsx#L92) | Lançar o erro quando a consulta falhar e mostrar um estado de erro |
| 9 | **Alertas** (super admin) | As 5 consultas **não filtram por casa** e a `queryKey` não tem a casa. Para o super admin, a RLS devolve todas as casas, e os limites (800 jogadores / 8.000 depósitos) passam a valer para a soma de todas: **fila misturada e errada** | [alertas.tsx:96-124](../src/routes/alertas.tsx#L96), [:573](../src/routes/alertas.tsx#L573) | `activeTenantFilter`/`scopeToTenant` (o mesmo padrão da correção de vazamento do super admin) e `tenantId` na `queryKey` |
| 10 | **Mídia/LTV → "Onde o dinheiro está"** | Paginação limitada a 10 botões, sem "Próxima". Com mais de 80 criativos, o resto fica inacessível | [midia-ltv.tsx:963](../src/routes/midia-ltv.tsx#L963) | Anterior/Próxima, como em [conversion-report.tsx:660](../src/components/conversion-report.tsx#L660) |
| 11 | **Treino IA** | Ações (ativar, remover, sinônimos) ignoram erro do banco. "Rascunho criado" aparece sem checar o resultado e duplica a cada toque | [treino-ia.tsx:135-142](../src/routes/treino-ia.tsx#L135), [:339-362](../src/routes/treino-ia.tsx#L339), [:522-533](../src/routes/treino-ia.tsx#L522) | Migrar para `useMutation` com `toast.error` e botão desabilitado enquanto envia |
| 12 | **Conectar ao Claude, Admin, Webhooks** | "Copiado!" aparece mesmo quando a cópia falha (o `writeText` não é aguardado) | [mcp.tsx:75](../src/routes/mcp.tsx#L75), [admin.tsx:348](../src/routes/admin.tsx#L348), [:732](../src/routes/admin.tsx#L732), [webhooks.tsx:283](../src/routes/webhooks.tsx#L283) | Mesmo utilitário do item 6 |

---

## 4. P1 por área

### Shell (cabeçalho, menu, avisos)
- **Header espreme o título em 360px.** O lado direito soma ~316px: seletor de casa ~192px, "Ao vivo", ajuda e conta. Sobram ~4px para o título ("Jogadores" vira "…"). Onde: [app-layout.tsx:75-109](../src/components/app-layout.tsx#L75). **Correção:** esconder o indicador de tempo real no mobile (ou virar um ponto no avatar) e deixar o seletor de casa compacto com no máximo ~88px.
- **Aviso "Disparos pausados" espremido.** Linha sem quebra: o texto fica com ~150px e o botão `nowrap` ocupa o resto. Onde: [providers-paused-banner.tsx:82](../src/components/providers-paused-banner.tsx#L82).
- **Banner de cobrança fora do padrão.** Ocupa a largura toda, sem o container de 1600px, e usa `amber/red` fixos em vez de `warning/danger`. Onde: [billing-banner.tsx:33](../src/components/billing/billing-banner.tsx#L33).
- **Cabeçalho do `DataCard` não quebra.** As ações ficam em `shrink-0` sem wrap. Onde: [data-card.tsx:31](../src/components/ui-premium/data-card.tsx#L31).
- **Viewport sem `viewport-fit=cover`.** Todo `env(safe-area-inset-bottom)` do app vale 0, então no app instalado no iPhone a tab bar fica sob o indicador de início. Onde: [__root.tsx:109](../src/routes/__root.tsx#L109). **Decidir:** ligar o `viewport-fit=cover` ou remover esses paddings.
- **Tour: "Saiba mais" encerra o tour.** Ele grava o tour como "pulado", e o tour não volta. Tocar fora do balão também conta como pulado. Onde: [help-provider.tsx:296](../src/components/help/help-provider.tsx#L296).

### Início, Resultados, Relatórios, Mídia, Alertas
- **Seletor de período do Início e do Histórico.** São 6 opções mais "Datas" (~500px) em 328px. A rolagem lateral não tem nenhuma pista, então "Mês passado" e "Datas" ficam invisíveis.
- **Valores em R$ vazando dos cards em grade de 2 colunas.** "R$ 12.345,67" usa espaço inquebrável e precisa de ~160px, mas o card tem ~126px.
  - Componentes: `KpiCard` ([home-cards.tsx:75](../src/components/home/home-cards.tsx#L75)), `MetricCard` ([metric-card.tsx:47](../src/components/ui-premium/metric-card.tsx#L47)), `StatCell` ([report-parts.tsx:73](../src/components/reports/report-parts.tsx#L73)) e os KPIs de Mídia.
  - O `MetricCard` ainda trunca o rótulo ("Custo por 1º…").
  - **Correção:** `min-w-0 break-words`, `text-xl sm:text-2xl` ou formato compacto no mobile, e `line-clamp-2` no rótulo.
- **Eixos de gráfico cortados ou gastando metade da largura.**
  - Onde: [midia-ltv.tsx:897](../src/routes/midia-ltv.tsx#L897) (`width={58}`), os dois eixos da Visão geral (80+90px) e [dashboard-blocks.tsx:256](../src/components/home/dashboard-blocks.tsx#L256).
  - A fonte dos eixos (11,5px) está abaixo do mínimo da escala ([chart-theme.ts](../src/lib/chart-theme.ts)).
- **Coluna Mensagem dos relatórios.** O `max-w` em `<td>` é ignorado e, com `truncate`, a coluna fica tão larga quanto o SMS inteiro. Onde: [conversion-report.tsx:1211](../src/components/conversion-report.tsx#L1211), [history-shell.tsx:540](../src/components/history/history-shell.tsx#L540).
- **Chat da IA no celular.** O contêiner não tem altura fixa, então a resposta nova não entra na tela e URLs longas estouram a bolha. Onde: [inteligencia.tsx:104](../src/routes/inteligencia.tsx#L104).

### Jornadas e automações
- **Saída sem aviso de alterações não salvas.** Um toque na tab bar, no "← Automações" ou no voltar do sistema descarta tudo. O padrão `useBlocker` já existe em [meta-connection-view.tsx:99](../src/components/integrations/meta/meta-connection-view.tsx#L99). Onde: [journey-editor.tsx:476](../src/components/journeys/journey-editor.tsx#L476).
- **Não dá para reordenar nem inserir etapas no meio.** O aviso da própria tela fala em "trocar a ordem", mas não existe essa opção. Usar ↑/↓ como em [flow-form-dialog.tsx:584](../src/components/ligacoes/flow-form-dialog.tsx#L584), "Adicionar etapa abaixo" e `key` estável no lugar de `key={i}`. Onde: [journey-editor.tsx:750](../src/components/journeys/journey-editor.tsx#L750), [:1143](../src/components/journeys/journey-editor.tsx#L1143).
- **Gamificação: "Atualizar" apaga a edição das faixas em andamento.** O `useEffect` reidrata o rascunho a cada refetch. Onde: [gamificacao.tsx:82](../src/routes/gamificacao.tsx#L82).
- **Diálogo de fluxo de voz.** O `grid-cols-2` não tem breakpoint, e a linha de SMS deixa ~40px para o Select. Onde: [flow-form-dialog.tsx:345](../src/components/ligacoes/flow-form-dialog.tsx#L345), [:836](../src/components/ligacoes/flow-form-dialog.tsx#L836).
- **Treino IA: linha de sinônimo estoura em 360px.** Onde: [treino-ia.tsx:451](../src/routes/treino-ia.tsx#L451).

### Canais (WhatsApp, e-mail, ligações, push)
- **WhatsApp inteiro fora do redesign.**
  - `min-h-screen p-6` próprio dentro do `main` (padding dobrado, ~280px úteis): [whatsapp.tsx:313](../src/routes/whatsapp.tsx#L313).
  - 55 textos de 9–11px.
  - Cores fixas.
  - Cabeçalhos `justify-between` sem quebra: [:977](../src/routes/whatsapp.tsx#L977), [:1506](../src/routes/whatsapp.tsx#L1506).
  - Botões só com ícone e sem `aria-label`.
- **Editores de e-mail.** Abaixo de 1024px, formulário e prévia dividem a mesma altura (~200px cada). **Correção:** abas "Editar | Prévia" e diálogo em tela cheia, como o compositor de campanha. Onde: [template-editor-dialog.tsx:303](../src/components/email/template-editor-dialog.tsx#L303), [quick-editor-dialog.tsx:367](../src/components/email/quick-editor-dialog.tsx#L367).
- **Grids de 2–3 colunas sem breakpoint em diálogos.** Fluxo e roteiro de ligação, editor de fluxo e Proxy do WhatsApp, toggles do editor de e-mail.

### Financeiro, Plano, Grupo, Casas, Configurações
- **Lista de dias com valores cortados.** Com 3 colunas de ~80px, o usuário vê "R$ 12.34…". Onde: [day-list.tsx:120](../src/components/finance/day-list.tsx#L120).
- **Cards do topo do Financeiro.** Números de 30–40px com `nowrap` invadem o card vizinho entre 768 e 1440px. Onde: [result-band.tsx:71](../src/components/finance/dashboard/result-band.tsx#L71).
- **Saldo do Plano.** `text-4xl` em 3 colunas no tablet. Onde: [plano-e-creditos.tsx:359](../src/routes/plano-e-creditos.tsx#L359).
- **Pix no celular.** A ação principal deveria ser um botão grande "Copiar código Pix" antes do QR, porque quem paga pelo celular usa o app do banco no mesmo aparelho. Onde: [pix-payment-dialog.tsx:325](../src/components/billing/pix-payment-dialog.tsx#L325).
- **"Editar" em Outros custos parece não funcionar.** Ele preenche um formulário fora da tela, sem rolar até ele. Onde: [finance-other-costs.tsx:519](../src/components/finance/finance-other-costs.tsx#L519).
- **Placar do grupo com variação/meta ilegíveis.** `text-[10px]` com `opacity-60`. Onde: [group-scoreboard.tsx:169](../src/components/group/group-scoreboard.tsx#L169).
- **Super admin em Casas.** Tocar numa casa não rola até os detalhes, que ficam abaixo de uma lista de 620px. Onde: [tenants.tsx:398](../src/routes/tenants.tsx#L398).
- **Remetente de e-mail.** Estoura a largura com domínio longo. Onde: [email-senders-section.tsx:211](../src/components/house-config/email-senders-section.tsx#L211).
- **Registros DNS.** No celular a coluna Valor mostra 1–2 caracteres por linha, e o Nome não tem botão de copiar. Onde: [domain-detail.tsx:143](../src/components/house-config/domain-detail.tsx#L143).
- **Conectar ao Claude.**
  - "Desconectar" não pede confirmação nem trata erro: [mcp.tsx:441](../src/routes/mcp.tsx#L441).
  - Os passos falam só de computador ("Ctrl+V", "canto de baixo à esquerda"), sem aviso para quem está no celular: [mcp.tsx:202](../src/routes/mcp.tsx#L202).
- **Login sem "Esqueci minha senha"** ([auth-gate.tsx](../src/components/auth-gate.tsx)). Quem esquece a senha fica travado.

### Área do Expert
- **CSV no celular** ([download-csv.ts](../src/components/rendimento/download-csv.ts)). No app instalado no iPhone e em navegadores dentro de apps (link aberto pelo WhatsApp/Instagram), o download não acontece, mas aparece "CSV exportado". **Correção:** usar `navigator.share({files})` quando disponível.
- **WhatsApp travado para leads de fora do Brasil.** Numa casa como Los Hermanos (ARS), aparece "Lead sem telefone válido" porque a normalização é só brasileira. Onde: [lead-actions.tsx:79](../src/components/expert/lead-actions.tsx#L79).
- **Modelos bloqueados quando a casa desliga o SMS.** Os modelos do expert são de WhatsApp, mas a tela inteira fica bloqueada. Onde: [expert.modelos.tsx:238](../src/routes/expert.modelos.tsx#L238).
- **Ficha do lead.** No celular, 5–6 cartões de ação vêm antes dos números do lead. Onde: [expert.leads.$playerId.tsx:78](../src/routes/expert.leads.$playerId.tsx#L78).
- **"Abrir no WhatsApp" no iOS** deixa uma aba em branco aberta. Onde: [lead-actions.tsx:161](../src/components/expert/lead-actions.tsx#L161).

---

## 5. P2 — acabamento (consolidado)

- **Texto abaixo de 12px:** ≈140 ocorrências de `text-[9–11.5px]`. As mais visíveis:
  - tab bar mobile (10,5px, [mobile-nav.tsx:32](../src/components/shell/mobile-nav.tsx#L32));
  - marca (9–10px);
  - seções do menu;
  - WhatsApp (55);
  - modal de dia do Financeiro (7);
  - placar e período do grupo;
  - eixos dos gráficos.
- **Cores fixas fora dos tokens:** ≈330 ocorrências de `emerald/amber/rose/red/violet/sky-NNN`, `#5b7fa6` e `border-white/5`. Deveriam ser `success/warning/danger/info`. Falta uma variante `warning` no `Badge`, e o selo amarelo é refeito à mão em vários lugares.
- **Tamanhos de fonte soltos** (`text-[12.5px]`, `[13px]`, `[13.5px]`, `[15px]`, `[22px]`, `[28px]`, `[30px]`) em vez da escala (`text-body`, `text-label`, `text-section`, `text-kpi`).
- **Páginas fora do padrão `Page`/`PageHeader`:** Financeiro, Grupo, Grupo/casa, Metas, Plano, Grupos (estas duas ficam sem `h1`), WhatsApp e Início (usa um `HomeHeader` próprio). Também a prop `icon` obsoleta, ainda passada em várias telas.
- **Abas:**
  - 3 estilos diferentes: o `Tabs` antigo (~28px, em Financeiro e Grupo/casa), o `PageTabs` e os `Tabs` de Mídia, que não têm `TabsContent`.
  - O seletor segmentado foi copiado 5 vezes, com conjuntos de períodos diferentes.
  - O `PageTabs` esconde a barra de rolagem: falta um esmaecimento nas bordas e o `scrollIntoView` da aba ativa.
- **`min-h-screen` em vez de `min-h-dvh`** (rolagem fantasma por causa da barra de endereço): `__root`, `auth-gate`, `mcp_.autorizar`, `u.$token`, WhatsApp.
- **Acessibilidade:**
  - `Label` sem `htmlFor` nos diálogos de casas e grupo.
  - Ordenação sem `aria-sort` no ranking, no placar e no lucro por casa.
  - `<button>` dentro de `<Link>` (mapa de jornadas).
  - Linhas de tabela clicáveis só com `onClick`.
  - Switches sem `aria-label`.
  - Os botões do tour perdem o anel de foco.
- **Campos numéricos que "pulam":** apagar `dailyLimit`/`cooldown` vira 0, e prioridade volta para 1 ([journey-editor.tsx:1561](../src/components/journeys/journey-editor.tsx#L1561)).
- **Rolagem dentro de rolagem** que prende o dedo: Treino IA (`max-h-[600px]`), Mídia (3 níveis), lista de casas (620px).
- **Textos:**
  - "Retention"/"Risk" em inglês em Alertas.
  - Mensagens de vazio que ignoram o filtro ativo (Alertas, Carteira).
  - Mídia mistura "-" e "—" para vazio.
  - "Casa fora do grupo." sem link de volta.
  - O cartão Mensalidade aparece vazio para casa isenta.
- **Navegação:**
  - `/automacoes/ligacoes` não abre a aba de voz.
  - `/regras` redireciona via `useEffect`, o que deixa a tela em branco por um instante.
  - "Jornada não encontrada" aparece num erro de rede.
  - `<a href>` em vez de `<Link>` em [link-insert-menu.tsx:60](../src/components/house-config/link-insert-menu.tsx#L60), o que recarrega a página.
- **Código morto:**
  - `channel-workspace-nav.tsx`;
  - `GatilhosTab`, `RegrasTab` e `InboxTab` em whatsapp.tsx;
  - `ExpertMetricCards`.

---

## 6. O que está bom (usar como referência)

- `reports/recipient-list.tsx`, Jogadores e Consentimentos (Base): cards no mobile e tabela no desktop.
- `IconButton` (`size-11 sm:size-9`), `h-11 sm:h-9` na ficha do lead, `min-h-11` no filtro de funil: alvos de toque certos.
- `Input`/`Textarea` base com `text-base md:text-sm`, que evita o zoom.
- `day-modal` (folha de tela cheia no celular) e `group-period-bar` (folha inferior no lugar do popover).
- `eventos.tsx`: estados de carregando, vazio e erro corretos.
- Compositor de campanha em tela cheia `h-dvh` no celular.
- `pix-payment-dialog`: trata o erro de cópia.
- `Term` (Popover): explicação que funciona com toque.

---

## 7. Plano de execução sugerido (para aprovação)

**Fase 1 — Raiz (1 PR, maior retorno, baixo risco)**
- S1: `<main>` com `overflow-x-clip` e animação sem `transform` residual.
- S2: Dialog, AlertDialog e Sheet com altura máxima, rolagem, margem, × de 40px "Fechar" e `gap` no rodapé.
- S6: tamanhos `sm`/`icon` do `Button`, `CommandInput` com 16px, limites no Popover, calendário com 1 mês no celular, Sonner escuro e fora da tab bar.
- Tour: rodapé que quebra linha, botões de 40px, balão que muda de lado e "Saiba mais" sem encerrar o tour.
- Header mobile mais enxuto.
- *Validar no celular após o deploy:* sticky, onboarding, toasts e tour.

**Fase 2 — P0 que mostram informação falsa ou perdem dado**
- Alertas: erro e filtro por casa.
- Estados de erro em todas as telas da seção S4.
- ID de afiliado no cadastro de expert.
- Utilitário único de cópia (expert, MCP, admin, webhooks).
- Paginação de Mídia.
- Treino IA com tratamento de erro.
- Rascunho da Gamificação.
- Bloqueio de saída com alteração não salva nas jornadas.

**Fase 3 — WhatsApp no celular**
- Inbox mestre-detalhe e compositor acima da tab bar.
- Integração externa.
- Migrar a página para `Page`, tokens e escala de texto.

**Fase 4 — Tabelas e componentes de informação**
- Componente `ResponsiveTable`, aplicado na ordem: Expert (leads, carteira, extrato), Origens, Comparar casas, Leads mortos, Metas e Pessoas do grupo, DNS, Equipe, Push, Fila de ligações.
- `InfoHint` único no lugar dos Tooltips.
- KPIs que não vazam (`KpiCard`, `MetricCard`, `StatCell`, `result-band`, `day-list`, saldo do Plano).

**Fase 5 — Editores e diálogos densos**
- Editores de e-mail com abas Editar/Prévia em tela cheia.
- Grids responsivos nos diálogos de ligação e WhatsApp.
- Reordenar e inserir etapas na jornada.
- CSV via compartilhamento no celular.
- WhatsApp para DDI estrangeiro.
- Modelos do expert sem depender do SMS.

**Fase 6 — Consistência (P2)**
- Texto < 12px para a escala.
- Cores para tokens e variante `warning` no Badge.
- Unificar abas e seletores segmentados.
- `Page`/`PageHeader` em todas as telas.
- `min-h-dvh`, decisão sobre `viewport-fit=cover`, acessibilidade e código morto.
- Atualizar o tutorial do CRM onde a UI mudar.

**Fora de design, mas encontrado (decidir à parte):**
- "Esqueci minha senha" no login.
- Alertas misturando casas para o super admin. Este é de dados e entra na Fase 2.
