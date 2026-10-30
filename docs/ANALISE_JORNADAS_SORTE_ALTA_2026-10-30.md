# Análise das jornadas — Sorte Alta (pixpgf) — 30/10/2026

Base: produção, consultas read-only. Período: ativação das jornadas (13–14/10) até 30/10.
Custo usado: **R$0,08 por SMS** (custo real do wallet_ledger; o `crm_results_daily` usa R$0,059 e subestima).

## 1. Panorama

- 12 jornadas ativas, todas **100% SMS**. E-mail: 3 envios em 30 dias; voz: 8. Há 16.638 jogadores com e-mail cadastrado.
- 9 das 12 jornadas terminam em `end { loop_to_position: 9 }`, ou seja, repetem os 2 últimos SMS a cada 2 dias **sem fim** até o lead depositar ou trocar de faixa.
- O holdout (grupo de controle de 10%) só existe em 3 jornadas: Esfriando, Dormindo e 30 dias.

## 2. Recuperação por jornada

### 2.1 Lift real, medido contra o holdout

Comparação feita só com entradas a partir de 16/10, quando o holdout passou a existir. Mede o depósito em até 7 dias após entrar na jornada.

| Jornada | Tratado | Holdout | Lift | Receita 7d/lead (tratado × holdout) |
|---|---|---|---|---|
| **Dormindo — 7 dias** | 18,5% (n=759) | 10,1% (n=79) | **+8,3 p.p.** | R$47,6 × R$18,0 |
| Esfriando — 2 dias | 56,0% (n=1.009) | 52,3% (n=111) | +3,8 p.p. | R$421 × R$323 |
| 30 dias sem depósito | 1,0% (n=508) | 0,0% (n=53) | ~+1 p.p. (amostra pequena) | R$2,1 × R$0 |

**Como ler:**
- **Dormindo** é a jornada com maior recuperação incremental.
- **Esfriando** traz muita receita, mas a maior parte desses jogadores voltaria de qualquer forma.
- **30 dias** quase não recupera.

### 2.2 Visão bruta, sem controle

Leads que receberam pelo menos 1 mensagem e depositaram em até 7 dias após a primeira. O resultado **não é incremental**: em jornadas de jogadores ativos (Saque, PIX, Níveis), o depósito aconteceria de qualquer forma.

| Jornada | Leads | Msgs/lead | Depositou 7d | Receita 7d | Custo real |
|---|---|---|---|---|---|
| Saque pago | 3.441 | 1,1 | 89,1% | R$6,0 mi | R$289 |
| Nível Black VIP | 288 | 5,2 | 84,7% | R$457 mil | R$120 |
| Nível Diamante | 390 | 4,1 | 83,1% | R$260 mil | R$129 |
| PIX gerado e não pago | 1.996 | 1,1 | 79,3% | R$1,7 mi | R$170 |
| Nível Ouro | 324 | 3,1 | 74,1% | R$115 mil | R$80 |
| Nível Prata | 319 | 2,9 | 66,5% | R$61 mil | R$75 |
| Nível Bronze | 246 | 2,6 | 55,7% | R$31 mil | R$50 |
| Boas-vindas FTD (removida) | 654 | 1,1 | 32,0% | R$204 mil | R$56 |
| Esfriando — 2 dias | 4.473 | 1,9 | 26,6% | R$536 mil | R$696 |
| Dormindo — 7 dias | 7.473 | 6,3 | 5,9% | R$147 mil | R$3.737 |
| **30 dias sem depósito** | 2.617 | 5,3 | **1,2%** | R$3,8 mil | R$1.103 |
| **Cadastrou e não depositou** | 7.307 | 6,8 | **0,9%** | R$13 mil | R$3.986 |

- **Maior recuperação:** Dormindo (incremental, comprovado) e Esfriando (volume). PIX gerado e Saque pago custam pouco e atingem o jogador no pico de intenção.
- **Menor recuperação:** "Cadastrou e não depositou" e "30 dias sem depósito". Juntas respondem por **~R$5,1 mil dos ~R$10,5 mil** gastos em jornadas e retornam ~R$17 mil brutos (não incrementais).

