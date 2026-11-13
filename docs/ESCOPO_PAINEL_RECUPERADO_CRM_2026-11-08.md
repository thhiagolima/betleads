# Escopo: painel "Recuperado pelo CRM" mais claro

**Data:** 08/11/2026
**Status:** proposto para validação
**Base:** [análise de 08/11](ANALISE_PAINEL_RECUPERADO_CRM_2026-11-08.md), com 5 especialistas (dados, atribuição, design de informação, UX writing e gestor de casa).
**Tela:** Central de Resultados › Visão geral (`src/components/crm-results/overview.tsx`) e as demais telas que usam os mesmos termos.

---

## 1. Problema

Os números do painel estão corretos para as regras do código. O problema é que ficam lado a lado medidas de grupos, janelas e bases diferentes, e o gestor tira conclusões erradas:

| O gestor vê | O gestor conclui | O que acontece |
|---|---|---|
| 70 cliques → 8 convertidos, "5,7% dos cliques" | 8/70 = 11%, então o número está errado | Os 8 depositaram hoje, mas vieram de cliques de até 7 dias. Os 5,7% vêm dos cliques de hoje (~4). |
| Visão ampla: 37 / R$ 1.811 contra CRM: 8 / R$ 2.197 | Uma das duas está errada | A ampla soma só o 1º depósito da volta (janela de 3 dias). O CRM soma todos os depósitos em 7 dias. |
| Retorno 7,9x ▲671% | O CRM melhorou muito | O custo é só o dos SMS de hoje (4,7 mil), mas os depósitos vieram dos ~59 mil SMS de ontem. |
| Custo ▼92% em verde | Economizamos | Foram enviados menos SMS. |
| "Fora da conta R$ 5.231" em letra pequena | Somar tudo (R$ 9,2 mil), ou achar que o sistema esconde receita | Jogadores já ativos excluídos de propósito. |

## 2. Objetivo

Em 5 segundos, o gestor responde, nesta ordem:

1. **Quanto o CRM trouxe?**
2. **Se paga?**
3. **De onde veio?**
4. **Está melhorando?**

Nenhum número da tela pode contradizer outro, e nenhum par de números pode parecer somável.

## 3. Fora do escopo

- Mudar a regra de atribuição por clique (janela de 7 dias, exclusão de quem depositou nas 48 h anteriores).
- Trocar o retorno sobre depósitos por GGR/NGR (registrado como evolução futura, item 9.3).
- Corrigir os SMS sem cliques desde 29/10. É outro incidente, mas afeta a leitura dos números (ver item 9.4).
- O sentido de "recuperado/convertido" em `alertas.tsx` e `players.tsx`, onde significa "voltou a logar" e "depositou". Fica registrado como conflito.

---

## 4. Glossário (obrigatório em todas as telas)

| Campo | Nome na tela | Não usar |
|---|---|---|
| `directRevenue` | **Recuperado pelo CRM** | "valor recuperado", "receita" |
| `directPlayers` | **jogadores que voltaram pelo link** (curto: "voltaram pelo link") | "convertidos" |
| `convertedClicks` | **cliques que viraram depósito** | "converteram" |
| `influencedPlayers` / `influencedRevenue` | **Reativações após SMS** / **1º depósito na volta** | "Recuperados", "visão ampla" |
| `directActivePlayers` / `directActiveRevenue` | **já estavam jogando** | "Fora da conta", "já ativos" |
| `sent` | **SMS enviados** | "SMS cobrados", "Envios" |
| `humanClicks` | **cliques no link** | "clique humano" |
| `clickRoi` | **Cada R$ 1 em SMS trouxe R$ X** (curto: "R$ X por R$ 1") | "Retorno 7,9x", "Retorno sobre o envio" |
| `costPerConversion` | **custo por jogador que voltou** | "custo por convertido" |
| inatividade | **2 dias sem depositar** | "48 h", "2+ dias" |

---

## 5. Fase 1: só front, sem migração (risco baixo)

### 5.1 Novo bloco principal (`overview.tsx`, linhas 82-179)

Os 3 cards de `Kpi` e os dois rodapés soltos são substituídos por um único card com três faixas.

