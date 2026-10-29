# Financeiro — auditoria e escopo do redesign do painel

**Data:** 29/10/2026
**Status:** Proposto (decisões da §4 tomadas em 29/10)
**Base:** o que está no `main` em `b831d56`: painel de resultado, GGR do mês, custo do provedor para casas isentas, dias sempre calculados e cards de depósitos e saques. Os specs de origem são `superpowers/specs/2026-10-24-grupos-de-casas-design.md` e `superpowers/specs/2026-10-27-financeiro-painel-design.md`.

## 1. Por que este documento

O dono das casas avaliou o Financeiro e apontou cinco problemas:

1. Os números do painel não estão claros.
2. O custo de envio aparece como um valor só, sem dizer quanto foi gasto em cada canal nem quantos envios foram feitos.
3. Faltam KPIs importantes para o admin entender a casa.
4. O lançamento dos dias pode melhorar, por exemplo clicando no dia e abrindo uma janela (modal).
5. O custo de envio não aparece nos dias, e "Outros custos" não tem data.

Este documento verifica cada ponto contra o código e os dados de produção (consultas só de leitura em 29/10) e propõe um escopo em fases.

**Conclusão:** os cinco pontos procedem. A auditoria achou mais três problemas que pioram a clareza (§2.6 a §2.8). Nenhuma casa lançou nada ainda: em produção há 3 linhas em `tenant_finance_daily`, todas sem anúncios e sem GGR, nenhum "outro custo" e nenhum GGR do mês. Dá para mudar a tela sem migrar nem confundir dados de ninguém.

## 2. Auditoria

### 2.1 "Os números não estão claros" — procede

- **Um número, dois nomes.**
  - O card diz "Lucro líquido", a aba Lançamentos diz "Resultado caixa", e a meta diz "Resultado".
  - O card diz "Net (depósitos − saques)", a grade diz "Net bruto", e o placar diz "Net".
- **A conta não aparece em lugar nenhum.**
  - Lucro = net − taxa de GGR − taxa de movimentação − anúncios − outros custos − custo Betleads.
  - A taxa de movimentação incide três vezes, sobre depósitos, saques e net (`computeDay` em `src/lib/finance/calc.ts`). O admin não tem como saber disso pela tela.
- **"Para onde foi o dinheiro" lista custos, mas não parte da receita.** O admin vê quanto saiu, mas não vê o caminho do net até o lucro.
- **Dois cálculos de GGR convivem sem explicação.** Uma casa pode lançar o GGR dia a dia ou pelo total do mês. No segundo caso os dias recebem uma estimativa, e só um aviso de rodapé conta isso.

### 2.2 "Custo de envio é um geral" — procede

- A linha "Betleads" de "Para onde foi o dinheiro" soma duas coisas diferentes: o **consumo** (SMS, voz e e-mail) e a **mensalidade** (`costBreakdown`, `amount = usage + fee`).
- Nas casas isentas a linha muda de nome para "Custo de envio (provedor)", mas continua sem separar os canais.
- **O dado por canal existe.** Cada linha de `wallet_ledger` tem `item` (`sms`, `voice_30s`, `email`), `units` (quantidade) e o preço e custo do provedor da época. A função `finance_betleads_usage` soma tudo num valor por dia e perde o canal.
- **Achado:** na tabela de preços em produção, **voz e e-mail não têm custo do provedor** (`provider_unit_cost` vazio; só o SMS tem R$ 0,059). Por isso, nas casas isentas, o custo de voz e de e-mail aparece como R$ 0. Hoje isso não pesa: nos últimos 30 dias só houve consumo de SMS (≈204 mil unidades reservadas e 4,8 mil estornadas). Vai pesar quando voz e e-mail forem usados.
- A Central de Resultados (`crm_results_daily`) tem, por dia, envios, cliques, receita direta e receita influenciada do CRM. O Financeiro não usa nada disso, então o admin vê o custo dos envios, mas não o que eles trouxeram.

### 2.3 "Faltam KPIs" — procede

Hoje o painel mostra 8 cards: lucro, ROI, anúncios, depósitos, saques, net, FTDs e custo por FTD.

O que já existe nos dados e não aparece:

| Dado | Fonte | KPI possível |
|---|---|---|
| quantidade de depósitos e depositantes únicos | `tenant_daily_metrics.approved_deposit_count` e `approved_depositor_count` | ticket médio, depósitos por depositante |
| quantidade de saques | `approved_withdrawal_count` | saque médio |
| Pix gerados | `generated_pix_count` | conversão de Pix gerado em pago |
| cadastros e FTDs | `registrations`, `ftds` | conversão de cadastro em FTD |
| valor dos primeiros depósitos | soma de FTD em `finance_days` | FTD médio |
| GGR e depósitos | lançamento e CRM | GGR ÷ depósitos (quanto a casa retém) |
| lucro e net | cálculo | margem (lucro ÷ net) |
| envios, cliques e receita do CRM | `crm_results_daily` | custo por envio, receita do CRM, retorno do CRM |
| impressões e cliques da Meta | `marketing_ad_metrics_daily` | CPM, CTR, custo por clique (só para casa com Meta conectada) |

