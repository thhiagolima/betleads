# Escopo: voz em lote (Infobip `/tts/3/advanced`) e interação por tecla (DTMF)

**Data:** 11/11/2026
**Status:** proposto. Nada foi implementado. As decisões de produto da seção 2 foram tomadas pelo responsável em 11/11/2026.
**Objetivo:** (1) campanhas de voz acima de 200 contatos saem em lote pela Infobip, no ritmo máximo da conta; (2) toda ligação pode pedir uma tecla ao jogador ("aperte 1 ou 2") e o CRM executa uma ação com base na resposta.

Esforço: **P** até 1 dia · **M** de 2 a 4 dias · **G** 1 semana ou mais. Estimativas para uma pessoa, testes incluídos.

---

## 1. Situação atual (levantamento de 11/11/2026)

| Tema | Como está hoje | Onde |
|---|---|---|
| Envio | Uma requisição por ligação ao Call Markup Language (`POST /markuplanguage/1/create`). Ao atender, a Infobip busca o nosso CML, que responde `play`/`say` + `hangup`. Sem interação. | `src/lib/infobip-voice.server.ts` (`placeCall`), `src/routes/api/public/infobip/voice/cml.ts` |
| Status e cobrança | Eventos da chamada chegam em `events.ts`; a carteira reserva antes de discar (`voice:<id da fila>`) e acerta pelo evento final; a conciliação diária (09:00) fecha o que ficou aberto. | `events.ts`, `voice-billing.server.ts`, `infobip-voice-reconciliation.server.ts` |
| Campanha | "Disparar agora" liga até 200 em linha; acima disso, e todo agendamento, vai para `call_queue`. O despachante (cron a cada minuto) processa até 200 itens **em série**, um por vez. Teto máximo ≈ 12 mil ligações/hora. | `calls-bulk.server.ts:54`, `calls.server.ts` (`runVoiceQueueDispatcher`), `hooks/dispatch.ts` |
| Entidade campanha | **Não existe.** A campanha de voz é o agrupamento de `call_queue.trigger_name`. Não há onde guardar configuração de campanha (teclas, lote, bulkId). | `call_queue` |
| Regras por número | Consentimento revogado, limite de contato (`voice_contact_policies`, hoje desligado em todas as casas), casa demo, teto do Expert, canal desligado. | `consent.server.ts`, `calls.server.ts` |
| Secretária eletrônica | Não tratada. A ligação toca o áudio para a caixa postal e é cobrada. | — |
| Destinos das ações | Etiqueta de jogador: **não existe**. Públicos (`sms_audiences`): são filtros (`criteria`), não listas fixas. Jornada: existe `enrollPlayersInJourney` (`journey-scanner.server.ts:253`). Webhook de saída para a casa: **não existe**. Envio de SMS e revogação de consentimento: existem. | — |
| Trava global | `VOICE_DISPATCH_ENABLED=true` em produção desde 11/11/2026. Continua valendo para tudo que este escopo cria. | `voice-dispatch-policy.ts` |

---

## 2. Decisões de produto (11/11/2026)

| # | Decisão |
|---|---|
| D1 | Campanhas com **mais de 200 contatos** usam o envio em lote (`/tts/3/advanced`). Até 200, jornadas e ligações avulsas continuam no CML. |
| D2 | Velocidade: **o máximo possível.** O lote vai sem `sendingSpeed` (a Infobip usa o limite da conta); o caminho CML passa a discar em paralelo. |
| D3 | Secretária eletrônica: **desligar.** |
| D4 | Catálogo de ações por tecla: **todas** — SMS, etiqueta, lista, jornada, revogar consentimento de voz, webhook da casa, transferir para atendente. |
| D5 | "Não apertou nada": **a casa decide** se configura uma ação para esse caso. |

---

## 3. Referência da Infobip (confirmada no SDK oficial `infobip-api-java-client`, modelos gerados do OpenAPI)

### 3.1 Envio em lote: `POST /tts/3/advanced`
Corpo: `{ "bulkId": string, "messages": [ CallsAdvancedMessage ] }`. Permissão da chave: `voice:message:message:send`.

Campos de cada mensagem usados neste escopo:

| Campo | Uso |
|---|---|
| `destinations[]` (`{ to }`) | Até **20 mil** destinos por mensagem. |
| `audioFileUrl` | Áudio da biblioteca. Até 4 MB; aac, aiff, m4a, mp2, mp3, mp4, ogg, wav, wma. A Infobip precisa de GET e HEAD na URL. |
| `text`, `language`, `voice`, `speechRate` | Roteiro (TTS). |
| `from` | Número de origem (conta da casa). |
| `notifyUrl`, `notifyContentType` | Relatório de entrega por destino. |
| `callbackData` | Até **700 caracteres**; volta no relatório. Leva o id do item da fila. |
| `machineDetection` | `"hangup"` (D3). |
| `maxDtmf`, `dtmfTimeout` (padrão 10 s), `repeatDtmf` | Coleta de tecla. `#` não é coletável (encerra a digitação). Repetição até 5 vezes. |
| `callTransfers[]` | `{ if: "dtmf" \| "anyDtmf", equals: "1", transferTo: "<E.164>", callTransferMaxDuration }` — a Infobip transfere na hora. |
| `ringTimeout` (padrão 45 s), `callTimeout`, `pause`, `retry`, `deliveryTimeWindow`, `sendAt` | Controle da ligação. |
| `sendingSpeed` (`speed`, `timeUnit`) | **Omitido** (D2). |

### 3.2 Relatório de entrega (`notifyUrl`)
`results[]` com `bulkId`, `messageId`, `from`, `to`, `sentAt`, `callbackData`, `status`, `error`, `price`, e `voiceCall`:
`startTime`, `answerTime`, `endTime`, `duration`, `chargedDuration`, `fileDuration`, `answeredBy` (pessoa/máquina), **`dtmfCodes`** (teclas digitadas), `ivr`.

### 3.3 Gestão do lote
- `GET /tts/3/bulks?bulkId=` e `GET/PUT /tts/3/bulks/status` com `PAUSED`, `PROCESSING`, `CANCELED`. Exige `bulkId` único por pedido.
- `GET /tts/3/logs`: histórico das mensagens de voz, para conciliação.

### 3.4 Interação no CML (caminho atual)
Ação `captureDtmf` (`maxLength`, `timeout`, `digitTimeout`, `terminator`). A Infobip chama o nosso webhook com os dígitos e espera, na resposta síncrona (200), as próximas ações. Permite reagir **durante** a ligação.

### 3.5 Confirmar com a Infobip / no painel da conta (bloqueia a Fase 2)
- A chave de API de cada casa tem a permissão `voice:message:message:send`?
- O preço por minuto do envio em lote é igual ao do CML? O TTS é cobrado à parte (add-on)?
- O `PUT /tts/3/bulks/status` cancela ligações de um lote **em andamento** ou só de um lote agendado (`sendAt`)?
- Limite de ligações simultâneas da conta (é o que define o "máximo possível").
- O nome da ação de transferência no CML (para a ação "transferir" no caminho CML).
- Se existe consulta de relatório de entrega por pull para voz (equivalente a `/sms/1/reports`); o SDK lista só `/tts/3/logs`.

---

## 4. Desenho

### 4.1 Dois caminhos, uma regra de teclas

| | Lote (`/tts/3/advanced`) | CML (`/markuplanguage/1/create`) |
|---|---|---|
| Quando | Campanha com mais de 200 contatos | Campanha até 200, jornadas, fluxos, avulsas |
| Velocidade | A Infobip controla; sem `sendingSpeed` | O despachante disca N em paralelo |
| Secretária | `machineDetection: "hangup"` | Desligar quando o evento indicar máquina (a confirmar no evento CML) |
| Tecla | Coletada pela Infobip (`maxDtmf`); chega em `dtmfCodes` **depois** da ligação | `captureDtmf`; chega **durante** a ligação |
| Transferir | Nativo, por `callTransfers` | Ação de transferência do CML na resposta do webhook |
| Demais ações | Executadas ao receber o relatório | Executadas ao receber a tecla |

A configuração das teclas é a mesma para os dois caminhos e fica na campanha (ou no roteiro, para jornadas).

### 4.2 Dados novos (migrations)