## 3. Quando o lead para de responder (base da regra "lead morto")

Para cada mensagem de jornada, contamos quantas mensagens seguidas o lead já tinha recebido sem nenhuma ação. Ação é depósito, PIX gerado, login ou clique.

| Msg consecutiva sem resposta | Mensagens | Agiu antes da próxima | Depositou |
|---|---|---|---|
| 1ª | 31.214 | 30,5% | 18,2% |
| 2ª | 21.068 | 12,1% | 4,9% |
| 3ª | 17.828 | 9,0% | 2,2% |
| 4ª | 15.502 | 6,3% | 1,6% |
| 5ª | 13.941 | 3,4% | 0,68% |
| 6ª | 12.490 | 2,2% | 0,30% |
| 7ª–12ª | 19.098 | ~0,7–2,5% | ~0,1–0,5% |

- Depois da 5ª mensagem foram enviados **31.588 SMS (~R$2.527)**, que geraram **109 depósitos**. Pelo holdout, parte desses depósitos aconteceria de qualquer forma.
- **12.839 leads (77% da base já contatada) estão hoje com 5 ou mais mensagens seguidas sem resposta.** Desses, 7.275 continuam inscritos e recebendo SMS.
- Conclusão: o limite de 5 é sustentado pelos dados. A regra corta ~25% do volume de SMS de jornada com perda de receita desprezível.

## 4. Lacunas encontradas

1. **Loops infinitos**: 9 jornadas repetem SMS a cada 2 dias sem limite. É a principal fonte de desperdício (ver seção 3).
2. **Sem jornada pós-FTD**: "Boas-vindas ao primeiro depósito" foi removida (7.818 inscrições saíram com `journey_removed`). **39% dos FTDs dos últimos 30 dias (2.015 de 5.182) nunca fizeram o 2º depósito.** Enquanto esteve ativa, era uma das jornadas de melhor retorno.
3. **Cashback — Reativação Automática nunca disparou**: 0 inscrições. O campo `players.last_cashback_paid_at` está vazio em 100% da base. O gatilho depende de uma integração que não existe para a Sorte Alta.
4. **"Cadastrou e não depositou" travada**:
   - 6.035 inscrições ficaram com status `failed` no incidente do SHORTIO_DOMAIN (22–23/10). Como a jornada usa `reentry: once`, esses leads **nunca mais entram**.
   - Outros 6.817 saíram por `no_contact`; 5.876 deles não têm telefone e só 197 têm e-mail.
5. **Canal único**: tudo vai por SMS. E-mail custa uma fração e alcançaria 16,6 mil jogadores. Hoje não há nenhum passo de e-mail.
6. **Holdout só em 3 jornadas**: Saque pago, PIX, Níveis e Cadastro não têm controle, então não dá para afirmar que geram receita incremental.
7. **Jornadas de Nível em loop para jogadores ativos**: 4 a 5 SMS por mudança de nível, mais loop. Há 356 inscrições em `paused_by_priority` por conflito com as jornadas de inatividade.
8. **Login sem depósito não é aproveitado**: ~40% dos logins (≈150/dia) não viram depósito em 24h. É um dos sinais de maior intenção e nenhuma jornada o usa.
9. **Campanhas manuais insistem em "perdido"**: as campanhas enviam 1–1,8 mil SMS por disparo para jogadores no estado "perdido", com conversão próxima de zero. O novo público "Leads mortos" permite excluí-los.

## 5. Recomendação: manter, reformular, tirar, criar

