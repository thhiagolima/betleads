# Tutorial do CRM: fase 3 (plano de implementação)

> **Para agentes:** sub-skill obrigatória: superpowers:subagent-driven-development (recomendada) ou superpowers:executing-plans. Os passos usam checkboxes (`- [ ]`) para acompanhamento.

**Objetivo.** Escrever os artigos e os tours das telas da fase 3 (spec §5): Resultados, Comparar casas, Aquisição e LTV, Financeiro, Rendimento (meu e da equipe), Assistente IA, Configurar IA, Experts e Conectar ao Claude. A fase também atualiza os artigos já publicados com o que mudou no código desde a fase 2.

**Abordagem.** A mesma da fase 2: só conteúdo e marcação. Cada tarefa segue o ciclo:
1. reinventariar a tela pelo código;
2. marcar os elementos com `tourAnchor()`;
3. escrever o artigo em `src/help/screens/<id>.ts`;
4. registrar o artigo em `HELP_SCREEN_LOADERS`;
5. tirar a rota de `PENDING_ROUTES`.

O teste de cobertura confirma a consistência. A fase 2 acrescentou duas proteções a ele: `<Term>` nunca fica dentro do label de um *Chip, e "expert" só pode aparecer em `roles` de telas que o expert abre.

**Stack.** A mesma da fase 2. A fase não tem migração nem dependência nova.

**Spec.** `docs/superpowers/specs/2026-11-05-tutorial-crm-design.md` (§2, §4.1, §4.2, §5 e §6). A manutenção segue `docs/AJUDA_MANUTENCAO.md`. O plano anterior é `docs/superpowers/plans/2026-11-06-tutorial-crm-fase2.md`.

- **Lição das fases 1 e 2 (obrigatória).**
  - Faça uma varredura em cada componente inventariado e nas server functions que ele chama. Procure `toast.*(`, `getErrorMessage(`, `errorMessage(`, `throw new Error(`, `requestConfirmation(` e AlertDialog, além dos textos de estado vazio. Cite cada string visível ao pé da letra.
  - Todo termo listado em `terms` precisa de `<Term>` no rótulo real da tela, quando esse rótulo existir. O `<Term>` nunca fica dentro de botão ou chip.
- **Papéis.**
  - `/financeiro` e `/resultados` têm partes só de super admin: o seletor de escopo "Ver:" e as visões de grupo e de todas as casas. Essas partes ficam fora.
  - O Financeiro tem partes só de admin (editar lançamentos e taxas) e partes que o gestor liberado só lê. Marque as duas com `roles`.

## Foco da revisão

1. **Jargão financeiro e de mídia.** GGR, Net, ROI, Margem, CPM, CTR, ROAS (líquido e bruto), CPA, cohort, mediana, holdout e IC 95%, "visão ampla", receita direta e influenciada. Cada termo deve ser explicado em linguagem simples, reaproveitando o glossário (`src/components/finance/definitions.ts` e o "Como ler" de Resultados).
2. **Números conferidos com o código.** As fórmulas descritas (Recuperado, Retorno, ROAS, Lucro líquido, Taxa de GGR) precisam bater com o que a tela calcula. Nada de inventar regra.
3. **Telas com variantes por papel.**
   - Rendimento: meu, da equipe e de uma pessoa. O expert vê a própria versão, que é da fase 4.
   - Financeiro: admin e gestor liberado.
   - Resultados: "Comparar casas" só aparece para admin de 2 ou mais casas.
4. **Componentes compartilhados.** `ReportView` (Rendimento) e o painel financeiro, que também é usado em `/grupo` (fase 4). As âncoras devem ser neutras e citadas do mesmo jeito em todos os artigos.
5. **Diálogos e gavetas grandes.** O modal do dia em Lançamentos, Outros custos com recorrência, o editor de expert, a revisão de campanha do expert e a importação do histórico em Configurar IA.

---

## Procedimento comum de cada tarefa

