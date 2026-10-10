# Matriz de aceite operacional dos canais

Use esta matriz a cada tenant/provedor antes de classificar um canal como plenamente funcional. Anexe IDs técnicos e horários; nunca insira tokens, payloads sensíveis ou dados pessoais desnecessários.

| Campo | Preenchimento |
| --- | --- |
| Tenant | |
| Canal / provedor | |
| Ambiente | Produção / homologação |
| Responsável pela execução | |
| Data e horário BRT | |
| Versão/commit | |

## SMS

| Cenário | Evidência exigida | Resultado |
| --- | --- | --- |
| Envio individual | ID interno, ID do provedor e recebimento no número de teste | ☐ |
| Campanha agendada | campanha concluída, quantidade esperada e fila zerada | ☐ |
| Automação/fluxo | evento de entrada, atraso e saída corretos | ☐ |
| Janela e limite | item adiado fora da janela e respeitado no limite diário | ☐ |
| Opt-out | número suprimido não recebe novo SMS | ☐ |
| Callback | status final correlacionado ao log | ☐ |
| Falha e reprocessamento | erro transitório preserva fila; reenvio não duplica | ☐ |

## E-mail

| Cenário | Evidência exigida | Resultado |
| --- | --- | --- |
| Envio de teste | ID interno/provedor e recebimento | ☐ |
| Domínio/remetente | SPF/DKIM/DMARC e remetente aceito pelo provedor | ☐ |
| Template | preview desktop/mobile, links e imagens válidos | ☐ |
| Campanha/agendamento | fila, quantidade e histórico coerentes | ☐ |
| Descadastro/supressão | destinatário suprimido não recebe novo e-mail | ☐ |
| Callback | entrega/bounce correlacionados ao log | ☐ |
| Falha e reprocessamento | erro transitório preserva fila; reenvio não duplica | ☐ |

## Voz

> Não habilite o **despacho automático** de voz (`VOICE_DISPATCH_ENABLED=true`) até concluir todos os itens abaixo. O cron de reconciliação de callbacks pode continuar ativo, pois apenas audita pendências e não cria chamadas.

| Cenário | Evidência exigida | Resultado |
| --- | --- | --- |
| Áudio | upload/TTS, URL assinada e reprodução corretos | ☐ |
| Chamada de teste | chamada recebida no número autorizado | ☐ |
| Callback assinado | status/duração/ID do provedor correlacionados | ☐ |
| Falha transitória | fila preservada e retentativa dentro da política | ☐ |
| Frequência/janela | tentativa bloqueada fora da regra | ☐ |
| Relatório | histórico e dashboard apresentam o resultado final | ☐ |
| Rollback | pausa remove novos despachos sem destruir evidências | ☐ |

## Aceite

| Decisão | Nome | Data | Observações |
| --- | --- | --- | --- |
| Operação/CRM | | | |
| Dev sênior | | | |
| Gerente de projeto | | | |
| UX (quando houver mudança de fluxo) | | | |

## Evidências de execução

| Data/hora BRT | Tenant | Canal | Cenário | Resultado | Evidência segura / próxima ação |
| --- | --- | --- | --- | --- | --- |
| 06/10/2026 | Sorte Alta | SMS / Short Brasil | envio unitário autorizado | Pendente de retentativa | Log interno `3ea50444-df91-41bc-8f21-36b982be2631`; três tentativas idempotentes expiraram sem resposta do provedor (8 s). Nenhuma confirmação de envio ou ID externo foi recebido. Investigar conectividade/saúde do Short Brasil antes de novo teste. |
| 06/10/2026 | Sorte Alta | E-mail | envio de teste autorizado | Bloqueado por configuração | Não há remetente ativo/default cadastrado para a tenant. Configurar remetente/domínio e repetir o teste para o destinatário autorizado. |
| 06/10/2026 | Sorte Alta | E-mail / BusinessCode (histórico) | envio de teste autorizado após cadastro do remetente | Provedor removido | Evidência histórica anterior à consolidação. BusinessCode foi removida; os novos testes de e-mail devem usar exclusivamente Infobip com o remetente `contato@bmkt.click`. |
| 06/10/2026 | Sorte Alta | Voz | preparação de chamada autorizada | Substituído pelo aceite de 08/10 | Script ativo de aceite criado (`34b1debe-51ad-4734-b385-9c7edbad11c9`). |
| 08/10/2026 | Sorte Alta | Voz / Infobip CML | chamada controlada para número autorizado | Reprodução aprovada; callback final pendente | Infobip aceitou a solicitação (HTTP 200) e o destinatário confirmou o recebimento e a reprodução do áudio. A correlação do evento final do provedor permanece pendente no histórico (`provider_call_id` `24660544-7de3-426e-8c07-80695e2209f7`); não foi simulada. |
