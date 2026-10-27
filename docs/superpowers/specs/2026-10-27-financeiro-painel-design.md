# Redesign do Financeiro — painel de resultado — design

Data: 2026-10-27
Status: rascunho para aprovação
Base: o financeiro e o painel do grupo descritos em `2026-10-24-grupos-de-casas-design.md`, já no main.
Mockup aprovado: `.superpowers/brainstorm/28046-1793138051/content/financeiro-painel-v1.html`.

## 1. Intenção

Hoje o Financeiro da casa (`src/routes/financeiro.tsx`) é a planilha da Pixreals recriada na tela:
uma grade com uma linha por dia, 13 colunas e um TOTAL no fim. Os números estão todos certos e o
lucro, o ROI e o total de anúncios já são calculados (`src/lib/finance/calc.ts`), mas a tela não
responde às perguntas que o dono faz ao abrir o Financeiro:

- Quanto a casa (ou o grupo) lucrou no mês, qual foi o retorno e quanto foi investido em anúncios?
- Como isso se compara com o mês anterior e com os meses de antes?
- Para onde foi o dinheiro, e quais gastos mais cresceram?

O redesign coloca um **painel de resultado** na frente e a planilha passa para uma aba de
lançamentos. Sucesso é o dono abrir o Financeiro e, num olhar, saber se o mês está melhor ou pior
que o anterior e por quê.

## 2. Objetivos, não-objetivos e anti-objetivos

**Objetivos**
- Uma aba **Painel**, que abre primeiro, com cards de KPI que mostram a variação contra o período de
  comparação, um gráfico do lucro em 12 meses e o bloco "Para onde foi o dinheiro".
- O **custo com a Betleads** (consumo de SMS, voz e e-mail e a mensalidade) entra sozinho no lucro,
  como mais uma linha de custo. Isso **revoga** o não-objetivo do spec de grupos, em que esses custos
  só entravam se alguém os lançasse em "outros custos".
- "Outros custos" passa a ter **categoria**: um conjunto fixo e, além dele, as categorias que a casa
  cria ao lançar, que ficam salvas para as próximas vezes.
- Um aviso visível quando faltam lançamentos que deixam o lucro incompleto, com atalho para lançar.
- A mesma tela de painel atende a casa, o grupo e o super admin, mudando só o recorte (veja §4).

**Não-objetivos**
- Mudar qualquer conta. Net, taxas, resultado caixa, ROI, dias pendentes e metas continuam como
  estão em `calc.ts` e no spec de grupos. A única exceção é o custo Betleads, que passa a ser
  descontado do resultado.
- Integrar o GGR com a plataforma da casa. Ele continua manual.
- Separar visualmente, no painel, o que foi digitado do que veio do CRM. O usuário pensou nisso e
  descartou. Ficam só os dois sinais leves descritos em §5.4 e §6.
- Mudar as permissões de quem vê e de quem lança (tabela do §3 do spec de grupos).