| Tabela / coluna | Conteúdo |
|---|---|
| `voice_campaigns` | `id`, `tenant_id`, `name`, `channel_mode` (`cml` \| `bulk`), `voice_asset_id`/`script_id`, `scheduled_at`, `status` (`draft`, `scheduled`, `sending`, `paused`, `cancelled`, `finished`), `dtmf_enabled`, `dtmf_max_digits`, `dtmf_timeout_s`, `repeat_digit`, `no_input_action_id` (D5), contadores. A tela de campanhas passa a ler daqui, e não do agrupamento por `trigger_name`. |
| `voice_campaign_batches` | Um registro por lote enviado: `campaign_id`, `bulk_id` (único, determinístico: `vc:<campanha>:<n>`), `message_count`, `destination_count`, `status`, `provider_response`, `sent_at`. |
| `call_queue` (+colunas) | `voice_campaign_id`, `batch_id`, `provider_message_id`, `dispatch_mode`. |
| `call_history` (+colunas) | `provider_message_id`, `bulk_id`, `answered_by`, `dtmf_codes`. |
| `voice_dtmf_options` | `owner_type` (`campaign` \| `script`), `owner_id`, `digit` (0–9, `*`; `no_input` para D5), `label`, `action_type`, `action_config` (jsonb), `position`. Única por (`owner`, `digit`). |
| `voice_dtmf_responses` | `tenant_id`, `call_history_id`, `call_queue_id`, `player_id` (nulo para lista de números), `phone`, `digits`, `matched_option_id`, `received_via` (`report` \| `cml`), `received_at`. Única por ligação. |
| `voice_dtmf_action_runs` | `response_id`, `action_type`, `status` (`pending`, `done`, `failed`, `skipped`), `attempts`, `result`, `error`. Única por (`response_id`, `option_id`) — garante que uma ação nunca roda duas vezes. |
| `player_tags` | `tenant_id`, `player_id`, `tag`, `source`, `created_at`. Única por (`tenant_id`, `player_id`, `tag`). Novo: não existe etiqueta hoje. |
| `player_lists` + `player_list_members` | Lista fixa de jogadores, usável como público de campanha. Novo: os públicos atuais são filtros. |
| `tenant_outbound_webhooks` | `tenant_id`, `url` (https, validada contra SSRF), `secret` (HMAC), `events`, `enabled`. Novo. |

Todas com RLS por casa, como as demais tabelas de canal.

### 4.3 Catálogo de ações (D4)

| Ação | `action_config` | Sem jogador (lista de números) | Observação |
|---|---|---|---|
| Mandar SMS | `template_id` ou `text`, conta de envio | Envia para o telefone | Passa pelas regras de SMS (consentimento, saldo, conta da casa). Cobra como SMS normal. |
| Pôr etiqueta | `tag` | Ignorada (`skipped`) | Grava em `player_tags`. |
| Incluir em lista | `list_id` | Ignorada | Grava em `player_list_members`. |
| Colocar em jornada | `journey_id` | Ignorada | Reusa `enrollPlayersInJourney`, com `source = "voice_dtmf"`. Respeita holdout e regras da jornada. |
| Tirar das ligações | — | Revoga pelo telefone | Grava a revogação de voz em `channel_consents`, como o opt-out atual. |
| Avisar sistema externo | `webhook_id` | Envia com o telefone | POST assinado (HMAC) com jogador, telefone, campanha, tecla e horário. Retentativa com recuo; após o limite, `failed`. |
| Transferir para atendente | `transfer_to` (E.164), `max_duration_s` | Funciona | **Executada pela Infobip durante a ligação** (lote: `callTransfers`; CML: ação de transferência). O CRM só registra. Minutos transferidos entram na cobrança. |

"Não apertou nada" (D5): a casa escolhe uma das ações acima, ou nenhuma. Só vale para ligação **atendida por pessoa** (`answeredBy` ≠ máquina). Ligação não atendida não dispara nada.

### 4.4 Fluxo do lote (campanha > 200)
1. Criação: grava `voice_campaigns` + itens em `call_queue` (em blocos de 500, como hoje), `dispatch_mode = "bulk"`.
2. No horário, o despachante de lote pega a campanha (com trava, para dois workers nunca pegarem a mesma), aplica as regras por número em cada item e separa os elegíveis.
3. Reserva na carteira o lote inteiro (um lançamento por item, mesma chave `voice:<id>` de hoje, para o acerto e a conciliação continuarem iguais). Sem saldo: a campanha fica pausada com "saldo insuficiente", como na fila atual.
4. Monta o pedido: áudio da biblioteca → uma mensagem com até 20 mil destinos; roteiro com variáveis → uma mensagem por jogador (mesmo pedido). Cada destino leva `callbackData` = id do item. `machineDetection: "hangup"`, teclas e `callTransfers` conforme a campanha.
5. Envia com `bulkId` determinístico. Uma nova tentativa do mesmo lote usa o mesmo `bulkId`, e a Infobip rejeita a duplicata. Falha de rede: o lote fica `unknown` e a conciliação consulta `GET /tts/3/bulks` antes de reenviar.
6. Relatório (`notifyUrl` novo): por destino, grava o `call_history`, acerta a cobrança pela `chargedDuration`, devolve o que não completou e, se houver `dtmfCodes`, registra a resposta e enfileira as ações.
7. Cancelar ou pausar a campanha chama `PUT /tts/3/bulks/status` e marca os itens restantes.
8. A conciliação diária passa a ler também `/tts/3/logs` para os lotes sem relatório.