### 2.4 "Lançamento dos dias pode melhorar" — procede

- A aba Lançamentos é uma tabela de 13 colunas com campos de digitar dentro das linhas (`finance-month-grid.tsx`). No celular ela precisa de rolagem lateral, e é difícil ver o dia como um todo.
- O dia não mostra o que veio sozinho do CRM separado do que a pessoa precisa digitar. Só a cor de fundo distingue.
- A sugestão de gasto da Meta é um botão pequeno com ícone, fácil de não notar.
- O salvamento é em lote ("Salvar alterações" no topo), e não por dia.

### 2.5 "Custos de envio não aparecem nos dias" — procede

- O consumo de envios entra no lucro **por dia** (`summarize` recebe `betleads.usage` somado), mas a grade não mostra esse valor em nenhuma linha.
- Só o resumo do mês, embaixo da grade, mostra o total do mês. Por isso o lucro de um dia na grade não fecha com o lucro do dia no painel.

### 2.6 "Outros custos não têm data" — procede

- `tenant_finance_other_costs` guarda só o **mês** (`month`, sempre dia 1).
- **Consequência:** outros custos (e a mensalidade) só entram em período de mês fechado ou no preset "Mês". Em "7 dias", "Ontem" ou num período personalizado, eles ficam de fora, e o painel avisa com a nota "Resultado sem outros custos e mensalidade do mês".
- Não existe custo recorrente. Um custo fixo mensal (equipe, ferramenta) tem de ser lançado de novo todo mês.

### 2.7 Achados adicionais

1. **A mensalidade fica junto com o consumo** na linha "Betleads" (§2.2). São custos de natureza diferente: um é fixo, o outro varia com o volume de envios.
2. **O consumo só existe a partir de 22/10/2026**, quando a carteira começou. Os meses anteriores mostram R$ 0 com a nota "Sem dado de custo Betleads antes de…". Está correto, mas fica escondido no rodapé do gráfico e do resumo.
3. **A isenção é avaliada pela situação atual da casa** e aplicada a todos os meses (limitação já aceita). Isso precisa aparecer na explicação da linha de custo.
4. **O ROI não tem referência.** Com "1,8×" o admin não sabe se o valor é bom. Uma meta ou a média das casas do grupo daria contexto.

## 3. Escopo proposto

### 3.1 Princípios

- Uma pergunta por bloco: **quanto sobrou**, **de onde veio**, **para onde foi**, **o que trouxe**.
- Cada número tem **um nome só** em todas as telas e um "como calculamos" ao passar o mouse ou tocar.
- O que vem do CRM aparece sozinho. O que precisa ser digitado fica claramente marcado e é rápido de lançar.

### 3.2 Painel (aba Painel)

1. **Faixa de resultado.** Lucro líquido, margem, ROI e investimento em anúncios, cada um com a variação e o "como calculamos".
2. **Do net ao lucro (cascata).** Um gráfico de cascata:
   - começa em depósitos e desce por saques até o net;
   - continua por taxa de GGR, taxa de movimentação, anúncios, envios, mensalidade e outros custos (por categoria);
   - termina no lucro.

   Ele substitui a lista "Para onde foi o dinheiro" e torna a conta visível.
3. **Blocos de KPIs, agrupados:**
   - **Movimentação:** depósitos (R$ e quantidade), depositantes, ticket médio, saques (R$ e quantidade), net, saques ÷ depósitos, Pix gerado → pago.
   - **Aquisição:** anúncios, cadastros, FTDs, conversão cadastro → FTD, custo por cadastro, custo por FTD, FTD médio, e da Meta CPM, CTR e custo por clique quando a casa tiver Meta conectada.
   - **GGR:** GGR, taxa de GGR, GGR ÷ depósitos. Se o GGR do mês vier de estimativa, isso aparece no próprio card.
   - **Envios e CRM:** uma linha por canal (SMS, voz, e-mail) com quantidade, custo e custo unitário; o total; a receita direta e a influenciada do CRM; e o retorno do CRM (receita ÷ custo de envio).
4. **Gráfico de 12 meses.** Fica como está, com opção de ver lucro, net ou depósitos.
5. **Grupo e "Todas as casas".** Os mesmos blocos somados, e a tabela "Lucro por casa" ganha as colunas margem e custo de envio.

### 3.3 Custo de envio por canal

