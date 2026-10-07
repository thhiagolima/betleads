# Escopo de remoção total da BusinessCode e padronização Infobip

**Data:** 06/10/2026  
**Decisão de produto:** e-mail e voz usam exclusivamente Infobip. SMS permanece em Short Brasil. Não haverá fallback para BusinessCode.

## Diagnóstico

A base já contém adaptadores Infobip para e-mail (`src/lib/infobip-email.server.ts`) e voz (`src/lib/infobip-voice.server.ts`). Entretanto, o caminho efetivo ainda é híbrido: e-mail seleciona Infobip apenas por `EMAIL_PROVIDER=infobip` e voz seleciona Infobip apenas por `VOICE_PROVIDER=infobip`; os demais caminhos mantêm BusinessCode como padrão, fallback, identidade de logs, telas ou diagnóstico.

O teste real da Sorte Alta confirmou que o token BusinessCode não existe no ambiente. Esse resultado é coerente com a nova decisão e não deve ser corrigido com uma nova credencial BusinessCode.

## Inventário auditado

### Bloqueadores de runtime — remover/substituir primeiro

| Área | Referências atuais | Ação obrigatória |
| --- | --- | --- |
| Envio de e-mail | `src/lib/email-send.server.ts`, `src/lib/email.functions.ts`, `src/lib/email-automations.server.ts`, `src/lib/journeys.server.ts`, `src/routes/api/public/email-campaigns/tick.ts` | Tornar `callInfobipEmail` o único adaptador; remover `callBusinessCodeEmail`, dispatches BusinessCode e toda seleção/fallback por `EMAIL_PROVIDER`. |
| Voz avulsa/fila | `src/lib/calls.functions.ts`, `src/lib/businesscode-voice.server.ts` | Trocar dispatch e consulta de status para Infobip; eliminar o arquivo do adaptador BusinessCode. |
| Voz em fluxos/jornadas | `src/lib/call-flows.server.ts`, `src/lib/journeys.server.ts` | Remover condicionais `VOICE_PROVIDER` e chamadas BusinessCode; sempre usar `callInfobipVoice`; registrar `provider: infobip`. |
| Webhooks e callback | `src/routes/api/public/calls/businesscode-webhook.ts`, `src/lib/cron-auth.server.ts`, `src/routes/api/public/sms-webhook.ts` | Manter somente callbacks Infobip (`/api/public/infobip/voice/cml` e `/api/public/infobip/voice/events`); remover segredo/compatibilidade BusinessCode. SMS deve aceitar apenas `SHORT_BRASIL_WEBHOOK_SECRET`. |
| Diagnósticos públicos | `src/routes/api/public/diag/businesscode-*.ts`, `src/routes/api/public/diag/call-status.ts` | Remover endpoints BusinessCode e criar, se necessário, diagnósticos Infobip autenticados, sem tokens na resposta. |

### UX, saúde e comunicação

| Área | Referências atuais | Ação obrigatória |
| --- | --- | --- |
| E-mail | `src/routes/email.tsx`, `src/components/provider-auth-banner.tsx`, `src/components/providers-paused-banner.tsx` | Renomear cartões, textos de erro, testes e seletor de provedor para Infobip; eliminar opção `businesscode` e o pseudo-SMTP `businesscode`. |
| Voz | `src/components/ligacoes/providers-tab.tsx`, `bulk-call-tab.tsx`, `dashboard-tab.tsx`, `history-tab.tsx` | Mostrar Infobip, callbacks e regras de áudio corretas; remover instruções, alertas e logs visuais da BusinessCode. |
| Saúde/fila | `src/lib/dispatch-pause-insufficient.server.ts`, `src/lib/provider-health.functions.ts`, `src/lib/send-window.server.ts` | Atualizar nomes, causas de pausa e mensagens para Infobip/Short Brasil; não apresentar a BusinessCode como fornecedor ativo. |

### Configuração, banco e documentação

| Área | Ação obrigatória |
| --- | --- |
| `.env.example` e cofre de segredos | Remover `BUSINESSCODE_EMAIL_TOKEN`, `BUSINESSCODE_VOICE_TOKEN` e `BUSINESSCODE_WEBHOOK_SECRET`; fixar `EMAIL_PROVIDER=infobip` e `VOICE_PROVIDER=infobip`; manter apenas as credenciais Infobip necessárias. |
| Migrations/dados | Criar migration para migrar valores históricos de `businesscode`, `businesscode-email` para `infobip` onde representam o provedor. Não alterar a trilha histórica sem preservar o valor original em auditoria quando exigido. |
| Rotas geradas | Excluir arquivos de rota BusinessCode e regenerar `src/routeTree.gen.ts`; nunca editar o arquivo gerado manualmente. |
| Documentação | Atualizar matriz de aceite, operação segura, escopo de canais e exemplos de deploy. O histórico de evidência poderá mencionar BusinessCode somente como fato passado, nunca como instrução operacional. |

## Entregas e ordem segura

1. **Preparação Infobip:** validar no cofre `INFOBIP_BASE_URL`, `INFOBIP_API_KEY`, `INFOBIP_WEBHOOK_SECRET`, `INFOBIP_VOICE_FROM`, `INFOBIP_VOICE_CALLBACK_TOKEN` e domínio `bmkt.click`; configurar callbacks de voz e entrega de e-mail no painel Infobip.
2. **E-mail exclusivamente Infobip:** refatorar adaptador, campanhas, automações, jornadas, logs e tela; remover fallback BusinessCode. Testar envio, entrega/bounce, descadastro, rastreamento e reprocessamento.
3. **Voz exclusivamente Infobip:** refatorar fila, fluxos e jornadas; migrar callback e polling para eventos Infobip; remover adaptador/webhook BusinessCode. Testar áudio, chamada, evento, duração, retentativa e pausa.
4. **Limpeza integral:** remover rotas, diagnósticos, variáveis, componentes e textos BusinessCode; migrar dados de provedor; regenerar árvore de rotas.
5. **Certificação:** executar a matriz de aceite para Sorte Alta e revisar `rg -i businesscode` até restarem, no máximo, registros históricos explicitamente aprovados.

## Critérios de aceite

- Nenhuma chamada HTTP, import, rota pública, variável ativa ou fallback aponta para `businesscode`/`dash.businesscode.com.br`.
- E-mail só envia por `callInfobipEmail`; voz só envia por `callInfobipVoice`.
- Todos os novos logs registram `provider = infobip` para e-mail e voz.
- Infobip retorna ID correlacionado no log interno; callbacks atualizam status de forma idempotente.
- Envio real de teste para os destinos autorizados, recebimento/callback e cenário de falha transitória validados.
- `npm test`, build, migration remota e health checks aprovados; busca residual documentada.

## Riscos e rollback

- **Risco principal:** credenciais, domínio e callbacks Infobip ainda não validados em produção. Não remover o código BusinessCode antes de os testes Infobip concluírem.
- **Rollback:** pausar e-mail e voz por canal, preservar filas/logs e restaurar o commit anterior apenas se a migração ainda não tiver removido migrations/dados incompatíveis. Não reintroduzir credenciais BusinessCode como solução de contingência.
- **Dependência externa:** acesso administrativo ao painel Infobip para domínio, sender, origem de voz e URLs de callback.

## Situação atual da Sorte Alta

- Remetente padrão cadastrado: `contato@bmkt.click`.
- Script de voz de aceite criado e ativo.
- O teste BusinessCode de e-mail falhou por ausência de token; este não é um bloqueio a corrigir, e sim uma evidência de que a transição para Infobip deve ser concluída.
- Ainda não há evidência de envio/retorno Infobip para e-mail ou voz.
