# Auditoria e escopo — gatilhos de entrada e saída, sobreposição e frequência das jornadas

**Data:** 15/10/2026
**Status:** auditoria concluída; escopo proposto para validação
**Modo:** somente análise. Nenhuma alteração de código, configuração ou dados foi feita.
**Perspectivas:** UX, dev sênior, QA, gerente de projeto e red team. Cada item tem
reavaliação individual e proposta de melhoria.

**Fontes confrontadas:**

| Fonte | Papel |
|---|---|
| `docs/FLUXO CRM.docx` | **especificação de negócio** (o que o cliente espera) |
| [ESCOPO_AUDITORIA_JORNADAS_2026-10-07.md](ESCOPO_AUDITORIA_JORNADAS_2026-10-07.md) | auditoria anterior do motor |
| [ESCOPO_JORNADAS_CRUZADAS_E_PROGRESSAO_NIVEIS.md](ESCOPO_JORNADAS_CRUZADAS_E_PROGRESSAO_NIVEIS.md) | regras de família, prioridade e contato |
| Código (`src/lib/journey*.ts`, `journeys.server.ts`, migrations) | comportamento implementado |
| Banco de produção (leitura agregada, 15/10/2026) | comportamento real |

Este escopo é separado da [Central de Resultados](ESCOPO_CENTRAL_RESULTADOS_CRM_2026-10-15.md)
e a antecede: a regra de crédito único da Central depende de cada jogador estar em uma
régua de categoria por vez.

---

## 1. Decisão executiva

As **mensagens** das jornadas seguem o FLUXO CRM (textos, D1–D5 e loop D4/D5). As
**regras ao redor** delas não seguem. O resultado é contato excessivo, matrículas que
nunca saem e jogadores em réguas contraditórias.

### Três problemas exigem ação imediata (antes de qualquer outra entrega)

1. **"PIX gerado e não pago" dispara uma mensagem por PIX, sem teto.** Cada PIX pendente
   abre uma matrícula própria. Hoje um jogador com 16 PIX pendentes recebeu **16 SMS
   entre 14h41 e 14h43**, depois de 16 tentativas com erro entre 12h55 e 13h59. As 16
   matrículas seguem abertas em loop diário sem fim. Outros jogadores receberam 4, 5 e 6
   SMS da mesma jornada hoje.
2. **Não existe teto de mensagens por jogador.** A tabela `journey_contact_limits`
   (máximo em 24 h e em 7 dias) está **vazia**, então a proteção existe no código, mas
   está desligada. Em 14/10, 215 jogadores receberam 4 ou mais SMS de jornada no mesmo
   dia (máximo 9); em 15/10, 48 (máximo 16).
3. **"Boas-vindas ao primeiro depósito (FTD)" não existe no FLUXO CRM.** Mesmo assim,
   está **ativa** em ForrandoBet e PixReals. Na Sorte Alta está pausada, mas segura 7.818
   jogadores (95% dos depositantes, matriculados em massa em 14/10), com 5.743 matrículas
   "ativas" congeladas.

### Causa de fundo

O motor trata cada jornada como independente. As faixas de inatividade não são
exclusivas, a saída só é avaliada quando um passo roda, matrículas pausadas nunca saem e
a ativação matricula a base histórica inteira. O documento de regras cruzadas já pedia
exclusividade, teto por pessoa e retomada controlada, mas isso não foi implementado ou
não foi configurado.

---

## 2. Especificação de referência (FLUXO CRM)

Regras extraídas do documento e numeradas para rastreio:

| ID | Regra do FLUXO CRM |
|---|---|
| F-1 | Cada régua: 1 mensagem por dia, D1 a D5; a partir do D6, loop alternando D4 e D5 até o objetivo |
| F-2 | **Virada de categoria:** ao mudar de status ou nível, a régua anterior **para imediatamente** e a nova começa no D1 |
| F-3 | Cadastro e onboarding: objetivo 1º depósito; loop até depositar |
| F-4 | PIX gerado e não pago: disparo imediato e reforço **diário enquanto o PIX estiver ativo sem pagamento** |
| F-5 | Esfriando: a partir de 2 dias sem depositar |
| F-6 | Dormindo: a partir de 7 dias sem depositar |
| F-7 | 30 dias sem depósito |
| F-8 | Níveis Bronze → Black VIP: régua diária com meta de subir de nível (Black: manutenção) |
| F-9 | Cashback: no **D+1 após saldo negativo**, **substitui o SMS VIP do dia** |

**Interpretação adotada (a validar, decisão D-1 da seção 8):** F-2 e F-9 implicam que o
jogador recebe **no máximo uma mensagem de régua por dia**. As faixas de status
(cadastro, esfriando, dormindo, 30 dias) são mutuamente exclusivas. O documento não diz
se uma régua de nível corre em paralelo com uma de status; essa é a principal decisão de
produto pendente.

---

## 3. Inventário real (banco, 15/10/2026)

- As três casas em operação (Sorte Alta, ForrandoBet, PixReals) têm **as mesmas 12
  jornadas clonadas**, todas com janela 08h–22h, todos os dias, limite de 5.000 por dia e
  jornada, e cooldown de 0 h (exceto Boas-vindas e Saque pago, com 72 h).
- Prioridade (1 = mais alta) e políticas configuradas:

| Prioridade | Jornada | Gatilho | Família / política | Saída | Spec? |
|---:|---|---|---|---|---|
| 1 | PIX gerado e não pago | `pix_gerado_nao_pago`, uma matrícula por PIX | aquisicao / pause_lower | depósito, 1º depósito | F-4 (parcial) |
| 2 | Cashback — Reativação | `cashback_pago` (pago hoje) | cashback_vip / pause_lower | depósito | F-9 (**diverge**) |
| 3 | 30 dias sem depósito | inatividade ≥ 720 h | inatividade_deposito / pause_lower | depósito | F-7 |
| 4 | Dormindo 7d | inatividade ≥ 168 h | inatividade_deposito / pause_lower | depósito, > 720 h | F-6 |
| 4 | Boas-vindas FTD | `primeiro_deposito` | — / coexist | depósito | **fora da spec** |
| 4 | Saque pago (express) | `saque_pago` | — / coexist | depósito | fora da spec original; **mantida pelo cliente (D-5) e redefinida (D-8)** |
| 5 | Esfriando 2d | inatividade ≥ 48 h | inatividade_deposito / pause_lower | depósito, > 168 h | F-5 |
| 6 | Nível Bronze…Black | `nivel_alterado` | progressao_niveis / exclusive | mudou de nível | F-8 |
| 7 | Cadastrou e não depositou | `cadastrados_sem_deposito` | aquisicao / pause_lower | depósito, 1º depósito | F-3 |

- **Entrada em massa em 14/10 (Sorte Alta):** Cadastrou 12.620 · Boas-vindas 7.890 ·
  Esfriando 6.954 · Dormindo 5.363 · 30 dias 641. Em 15/10: PIX 1.217 e Saque 203.
- **Matrículas abertas:** 34.342, de 20.789 jogadores (99,7% da base de 20.862).

---

## 4. Matriz de conformidade por jornada

Legenda: ✅ conforme · ⚠️ parcial · ❌ não conforme.

