# Operação segura

## Webhooks

- Use `X-Webhook-Signature: sha256=<HMAC-SHA256 do corpo bruto>` quando o tenant possuir `webhook_secret`.
- Rode rotação do segredo junto ao provedor e valide primeiro em ambiente controlado.
- Nunca registre tokens, segredos ou payloads com dados sensíveis fora da auditoria restrita.

## Retenção e LGPD

- Defina formalmente com o responsável jurídico os prazos de retenção para PII, payload financeiro e logs.
- Restrinja exportações a usuários autorizados e mantenha trilha de auditoria.
- Antes de anonimizar ou apagar dados, valide backups e o impacto em métricas financeiras.

## Deploy

1. Worktree limpo e revisão do diff.
2. `npm run lint`, `npm run typecheck`, `npm test` e `npm run build` aprovados. Os quatro jobs são bloqueantes no CI; avisos de tipagem legada permanecem visíveis, mas erros de lint interrompem a entrega.
3. `npx supabase db push` e `npx supabase db lint --linked` aprovados quando houver migration.
4. Backup, plano de rollback e responsável operacional registrados.
5. Health check em `/`, login, Players, SMS, e-mail, voz (quando ativo) e webhook autorizado.
6. Para qualquer mudança de canal, registrar o resultado na matriz de aceite antes de declarar o canal plenamente funcional.

## Resposta a incidentes dos canais

### Severidade e responsáveis

| Severidade | Exemplo                                                                    | Ação inicial                              | Responsável           |
| ---------- | -------------------------------------------------------------------------- | ----------------------------------------- | --------------------- |
| Crítica    | envio indevido, vazamento, falha total com fila crescendo                  | pausar o canal e abrir incidente          | Operação + dev sênior |
| Alta       | provedor indisponível, callbacks não correlacionados, taxa de erro elevada | pausar novas campanhas e preservar a fila | Dev sênior            |
| Média      | degradação parcial, atraso de worker, template com falha                   | corrigir/reprocessar com acompanhamento   | Operação              |
| Baixa      | métrica divergente sem impacto de envio                                    | registrar e priorizar na revisão semanal  | Gerente de projeto    |

### Procedimento

1. Identifique o tenant, canal, período, IDs de campanha/fluxo e IDs do provedor. Não inclua tokens ou PII em canais públicos.
2. Consulte `dispatcher_runs`, estado de pausa, fila e logs de envio; confirme se o problema é local, de credencial, de saldo ou do provedor.
3. Para risco de envio indevido, pause o canal antes de reprocessar. Preserve logs, eventos e itens de fila para auditoria.
4. Aplique a correção ou o rollback documentado. Reprocesse somente itens idempotentes e elegíveis; nunca recrie envios finalizados sem aprovação operacional.
5. Execute envio de prova para destinatário de teste, valide callback/status final e acompanhe a fila até estabilizar.
6. Registre causa, impacto, correção, evidência e ação preventiva na revisão semanal.

### Regras por canal

- **SMS:** valide saldo, limite de partes, supressão/SAIR, janela de envio e callback Short Brasil antes de reabrir.
- **E-mail:** valide remetente/domínio, supressão/descadastro, URLs/imagens e callback do provedor antes de reabrir.
- **Voz:** mantenha o despacho automático desligado (`VOICE_DISPATCH_ENABLED=false`) até a chamada real, callback assinado, status final e retentativa serem aceitos. O cron de reconciliação pode permanecer ativo porque apenas audita callbacks pendentes; ele não cria chamadas. Uma falha não deve disparar nova chamada sem política de frequência e idempotência.

## Critério de retorno à operação

O canal só retorna a produção após haver: credencial válida, envio de prova, callback/status final correlacionado, fila sem itens presos, alerta/monitoramento ativo, rollback disponível e registro de aceite na matriz de canais.

## Comando operacional no produto

O painel **Campanhas > Operação dos canais** é a fonte única para a primeira triagem. Ele mostra, por tenant e canal, configuração/disponibilidade do provedor, pausa, fila pendente, itens presos, entrega e erros das últimas 24 horas e atraso do último worker.

- **Pausar/retomar:** informe um motivo objetivo. A ação e o usuário ficam registrados em `tenant_audit_logs`.
- **Reprocessar presos:** libera apenas itens do tenant atual cujo lock excedeu o limite seguro; a ação não recria itens finalizados e também é auditada.
- **Atualizar:** espere ao menos um ciclo do worker e confirme queda da fila e ausência de novos erros antes de encerrar o incidente.
- Se o painel estiver indisponível, a pausa no banco é o fallback. Nunca altere status de itens finalizados diretamente.

