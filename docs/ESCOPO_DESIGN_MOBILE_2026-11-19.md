# Escopo — correções de design e mobile (2026-11-19)

Fonte: [AUDITORIA_DESIGN_MOBILE_2026-11-19.md](AUDITORIA_DESIGN_MOBILE_2026-11-19.md).
Branch: `feat/design-mobile`, a partir de `origin/main` 85a42daa.

**Sem migração de banco.** Todas as mudanças são de front-end.

Em todas as fases:
- Rodar `npm run typecheck`, `npm test` e `npm run build`.
- Fazer um commit por fase.
- Atualizar o tutorial do CRM (`src/help/screens`) onde um âncora ou texto mudar.

## Fase 1 — Peças compartilhadas (shell e componentes base)

| Item | Arquivo | Critério de pronto |
|---|---|---|
| 1.1 `<main>` sem contêiner de rolagem e sem `transform` residual | `app-layout.tsx`, `styles.css` | `overflow-x-clip`. A animação de entrada não deixa `transform` depois de terminar, e o `sticky` e o `fixed` das páginas voltam a valer para a tela inteira |
| 1.2 Dialog, AlertDialog e Sheet | `ui/dialog.tsx`, `ui/alert-dialog.tsx`, `ui/sheet.tsx` | Margem de 16px no celular, `max-h` de 100dvh−2rem com rolagem, cantos arredondados, × de 40px "Fechar", rodapé com `gap` |
| 1.3 Alvos de toque do `Button` | `ui/button.tsx` | `default`, `sm` e `icon` com 40px abaixo de `sm` e 36px a partir de `sm` |
| 1.4 Zoom do iOS | `ui/command.tsx` e demais componentes base | Campos com 16px no celular |
| 1.5 Popover | `ui/popover.tsx` | Nunca maior que a tela, com rolagem quando não cabe |
| 1.6 Calendário de período | `home/period-picker.tsx`, `dashboard-date-range-picker.tsx` | 1 mês no celular e 2 no desktop |
| 1.7 Toasts | `ui/sonner.tsx` | Tema escuro com os tokens, no topo no celular, sem cobrir a tab bar |
| 1.8 Tour | `help/tour.css`, `help/tour-runner.ts`, `help-provider.tsx` | No celular: rodapé quebra linha e botões têm 40px. O balão vai para o topo quando o alvo está embaixo. O título não passa por baixo do × e o foco fica visível |
| 1.9 Header mobile | `app-layout.tsx`, `active-tenant-switcher.tsx` | Título legível em 360px |
| 1.10 Componentes de apoio | `data-card.tsx`, `providers-paused-banner.tsx`, `tabs.tsx`, `page-tabs.tsx`, `mobile-nav.tsx` | Ações quebram linha, abas rolam, texto ≥ 12px |
| 1.11 `InfoHint` único (Popover que abre com toque) | `ui-premium/info-hint.tsx` | `InfoTip`, `StatCell hint`, `JourneyMetric` e `DemoDisabledTooltip` passam a abrir com toque |
| 1.12 Utilitário de cópia | `lib/clipboard.ts` | Aceita uma promessa de texto (iOS), tem plano B com `execCommand` e devolve `boolean` |
| 1.13 `viewport-fit=cover` e `min-h-dvh` | `__root.tsx`, `auth-gate.tsx` e outros | A área segura do iPhone é respeitada |

## Fase 2 — Telas que mostram informação falsa ou perdem dado

- Alertas:
  - estado de erro;
  - filtro pela casa ativa e `tenantId` na `queryKey`;
  - rótulos em pt-BR.
- Estados de carregando, erro e vazio:
  - expert (Início e Leads), Experts, Extrato de crédito;
  - Jornadas (lista, fila, falhas e conflitos);
  - MCP, Grupo/casa, Outros custos, Config. financeiro, Metas, Pessoas;
  - Rendimento sem casa ativa.
- Cadastro de expert: o ID digitado entra ao sair do campo, ao salvar e pelo botão "Adicionar".
- Cópia: Ficha do lead, MCP, Admin e Webhooks passam a usar `lib/clipboard`.
- Mídia: paginação com Anterior e Próxima.
- Treino IA: as ações tratam erro e o botão fica travado enquanto envia.
- Gamificação: o refetch não apaga o rascunho.
- Jornada: aviso ao sair com alterações não salvas.

## Fase 3 — WhatsApp no celular

- Inbox no formato mestre-detalhe, com botão "Voltar".
- Altura da Inbox descontando o header e a tab bar.
- Integração externa: os botões quebram linha.
- Página com o layout padrão (sem `p-6`/`min-h-screen` próprios).
- Texto ≥ 12px e cores por token.

## Fase 4 — Tabelas e números

- Lista em cards no celular:
  - expert: leads, carteira e extrato;
  - Leads mortos, Metas e Pessoas do grupo, DNS, Push, Fila de ligações, Consentimentos (Histórico).
- Primeira coluna fixa: Origens, Comparar casas, Ranking, lista de Experts e Equipe.
- KPIs sem vazar do card: `KpiCard`, `MetricCard`, `StatCell`, `result-band`, `day-list` e saldo do Plano.
- Eixos dos gráficos com valores compactos no celular e fonte de 12px.

## Fase 5 — Editores e diálogos densos

- Editores de e-mail: abas "Editar | Prévia" no celular.
- Grids responsivos nos diálogos de ligação, fluxo de voz, Proxy e editor de fluxo do WhatsApp.
- Jornada: reordenar etapas (↑/↓), "Adicionar etapa abaixo" e `key` estável.
- Expert:
  - CSV pelo compartilhamento do celular;
  - WhatsApp com DDI estrangeiro;
  - Modelos sem depender do SMS;
  - "Abrir no WhatsApp" sem deixar aba vazia.
- Pix: botão grande "Copiar código Pix" no celular.
- Outros custos: o "Editar" rola até o formulário.
- Conectar ao Claude:
  - "Desconectar" com confirmação;
  - aviso de que os passos são feitos no computador.
- Chat da IA: altura fixa no celular.

## Fase 6 — Consistência

- Texto < 12px passa para a escala.
- Cores fixas passam para tokens, com variante `warning` no `Badge`.
- `Page`/`PageHeader` nas telas que ainda não usam.
- Abas antigas passam para o padrão.
- Acessibilidade: `htmlFor`, `aria-sort`, `aria-label`.
- Código morto removido.

## Fora deste escopo (decidir à parte)

- "Esqueci minha senha" no login: depende do fluxo de e-mail do Supabase Auth.
- Validar num aparelho real depois do deploy: sticky, onboarding, toasts, tour e cópia no iPhone.