**Anti-objetivos** (falharia mesmo funcionando)
- O painel mostrar um lucro diferente do TOTAL da aba Lançamentos para o mesmo mês e o mesmo recorte.
- Um admin ou gestor de casa ver qualquer número de outra casa, inclusive somado.
- O custo Betleads ser contado duas vezes (por exemplo, a casa já tinha lançado o SMS em "outros
  custos" e agora ele também entra sozinho). Veja §7.3.
- Virar uma tela de BI genérica, com dezenas de gráficos. O foco são os três números: lucro,
  retorno e investimento em anúncios.

## 3. Quem vê o quê

Isto não muda. Só se escreve aqui o recorte que cada papel enxerga no painel:

| Papel | Recorte do painel |
|---|---|
| Admin da casa, gestor da casa liberado | só a própria casa |
| Gestor de grupo | um grupo dele, somado, com o detalhe de cada casa do grupo |
| Super admin | todas as casas, um grupo ou uma casa |

## 4. Navegação

- **Casa selecionada no seletor do topo** → menu Financeiro → abas **Painel** (padrão),
  **Lançamentos** (a grade de hoje), **Outros custos** e **Configurações**.
- **Grupo selecionado** → o "Painel do grupo" de hoje (`/grupo`) **passa a ser** o painel de recorte
  grupo (§6). Não ficam duas telas parecidas. O placar com metas que já existe entra embaixo desse
  painel. Clicar numa casa continua abrindo o financeiro dela, só para leitura (`/grupo/casa`), que
  ganha também a aba Painel.
- **Super admin** → no painel aparece um seletor **"Ver:"** com *Todas as casas*, cada grupo e cada
  casa. O recorte "Todas as casas" é novo, já que hoje o consolidado só existe por grupo.

## 5. Painel — recorte de uma casa

Ordem de cima para baixo, como no mockup (lado esquerdo).

### 5.1 Período e comparação
- Seletor de mês (padrão: mês atual) e "comparar com" (padrão: mês anterior). *Escolha minha:* o
  mesmo controle de período do grupo (`group-period-bar.tsx`), que já tem os presets e a regra de
  comparar o mês em andamento até o mesmo dia do mês anterior (`compareRange`).

### 5.2 Aviso de pendência
- Se há dias passados sem GGR ou sem anúncios confirmados: faixa amarela, "Faltam N dias de GGR
  (12, 18, 19). O lucro está incompleto.", com link **Lançar agora**, que abre a aba Lançamentos já
  no mês e rolando até o primeiro dia vazio.
- O dia de hoje, incompleto, não dispara o aviso (igual a `pendingDays` hoje).

### 5.3 Cards de KPI
Três cards em destaque e três de apoio. Todos mostram o valor e a variação contra o período de
comparação (▲/▼ verde ou vermelho, com a cor invertida para custos, como já faz `group-totals.tsx`):

| Destaque | Apoio |
|---|---|
| **Lucro líquido** (resultado caixa, já descontados os outros custos e o custo Betleads) | **Net** (depósitos − saques) |
| **Retorno (ROI)** (lucro ÷ anúncios), variação em pontos ou em "×" | **FTDs** |
| **Investido em anúncios** | **Custo por FTD** |

### 5.4 Lucro em 12 meses
- Barras do lucro líquido de cada um dos últimos 12 meses até o mês selecionado. Mês negativo em
  vermelho e mês em andamento num tom mais claro.
- Mês com dias pendentes leva uma marca de "incompleto", porque o valor pode subir ou descer quando
  os lançamentos chegarem.
- Passar o mouse mostra lucro, anúncios e ROI do mês.

### 5.5 Para onde foi o dinheiro
Lista dos custos do período, do maior para o menor, com uma barra proporcional, o valor e a
variação contra o período de comparação:
- Anúncios
- Taxa de GGR (com o % da casa no rótulo)
- Taxa de movimentação
- **Betleads**, com a etiqueta *automático* (§7)
- Uma linha por **categoria** de outros custos (§8)

## 6. Painel — recorte de grupo ou de todas as casas

Mesmo esqueleto da casa (lado direito do mockup), somando as casas do recorte:
- Período, comparação e aviso de pendência. O aviso diz quais casas têm dias faltando.
- Os três cards de destaque (lucro, ROI e anúncios) somados. *Escolha minha:* os três de apoio
  também, para a tela não mudar de forma entre os recortes.
- **Lucro por casa**: uma linha por casa, com lucro, ROI, anúncios e variação do lucro. Clicar abre o
  painel da casa (só leitura para o gestor de grupo). Ordenável por coluna.
- **Lucro em 12 meses** com as barras empilhadas por casa.
- **Para onde foi o dinheiro** somado. As categorias de outros custos são da casa (§8), então no
  consolidado as categorias com o mesmo nome se juntam numa linha só.
- Embaixo, o **placar com metas** que existe hoje (`group-scoreboard.tsx`). No recorte
  "Todas as casas" do super admin, o placar mostra todas as casas.
- *Escolha minha:* "Todas as casas" inclui as casas ativas, inclusive as do plano interno, e deixa
  de fora a casa demo e as casas desativadas.
- *Escolha minha:* o lucro é um número só. As metas de Resultado e de ROI no placar passam a usar o
  lucro já com o custo Betleads descontado, o mesmo dos cards. Os gestores de grupo devem revisar
  essas metas depois do lançamento, porque elas foram definidas sem esse custo.

Os sinais de pendência por casa usam a regra que já existe: `pendingDays` conta datas distintas.

## 7. Custo Betleads automático

### 7.1 O que entra
- **Consumo**: SMS, voz e e-mail debitados da carteira da casa (`wallet_ledger`, reservas de uso
  menos os estornos), no dia do débito, no fuso de São Paulo.
- **Mensalidade**: as faturas de `billing_invoices`. *Escolha minha* (regime de competência):
  - a fatura conta no mês do `period_start`, e não na data de emissão, de vencimento ou de pagamento;
  - o valor é `amount_cents`, já com desconto;
  - faturas `open` e `paid` contam e `canceled` não. Assim, o lucro de um mês não muda quando a
    fatura é paga.
  - Casa do plano interno, isenta, tem custo zero.

### 7.2 Como entra na conta
- O custo Betleads é descontado do lucro líquido do período e entra no ROI, como os outros custos.
- *Escolha minha:* o consumo entra **por dia**. Diferente de "outros custos", ele aparece também em
  períodos que não são um mês fechado, porque tem data. A mensalidade, por ser mensal, segue a regra
  de "outros custos" e só entra quando o período é um mês fechado.
- *Escolha minha:* quem pode ver o financeiro da casa vê também o custo Betleads, inclusive o
  gestor liberado. É um custo da própria casa, como os outros.
- Não entra na conta do dia na grade (o dia continua "pendente" só por falta de GGR ou de anúncios).
  Na aba Lançamentos ele aparece no resumo do mês, ao lado de taxa de movimentação, taxa de GGR e
  outros custos.
- Antes da carteira existir (consumo antigo em créditos de SMS) não há dado confiável. Esses meses
  mostram Betleads = 0 com a nota "sem dado de consumo antes de out/2026". O builder confirma a data
  de corte real.

### 7.3 Evitar contar duas vezes
- Ao lançar um "outro custo" cujo nome pareça custo Betleads (SMS, Betleads, mensalidade, voz,
  e-mail), a tela avisa: "o custo Betleads já entra sozinho".
- Os outros custos já lançados com esses nomes **não são apagados nem ignorados sozinhos** (decisão
  do usuário). Nos meses em que já há dado da carteira ou fatura, a aba Outros custos marca esses
  lançamentos como "parece duplicado com o custo Betleads automático", com um botão de remover. O
  painel mostra um aviso enquanto houver lançamento marcado no período ("pode haver custo Betleads
  contado duas vezes, revise em Outros custos"). Nos meses anteriores à carteira, os lançamentos
  manuais são o único dado e não são marcados.

## 8. Outros custos com categoria

- Cada lançamento de "outros custos" ganha uma **categoria**, além da descrição e do valor que já
  existem.
- **Categorias fixas** (*escolha minha*, ajustável): Afiliados e influenciadores, Equipe,
  Ferramentas, Impostos, Outros.
- **Categorias da casa**: ao lançar, a pessoa pode digitar um nome novo. Ele fica salvo e aparece nas
  próximas vezes como opção. *Escolha minha:* as categorias criadas valem só para a casa que as criou.
- Lançamentos antigos, sem categoria, ficam em "Outros".
- No painel, cada categoria vira uma linha em "Para onde foi o dinheiro".

## 9. Aba Lançamentos

É a grade de hoje (`finance-month-grid.tsx`), com dois ajustes:
- As colunas digitáveis (Anúncios e GGR) ganham um fundo diferente das que vêm do CRM, para ficar
  claro onde se digita.
- O resumo do mês, embaixo, ganha a linha **Betleads**.

## 10. O que já existe e é reaproveitado

- Todas as contas: `computeDay`, `summarize`, `compareRange`, `pctChange` e `ppChange` em
  `src/lib/finance/calc.ts`.
- A leitura dos dias: o RPC `finance_days` e `getTenantFinanceMonth` e `getGroupOverviewFor` em
  `src/lib/finance.functions.ts`.
- O controle de período e os cards com variação do grupo (`group-period-bar.tsx`,
  `group-totals.tsx`) e o placar (`group-scoreboard.tsx`).
- As permissões `finance_can_view` e as demais funções da migração `20261101100100_tenant_finance.sql`.

O que falta: uma leitura de vários meses de uma vez (para o gráfico de 12 meses), a soma do custo
Betleads por dia e por mês, o recorte "Todas as casas" para o super admin e a categoria em outros
custos.

## 11. Decisões tomadas

- Direção A (painel com cards de KPI) e não uma tabela de balanço com os meses lado a lado.
- O painel abre primeiro e a grade vira a aba Lançamentos.
- O painel do grupo de hoje é substituído pelo recorte grupo do novo painel, com o placar embaixo.
- O custo Betleads entra sozinho no lucro.
- Outros custos têm categorias fixas mais as que a casa cria, salvas para reuso.
- Não há separação forte entre manual e CRM, só o aviso de pendência e a cor das colunas digitáveis.
- Custo Betleads lançado à mão antes não é removido sozinho. A pessoa revisa e remove (§7.3).

### Escolhas minhas (para conferir)
- Mensalidade por competência (mês do `period_start`), com `amount_cents` e faturas abertas ou pagas.
- Consumo por dia; mensalidade só em mês fechado, como "outros custos".
- Lucro único: as metas de Resultado e de ROI também descontam o custo Betleads.
- "Todas as casas" = casas ativas, sem a demo.
- O gestor liberado vê o custo Betleads.
- Categorias fixas: Afiliados e influenciadores, Equipe, Ferramentas, Impostos, Outros. As
  categorias criadas valem só para a casa.
- Os três cards de apoio também aparecem no recorte de grupo.

## 12. Deixado para o builder

- Nome e formato das tabelas e colunas novas (categoria, categorias da casa) e das migrações.
- Como somar o consumo da carteira por dia: em consulta ou numa função SQL nova.
- Biblioteca e detalhes do gráfico, seguindo o padrão de gráficos que o projeto já usa.
- Layout no celular. A tela tem que funcionar no celular (cards em uma coluna e tabela de casas com
  rolagem).
- O seed e o reset da demo precisam gerar custo Betleads, categorias e 12 meses de histórico para o
  painel aparecer cheio.
