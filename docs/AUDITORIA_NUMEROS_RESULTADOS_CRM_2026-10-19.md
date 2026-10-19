# Auditoria dos números da Central de Resultados — 19/10/2026

**Origem:** o gestor da Sorte Alta achou os números de 18/10 ("Ontem") muito acima do padrão.
**Escopo:** card "Conversão por clique" e KPIs derivados (custo por convertido, retorno), aba Origens,
Base de jogadores, Comparar casas, CSV e o "recuperado" dos cards de Jornadas.
**Status:** corrigido na migração `20261019120000_crm_click_conversion_incremental.sql` (rule_version 3).

## 1. O que a tela mostrava (Sorte Alta, 18/10)

| Indicador | Valor exibido |
|---|---|
| SMS cobrados | 12.522 |
| SMS clicados | 400 (3,2%) |
| Jogadores convertidos | 95 (23,8% dos cliques) |
| Valor convertido | R$ 22.904,51 |
| Custo em SMS | R$ 738,80 |
| Custo por convertido | R$ 7,78 |
| Retorno | 31,0x |
| Visão ampla (recuperados) | 83 · R$ 4.492,36 · 6,1x |

## 2. O que está correto

Os 262 depósitos atribuídos em 18/10 foram conferidos um a um contra a tabela `deposits`. Todos
existem, estão aprovados, pertencem ao mesmo jogador e têm o mesmo valor (soma R$ 22.904,51). Também
não há duplicidade. SMS cobrados, cliques e custo batem com os logs. **Não há erro de dado. O problema
é a regra de cálculo.**

## 3. Falhas encontradas

### F1 — Depósitos de jogadores já ativos contavam como conversão (impacto alto)

A regra somava **todo** depósito feito até 7 dias depois de um clique, de qualquer jogador.

| Situação do jogador no momento do clique | Jogadores | Valor |
|---|---|---|
| Ativo: depositou nas 48 h anteriores (média de **18,9 depósitos** nos 7 dias antes) | 66 | R$ 15.763,97 (69%) |
| Parado há 2 a 7 dias | 17 | R$ 3.584,54 |
| Parado há 7 dias ou mais | 6 | R$ 356,00 |
| Nunca tinha depositado | 1 | R$ 3.200,00 |

Quem deposita quase três vezes por dia ia depositar com ou sem o SMS. A "Visão ampla" já excluía esses
jogadores, e por isso as duas visões se contradiziam na mesma tela (31x contra 6,1x).

### F2 — A taxa "% dos cliques" misturava grupos diferentes (impacto alto)

O numerador eram os jogadores que depositaram em 18/10, com clique em qualquer dia entre 15 e 18/10:
só 18 deles clicaram em 18/10. O denominador eram apenas os cliques de 18/10. Olhando quem clicou em
18/10 (347 jogadores), 21 depositaram depois (~6%). Entre os que estavam parados, foram 6 de 304 (~2%).

### F3 — Jogador contado mais de uma vez (impacto baixo)

O número de jogadores era distinto por dia × origem × etapa e depois somado. Em 18/10, cinco jogadores
tinham depósitos vindos de dois SMS diferentes: 90 jogadores reais apareciam como 95. Em períodos de
7, 30 e 90 dias, o mesmo jogador também era somado uma vez por dia em que depositava.

### F4 — Aviso de "números ainda vão crescer" incorreto (impacto baixo)

O valor e os jogadores são registrados no dia do depósito, então um dia encerrado não cresce mais. O
gráfico diário também desenhava os últimos 7 dias como "ainda chegando", o que não é verdade para o
valor.

### F5 — Cards de Jornadas com a mesma inflação (impacto alto)

O "recuperado" de cada jornada (`list_journey_metrics`) somava todos os depósitos atribuídos, inclusive
os de jogadores ativos.

## 4. Nova regra (rule_version 3)

1. **Conversão por clique = jogador que não estava ativo no clique.** O jogador conta se não tinha
   depósito aprovado nas 48 h antes do primeiro clique naquele SMS, o mesmo corte de 48 h da visão
   ampla e do estado "Ativo". Entram todos os depósitos dele até 7 dias depois do clique. Os
   depósitos de quem já estava ativo vão para colunas separadas ("já ativos") e não entram no valor
   convertido, no custo por convertido nem no retorno.