```
Recuperado pelo CRM ⓘ                               [Parcial ⓘ]
Jogadores parados que clicaram no SMS e voltaram a depositar.
┌──────────────────────────────────────────────────────────────────┐
│ R$ 2.197,32                         Cada R$ 1 em SMS trouxe       │
│ 8 jogadores voltaram pelo link      R$ 7,90                       │
│ −R$ 1.403 vs sáb 01/11              R$ 278,60 em SMS              │
│                                     R$ 34,82 por jogador          │
│──────────────────────────────────────────────────────────────────│
│ De onde veio                                                     │
│ 4.722 SMS enviados → 70 cliques no link (1,5%)                   │
│ → 4 cliques viraram depósito (5,7%, ainda pode subir)            │
│──────────────────────────────────────────────────────────────────│
│ Depositaram depois de clicar: 40 jogadores · R$ 7.429            │
│ ████████░░░░░░░░░░░░░░░░░░░░░░                                   │
│ ■ Recuperado pelo CRM R$ 2.197 (8)  □ Já estavam jogando R$ 5.232 (32) ⓘ │
└──────────────────────────────────────────────────────────────────┘
```

**Regras:**

- **Valor herói:** o `directRevenue` aparece à esquerda, em `text-kpi` verde. Logo abaixo vem "N jogadores voltaram pelo link", seguido do delta (seção 5.3).
- **Coluna da direita:** "Cada R$ 1 em SMS trouxe" com o valor em `text-kpi-sm`. Abaixo, em texto pequeno, o custo em SMS e o custo por jogador.
  - Casa em outra moeda: "—" e o texto de `crossCurrencyNote`, como hoje.
  - Quando `smallSample` (menos de 5 jogadores), o retorno vem com a etiqueta "amostra pequena" e fica sem cor.
- **Funil "De onde veio":** a 3ª etapa passa a usar **`convertedClicks`**, que é do mesmo grupo dos cliques. O texto é "N cliques viraram depósito (X%)". Os 8 jogadores do dia **não entram no funil**: ficam só no herói.
  - Quando o período inclui algum dos últimos 7 dias, a taxa ganha o sufixo ", ainda pode subir".
- **Ponte "Depositaram depois de clicar":**
  - O total é `directRevenue + directActiveRevenue`, e os jogadores são `directPlayers + directActivePlayers`.
  - Barra empilhada com duas partes: Recuperado em verde (`success`) e Já estavam jogando em neutro (`muted`).
  - Tooltip de "Já estavam jogando": "Clicaram, mas tinham depositado nos 2 dias anteriores e iam depositar de qualquer forma. Por isso não entram no Recuperado pelo CRM nem no retorno. O efeito do SMS sobre eles aparece em Prova e método."
  - A ponte só aparece quando `directActivePlayers > 0`.
- **Fim dos rodapés:** "Fora da conta" e a linha do relógio saem da tela. O conteúdo do relógio vai para o badge **Parcial** (seção 5.4).
- **Tooltip do título:** "Conta quem estava há 2 dias ou mais sem depositar (ou nunca depositou), clicou no link do SMS e depositou em até 7 dias depois do clique. Soma todos os depósitos desses 7 dias. Cada jogador conta uma vez, no dia do primeiro depósito. Quem já estava jogando não entra. O custo considera só SMS."
- **Mobile:** uma coluna, nesta ordem:
  1. herói;
  2. linha "R$ 7,90 por R$ 1 · R$ 278,60 em SMS";
  3. funil em 3 linhas verticais (número à direita, % em cinza, sem chevrons);
  4. barra em largura total, com a legenda em 2 linhas.

### 5.2 Visão ampla sai da Visão geral

- O card de `overview.tsx:181-208` é removido.
- A aba "Teste de controle" (`TABS` em `search.ts`) passa a se chamar **"Prova e método"** e ganha uma seção **"Reativações após SMS"**, colocada antes do holdout:
  - **Subtítulo:** "Jogadores parados que voltaram a depositar até 3 dias depois de receber um SMS, com ou sem clique."
  - **Números:** reativações | 1º depósito na volta | custo por reativação. **Sem retorno próprio**: o `roi` sai da tela.
  - **Aviso fixo:** "Outra régua: conta voltas (não pessoas), só o 1º depósito e janela de 3 dias. Por isso pode ser maior em jogadores e menor em valor que o Recuperado pelo CRM. Não some os dois."
  - **Tooltip:** o texto atual de `overview.tsx:186`, com os termos do glossário.