1. **Reinventariar pelo código.** Leia o componente da rota e tudo o que ele renderiza: diálogos, gavetas e sub-diálogos. Liste cada controle, estado, aviso e mensagem de erro.
2. **Marcar com `tourAnchor()`.** Marque cada controle que o artigo citar com `anchor`. No mínimo, todos os controles usados nos tours.
3. **Escrever `src/help/screens/<id>.ts`.** Use `export default` de um `HelpScreen`, no mesmo nível de profundidade de `configuracoes-casa.ts`, que é a referência:
   - uma seção por bloco visual, com `tab` quando houver abas;
   - um item por controle, com `roles` quando o controle depender do papel;
   - `states` com os estados da tela;
   - `tours` por aba;
   - `terms` com os termos de jargão.
4. **Registrar.** Inclua a tela em `HELP_SCREEN_LOADERS` e tire a rota (ou `rota#aba`) de `PENDING_ROUTES`. Termos novos vão para `src/help/glossary.ts`.
5. **Verificar.** Rode as verificações das restrições globais.
6. **Commit.** Use `docs(ajuda): artigo e tour de <tela>`, com o trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
7. **Relatório.** Inclua a tabela de inventário (controle → item que o cobre).

### Task 1: Resultados do CRM e Comparar casas

- **Arquivos.** `src/help/screens/resultados.ts` (`/resultados`, abas conforme o hash real) e `src/help/screens/resultados-comparar.ts` (`/resultados/comparar`).
- **Código.** `src/routes/resultados.tsx`, `src/routes/resultados_.comparar.tsx` e `src/components/crm-results/*`. O painel foi redesenhado e agora tem: Recuperado pelo CRM, selo de grupo de controle, Reativações após SMS, Origens, Teste de controle, Saúde dos dados, "Como ler" e CSV.
- **O que cobrir em Resultados.**
  - O período.
  - A pílula de saúde e a gaveta que ela abre.
  - "Como ler".
  - "Comparar casas", que só aparece para admin de 2 ou mais casas.
  - O CSV.
  - Cada cartão e KPI, com a regra de cada um.
  - O gráfico, os destaques e "O que fazer agora".
  - Origens: tipo, busca, tabela ordenável, expandir a jornada e os selos.
  - "Para quem vai o dinheiro".
  - Teste de controle: o sorteio, a leitura e o IC 95%.
  - Os estados.
- **O que cobrir em Comparar.** Os períodos e as 19 métricas.

### Task 2: Aquisição e LTV

- **Arquivo.** `src/help/screens/midia-ltv.ts` (`/midia-ltv`, abas Mídia e Retenção).
- **O que cobrir.**
  - "Conectar Meta" e "Atualizar agora" (só admin).
  - O status de sincronização.
  - O período, as datas e o filtro de BM e conta.
  - Os avisos.
  - Os 5 KPIs, com a fórmula do ROAS.
  - As abas internas: Por criativo, Por público, Por campanha, Evolução e Diagnóstico (com os órfãos).
  - Retenção: base agora, evolução, funil, origem e cohort.
- **Termos.** ROAS, CPA/CAC, CTR, impressões, BM, UTM, cohort e LTV.

### Task 3: Financeiro

- **Arquivo.** `src/help/screens/financeiro.ts` (`/financeiro`, abas Painel, Lançamentos, Outros custos e Configurações).
- **O que cobrir no Painel.**
  - O período: atalhos, calendário e a versão de celular.
  - "Comparar com".
  - O banner de pendências e "Lançar agora".
  - A faixa de resultado e a cascata.
  - Os blocos de KPI (Movimentação, Aquisição, GGR, Envios e CRM), com "Como calculamos".
  - O gráfico de 12 meses.
- **O que cobrir em Lançamentos.**
  - O mês e os pendentes.
  - "Usar gasto da Meta".
  - O GGR do mês.
  - As linhas do dia.
  - O modal do dia inteiro, incluindo "Descartar alterações?".