| Jornada | Textos e cadência (F-1) | Entrada | Saída e virada (F-2) | Sobreposição | Veredito |
|---|---|---|---|---|---|
| Cadastrou e não depositou | ✅ | ⚠️ backfill da base histórica inteira (12.620, inclusive cadastros antigos) | ⚠️ 12 jogadores que já depositaram seguem matriculados (saída tardia) | ✅ | ⚠️ |
| PIX gerado e não pago | ✅ textos; ❌ 1 matrícula por PIX | ❌ uma por PIX; reconfere "qualquer PIX pendente", não o PIX de origem | ❌ 326 matriculados já depositaram após a entrada; o loop não tem fim nem expiração do PIX | ❌ até 16 envios simultâneos | ❌ |
| Esfriando 2d | ✅ | ❌ sem teto superior: quem está inativo há 30 dias também entra | ❌ **5.381** matriculados já passaram de 7 dias (4.311 pausados por prioridade nunca saem) | ❌ 5.172 também em Dormindo | ❌ |
| Dormindo 7d | ✅ | ❌ sem teto superior | ❌ 488 já passaram de 30 dias | ❌ 487 também em 30 dias | ❌ |
| 30 dias | ✅ | ⚠️ backfill | ✅ | ❌ 587 também em Esfriando | ⚠️ |
| Níveis (5) | ✅ | ❌ só entra quem **muda** de nível depois da ativação, sem backfill: ~490 jogadores contra 8.197 depositantes | ✅ `level_changed` funciona (outbox) | ⚠️ prioridade 6, abaixo das faixas de inatividade (o escopo de regras cruzadas previa 2) | ⚠️ |
| Cashback | ✅ texto | ❌ gatilho "cashback pago hoje", e não "D+1 após saldo negativo" | ✅ | ❌ não substitui o SMS de nível do dia | ❌ |
| Boas-vindas FTD | — fora da spec; 4 SMS de texto quase idêntico em ~3 h | ❌ backfill de 7.890 depositantes antigos | ❌ 598 já depositaram de novo | ❌ 6.722 também em Esfriando | ❌ remover ou redefinir |
| Saque pago | — fora da spec; 4 SMS em 2 h | ✅ por saque, `start_after` definido | ✅ | ⚠️ coexiste e escapa da arbitragem (express) | ⚠️ validar com o cliente |

---

## 5. Achados

Formato: **evidência → impacto → reavaliação → melhoria**. Severidade: **S0** = dano ao
jogador ou ao custo acontecendo agora; **S1** = regra de negócio violada; **S2** =
capacidade ou robustez faltando; **S3** = qualidade.

### 5.1 Entrada

#### E-01 · PIX abre uma matrícula por PIX, sem teto nem expiração — S0
- **Evidência:** `entry_rules.reentry = per_occurrence`; a `entry_key` é o id do PIX
  (`journey-policy.ts:86-99`). `stillMatchesJourneyEntry` aceita qualquer PIX pendente,
  não o PIX de origem (`journeys.server.ts:122-137`). O loop volta ao D3 sem limite. No
  banco: 1 jogador com 16 matrículas e 16 SMS em 2 minutos; 103 pares jogador × jornada
  repetidos.
- **Impacto:** spam ao jogador, custo e risco de denúncia e bloqueio da rota de SMS.
- **Reavaliação:** confirmado no código e no banco. Contraria F-4 ("reforço diário",
  singular).
- **Melhoria:** uma matrícula por jogador; um novo PIX **reinicia** a mesma matrícula. A
  saída ocorre quando **todos** os PIX do jogador foram pagos ou expiraram (prazo de
  expiração do PIX configurável, sugestão: 24–72 h). O loop tem limite de iterações.

#### E-02 · Ativação matricula toda a base histórica — S1
- **Evidência:** o scanner cria um job de backfill por jornada ativa e varre todos os
  jogadores (`journey-scanner.server.ts:471-494`). `trigger_config.start_after` não pode
  ser definido pela interface. No banco: 33.468 matrículas criadas em 14/10.
- **Impacto:** "Cadastrou e não depositou" atinge cadastros de meses atrás; "Boas-vindas
  FTD" atinge depositantes antigos; a primeira ativação gera um pico de envio.
- **Reavaliação:** confirmado. Para faixas de inatividade o backfill pode ser desejado
  (é a base a recuperar); para eventos (FTD, cadastro) não.
- **Melhoria:** na ativação, escolha explícita entre "apenas novos casos a partir de
  agora" e "incluir base atual (N jogadores)", com prévia de contagem e custo estimado.
  Jornadas de evento usam "apenas novos" como padrão.

#### E-03 · Faixas de inatividade sem teto superior — S1
- **Evidência:** o gatilho `inactivity` só verifica `campo ≤ agora − horas`
  (`journey-policy.ts:67-84`). Um jogador inativo há 40 dias satisfaz Esfriando (48 h),
  Dormindo (168 h) e 30 dias (720 h) ao mesmo tempo.
- **Impacto:** viola F-2 e F-5–F-7; gera as 5.172 sobreposições Esfriando × Dormindo.
- **Reavaliação:** confirmado no código e no banco.
- **Melhoria:** faixa com intervalo fechado [mín, máx) definido no gatilho (Esfriando 48–168
  h; Dormindo 168–720 h; 30 dias ≥ 720 h). A entrada só ocorre na faixa certa.

#### E-04 · Níveis só recebem quem muda de nível depois da ativação — S1
- **Evidência:** a entrada em nível vem apenas do outbox de transição; não há backfill
  (`level_transition_outbox.sql:178-187`); o scanner ignora `nivel_alterado`. No banco:
  ~490 jogadores em jornadas de nível contra 8.197 depositantes.
- **Impacto:** F-8 descreve régua diária para quem está em cada nível; hoje 94% dos
  depositantes nunca a recebem.
- **Reavaliação:** confirmado. Pode ser intencional (evitar volume), mas não está
  documentado. Depende da decisão D-1.
- **Melhoria:** opção de backfill de nível com prévia de volume, condicionada à decisão
  sobre a convivência entre nível e status.

#### E-05 · Cashback diverge da regra — S1
- **Evidência:** `cashback_pago` = cashback pago hoje (`triggers.server.ts:139-153`). Não
  há verificação de saldo negativo, atraso D+1 nem substituição do SMS de nível.
- **Reavaliação:** confirmado (F-9 não implementada). Fluxos legados de cashback ainda
  podem enviar em paralelo (`webhook-process.server.ts:476-560`); verificar se há fluxo
  legado ativo em cada casa.
- **Melhoria:** gatilho "saldo negativo no dia anterior", disparo no D+1 dentro da
  janela, e regra de substituição: no dia do cashback, a régua de nível é adiada.

#### E-07 · Saque pago abre uma matrícula por saque e fura o teto — S0
- **Evidência:** `reentry = per_occurrence`, `entry_key` = id do saque, `express = true`
  (ignora cooldown, teto de contato e arbitragem). Cada saque inicia a sequência inteira
  (4 SMS em ~2 h). No banco (Sorte Alta, desde 15/10): 98 jogadores com 1 matrícula, 28
  com 2, 12 com 3 e 5 com 4 a 7. SMS da jornada por jogador: 4 jogadores com 8 e **1 com
  14**. ForrandoBet: 3 jogadores com 3 matrículas.
- **Impacto:** mesmo padrão do PIX (E-01), agravado por escapar do teto. O teto de 2/dia
  (C-01) **não** contém esta jornada.
- **Reavaliação:** confirmado no banco. Contraria as decisões D-2 e D-8.
- **Melhoria (D-8):** a jornada deixa de ser sequência. Cada saque gera 1 SMS sorteado
  entre as mensagens cadastradas, com teto de 4 por jogador por dia, orçamento separado
  do padrão e matrícula de execução única (detalhe na seção 8.1, item 5). Até o código,
  reduzir a jornada a um único passo de SMS limita o envio a 1 mensagem por saque.

