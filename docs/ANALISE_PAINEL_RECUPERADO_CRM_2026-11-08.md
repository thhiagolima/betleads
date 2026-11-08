# Análise do painel "Recuperado pelo CRM" (Central de Resultados › Visão geral)

Data: 2026-11-08. Componente: `src/components/crm-results/overview.tsx` (linhas 64-208).
Especialistas consultados: analista de dados, especialista em atribuição de CRM, designer de informação, UX writer e gestor de casa (persona + PM). Nenhum código alterado.

Print de referência (período 1 dia, 08/11 vs 07/11): 4.722 SMS → 70 cliques → 8 convertidos, R$ 2.197,32 ▼39%; custo R$ 278,60 ▼92%; R$ 34,82/convertido ▼69%; retorno 7,9x ▲671%; "fora da conta" 32 ativos / R$ 5.231,68; visão ampla 37 / R$ 1.811,32 / R$ 7,53 / 6,5x.

## 1. Por que confunde: os números estão certos, mas lado a lado se contradizem

| # | Problema | Gravidade | Causa no código |
|---|---|---|---|
| 1 | O funil sugere que os 8 convertidos saíram dos 70 cliques, mas "5,7% dos cliques" equivale a ~4 cliques. O gestor calcula 8/70 = 11% e conclui que o número está errado. | Alta | Os 8 são primeiros depósitos **do dia**, de cliques de até 7 dias antes (`crm-results.ts:142-154`). Os 5,7% são da coorte de cliques do dia (`crm-results.ts:124`). |
| 2 | 37 "recuperados" valem R$ 1.811 e 8 valem R$ 2.197, embora a ampla "inclua boa parte". | Alta | O CRM soma **todos** os depósitos em 7 dias. A ampla soma só o **depósito de retorno**, numa janela de 3 dias, e conta retornos, não pessoas (`20261129100000_supabase_consumo_p0.sql:140, 161-195`). |
| 3 | Deltas de 1 dia contra 1 dia (▼92%, ▲671%) são ruído: com n=8, o IC 95% vai de ~3 a 16. | Alta | `Delta` não tem mínimo de amostra (`shared.tsx:46-56`). Existe `smallSample`, mas ele não é usado na visão geral. |
| 4 | O retorno de 7,9x está inflado. O custo é o dos SMS do dia (4,7 mil), mas os depósitos vêm de cliques de SMS de dias anteriores (07/11 teve ~59 mil SMS). Quando o volume cai, o retorno sobe sozinho, e vice-versa. | Alta | `crm-results.ts:125-126`. |
| 5 | "Custo em SMS ▼92%" aparece em verde, mas a queda só significa que foram enviados menos SMS. | Média | `better="low"` (`overview.tsx:139`). |
| 6 | "Fora da conta" mostra o maior valor da tela (R$ 5.231) em letra pequena. O gestor ou soma tudo (R$ 9,2 mil) ou acha que o CRM esconde receita. | Média | `overview.tsx:165-171`. |
| 7 | Dois "retornos" (7,9x e 6,5x) e dois nomes quase iguais ("Recuperado" / "Recuperados"). | Média | Texto. |
| 8 | A mesma regra é explicada em 3 lugares (subtítulo, tooltip e rodapés), com prazos espalhados (2+ dias, 48 h, 7 dias, 3 dias). | Baixa | Texto. |
| 9 | O retorno é calculado como depósitos ÷ custo, mas o mercado usa GGR/NGR. O rótulo deveria deixar claro que se trata de depósitos. | Baixa | Definição. |

Âncora da janela de 7 dias: começa no clique quando o horário do clique é conhecido. Caso contrário, começa no envio (`conversion-attribution.server.ts:42`). O texto "depositaram em até 7 dias" é aceitável.

Contexto: o problema "SMS sem cliques desde 10-29" ainda está aberto. O CTR de 1,5% pode refletir uma falha de entrega, e não o desempenho do CRM.

## 2. Consenso dos especialistas

1. **Uma métrica herói só:** "Recuperado pelo CRM" (por clique, sem os ativos). É auditável e conservadora.
2. **A visão ampla sai da Visão geral.** Ela vai para uma aba "Prova e método", junto com o Teste de controle. Lá deixa de ter um "retorno" próprio. Só pode voltar à Visão geral como faixa ("entre R$ X e R$ Y") depois de alinhada: mesma regra de "parado", janela de 7 dias, pessoas únicas e todos os depósitos. Com isso ela vira um superconjunto matemático do herói.
3. **"Já ativos" vira uma ponte visível em vez de rodapé:** depositaram após clicar 40 / R$ 7.429 → já jogavam 32 / R$ 5.232 → **recuperados 8 / R$ 2.197**. Mostrar como barra empilhada com cor neutra na parte excluída.
4. **Custo deixa de ser KPI de peso igual.** Vira uma linha de apoio ao retorno.
5. **Regras de delta:**
   - sem % quando houver menos de 20 convertidos ou menos de 1.000 SMS; nesses casos, mostrar a diferença absoluta em cinza;
   - no filtro de 1 dia, comparar com o mesmo dia da semana anterior;
   - limitar a +200%;
   - verde/vermelho só para valor e retorno; custo e volume sempre em cinza;
   - alerta explícito quando o envio cair mais de 50%.
