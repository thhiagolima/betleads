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
2. `npm run lint`, `npm test` e `npm run build` aprovados. Os três jobs são bloqueantes no CI; avisos de tipagem legada permanecem visíveis, mas erros de lint interrompem a entrega.
3. `npx supabase db push` e `npx supabase db lint --linked` aprovados quando houver migration.
4. Backup, plano de rollback e responsável operacional registrados.
5. Health check em `/`, login, Players, SMS, e-mail, voz (quando ativo) e webhook autorizado.
6. Para qualquer mudança de canal, registrar o resultado na matriz de aceite antes de declarar o canal plenamente funcional.

## Resposta a incidentes dos canais

### Severidade e responsáveis

| Severidade | Exemplo | Ação inicial | Responsável |
| --- | --- | --- | --- |
| Crítica | envio indevido, vazamento, falha total com fila crescendo | pausar o canal e abrir incidente | Operação + dev sênior |
| Alta | provedor indisponível, callbacks não correlacionados, taxa de erro elevada | pausar novas campanhas e preservar a fila | Dev sênior |
| Média | degradação parcial, atraso de worker, template com falha | corrigir/reprocessar com acompanhamento | Operação |
| Baixa | métrica divergente sem impacto de envio | registrar e priorizar na revisão semanal | Gerente de projeto |

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
- **Voz:** mantenha o cron desligado até a chamada real, callback assinado, status final e retentativa serem aceitos. Uma falha não deve disparar nova chamada sem política de frequência e idempotência.

## Critério de retorno à operação

O canal só retorna a produção após haver: credencial válida, envio de prova, callback/status final correlacionado, fila sem itens presos, alerta/monitoramento ativo, rollback disponível e registro de aceite na matriz de canais.

## Rollback Short.io

1. Como administrador do tenant, desative o canal SMS e/ou e-mail em **Links > Configurações** (ou defina `enabled=false`).
2. Novos envios preservam as URLs originais; links `bmkt.click` já enviados continuam válidos e redirecionando.
3. Não apague `tracked_links`, `link_dispatches` ou snapshots durante o rollback: eles são a trilha de auditoria.
4. Após a estabilização, valide o último sync e os logs do canal antes de reativar o tenant.