- **O que cobrir em Outros custos.** A tabela, o formulário, a categoria, a recorrência e os dois modos de excluir.
- **O que cobrir em Configurações.** As taxas com o histórico e a liberação para gestores.
- **Papéis.**
  - Editar é só do admin; o gestor liberado só lê.
  - O seletor "Ver:" e as visões de grupo e de todas as casas são só de super admin e ficam fora.
- **Âncoras.** O painel é compartilhado com `/grupo` (fase 4). Use o prefixo neutro `financeiro.`, que serve para os dois.

### Task 4: Rendimento

- **Arquivos.** `src/help/screens/rendimento.ts` (`/rendimento`), `src/help/screens/rendimento-equipe.ts` (`/rendimento/equipe`) e `src/help/screens/rendimento-pessoa.ts` (`/rendimento/equipe/$expertId`).
- **Âncoras.** `ReportView` é compartilhado, inclusive com `/expert/rendimento` (fase 4). Use o prefixo neutro `rendimento.` e cite as mesmas âncoras nos três artigos.
- **O que cobrir no relatório.**
  - O período e o CSV.
  - Os cartões, o funil e o gráfico.
  - "Leads que mais depositaram" e a gaveta de histórico.
  - O extrato de créditos.
  - "Leads do período": busca, "Só FTD" e "Só reativados".
- **O que cobrir em Equipe.**
  - "Regras de crédito" (janela de clique).
  - O CSV e os KPIs.
  - O ranking ordenável.
- **O que cobrir em Pessoa.**
  - As abas Rendimento e Campanhas.
  - "Editar", com o diálogo completo.
  - Ativar e Desativar.
  - A aprovação de campanha: revisar, aprovar e recusar com motivo.
- **Termos.** Creditado, janela de clique, reativado, redepósito e teto.

### Task 5: Assistente IA e Configurar IA

- **Arquivos.** `src/help/screens/inteligencia.ts` (`/inteligencia`) e `src/help/screens/treino-ia.ts` (`/treino-ia`, abas Exemplos, Assuntos e sinônimos, Avaliações). As duas telas são só de admin.
- **O que cobrir no Assistente.** A pergunta, o botão de enviar, as sugestões, as respostas (cartões de jogador) e o feedback 👍/👎 com o formulário.
- **O que cobrir em Configurar IA.**
  - Exemplos: os campos, "Importar do histórico", a lista, ligar e desligar, excluir.
  - Assuntos e sinônimos, com os tipos.
  - Avaliações, com "Criar exemplo".
- **Linguagem.** Explique "assunto" e "sinônimo" em linguagem simples, sem o jargão técnico do código (intent, campo_alvo).

### Task 6: Experts e Conectar ao Claude

- **Arquivos.** `src/help/screens/experts.ts` (`/experts`, admin) e `src/help/screens/mcp.ts` (`/mcp`).
- **O que cobrir em Experts.**
  - "Regras de crédito" e "Novo expert".
  - As aprovações pendentes: revisar, aprovar e recusar.
  - A tabela.
  - As ações de cada linha: editar, convidar, vincular, desvincular, remover acesso, ativar/desativar e excluir.
  - "IDs de afiliado sem expert".
  - Todos os diálogos.
- **O que cobrir em MCP.** A URL, as instruções para claude.ai, Desktop e Code, as conexões ativas e os estados.
- **Termos.** ID de afiliado e MCP.

### Task 7: Manutenção dos artigos publicados

- Para cada artigo em `src/help/screens/`, rode `git log a1908ea..HEAD -- <componentes da tela>`.
- Atualize o artigo com qualquer mudança de UI desde a fase 2: strings, controles ou estados.
- Registre no relatório o que mudou e por quê.

### Task 8: Fechamento

- Se surgir algum padrão novo, atualize `docs/AJUDA_MANUTENCAO.md`.
- Rode a verificação completa:
  - `npm test` (as falhas conhecidas são seed-demo-finance e billing-admin antes do meio-dia);
  - tsc, lint e build.
- Faça a revisão final da branch.