#### E-06 · A reavaliação de entrada não reconfere o público — S2
- **Evidência:** `stillMatchesJourneyEntry` ignora a audiência (`journeys.server.ts:378-403`).
- **Melhoria:** reconferir audiência, consentimento e bloqueio a cada passo.

### 5.2 Saída e virada de categoria

#### S-01 · A saída só é avaliada quando um passo roda — S1
- **Evidência:** `shouldExit` é chamado só no claim do dispatcher (`journeys.server.ts:496-520`);
  nenhum webhook encerra matrículas. Com espera de 24 h, a saída atrasa até 24 h.
- **Impacto:** viola F-2 ("para imediatamente"). No banco: 598 matriculados de
  Boas-vindas, 326 de PIX, 81 de Bronze e outros já depositaram depois de entrar e
  continuam abertos.
- **Reavaliação:** confirmado. O risco de envio indevido é menor, porque a saída é checada
  antes de enviar, mas as contagens, a fila, a prioridade e os relatórios ficam errados.
- **Melhoria:** saída por evento. Depósito, login e mudança de nível encerram na hora as
  matrículas afetadas (pelo mesmo padrão outbox já usado para nível) e iniciam a régua
  da nova categoria (F-2).

#### S-02 · Matrícula pausada por prioridade nunca sai — S1
- **Evidência:** `paused_by_priority` não é reivindicada pelo dispatcher, então
  `shouldExit` e `inactivity_threshold` nunca rodam para ela. A retomada só ocorre quando
  a jornada vencedora termina para aquele jogador (`resume_priority_paused_journeys`),
  mas as vencedoras estão em loop infinito. No banco: 4.311 matrículas de Esfriando
  pausadas que já passaram de 7 dias e nunca vão sair.
- **Reavaliação:** confirmado no código e no banco.
- **Melhoria:** um job periódico reavalia matrículas pausadas (saída e elegibilidade) e
  encerra as que perderam a faixa. Com faixas exclusivas (E-03), o caso some na origem.

#### S-03 · Jornada pausada congela matrículas indefinidamente — S1
- **Evidência:** pausar só altera a linha da jornada (`journeys.functions.ts:667-671`); as
  matrículas ficam ativas ou aguardando; o claim as ignora; na reativação, todo o atraso
  dispara de uma vez. No banco: Boas-vindas pausada com 5.743 "ativas" desde 14/10.
- **Impacto:** a fila e os indicadores mentem; ao reativar, há um pico de envio de
  mensagens velhas (só PIX e saque têm a regra de mensagem obsoleta).
- **Melhoria:** ao pausar, mostrar o impacto (N jogadores) e escolher entre "manter e
  retomar do ponto" ou "encerrar matrículas". Na retomada, descartar passos atrasados
  além de X horas e respeitar teto e janela.

#### S-04 · A flag "sai ao mudar de nível" na interface não faz nada — S3
- **Evidência:** `shouldExit` ignora `level_changed` (`journey-editor.tsx:601`); a saída
  por nível é aplicada à família inteira pelo SQL.
- **Melhoria:** remover a flag ou ligá-la de verdade, com texto explicando a regra.

#### S-05 · `inactivity_threshold` mede sempre `ultimo_deposito` — S3
- **Evidência:** `journeys.server.ts:313-314` ignora o `field` configurado no gatilho.
- **Melhoria:** usar o mesmo campo da entrada.

### 5.3 Sobreposição e arbitragem

#### O-01 · Política `exclusive` e família não são aplicadas — S1
- **Evidência:** a arbitragem (`reserve_journey_delivery`,
  `20261015122000_express_journeys.sql:151-200`) só compara prioridade entre envios do
  mesmo canal **devidos no mesmo instante**. `conflict_family` não é consultada;
  `exclusive` age como `coexist`. Só a família de níveis tem exclusividade, e via SQL
  próprio.
- **Impacto:** sobreposições no banco: Boas-vindas × Esfriando 6.722; Dormindo ×
  Esfriando 5.172; Boas-vindas × Dormindo 5.165; 30 dias × Esfriando 587; 30 dias ×
  Dormindo 487.
- **Reavaliação:** confirmado. O escopo de regras cruzadas pedia exatamente o contrário
  ("um jogador nunca permanece simultaneamente em duas jornadas da família").
- **Melhoria:** família exclusiva aplicada **na entrada**: entrar numa jornada da família
  encerra a anterior (`category_changed`), como já ocorre com níveis. Vale para
  `inatividade_deposito` e para a família de aquisição (cadastro × PIX, a decidir).

#### O-02 · A arbitragem só olha envios simultâneos — S2
- **Evidência:** competidores precisam estar devidos agora e no mesmo canal. Duas réguas
  com horários diferentes no mesmo dia enviam as duas.
- **Impacto:** jogador recebe Dormindo às 10h e Esfriando às 15h no mesmo dia.
- **Melhoria:** arbitragem por **dia e jogador**: um "orçamento diário de régua" (decisão
  D-2), com eventos transacionais (PIX, saque, cashback) consumindo prioridade.

#### O-03 · Prioridades contrariam o escopo de regras cruzadas — S2
- **Evidência:** níveis com prioridade 6, abaixo das faixas de inatividade (3–5); o escopo
  de 07/10 e o preset do editor usam 2 (`journey-editor.tsx:538-543`).
- **Reavaliação:** como as casas foram clonadas com 6, a decisão parece ter sido
  operacional, mas não está registrada.
- **Melhoria:** tabela de prioridades única, documentada e validada pelo cliente (decisão
  D-3).

#### O-04 · Jornadas "express" escapam da arbitragem — S2
- **Evidência:** Saque pago (`express = true`) não entra na disputa; ele mandou 233 SMS
  em dias de 3 ou mais mensagens para 58 jogadores.
- **Melhoria:** express pode furar a fila de prioridade, mas não o teto diário de contato.

### 5.4 Frequência de contato e custo

#### C-01 · Teto de mensagens por jogador desligado — S0
- **Evidência:** `journey_contact_limits` está vazia (o código existe em
  `express_journeys.sql:312-365`). Cooldown de 0 h na maioria das jornadas.
- **Impacto (SMS de jornada por jogador por dia):** em 14/10, 2.919 jogadores, 980 com 2
  ou mais, 215 com 4 ou mais, máximo 9. Em 15/10, 10.703 jogadores, 444 com 2 ou mais, 48
  com 4 ou mais, máximo 16. Nos dias com 3 ou mais SMS, a composição é Dormindo 515,
  Esfriando 486, 30 dias 295, Saque 233, Cadastro 169 e PIX 77 SMS.
- **Reavaliação:** confirmado. É a falha que mais expõe a operação (reclamação, opt-out,
  bloqueio de rota).
- **Melhoria:** configurar já um teto padrão por casa (sugestão: no máximo 2 SMS por dia e
  10 por 7 dias por jogador, somando jornadas e campanhas) e tornar o teto obrigatório na
  criação do tenant.

#### C-02 · Custo estrutural de régua infinita sobre a base inteira — S1
- **Evidência:** todas as réguas de categoria fazem loop diário sem fim (F-1), e 99,7% da
  base está em jornada.
- **Impacto estimado (Sorte Alta):** em regime, cerca de 1 SMS por jogador por dia ≈ 20
  mil SMS/dia × R$ 0,12 ≈ **R$ 2,4 mil/dia (~R$ 72 mil/mês)**, antes de campanhas. Os
  saldos de crédito foram elevados manualmente para 99.999.999 e não freiam o gasto (R-09
  da Central).
- **Reavaliação:** é coerente com o FLUXO CRM, mas a especificação não fala em custo nem em
  fim. É uma decisão de negócio (D-4), não um bug.
