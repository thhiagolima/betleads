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

> Não habilite cron/automação de voz até concluir todos os itens abaixo.

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