### 4.5 Fluxo CML com tecla
1. `cml.ts` passa a responder `play`/`say` + `captureDtmf` quando a campanha ou o roteiro tem teclas.
2. Endpoint novo `POST /api/public/infobip/voice/dtmf` (mesma autenticação do `cml.ts`): recebe os dígitos e registra a resposta. Responde na hora com o próximo passo (áudio de confirmação opcional, transferência ou `hangup`). As ações que não são transferência vão para a fila de execução, e o webhook nunca espera por elas.
3. Sem tecla no tempo limite: ação "não apertou nada", se configurada.

### 4.6 Execução das ações
Um único executor (`voice-dtmf-actions.server.ts`) lê `voice_dtmf_action_runs` pendentes. Ele roda no cron de voz existente e uma vez logo após cada relatório ou tecla. É idempotente por (`response_id`, `option_id`), tenta de novo com recuo e fica `failed` após o limite. Nunca roda para casa demo nem com o canal de voz desligado.

---

## 5. Fases e itens

### Fase 1: base (sem mudança visível para a casa)
| ID | Item | Critério de aceite | Esf. |
|---|---|---|---|
| V1-01 | Despachante CML com **concorrência configurável** (`VOICE_DISPATCH_CONCURRENCY`, padrão 10), mantendo a trava atômica por item. | Teste: 50 itens despachados em paralelo, nenhum discado duas vezes; o tempo de um tick cai proporcionalmente. | M |
| V1-02 | **Secretária eletrônica: desligar** no caminho CML (identificar o sinal de máquina no evento ou no webhook e encerrar). | Teste com evento de máquina: `hangup`, `call_history.answered_by = machine`. | M |
| V1-03 | Migration: `voice_campaigns`, `voice_campaign_batches`, novas colunas de `call_queue`/`call_history`, com RLS. Criação de campanha passa a gravar `voice_campaigns`; a tela lê dela (e continua mostrando as antigas pelo `trigger_name`). | Teste de banco (PGlite) com RLS entre casas; campanhas antigas continuam na lista. | M |
| V1-04 | Migration: `voice_dtmf_options`, `voice_dtmf_responses`, `voice_dtmf_action_runs`, com unicidades e RLS. | Teste de banco: segunda resposta da mesma ligação e segunda execução da mesma ação são recusadas. | P |

### Fase 2: envio em lote acima de 200 (sem tecla)
| ID | Item | Critério de aceite | Esf. |
|---|---|---|---|
| V2-01 | Cliente `/tts/3/advanced` (`infobip-voice-bulk.server.ts`): montagem do pedido, `bulkId` determinístico, divisão em blocos de 20 mil, `callbackData`, `machineDetection: "hangup"`, sem `sendingSpeed`. Usa a conta Infobip da casa (`provider_accounts`). | Testes unitários do corpo do pedido (áudio, roteiro personalizado, divisão de blocos, limite de 700 caracteres no `callbackData`). | M |
| V2-02 | Despachante de lote: trava por campanha, regras por número, reserva na carteira, envio, tratamento de erro e `unknown`. Regra de roteamento: mais de 200 elegíveis → lote. | Teste: campanha de 201 vai para o lote, de 200 vai para o CML; envio repetido não duplica (mesmo `bulkId`); sem saldo, pausa sem enviar. | G |
| V2-03 | Webhook de relatório `POST /api/public/infobip/voice/bulk-report`: autenticação, idempotência por `messageId`, `call_history`, acerto e devolução na carteira. | Teste com o relatório real do SDK (atendida, não atendida, máquina, erro); relatório repetido não acerta duas vezes. | G |
| V2-04 | Cancelar/pausar/retomar campanha em lote via `PUT /tts/3/bulks/status`. | Teste: cancelar marca os itens restantes e chama a Infobip; a tela reflete. | M |
| V2-05 | Conciliação: lotes sem relatório consultam `/tts/3/logs`; reservas abertas são acertadas ou devolvidas. | Teste com relatório ausente: a conciliação fecha a reserva. | M |