- **Melhoria:** limite de iterações do loop por faixa (por exemplo, Dormindo para após 30
  dias e passa a 1 SMS por semana), teto diário de gasto por casa e alerta de consumo.

#### C-03 · ~~Execuções "puladas" sem motivo registrado~~ → jogadores sem consentimento seguem em loop — S2 (reavaliado)
- **Reavaliação (15/10, durante a P0):** o achado original estava **errado**. O motivo é
  gravado na coluna `provider` (`consent`, `exit_policy`), que a consulta da auditoria não
  leu. Sorte Alta: 8.120 execuções puladas por **consentimento revogado** e 7 por regra de
  saída.
- **Problema real:** quem revogou o consentimento continua matriculado e, em loop, é
  reprocessado todo dia só para ser pulado de novo (carga sem efeito, fila inflada).
- **Melhoria (P1):** consentimento revogado no canal da régua encerra a matrícula
  (`exit_reason = 'consent_revoked'`); a reentrada só ocorre se o consentimento voltar.
  Normalizar o motivo de pulo num campo próprio é melhoria de legibilidade (P3), não um bug.

### 5.5 Governança e operação

#### G-01 · Jornadas fora da spec clonadas para todas as casas — S1
- **Evidência:** Boas-vindas FTD e Saque pago existem e estão ativas em ForrandoBet e
  PixReals; nenhuma das duas está no FLUXO CRM.
- **Melhoria:** inventário de jornadas por casa aprovado pelo cliente; clonagem só a partir
  de um modelo versionado e aprovado.

#### G-02 · Código morto com regra paralela de matrícula — S3
- **Evidência:** `enrollEligibleJourneyPlayers` (`journeys.server.ts:140-248`) duplica o
  scanner.
- **Melhoria:** remover.

#### G-03 · Lacunas de teste — S2
- **Evidência:** não há teste para `shouldExit`, `inactivity_threshold`, loop,
  `resume_priority_paused_journeys`, família exclusiva nem teto de contato.
- **Melhoria:** ver a matriz da seção 6.3.

### 5.6 Coberturas que funcionam (preservar)

- Cobertura das faixas de inatividade: Esfriando 1.404/1.455, Dormindo 4.774/4.855 e
  perdidos 30+ 680/692 estão na jornada certa e não pausados.
- Transição de nível pelo outbox: atômica, encerra o nível anterior, sem duplicar.
- Regra de mensagem obsoleta para PIX e saque; janela 08h–22h em horário de Brasília;
  limite diário por jornada; textos e loops fiéis ao FLUXO CRM.

---

## 6. Perspectivas complementares

### 6.1 UX
- **Mapa de jornadas por casa:** uma tela mostra as réguas como faixas exclusivas
  (cadastro → ativo → esfriando → dormindo → 30 dias) e a camada de nível, com quantos
  jogadores há em cada uma e para onde migram.
- **Prévia antes de ativar:** "vai matricular N jogadores, ~X SMS/dia, ~R$ Y/dia"; escolha
  entre "só novos" e "incluir base".
- **Pausa com impacto:** o diálogo mostra jogadores afetados e o que acontece com eles.
- **Ficha do jogador:** "réguas atuais", "próximo envio", "por que ficou pausado" e
  "mensagens recebidas nos últimos 7 dias".
- **Avisos de conflito no editor:** "esta jornada se sobrepõe a Dormindo para 5.172
  jogadores".
- Linguagem de negócio: "faixa", "régua", "nível"; sem `entry_key` ou
  `paused_by_priority` na interface.

### 6.2 Dev sênior — modelo alvo
- **Estado do jogador em dois eixos exclusivos**, calculado por evento:
  - *Ciclo de vida:* cadastro sem depósito · ativo (< 48 h) · esfriando · dormindo ·
    perdido 30+;
  - *Nível:* bronze … black.
- **Uma matrícula por eixo:** mudar de estado encerra a matrícula do eixo e abre a nova no
  D1 (F-2), na mesma transação, via outbox.
- **Eventos transacionais** (PIX, saque, cashback) são matrículas temporárias que
  sobrepõem e **adiam** a régua do dia, não somam (F-9).
- **Orçamento de contato** por jogador/dia aplicado em `reserve_journey_delivery` para
  todas as origens, inclusive campanhas e express.
- **Reavaliação contínua** de matrículas pausadas e aguardando por job periódico, com
  saída por evento.

### 6.3 QA — matriz mínima
| Cenário | Esperado |
|---|---|
| Jogador inativo há 40 dias na ativação | entra só em "30 dias" |
| Esfriando que completa 7 dias | sai de Esfriando e entra em Dormindo D1 no mesmo dia |
| Depósito durante espera de 24 h | todas as matrículas de status e PIX saem em até 1 min |
| 3 PIX pendentes em 10 min | 1 matrícula, 1 SMS imediato |
| Paga 1 de 2 PIX | segue em PIX até o último pago ou expirado |
| Sobe de Bronze para Ouro | sai de Bronze, entra em Ouro D1, sem passar por Prata |
| Cashback D+1 em jogador Ouro | recebe cashback e não recebe a régua Ouro naquele dia |
| Teto de 2/dia com 3 réguas devidas | só as 2 de maior prioridade saem; a 3ª vai para o dia seguinte com motivo registrado |
| Jornada pausada por 48 h e reativada | sem rajada; passos atrasados descartados ou reagendados |
| Ativação "só novos" | zero matrículas da base histórica |
| Isolamento | jornadas de uma casa nunca matriculam jogadores de outra (verificado: 0 cruzamentos) |

### 6.4 Red team
- **Spam como vetor de dano:** um jogador gera dezenas de PIX (bot ou erro de app), e o
  sistema dispara um SMS por PIX. Isso é custo, risco de denúncia à operadora e bloqueio
  de rota. Mitigação: E-01 + C-01 + limite de matrículas por jogador por hora.
- **Reativação em massa:** reativar uma jornada pausada há dias despeja o atraso. Mitigação:
  S-03.
- **Clonagem sem revisão:** jornadas fora da spec chegam a casas novas. Mitigação: G-01.
- **Créditos ilimitados:** sem teto de gasto, um erro de regra vira prejuízo. Mitigação:
  C-02 + R-09 da Central.
- **Regulação e consentimento:** frequência alta aumenta opt-out e reclamação; o
  consentimento é checado no envio (preservar), mas o teto é a primeira defesa.

### 6.5 Gerente de projeto — plano

| Fase | Prazo | Entregáveis | Itens |
|---|---|---|---|
| **P0 imediato (operacional, sem código)** | hoje | `journey_contact_limits` = 2/24 h e 14/7 dias nas três casas (isso também contém o PIX: no máximo 2 SMS/dia por jogador); pausar Boas-vindas FTD em ForrandoBet e PixReals; reduzir Saque pago a um único passo de SMS (contenção da D-8: 1 mensagem por saque) | C-01, G-01, E-01 (contenção) |
| **P0 dados** | 1 dia | script revisado: encerrar as matrículas de Boas-vindas (7.818 na Sorte Alta + as das outras casas) e arquivar a jornada; fundir matrículas duplicadas de PIX | D-5, E-01 |
| **P0 código** | 2–4 dias | PIX: 1 matrícula por jogador + expiração/limite de loop (E-01); Saque pago como mensagem única randomizada por saque, até 4/dia, orçamento separado (E-07, D-8); faixas de inatividade com teto superior; job de limpeza de matrículas pausadas e órfãs (encerrar com motivo auditável) | E-01, E-03, S-02 |
| **P1 regras** | 5–8 dias | job de reconciliação de categoria (seção 8.3), primeiro em simulação; família exclusiva na entrada; saída por evento via outbox; virada de categoria F-2; pausa e retomada com impacto; ativação "só novos / incluir base" | O-01, S-01, S-03, E-02 |
| **P2 negócio** | 5–7 dias | orçamento por categoria 2 padrão + 4 saque (D-2); campo **data de término** na criação e edição (D-4); prioridades da D-3; PIX com expiração de 72 h (D-6); cashback D+1 com substituição; backfill de nível para ativos (D-7); teto de gasto | E-04, E-05, O-02, O-03, C-02 |
| **P3 UX e QA** | 5–7 dias | mapa de jornadas, prévia de ativação, ficha do jogador, avisos de conflito; matriz da seção 6.3 automatizada | 6.1, 6.3, G-03 |