### Limites para alerta

| Sinal               |         Atenção |                                             Crítico |
| ------------------- | --------------: | --------------------------------------------------: |
| Atraso do worker    | acima de 10 min |                  acima de 20 min com fila crescente |
| Itens presos        |    pelo menos 1 |                 crescimento após um reprocessamento |
| Taxa de erro em 24h |      5% ou mais |                                         20% ou mais |
| Provedor            |   backoff ativo | credencial inválida ou indisponibilidade prolongada |

## Pausa, recuperação e rollback por canal

### SMS

1. Pause SMS no painel e registre campanha, horário e motivo.
2. Confirme créditos, credenciais Short Brasil, limite de partes, janela e supressões.
3. Para lock expirado, use **Reprocessar presos** uma vez e acompanhe `sms_campaigns` e `sms_send_logs`.
4. Se a mudança de aplicação causou a falha, restaure a release anterior mantendo filas e logs. Não apague reservas de crédito.
5. Retome somente após envio unitário autorizado e callback correlacionado.

### E-mail

1. Pause e-mail e preserve campanhas agendadas.
2. Confirme domínio/remetente, credencial Infobip, supressões, links e imagens do snapshot publicado.
3. Reprocesse apenas campanhas com lock expirado; não edite o template publicado para alterar campanhas já criadas.
4. Em rollback, restaure a release anterior e mantenha `template_snapshot`, logs e tokens de descadastro.
5. Retome após renderização desktop/mobile, envio de prova e callback final.

### Voz

1. Pause voz imediatamente em qualquer chamada inesperada. Mantenha `VOICE_DISPATCH_ENABLED=false` até o aceite ponta a ponta; o cron de reconciliação não precisa ser desligado porque não despacha chamadas.
2. Confirme consentimento, janela, cooldown, limite móvel, asset/script versionado e credencial Infobip.
3. Reprocessar presos apenas devolve chamadas em `calling` com lock expirado para a fila; valide idempotência antes de permitir novo despacho.
4. Em rollback, mantenha `VOICE_DISPATCH_ENABLED=false`, restaure a release anterior e preserve áudio, fila e histórico.
5. A retomada automática exige chamada real autorizada, callback assinado, relatório e decisão formal de go/no-go.

## Comunicação e registro

O dono do incidente deve manter uma linha do tempo com: início, detecção, pausa, diagnóstico, correção, teste, retomada e encerramento. A comunicação deve informar impacto e canal afetado sem expor PII, credenciais ou conteúdo de mensagem.

| Momento               | Destinatários                  | Conteúdo mínimo                                                           |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------- |
| Abertura crítica/alta | operação, dev sênior e gerente | tenant, canal, impacto, início e estado da pausa                          |
| Atualização           | mesmos responsáveis            | hipótese, evidência, fila, ação em curso e próximo horário de atualização |
| Retomada              | operação e gerente             | teste executado, métricas estáveis, responsável e plano de observação     |
| Encerramento          | responsáveis e revisão semanal | causa raiz, impacto, correção, evidência, rollback e ação preventiva      |

Nenhum incidente crítico ou alto é encerrado sem dono, causa registrada, evidência de estabilização e ação preventiva com prazo.

## Retenção de ativos de voz

- Áudios ativos permanecem disponíveis enquanto forem usados por campanhas, filas ou jornadas.
- Ao deixar de usar um áudio, arquive-o. O instante é registrado em `archived_at`.
- Preserve o áudio arquivado por no mínimo 90 dias, salvo prazo maior definido pelo jurídico ou por incidente/auditoria.
- A exclusão remove também o objeto do bucket privado e só é permitida quando não existem referências em jornadas ou filas.
- Não execute limpeza automática até que o prazo jurídico do tenant esteja formalizado. Exceções devem indicar responsável, justificativa e evidência na auditoria.

## Rollback Short.io

1. Como administrador do tenant, desative o canal SMS e/ou e-mail em **Links > Configurações** (ou defina `enabled=false`).
2. Novos envios preservam as URLs originais; links `bmkt.click` já enviados continuam válidos e redirecionando.
3. Não apague `tracked_links`, `link_dispatches` ou snapshots durante o rollback: eles são a trilha de auditoria.
4. Após a estabilização, valide o último sync e os logs do canal antes de reativar o tenant.