### Fase 3: tecla no lote + ações
| ID | Item | Critério de aceite | Esf. |
|---|---|---|---|
| V3-01 | Lote envia `maxDtmf`, `dtmfTimeout`, `repeatDtmf` e `callTransfers` a partir de `voice_dtmf_options`. | Teste do corpo do pedido com 3 teclas, sendo uma transferência. | P |
| V3-02 | Relatório lê `dtmfCodes`, casa com a opção, grava a resposta e enfileira as ações; aplica "não apertou nada" só para atendida por pessoa. | Teste: tecla 1 → ação 1; sem tecla e atendida → ação `no_input`; máquina → nada. | M |
| V3-03 | Executor de ações + SMS, revogar consentimento, colocar em jornada. | Um teste por ação, incluindo lista de números (sem jogador) e repetição sem duplicar. | G |
| V3-04 | Etiquetas (`player_tags`) e listas fixas (`player_lists`), com uso como público de campanha. | Teste de banco + campanha para lista criada por tecla. | G |
| V3-05 | Webhooks de saída da casa (`tenant_outbound_webhooks`): cadastro, assinatura HMAC, proteção SSRF (reusar `ssrf-guard`), retentativa. | Teste: corpo assinado, URL interna recusada, retentativa até o limite. | M |

### Fase 4: tecla no CML
| ID | Item | Critério de aceite | Esf. |
|---|---|---|---|
| V4-01 | `cml.ts` responde com `captureDtmf` quando há teclas; endpoint `voice/dtmf` responde o próximo passo e registra a resposta. | Teste do webhook: tecla válida, tecla sem opção, tempo esgotado. | M |
| V4-02 | Transferência no CML (ação a confirmar com a Infobip, seção 3.5). | Ligação de teste transferida para o número configurado. | M |
| V4-03 | Teclas em roteiros de jornada e fluxos de ligação (a configuração fica no roteiro). | Teste: passo de voz da jornada com tecla executa a ação. | M |

### Fase 5: telas e ajuda
| ID | Item | Critério de aceite | Esf. |
|---|---|---|---|
| V5-01 | Formulário de campanha e de roteiro: bloco "Interação por tecla" (tecla, rótulo, ação e configuração, "não apertou nada", tempo de espera, tecla de repetir). Aviso de que o áudio precisa dizer as opções. | Validação: tecla duplicada, `#` recusado, transferência exige E.164. | G |
| V5-02 | Relatório da campanha: respostas por tecla, sem resposta, máquina, ações concluídas/falhas, lista por jogador e exportação. | Números do relatório batem com `voice_dtmf_responses`. | M |
| V5-03 | Telas de etiquetas, listas e webhooks da casa. | — | M |
| V5-04 | Ajuda (`src/help/screens/campanhas.ts` e novas telas) e tour. | Testes da ajuda passam. | P |

---

## 6. Riscos

| Risco | Mitigação |
|---|---|
| Ligar em dobro (lote reenviado, relatório repetido) | `bulkId` determinístico; idempotência por `messageId`; trava por campanha. |
| Cobrança divergente no lote | Mesma chave `voice:<id da fila>` por item; acerto só pelo relatório ou pela conciliação, nunca pelos dois (chave `voice-settle:<ref>` de hoje). |
| "Máximo possível" esbarrar no limite da conta Infobip | Confirmar o limite (3.5); erros 429 tratados como temporários, com nova tentativa. |
| Ação disparada sem consentimento (ex.: SMS) | Cada ação passa pelas regras do próprio canal. |
| Webhook da casa usado para SSRF | `ssrf-guard`, somente https, assinatura HMAC. |
| Transferência gerando minutos não previstos | `callTransferMaxDuration` obrigatório; minutos entram no acerto. |
| Lista de números (sem jogador) | Ações que exigem jogador ficam `skipped`, com o motivo no relatório. |

---

## 7. Regras de execução
1. Branch a partir de `origin/main` atualizada; um PR por fase (ou por item grande), com CI verde.
2. Migrations aplicadas em produção **antes** do push para a `main` (o deploy acompanha a `main`).
3. Nenhuma ligação real em teste automatizado; testes de ponta a ponta só com números de teste da ForrandoBet e aviso prévio.
4. A Fase 2 só começa depois das respostas da seção 3.5.

---

## 8. Quadro de status

| ID | Status | Commit | Evidência | Data |
|---|---|---|---|---|
| V1-01 a V5-04 | Não iniciado | — | — | — |