**Dependência com a Central de Resultados:** a F1 da Central (crédito único por depósito)
deve começar depois do P1 desta auditoria, ou assumir explicitamente a sobreposição atual.

**Dados existentes:** a limpeza (P0 código) precisa de um script revisado, idempotente e
com relatório antes/depois, executado com autorização explícita. As matrículas encerradas
recebem `exit_reason` específico (`audit_cleanup_2026_10`) para não poluir as métricas.

---

## 7. Reavaliação consolidada

| ID | Sev. | Reavaliação | Fase |
|---|---|---|---|
| E-01 | S0 | confirmado (16 SMS em 2 min a um jogador) | P0 |
| E-07 | S0 | confirmado (até 7 matrículas e 14 SMS de saque por jogador; fura o teto) | P0 imediato (1 passo) / P0 código (randomizado, D-8) |
| C-01 | S0 | confirmado (tabela de limites vazia; até 16 SMS/dia) | P0 imediato |
| G-01 | S1 | confirmado (Boas-vindas ativa em 2 casas, fora da spec) | P0 imediato |
| E-02 | S1 | confirmado (33.468 matrículas em 14/10) | P1 |
| E-03 | S1 | confirmado (sobreposição de faixas) | P0 código |
| E-04 | S1 | confirmado; depende da decisão D-1 | P2 |
| E-05 | S1 | confirmado (F-9 não implementada) | P2 |
| E-06 | S2 | confirmado | P1 |
| S-01 | S1 | confirmado (598 + 326 + … abertos após depósito) | P1 |
| S-02 | S1 | confirmado (4.311 pausados que nunca saem) | P0 código |
| S-03 | S1 | confirmado (5.743 congelados) | P1 |
| S-04 | S3 | confirmado | P3 |
| S-05 | S3 | confirmado | P1 |
| O-01 | S1 | confirmado (5.172 em Esfriando × Dormindo) | P1 |
| O-02 | S2 | confirmado | P2 |
| O-03 | S2 | divergência documentada; decisão D-3 | P2 |
| O-04 | S2 | confirmado | P2 |
| C-02 | S1 | estimativa; decisão D-4 | P2 |
| C-03 | S2 | **reavaliado**: o motivo existe (coluna `provider`); problema real é o loop de jogadores sem consentimento (8.120 pulos) | P1 |
| G-02 | S3 | confirmado | P3 |
| G-03 | S2 | confirmado | P3 |
| C-04 | S1 | novo (P1): 37% da base sem telefone em réguas de SMS; todos os pulos "consent" | P1 (branch `feat/journey-p1-exits`) |
| R-10 | S0 | novo (P1): pedidos de SAIR não são capturados (0 respostas, 0 supressões) | escopo próprio urgente |
| G-04 | S0 | novo (P1): editor apagava SMS sem template, reativava passos desligados e regras não exibidas | corrigido em `5551a1e` |

---

## 8. Decisões (registradas em 15/10/2026)

| ID | Pergunta | Decisão | Origem |
|---|---|---|---|
| D-1 | Régua de nível e de status convivem? | **Sim, podem rodar juntas** | cliente |
| D-2 | Orçamento diário por jogador | **2 mensagens padrão por dia + até 4 de "Saque pago"**, independentes (revisado em 15/10: antes era +2) | cliente |
| D-8 | Formato do Saque pago | **Deixa de ser sequência:** cada saque recebe 1 mensagem sorteada entre as cadastradas; no máximo 4 por dia por jogador | cliente |
| D-3 | Ordem de prioridade | **PIX (1) > Cashback (2) > faixa de inatividade (3) > Nível (4) > Cadastro (5)**; Saque pago fora da disputa, com orçamento próprio | delegada; ver justificativa abaixo |
| D-4 | Loop infinito | **Continua por padrão**; novo campo **data de término** na criação e edição da jornada | cliente |
| D-5 | Boas-vindas FTD e Saque pago | **Boas-vindas FTD sai** (nas três casas); **Saque pago fica** | cliente |
| D-6 | Expiração do PIX | **72 h após o último PIX gerado** sem pagamento; uma matrícula por jogador | delegada |
| D-7 | Backfill | **Status:** incluir a base atual (já ocorreu e a cobertura está correta). **Nível:** incluir agora só jogadores **ativos** (depósito < 48 h, ~1,2 mil na Sorte Alta, que hoje não recebem régua nenhuma); estender aos demais depois de 2 semanas de dados na Central de Resultados | delegada |

**Justificativa de D-3:** com orçamento de 2 mensagens por dia, a prioridade decide quem
ocupa as vagas quando há 3 ou mais mensagens devidas. Eventos com intenção de pagamento
(PIX) e com dinheiro devolvido (cashback) convertem mais e são sensíveis a tempo. A faixa
de inatividade vem antes do nível porque é o risco de perda: um jogador parado precisa de
reativação antes de incentivo de progressão. O Cadastro fica por último, mas na prática
só concorre com o PIX, pois quem não depositou não está em faixa nem em nível. Esfriando,
Dormindo e 30 dias passam a ser exclusivas entre si (E-03 e O-01), então dividem o mesmo
nível de prioridade.

**Justificativa de D-6:** 72 h cobre o imediato, o D2 e o D3 previstos no FLUXO CRM (F-4)
sem loop eterno sobre uma intenção de pagamento que já esfriou. Depois disso, o jogador
segue nas réguas normais.

**Justificativa de D-7:** o backfill de nível para toda a base dobraria o volume (≈ +R$ 2
mil/dia na Sorte Alta) antes de existir medição de retorno. Começar pelos ativos atende
quem hoje não recebe nada e gera dados para decidir o resto.

### 8.1 Consequências técnicas das decisões

1. **Orçamento 2 padrão + até 4 de saque (D-2, revisada).** O mecanismo atual
   (`journey_contact_limits`) é um teto único em janela móvel de 24 h por casa e conta
   **todos** os SMS, inclusive de campanhas. A jornada expressa (Saque pago) o ignora, mas
   os envios dela **contam** para as demais: hoje um jogador que saca esgota as 2 vagas
   padrão do dia.
   - *Imediato (configuração):* teto de 2 em 24 h e 14 em 7 dias nas três casas. Saque
     pago continua furando o teto como expressa; como contenção até o código (item 5),
     reduzir a jornada a **um único passo de SMS**, o que dá 1 mensagem por saque (sem
     sorteio e sem limite diário ainda).
   - *Definitivo (código):* orçamento por categoria em dia-calendário de Brasília:
     `standard` = 2/dia e `saque` = 4/dia, **independentes**. Mensagens de saque não
     consomem as vagas padrão, e vice-versa. Um parâmetro define se campanhas consomem o
     orçamento padrão (recomendação: sim).
   - Jogadores barrados pelo teto tentam de novo a cada 1 h; com milhares adiados, isso
     gera carga no banco (CPU já alta). O definitivo reagenda para a próxima janela do
     dia seguinte.