2. **Jogador convertido conta no dia do primeiro depósito vindo daquele clique.** Nos dias seguintes,
   os depósitos dele somam valor, mas ele não é contado de novo.
3. **Total do período = jogadores distintos.** O topo da tela usa a função
   `crm_click_players_period`, que conta cada jogador uma vez no período. Por origem, etapa e estado,
   o jogador conta uma vez por SMS que o converteu, então a soma das origens pode passar do total.
4. **Taxa de conversão por coorte de clique.** `converted_clicks` conta os SMS clicados no dia que
   geraram depósito de jogador não ativo (em até 7 dias). Taxa = `converted_clicks ÷ human_clicks`.
   Essa taxa sobe durante 7 dias depois do clique. É atualizada a cada 10 minutos para hoje e ontem,
   e uma vez por dia (03:20) para os 8 últimos dias.
5. **Verificação de saúde** (`check_crm_results_day`): compara o total de atribuições com a soma de
   convertidos + já ativos.
6. **Jornadas:** o "recuperado" exclui jogadores ativos no clique.

## 5. Efeito esperado em 18/10 (Sorte Alta)

| Indicador | Antes | Depois (estimado na auditoria) |
|---|---|---|
| Jogadores convertidos | 95 | 24 |
| Valor convertido | R$ 22.904,51 | R$ 7.140,54 |
| Custo por convertido | R$ 7,78 | ~R$ 30,78 |
| Retorno | 31,0x | ~9,7x |
| Já ativos (fora do retorno) | — | 66 jogadores · R$ 15.763,97 |

Um único depósito de R$ 3.200 (jogador novo) pesa no valor: sem ele, o retorno fica perto de 5x,
alinhado com a visão ampla (6,1x). Os valores finais depois do recálculo estão na seção 7.

## 6. Fora deste escopo (pendências)

- Relatórios detalhados por campanha/jornada (`conversion-report.functions.ts`), exportação de
  atribuições e painel de experimento A/B continuam listando todos os depósitos atribuídos. São
  registros de auditoria, não indicadores de retorno. O A/B compara variantes sob a mesma regra.
  Avaliar se o cabeçalho desses relatórios deve adotar o mesmo filtro.
- O efeito causal real continua sendo medido pelo Teste de controle (holdout). A conversão por clique
  é atribuição, não prova de incrementalidade.

## 7. Implantação

- Migração: `supabase/migrations/20261019120000_crm_click_conversion_incremental.sql`.
- Histórico recalculado com `refresh_crm_results_day` para todas as casas desde o primeiro dia com
  dados.
- Resultado do recálculo: ver registro de implantação abaixo.

### Registro de implantação

**19/10/2026.** A migração foi aplicada numa transação única, com o recálculo automático travado.
Foram recalculados 43 dias×casa em 29 s, com 0 falha na verificação de saúde de 18/10 e todas as
linhas em rule_version 3. A migração está registrada em `supabase_migrations.schema_migrations`.

Sorte Alta depois do recálculo:

| Dia | Custo | Cliques | Cliques convertidos | Jogadores | Valor convertido | Já ativos (fora do retorno) |
|---|---|---|---|---|---|---|
| 15/10 | R$ 723,34 | 251 | 22 | 17 | R$ 1.510,43 | 13 · R$ 2.783,41 |
| 16/10 | R$ 1.745,99 | 937 | 67 | 44 | R$ 7.435,00 | 56 · R$ 13.769,26 |
| 17/10 | R$ 1.144,01 | 492 | 25 | 32 | R$ 11.624,04 | 93 · R$ 19.006,55 |
| 18/10 | R$ 738,80 | 400 | 5 (maturando) | 13 | R$ 6.717,54 | 70 · R$ 16.186,97 |

- 18/10: retorno de 31,0x para 9,1x; custo por convertido de R$ 7,78 para R$ 56,83.
- Últimos 7 dias, retorno por clique: Sorte Alta 5,2x · PixReals 1,8x · Casa Betleads 1,7x ·
  ForrandoBet 0,4x.
- Jornadas da Sorte Alta, "recuperado" total: de R$ 38.321,78 para R$ 12.414,99.