- A série "recovered" do gráfico diário (`overview.tsx:261-262`) também sai da Visão geral e vai para a mesma aba.
- O parâmetro de URL `aba=controle` continua funcionando, para não quebrar links salvos.

### 5.3 Regras do delta (`shared.tsx`, `Delta`)

O `Delta` ganha props novas, e todas as chamadas da Visão geral passam a usá-las.

| Regra | Comportamento |
|---|---|
| Amostra mínima | Sem %. Mostra a diferença absoluta em cinza ("−R$ 1.403 vs sáb 01/11") quando o período atual ou o anterior tem `directPlayers < 20` ou `sent < 1.000`. |
| Teto | Acima de +200%, mostra "3,2x o anterior". |
| Métricas neutras | `tone="neutral"`: custo e volume de SMS ficam sempre em cinza. Verde e vermelho valem só para valor recuperado, jogadores e retorno. |
| Rótulo | A legenda solta "▲▼ comparado a 07/11" (`overview.tsx:96-101`) sai. Cada delta traz "vs {rótulo}". |
| Queda de envio | Se `sent` cair mais de 50% em relação ao período anterior, aparece um aviso âmbar acima do card: "Foram enviados 92% menos SMS que em {rótulo}. Custo e retorno mudam por isso." |

**Comparação de 1 dia** (`crm-results.functions.ts:105`): quando `days === 1` ("Hoje"/"Ontem"), o período anterior passa a ser **o mesmo dia da semana anterior** (`endOffset + 7`), em vez do dia anterior. O rótulo fica "vs sáb 01/11". Os demais períodos não mudam.

### 5.4 Badge "Parcial"

- Aparece no cabeçalho do bloco quando `to` está a menos de 7 dias de hoje.
- Tooltip: "Quem clicou tem até 7 dias para depositar. Os números deste período ainda podem subir."
- Substitui a linha do relógio (`overview.tsx:174-178`).

### 5.5 Consistência de termos

O glossário (seção 4) vale nos seguintes pontos:

| Arquivo | Trecho |
|---|---|
| `overview.tsx` | funil, Highlights e legendas (inclui a linha ~356 "convertidos") |
| `routes/index.tsx` | 141-147 (gasto/retorno) e 444 |
| `origins.tsx` | 34-52 |
| `tenant-comparison.tsx` | 63-134 e 222 |
| `central-results.tsx` | 168-179 (glossário da central) |
| `retention.tsx` | 126-139 |
| `shared.tsx` | 121 |
| `conversion-report.tsx` | 498-500 e 787 |
| `journeys/journeys-hub.tsx` | 838-849 |
| Tour e painel "?" do tutorial | conferir em `origin/main`: o branch `trabalho` não tem esses arquivos |
| CSV da Central (`downloadCsv`) | cabeçalhos com os novos nomes; manter a ordem das colunas |
| Recomendações (`lib/crm-recommendations`) | textos que citam "convertidos", "retorno" ou "recuperados" |

### 5.6 Testes e aceite da fase 1

- **Unitário do `Delta`:** amostra pequena (vira valor absoluto), teto de 200%, tom neutro e base zero.
- **Unitário de `periodBounds` com `days=1`:** o anterior cai em D-7.
- **Render da Visão geral** com os dados do print:
  - o funil mostra 4 (e não 8) na 3ª etapa;
  - a ponte soma 40 / R$ 7.429;
  - não existe "Recuperados (visão ampla)" na aba;
  - não existe "%" no delta do custo.
- **`grep` sem ocorrências** de "visão ampla", "Fora da conta", "SMS cobrados" e "convertidos" em `src/components/crm-results` e `src/routes/index.tsx`, exceto nos testes.
- Testar com casa em outra moeda (Los Hermanos, ARS) e com casa sem envios (`EmptyCard`).
- `npm run build` antes do merge (memória: vazamento de `*.server`).
- **Demo** (Casa Betleads): conferir visualmente em desktop e em 390 px.