2. **Data de término (D-4).** Novo campo `ends_at` (opcional) em `journeys`, editável na
   criação e na edição, em horário de Brasília. A partir de `ends_at`: nenhuma entrada
   nova; matrículas abertas são encerradas com `exit_reason = 'journey_ended'`; a jornada
   passa a `completed` (estado novo) e aparece como "Encerrada em dd/mm". Validações: data
   futura, aviso quando houver matrículas abertas, e prévia de quantos jogadores serão
   encerrados. Opcional (P2): duração máxima por jogador (dias na régua), separada da data
   de término da jornada.
3. **Boas-vindas FTD sai (D-5).** Arquivar nas três casas e encerrar as matrículas
   abertas com `exit_reason = 'journey_removed'` (Sorte Alta: 7.818). Remover o modelo dos
   templates de clonagem.
4. **PIX (D-6).** Uma matrícula por jogador (`entry_key` fixa); um novo PIX reinicia o D1
   se a matrícula estiver em loop, ou é ignorado se o D1 saiu há menos de 24 h. Saída
   quando não houver PIX pendente com menos de 72 h. Fusão das matrículas duplicadas
   existentes (manter a mais recente).
5. **Saque pago randomizado (D-2 revisada e D-8).** Deixa de ser sequência:
   - **cada saque aprovado gera 1 SMS**, sorteado entre as mensagens cadastradas na
     jornada;
   - **no máximo 4 SMS de saque por jogador por dia** (calendário de Brasília); saques
     além do 4º no dia não geram mensagem e ficam registrados com motivo
     `saque_daily_cap`;
   - **sorteio determinístico por saque** (semente = id do saque), para que retry ou
     reprocessamento do webhook nunca envie uma mensagem diferente ou duplicada;
   - **evitar repetição:** sortear entre as mensagens não usadas para aquele jogador no
     dia; quando todas já foram usadas, sorteia entre todas;
   - **sem espera nem loop:** a matrícula é de execução única (envia e encerra com
     `exit_reason = 'sent'`), então não sobram matrículas abertas por saque;
   - janela de envio 08h–22h e consentimento continuam valendo. Um saque fora da janela
     envia na abertura seguinte apenas se ainda estiver dentro da regra de mensagem
     obsoleta (hoje 120 min); senão, é descartado com motivo;
   - **editor:** novo tipo de jornada "mensagem única por evento" com lista de variações
     (mínimo 1, sugestão até 8), limite diário por jogador configurável (padrão 4) e
     prévia das variações. As 4 mensagens atuais de Saque pago viram as 4 variações;
   - **intervalo mínimo de 15 min** entre SMS de saque ao mesmo jogador (aprovado pelo
     cliente em 15/10), para que 4 saques em sequência não gerem 4 SMS no mesmo minuto;
     um saque dentro do intervalo é enviado ao fim dele, se ainda estiver na janela
     e no teto diário;
   - **gatilho exclusivo de saque aprovado:** só os webhooks `saque-aprovado` e
     `saque-concluido` (o mesmo saque, deduplicado pelo id) geram mensagem; `saque-pendente`
     (saque iniciado) **nunca** gera. Já é assim no código
     (`webhook-process.server.ts:1158-1162`, `journey-scanner.server.ts:348-349` e
     `:111-114`, que filtra `status = 'aprovado'`). A refatoração deve preservar isso, com
     teste de regressão: saque pendente → 0 SMS; pendente seguido de aprovado → 1 SMS;
     `saque-aprovado` + `saque-concluido` do mesmo saque → 1 SMS.

---

## 8.2 Contenção aplicada em produção (15/10/2026, 18h53 BRT)

Autorizada pelo cliente. Uma única transação, com conferência do número de linhas
afetadas e registro `audit_config_change` em `journey_events` para cada jornada alterada.

| # | Mudança | Casas | Linhas | Reverter |
|---|---|---|---|---|
| 1 | `journey_contact_limits`: 2 SMS/24 h e 14/7 dias por jogador | Sorte Alta, ForrandoBet, PixReals | 3 | apagar as 3 linhas (antes: tabela vazia) |
| 2 | Boas-vindas FTD → `paused` | ForrandoBet (`75961138…`), PixReals (`446318eb…`); Sorte Alta já estava pausada | 2 | `status='active', paused_at=null` |
| 3 | Saque pago: passos 1–7 desativados (`is_enabled=false`), só o 1º SMS é enviado | três casas (`8bcfa239…`, `d4699727…`, `2cd8d88b…`) | 21 | `is_enabled=true` nas posições 1–7 |

**Verificação (19h16 BRT, 23 min depois):**
- Saque pago: só execuções na posição 0 (9 enviadas, 3 falhas, 2 puladas); 51 matrículas
  encerradas como `finished` sem novo envio; 9 saíram por depósito; 17 aguardando.
- Teto: 228 jogadores receberam SMS no intervalo, **máximo 2 por jogador**, nenhum acima
  de 2; 24 envios adiados por `global_limit_24h`.
- 143 adiamentos por `daily_limit` (limite de 5.000 por jornada/dia, já existente):
  algumas jornadas estão batendo o teto diário. Avaliar na P2 junto com o orçamento por
  jogador.

**Limitações até o código:**
- O teto **não** vale para Saque pago (jornada expressa): cada saque gera 1 SMS, ainda sem
  o máximo de 4 por dia nem o intervalo de 15 min (D-8).
- Jogadores no teto são reagendados de hora em hora (`global_limit_24h`), o que gera carga
  extra até o orçamento definitivo por dia-calendário.

## 8.3 Limpeza de matrículas executada (15/10/2026, ~19h30 BRT)

Autorizada pelo cliente após relatório de simulação. Uma transação por grupo, com
`journey_events.event_type = 'audit_cleanup'` por jornada e lista de IDs encerrados
preservada (arquivos da sessão `ids_A_boas_vindas.json`, `ids_B_pix_duplicadas.json`,
`ids_C_faixas_inatividade.json`). Nenhum SMS foi enviado pela operação. Matrículas com
lease ativo (em envio) foram preservadas.

| Grupo | Ação | `exit_reason` | Encerradas | Observação |
|---|---|---|---|---|
| A | Boas-vindas FTD: encerrar matrículas abertas e **arquivar** a jornada nas 3 casas | `journey_removed` | **9.527** (Sorte Alta 7.818, PixReals 1.216, ForrandoBet 493) | contagem idêntica à simulação |
| B | PIX: manter só a matrícula mais recente por jogador | `merged_duplicate` | **103** (Sorte Alta 77, ForrandoBet 26) | a simulação indicava 92; novos PIX entraram durante a execução. A trava de tolerância fixa desfez duas tentativas e foi trocada por contagem com bloqueio dentro da própria transação |
| C | Esfriando com jogador há mais de 7 dias e Dormindo há mais de 30 dias | `audit_cleanup_inactivity_band` | **7.000** (Sorte Alta 5.572, PixReals 1.392, ForrandoBet 36) | simulação: 7.007 |

**Estado depois (Sorte Alta):**
- 20.190 matrículas abertas para 20.071 jogadores (antes: 34.342 para 20.789);
  19.964 jogadores em uma única jornada.
- Jogadores em duas faixas de inatividade ao mesmo tempo: 7 (ForrandoBet: 2), contra
  5.429 antes.
- Cobertura mantida: esfriando 1.363/1.418, dormindo 4.793/4.897, perdidos 684/694. Os
  que estão sem régua são casos recém-cruzados que a varredura (a cada 5 min) matricula.