| Ação | Jornada | O que fazer |
|---|---|---|
| **Manter** | Esfriando — 2 dias | Remover o loop: 3 SMS e fim. Manter o holdout. |
| **Manter** | Dormindo — 7 dias | É a melhor em lift. Remover o loop e trocar 1 SMS por e-mail. |
| **Manter** | PIX gerado e não pago | OK. Adicionar holdout de 5% para medir. |
| **Manter** | Saque pago | OK. Adicionar holdout de 5%. |
| **Reformular** | Cadastrou e não depositou | No máximo 3 SMS em 72h, mais e-mail D+1/D+3/D+7, sem loop. Reenfileirar as 6.035 inscrições `failed`. Adicionar holdout. |
| **Reformular** | 5 jornadas de Nível | Juntar em 1 jornada "Subiu de nível" com 1 SMS personalizado (`{nivel}`) e 1 lembrete. Sem loop. Holdout. |
| **Reformular** | 30 dias sem depósito | 1 SMS com oferta + 1 e-mail, depois fim. Daí o lead vai para Leads mortos. |
| **Tirar / pausar** | Cashback — Reativação | Pausar até existir integração de cashback pago. |
| **Criar** | Pós-FTD / 2º depósito | Entrada: FTD aprovado. Passos: D0 boas-vindas, D+1 e D+3 lembrete. Saída: 2º depósito. |
| **Criar** | Login sem depósito | Entrada: login sem depósito em 2h. 1 SMS no mesmo dia. Express, máx. 1/dia. Saída: depósito ou PIX gerado. |
| **Criar** | Win-back de Leads mortos | Campanha mensal só por **e-mail** (custo ~zero) para o público "Leads mortos", com oferta forte. Quem agir é reativado automaticamente. |
| **Avaliar** | Aniversário | Usar `data_nascimento`; é mensagem de baixo custo e alta abertura. |

### Novos gatilhos de entrada

- FTD aprovado (pós-FTD)
- Login sem depósito em X horas
- Lead reativado depois de morto (volta para a jornada de boas-vindas de retorno)
- Aniversário

### Novos gatilhos de saída

- **`dead_lead`**: N mensagens seguidas sem ação. Implementado nesta branch.
- Clique humano no link: sair da cadência fria e entrar em uma jornada "quente" de 1 mensagem.
- Opt-out (resposta SAIR): saída global de todas as jornadas, não só pular o passo.
- 2º depósito (para a jornada pós-FTD)

## 6. Regra "Lead morto" (implementada em `feat/dead-leads`)

- **Opcional por casa** (desligada por padrão). Fica no diálogo "Limites de contato" das Automações, com limite configurável entre 2 e 50 (padrão 5).
- **Contagem**: mensagens de jornada (SMS, e-mail ou voz) somadas entre todas as jornadas, desde a última ação na casa ou a última reativação. Envios a leads do holdout não contam.
  - Ação é depósito, PIX gerado, saque, FTD, login, jogo ou clique humano em link (first-party).
  - Cliques Short.io ficam de fora porque não têm filtro de bot.
- **Ao atingir o limite**:
  - o lead sai das jornadas abertas com `exit_reason = 'dead_lead'`;
  - entra na tabela `journey_dead_leads`;
  - fica bloqueado para entrar em jornadas não-express (o bloqueio está no trigger de inscrição).
  - Jornadas **express** (PIX gerado, Saque pago) ficam fora do bloqueio e da saída, porque nascem de uma ação do próprio jogador, e essa ação já o reativa.
- **Reativação**: automática quando o lead volta a agir (feita a cada ciclo do dispatcher); também há reativação manual na aba.
- **Inscrição manual** de um lead morto em jornada não-express retorna erro pedindo a reativação.
- **Ordem de deploy**: aplicar a migration `20261117100000_journey_dead_leads.sql` **antes** do deploy do código. Sem ela, o público falha fechado (não envia para todos) e a checagem é pulada.
- **Simulação na base atual** (N=5): o primeiro "Avaliar base atual" marcaria ~12,8 mil leads.
- **Público** `system:dead-leads` ("Leads mortos") disponível em Campanhas.
- **Aba "Leads mortos"** em Automações: lista com última ação, mensagens recebidas, última jornada, total depositado e FTD, e um botão "Avaliar base atual" para o backfill.