---

## 6. Fase 2: retorno honesto em períodos curtos (risco médio, sem migração)

**Problema:** em períodos curtos, o retorno divide o custo do período pelos depósitos de cliques de até 7 dias antes.

- Para `days < 7`, o retorno e o custo por jogador passam a usar uma **janela móvel de 7 dias** que termina em `to`: custo D-6..D contra recuperado D-6..D.
  - Implementação: em `getCrmResults`, carregar as linhas da janela móvel com `loadResultRows`, como já é feito para o período anterior, e expor `rolling: { cost, directRevenue, directPlayers }`.
- **Na tela:** "Cada R$ 1 em SMS trouxe R$ X (últimos 7 dias)". O valor herói e os jogadores continuam sendo do período escolhido.
- **Aceite:** no dia do print, o retorno exibido usa o custo de 7 dias (~R$ 3,8 mil e não R$ 278), e o rótulo deixa a janela explícita.
- **Medir antes:** tempo do `getCrmResults` com uma consulta a mais (alvo: menos de 1,5 s em Sorte Alta, 30 dias). Lembrar do timeout de 8 s (memória: finance_send_usage).

## 7. Fase 3: alinhar Reativações com o Recuperado (risco médio, com migração)

O objetivo é que Reativações vire um **superconjunto** do Recuperado. Assim, os dois podem ser mostrados como faixa ("entre R$ X por clique e R$ Y por exposição").

- **Mesma regra de parado:** 2 dias sem depositar, medida no envio.
- **Janela de 7 dias:** igual ao Recuperado e ao holdout.
- **Pessoas únicas no período,** sem somar entre dias.
- **Valor:** todos os depósitos em 7 dias a partir da volta.

**Entrega:**
- nova função/coluna na RPC de resultados (migração nova, sem alterar migrations já aplicadas);
- backfill do período exibido;
- teste de banco garantindo `influenced >= direct` para jogadores e valor.

**Depois do aceite:** a Visão geral ganha uma linha discreta abaixo da ponte: "Contando também quem voltou sem clicar: até N jogadores e R$ Y. Ver Prova e método."

## 8. Fase 4: selo de prova (risco médio)

No cabeçalho do bloco principal:

- **Com holdout e amostra mínima:** "Efeito comprovado: +X p.p. de volta vs grupo de controle", com link para a aba Prova e método.
- **Sem amostra:** "Sem prova causal ainda: ative o grupo de controle nas jornadas."
- **Depois:** um fator de calibração (incremental ÷ atribuído) por jornada, na aba Prova e método.

---

## 9. Pontos em aberto

1. **Limiar de amostra:** 20 jogadores e 1.000 SMS para mostrar % no delta. O `MIN_CONVERSIONS = 5` atual continua valendo só para "amostra pequena" no retorno. Validar com o dono do produto.
2. **Barra empilhada com outra moeda:** os valores estão na moeda da casa, então funciona. O retorno continua "—".
3. **GGR/NGR:** hoje o retorno é "depósitos ÷ custo". Quando houver GGR por jogador, avaliar trocar e renomear.
4. **SMS sem cliques desde 29/10:** com 1,5% de clique, o funil pode refletir falha de entrega. Enquanto o incidente estiver aberto, avaliar um aviso na Central quando a taxa de clique da casa cair mais de 70% contra a média de 30 dias.

## 10. Ordem e esforço estimado

| Fase | Entrega | Esforço | Depende de |
|---|---|---|---|
| 1 | Bloco novo, aba Prova e método, delta, Parcial, glossário, tutorial | 1,5-2 dias | — |
| 2 | Retorno em janela móvel | 0,5-1 dia | 1 |
| 3 | Reativações alinhadas + faixa | 2 dias | 1 |
| 4 | Selo de holdout | 1 dia | 1 (3 ajuda) |

As fases 1 e 2 podem ir no mesmo deploy. A fase 3 exige aplicar a migração em produção, com aprovação explícita.