6. **Período padrão:** últimos 7 dias completos vs 7 anteriores. 1 dia não serve para uma métrica com janela de 7 dias. "Hoje" fica só para a parte operacional (envio e cliques).
7. **Badge "Parcial"** quando o período incluir os últimos 7 dias. Ele substitui a linha do relógio.

## 3. Layout recomendado (designer: proposta A com duas ideias da B)

```
[ Resultado | Prova e método ]                        Parcial ⓘ
Recuperado pelo CRM ⓘ
┌──────────────────────────────────────────────────────────────────┐
│ R$ 2.197,32                        Cada R$ 1 em SMS trouxe R$ 7,90│
│ 8 jogadores parados voltaram       R$ 278,60 em SMS · R$ 34,82/jog│
│ −R$ 1.403 vs sáb 01/11 (cinza)                                    │
│──────────────────────────────────────────────────────────────────│
│ De onde veio: 4.722 SMS → 70 cliques (1,5%) → 4 já depositaram    │
│               (5,7% dos cliques do período, ainda subindo)        │
│──────────────────────────────────────────────────────────────────│
│ Depositaram após clicar  ███████░░░░░░░░░░░░░░░░░░░  R$ 7.429     │
│   ■ recuperados R$ 2.197 (8)   □ já jogavam R$ 5.232 (32) ⓘ       │
└──────────────────────────────────────────────────────────────────┘
```

- O valor fica à esquerda, onde o olho entra. Isso deixa a tela coerente com o `CrmCard` da home (`src/routes/index.tsx:128-170`).
- "Cada R$ 1 em SMS trouxe R$ 7,90" se lê sem precisar saber o que é "x".
- No mobile: uma coluna, funil em 3 linhas verticais, barra em largura total e as abas como segmented control.

## 4. Textos (UX writer)

Glossário, para usar igual em todas as telas:

| Conceito | Nome |
|---|---|
| directRevenue | **Recuperado pelo CRM** |
| directPlayers | **voltaram pelo link** |
| influenced* | **Reativações após SMS** (some a palavra "recuperado", então ninguém soma as duas) |
| sent | **SMS enviados** |
| humanClicks | **Cliques no link** |
| directActive | **Já estavam jogando** |
| roi | **Cada R$ 1 em SMS trouxe R$ X** |
| inatividade | sempre "2 dias sem depositar" (não usar "48 h") |

- Subtítulo: "Jogadores parados que clicaram no SMS e voltaram a depositar."
- Tooltip do título: "Conta quem estava há 2 dias ou mais sem depositar (ou nunca depositou), clicou no link do SMS e depositou em até 7 dias. Soma todos os depósitos desses 7 dias. Cada jogador conta uma vez, no dia do primeiro depósito. Quem já estava jogando não entra."
- Ponte (tooltip de "já jogavam"): "32 jogadores que já estavam jogando também clicaram e depositaram R$ 5.231,68. Eles iam depositar de qualquer forma, por isso não contam. O efeito do SMS sobre eles aparece em Prova e método."
- Reativações (na aba): o valor passa a se chamar "1º depósito na volta", com a explicação: "por isso pode ficar menor que o Recuperado pelo CRM".

Arquivos que precisam mudar para manter consistência:
- `overview.tsx`
- `origins.tsx` (34-52)
- `tenant-comparison.tsx` (63-134, 222)
- `central-results.tsx` (168-179)
- `retention.tsx` (126-139)
- `shared.tsx` (121)
- `conversion-report.tsx` (498-500, 787)
- `journeys-hub.tsx` (838-849)
- `routes/index.tsx` (141-147, 444)
- tour e painel "?" do tutorial

## 5. Plano em fases

| Fase | O que entra | Risco |
|---|---|---|
| **1. Só front** | Novos textos e glossário; visão ampla movida para a aba; ponte "já jogavam"; custo rebaixado; regras de delta (amostra mínima, cor neutra em custo/volume, mesmo dia da semana); badge "Parcial"; funil com o numerador da mesma coorte (`convertedClicks`); tutorial atualizado. | Baixo |
| **2. Período e coorte** | Padrão de 7 dias completos; retorno e custo por convertido em janela móvel de 7 dias (custo D-7..D vs receita D-7..D) quando o filtro for curto. | Médio (RPC) |
| **3. Alinhar a visão ampla** | Mesma janela (7 d), pessoas únicas e todos os depósitos; volta como faixa "entre X e Y" na Visão geral. | Médio (SQL + migration) |
| **4. Prova** | Selo de holdout no herói: "efeito comprovado +X p.p. vs controle" ou "ative o grupo de controle". | Médio |
