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
2. `npm run build` aprovado.
3. `npx supabase db push` e `npx supabase db lint --linked` aprovados.
4. Backup e plano de rollback registrados.
5. Health check em `/`, login, Players, SMS e webhook autorizado.