**Por que não zerar e rematricular tudo:** com as regras atuais, a rematrícula recriaria as
mesmas sobreposições (faixas sem limite superior), reiniciaria todos no D1 sem mudança de
categoria (contra F-2) e, para permitir reentrada única, exigiria apagar matrículas, o que
apaga em cascata o histórico de execuções usado pela Central de Resultados. Jornadas de
nível não têm backfill, então ~490 jogadores sairiam sem voltar.

**Reconciliação (novo item da P1):** depois de E-03, O-01 e S-01 em código, rodar um job de
reconciliação que compara a faixa e o nível atuais de cada jogador com as matrículas
abertas, encerra o que diverge (`category_reconciled`) e matricula na régua correta a
partir do D1 apenas quem mudou de categoria. Quem já está na régua certa não é mexido.
Executar primeiro em simulação, com relatório.

## 8.4 P0 de código — entrega (15/10/2026, noite)

- **Commit** `0353f75` em `main` (push feito): matrícula única por jornada (gatilho no
  banco, exceto expressas), faixas de inatividade exclusivas (limite superior = limite de
  saída da jornada), expiração de PIX em 72 h, `reserve_journey_delivery_v2` com teto
  diário e intervalo por jogador e jornada, variações de SMS com sorteio determinístico,
  varredura das matrículas `paused_by_priority`, e `inactivity_threshold` medido no campo
  da jornada. Testes: 489 (13 novos de banco em PGlite, 4 novos no dispatcher); tipos,
  lint e build ok.
- **Migration** `20261015200000_journey_p0_rules` aplicada em produção e registrada em
  `supabase_migrations.schema_migrations`. Primeira varredura prevista: 18 das 33 pausadas
  (todas por depósito).
- **Configuração Saque pago (3 casas):** passo 0 com as 4 mensagens atuais como
  `variants`; `entry_rules.max_per_player_day = 4` e `min_interval_minutes = 15`. Estado
  anterior salvo (snapshot da sessão). Passos 1–7 continuam desativados.
- **Deploy feito (verificado em 15/10, ~20h10 BRT):** a varredura encerrou 19 matrículas
  pausadas (restam 15 válidas); o saque já sorteia variações e barrou 1 envio pelo teto
  diário; 60 matrículas saíram por `inactivity_threshold`; 70 envios adiados pelo teto
  global; nenhum jogador acima de 2 SMS padrão. Falhas da última hora: só telefones
  inválidos (8).
- **Resíduo tratado:** 26 matrículas de PIX duplicadas criadas entre a limpeza e a
  migration (nenhuma depois da trava) foram fundidas (`merged_duplicate`). 10 jogadores
  ainda aparecem em Esfriando (de 14/10) e Dormindo (nova, correta); a Esfriando sai no
  próximo passo pela regra nova, antes de qualquer envio.
- **Textos do saque reescritos** para envio isolado (4 variações por casa, de 119 a 136
  caracteres sem o nome, sem acento, para caber em um SMS).
- **CI:** correção do npm 11 commitada (`8ae771f`).

## 8.5 P1 — motor (em andamento, 15/10/2026)

**Achados novos durante a P1:**

- **C-04 · 37% da base sem telefone em réguas de SMS — S1.** Na Sorte Alta, 7.855 de
  20.975 jogadores não têm telefone. Telefone vazio é tratado como "consentimento
  revogado" (`consent.server.ts`, `if (!normalized) return "revoked"`), então os 8.120
  pulos registrados como `consent` são **todos** de jogadores sem telefone (7.199
  jogadores; 0 opt-outs reais). Eles ficam em loop diário sem receber nada. Correção na
  P1: não entram em jornada só de SMS e, se já estiverem, saem como `no_contact`, com a
  chave liberada para reentrar quando o telefone chegar. A origem dos cadastros sem
  telefone (webhook ou sync de exportação) deve ser investigada à parte.
- **R-10 · Pedidos de "SAIR" não são capturados — S0 (conformidade).** As mensagens
  dizem "Para sair, responda SAIR", mas há **0** respostas registradas
  (`delivery_status = 'replied'`), **0** linhas em `sms_suppressions` e **0** em
  `channel_consents`, em todas as casas. Ou o provedor não repassa as respostas, ou o
  webhook não as transforma em supressão. Exige escopo próprio e urgente: confirmar com o
  provedor o envio de MO (mensagem de resposta), tratar "SAIR/PARAR/STOP" no webhook,
  gravar a supressão, encerrar as matrículas do jogador e testar ponta a ponta.

**Entregue em código (branch `feat/journey-p1-exits`, commit `ad1caf5`; testes 498, build
ok; ainda não aplicado em produção):**

- `sweep_journey_exits`: avalia as regras de saída de **todas** as matrículas abertas a
  cada ciclo do dispatcher (depósito, primeiro depósito, login, faixa vencida, jornada
  arquivada, sem contato), ignorando itens em envio. Substitui a varredura só das
  pausadas. Custo medido no banco real: ~70 ms por execução.
- Gatilho de entrada: além da matrícula única, barra jogador sem telefone em jornada só de
  SMS (`journey_requires_phone`).
- **Reconciliação (8.3):** com faixas exclusivas (P0) e esta varredura, o job dedicado de
  reconciliação deixa de ser necessário. A varredura encerra quem está na régua errada, e
  o scanner (a cada 5 min) matricula na régua certa.

**Simulação da primeira execução (somente leitura):**

| Casa | sem contato | depósito | faixa vencida |
|---|---|---|---|
| Sorte Alta | 7.736 (Cadastrou 6.816, Esfriando 475, níveis 360, PIX 70, Dormindo 58, 30 dias 8) | 180 | 26 |
| PixReals | 141 | 0 | 13 |
| ForrandoBet | 41 | 77 | 10 |

**Aplicado (15/10, ~20h30–21h):** migrations `20261016090000_journey_p1_exits` e
`20261016100000_journey_end_date` em produção; código em `main` (`ad1caf5`, `1107e35`
editor do cliente, `5551a1e`). O bloqueio de entrada sem telefone vale desde 20h32 (zero
entradas sem telefone desde então). A varredura geral e a data de término dependem do
deploy da aplicação.

**Entregue também (`5551a1e`):**
- **Data de término (D-4):** campo opcional na criação e na edição (horário de
  Brasília); sem novas entradas depois dela; matrículas abertas saem como
  `journey_ended`; selo "encerra em / encerrada em" no hub.
- **G-04 · Editor destruía jornadas ao salvar — S0 (novo, corrigido).** Salvar qualquer
  das 12 jornadas clonadas apagava todos os SMS de texto direto (sem template), reativava
  passos desligados e apagava `entry_rules` e chaves do SMS que o editor não exibe (teto e
  intervalo do saque, variações, `track_links`). Agora o editor carrega só os passos
  ativos, mantém SMS sem template e preserva essas chaves; avisa quando o passo sorteia
  variações.

**Entregue em seguida (`413e958`, branch `feat/journey-pause-publish-dialogs`; 508 testes,
build ok; sem migration):**
- **Pausa com impacto (S-03):** ao desligar, o hub mostra quantos jogadores estão na
  jornada e oferece manter (retomam de onde pararam) ou encerrar todas as matrículas
  (`journey_paused_closed`).
- **Ativação com escopo (E-02):** ao publicar, "só casos novos a partir de agora" grava
  `start_after`; "incluir a base atual" remove um `start_after` anterior apenas nas
  faixas de inatividade. Em gatilhos de evento (PIX, saque, cashback, cadastro, primeiro
  depósito) o `start_after` existente é sempre preservado, para não reenviar eventos
  passados; o padrão desses gatilhos é "só novos". Níveis e manual publicam direto.
- Não verificado visualmente no navegador (sem sessão autenticada local); coberto por
  tipos, lint e testes da regra.