- `finance_betleads_usage` passa a devolver o custo **por canal** (`item`), com a quantidade (`units`) por dia.
- A mensalidade vira uma linha própria, **"Mensalidade"**, separada de **"Envios"**.
- Casa isenta: custo do provedor por canal. **Pré-requisito:** cadastrar o custo do provedor de voz e de e-mail na tabela de preços (§4.1). Enquanto não houver, o card do canal mostra "custo do provedor não cadastrado" em vez de R$ 0.

### 3.4 Lançamentos: lista de dias e modal do dia

- **Lista de dias** (substitui a grade de 13 colunas). Cada linha mostra a data, um selo de situação (**completo** / **falta anúncios** / **falta GGR** / **estimado**), o net, os envios e o lucro do dia. Funciona no celular sem rolagem lateral.
- **Clicar no dia abre um modal** com três partes:
  - **Veio do CRM (automático):** cadastros, FTDs, valor de FTD, depósitos, saques, net, envios por canal (quantidade e custo) e, se houver, gasto da Meta.
  - **Você lança:** anúncios (com o botão "Usar valor da Meta" visível), GGR ("Perdas na casa"; bloqueado com explicação quando o mês usa o total) e outros custos do dia (§3.5).
  - **Resultado do dia:** a mesma cascata do painel, em miniatura.

  Botões "dia anterior" e "próximo dia", e "Salvar" por dia. O GGR do mês continua no topo da aba.
- **Atalho em massa:** "Usar gasto da Meta em todos os dias vazios do mês".

### 3.5 Outros custos com data

- Cada custo ganha uma **data** (padrão: hoje) e passa a entrar em qualquer período que contenha essa data, como os demais custos.
- Opção **"Repetir todo mês"** para custos fixos: cria o lançamento do mês seguinte no mesmo dia, e ele pode ser editado ou removido.
- Os lançamentos antigos sem data ficam no dia 1 do mês. Hoje não existe nenhum em produção.
- Com isso, a nota "Resultado sem outros custos do mês" deixa de existir. A mensalidade segue só em mês fechado (§4.3).

### 3.6 Clareza (vale para tudo)

- Um nome por número, nesta lista:
  - **Lucro líquido**;
  - **Net (depósitos − saques)**;
  - **GGR (Perdas na casa)**;
  - **Taxa de GGR**;
  - **Taxa de movimentação**;
  - **Envios**;
  - **Mensalidade**;
  - **Outros custos**.

  Isso vale para cards, Lançamentos, metas e placar.
- "Como calculamos" em cada card. A taxa de movimentação explica a base tripla.
- Os avisos (estimativa de GGR, sem dado de consumo antes de 22/10, isenção pela situação atual) saem do rodapé e vão para o card ou a linha a que se referem.

### 3.7 Fases sugeridas

| Fase | Entrega | Depende de |
|---|---|---|
| F1 | Custo por canal e mensalidade separada (§3.3), envios nos dias, nomes únicos (§3.6) | cadastrar custo do provedor (§4.1) |
| F2 | Outros custos com data e recorrência (§3.5) | — |
| F3 | Lançamentos em lista com modal do dia (§3.4) | F1 |
| F4 | Painel com cascata e blocos de KPIs (§3.2) | F1, F2 |
| F5 | KPIs do CRM e da Meta no Financeiro, referência para o ROI | F4 |

## 4. Decisões (respondidas em 29/10/2026)

1. **Custo do provedor:** voz **R$ 0,0035 por 30 s**, e-mail **R$ 0,0004 por e-mail** (SMS segue R$ 0,059). Esses valores precisam ser cadastrados na tabela de preços (`billing_price_book.provider_unit_cost`) com vigência a partir do cadastro. Os registros já gravados na carteira continuam com o custo vazio, então o custo de voz e e-mail das casas isentas só aparece a partir dessa data.
2. **Retorno do CRM:** mostrar **as duas** receitas, a direta (clique → depósito) e a influenciada (regra da Central de Resultados), cada uma com o seu retorno (receita ÷ custo de envio).
3. **Mensalidade:** continua entrando **só em mês fechado** (e no preset "Mês"). Nos outros períodos, o card da mensalidade diz que ela entra no fechamento do mês.
4. **Outros custos:** cada custo tem data. **Nem todos repetem**: a opção "Repetir todo mês" é por custo e vem desligada.
5. **Referência do ROI:** o **mês anterior** (mesma regra de comparação do painel: o mês em andamento é comparado até o mesmo dia).

## 5. Fora do escopo

- Integração automática do GGR com a plataforma da casa (o GGR continua sendo lançado).
- Mudanças em cobrança, preços ou carteira, além de cadastrar o custo do provedor de voz e de e-mail.
- Relatórios exportáveis (CSV ou PDF) do Financeiro.