**P1 concluída em código.** Próximo: P2 (orçamento 2 padrão + 4 saque independentes,
cashback D+1, prioridades D-3, backfill de nível para ativos, teto de gasto).

## 8.6 P2 — andamento (15/10/2026, noite)

- **Orçamento independente (D-2):** migration `20261016110000` aplicada; commit
  `99629ff` em `main`. SMS de jornadas expressas (Saque pago) não contam mais no limite
  padrão de 2/24 h; quem bate o teto é retentado quando a mensagem mais antiga sai da
  janela, e não a cada hora. Vale sem deploy (é função do banco).
- **Prioridades (D-3):** 24 jornadas ajustadas nas três casas (Dormindo e Esfriando → 3,
  níveis → 4, Cadastrou → 5; PIX 1, Cashback 2 e 30 dias 3 já estavam certos). Estado
  anterior salvo.
- **Backfill de nível para ativos (D-7):** 631 matrículas criadas (simulação: 633),
  jogadores com depósito nas últimas 48 h, com telefone e sem régua de nível; começam no
  D1 do próprio nível. Marcadas em `metadata.backfill = active_players_2026-10-15`; lista
  de ids salva.
- **Observação operacional:** outra sessão commitou na mesma pasta de trabalho durante
  este trabalho (`f3d0dbd`/`6d37be6`, log de callbacks de SMS). A `main` foi realinhada
  ao GitHub sem perda (backup em `backup/main-before-sync`).
- **Adiado por decisão do cliente (15/10):** cashback D+1 com substituição do SMS de nível
  (E-05) e teto de gasto diário por casa (C-02) serão tratados ao final, com a equipe.
  **P2 encerrada** com isso.

## 8.7 P3 — interface e QA (16/10/2026)

Branch `feat/journeys-p3`: `7e2e969`, `f772684`, `85a1e9d`; 557 testes, build ok.

- **E-06:** público da jornada reconferido a cada passo. **S-04:** a opção "Mudou de
  nível", que não fazia nada, saiu do editor; jornadas de nível explicam que encerram ao
  mudar de nível; o modelo de nível usa prioridade 4 (D-3). **G-02:** removido
  `enrollEligibleJourneyPlayers` (109 linhas sem uso).
- **Ficha do jogador:** cartão "Jornadas" com réguas atuais (etapa X de Y, próximo
  envio, jornada que pausou, grupo de controle), saídas anteriores com o motivo em
  linguagem simples, e SMS nas últimas 24 h e 7 dias contra o limite por jogador.
- **Mapa das réguas** no hub: aquisição, faixas de inatividade em ordem (com a faixa em
  dias), níveis em ordem e eventos, com jogadores em cada uma.
- **Prévia ao publicar:** com "incluir a base atual", mostra quantos jogadores entram
  agora e o custo do 1º envio (`journey_activation_estimate`, migration `20261016160000`).
- **Avisos de conflito no editor:** faixa de inatividade sobreposta, segundo jornada
  ativa para o mesmo nível, mesmo gatilho com a mesma prioridade.
- Não verificado no navegador (sem sessão local).

**Matriz de QA (6.3) × testes automatizados:**

| Cenário | Cobertura |
|---|---|
| Inativo há 40 dias entra só em "30 dias" | ✅ `journey-policy.test` (teto da faixa), `journey-activation-estimate.db.test` |
| Esfriando que completa 7 dias sai e entra em Dormindo | ✅ saída: `journey-p0-rules.db.test` (varredura); entrada: teto da faixa. Sem teste de ponta a ponta |
| Depósito durante espera sai em até 1 min | ✅ `journey-p0-rules.db.test` (varredura geral, roda a cada ciclo) |
| 3 PIX em 10 min → 1 matrícula | ✅ `journey-p0-rules.db.test` (matrícula única) |
| Paga 1 de 2 PIX segue até o último pago ou expirado | ⚠️ regra no código (`matchFinancialTrigger` + 72 h), sem teste dedicado |
| Sobe de Bronze para Ouro | ✅ `journey-level-transition.db.test` |
| Cashback D+1 | ⏸️ adiado (equipe) |
| Teto de 2/dia com 3 réguas devidas | ✅ `journey-express.db.test`, `journey-p0-rules.db.test` (orçamento separado) |
| Jornada pausada 48 h e reativada sem rajada | ⚠️ retoma de onde parou dentro do teto por jogador; descarte de passos atrasados não implementado |
| Ativação "só novos" | ✅ `journey-policy.test` (`activationTriggerConfig`) |
| Isolamento entre casas | ✅ testes de RLS das funções novas; 0 cruzamentos verificado em produção |

## 8.8 Janela de envio do Saque pago (16/10/2026, 04h)

Achado na verificação pós-deploy: o **Saque pago não tinha janela de envio** (as demais
jornadas usam 08h–22h). As tentativas de teste do disjuntor do SMS durante a madrugada
pegaram mensagens de saque (00h02 a 03h54), todas recusadas pela Short Brasil por
autenticação, ou seja, nada foi entregue. Corrigido com autorização do cliente: janela
08h–22h, todos os dias, nas três casas, preservando teto de 4/dia e intervalo de 15 min
(`audit_config_change` em `journey_events`). Um saque fora da janela recebe a mensagem às
08h (a regra de mensagem obsoleta trata a espera pela janela como planejada). Conferido:
nenhuma outra jornada ativa sem janela.

## 9. Evidências (consultas somente leitura, 15/10/2026, Sorte Alta salvo indicação)

| Consulta | Resultado |
|---|---|
| Configuração das jornadas (todas as casas) | 12 jornadas idênticas em Sorte Alta, ForrandoBet e PixReals; tabela da seção 3 |
| Matrículas abertas | 34.342 / 20.789 jogadores; 13.323 em 1 jornada, 1.964 em 2, 5.012 em 3, 454 em 4, 38 em 5+ |
| Entrada por dia | 14/10: Cadastrou 12.620, Boas-vindas 7.890, Esfriando 6.954, Dormindo 5.363, 30 dias 641; 15/10: PIX 1.217, Saque 203 |
| Pares simultâneos | Boas-vindas × Esfriando 6.722; Dormindo × Esfriando 5.172; Boas-vindas × Dormindo 5.165; 30d × Boas-vindas 647; 30d × Esfriando 587; 30d × Dormindo 487 |
| Deveriam ter saído | Esfriando além de 7 dias: 5.381 (4.311 pausadas + 1.066 aguardando + 4 ativas); Dormindo além de 30 dias: 489; depositaram após entrar: Boas-vindas 598, PIX 326, níveis 211; Cadastrou já depositou: 12 |
| Cobertura | Esfriando 1.404/1.455; Dormindo 4.774/4.855; 30d+ 680/692; ativos (< 2 dias) ainda em alguma régua de inatividade: 58 |
| SMS de jornada por jogador/dia | 14/10: 2.919 jogadores, 980 ≥ 2, 215 ≥ 4, máx. 9 · 15/10: 10.703, 444 ≥ 2, 48 ≥ 4, máx. 16 |
| Caso extremo | 1 jogador, jornada PIX, 16 matrículas: 16 erros (12h55–13h59) e 16 SMS enviados (14h41–14h43); 16 matrículas seguem aguardando |
| PIX hoje por jogador | 79 com 1, 22 com 2, 3 com 3, 2 com 4, 2 com 5, 1 com 6, 1 com 16 |
| Limites de contato | `journey_contact_limits`: 0 linhas |
| Execuções puladas | 7.978 sem motivo registrado |
| Isolamento | 0 matrículas com jogador de outra casa |
