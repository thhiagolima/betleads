# Contrato de rastreamento de clique e atribuição

**Versão:** 2.0
**Data:** 15/10/2026 (substitui a v1.0 de 09/10/2026)
**Status:** vigente para links gerados a partir de 14/10/2026

## O que mudou em relação à v1.0

A v1.0 exigia que a casa capturasse `bl_click_id` na página de destino e o devolvesse no webhook. **Isso não é mais necessário nem usado.** O clique passa a ser registrado pelo redirect próprio da BetLeads, e a identidade vem do identificador do jogador que a casa já envia nos webhooks.

| Tema                    | v1.0 (obsoleta)                               | v2.0 (vigente)                                              |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| Prova do clique         | casa devolve `bl_click_id`                    | evento em `click_events` gravado pelo redirect BetLeads     |
| Identidade no webhook   | `bl_click_id` / `utm_content` UUID            | identificador externo do jogador → `players.player_external_id` |
| Parâmetro na URL final  | `bl_click_id` exposto ao destino              | não exposto; destino recebe só as UTMs                      |
| Âncora da janela        | `bl_click_captured_at` ou `sent_at`           | horário exato do clique confirmado                          |
| `utm_content`           | chave técnica de compatibilidade              | somente criativo/mídia; nunca identidade                    |

## Cadeia de evidência

```text
envio (link_dispatches, com recipient_player_id)
  → clique no redirect BetLeads (click_events, horário exato, humano)
  → webhook da casa com o identificador do jogador
  → mesmo player interno do dispatch
  → conversion_attributions (grau A)
```

## URL enviada ao jogador

```text
https://<app>/api/public/click/<tracking_token>?s=<assinatura>
```

- `tracking_token` é opaco, individual por dispatch (tenant, origem, envio, destinatário e posição da URL) e não contém PII.
- `s` é uma assinatura HMAC do token. Token adulterado ou de assinatura inválida responde 404, sem consultar o banco.
- No SMS, essa URL pode ser encurtada pelo Short.io do tenant; o Short.io apenas redireciona para o redirect BetLeads.
- O redirect grava o clique e responde 302 para o destino original com as UTMs (`utm_source=betleads`, `utm_medium`, `utm_campaign`); UTMs preexistentes não são sobrescritas.

## Comportamento esperado da casa

1. Enviar webhooks autenticados (token na URL hoje; HMAC conforme WHK-05 do escopo de escala).
2. Incluir em **todos** os eventos (cadastro, login, depósitos, saques) o mesmo identificador estável do jogador. Na Sorte Alta é `data.userId`.
3. Preservar um `eventId` estável e único por evento (deduplicação).
4. Informar o horário real do evento.

A casa **não** precisa capturar, persistir ou devolver nenhum parâmetro da BetLeads.

## Regras de atribuição

- Só há atribuição com clique first-party confirmado: `click_events.is_human = true`, mesmo tenant, dispatch com `recipient_player_id` igual ao player resolvido no webhook.
- Último clique válido anterior ao evento (`occurred_at` do clique ≤ horário do evento).
- Janela ancorada no horário do clique:
  - até 7 dias: **direta** — única que entra em "recuperado atribuído";
  - de 7 a 14 dias: **assistida**, registrada à parte, nunca somada à receita direta;
  - após 14 dias: fora da janela.
- Snapshot do Short.io é apenas observação (grau B) e nunca gera atribuição.
- Links anteriores a 14/10/2026 (com `bl_click_id`/`utm_content`) não são reatribuídos.

## Segurança e integridade

- Token sem PII; assinatura HMAC; tenant validado pelo dispatch.
- O ledger financeiro registra o depósito independentemente da atribuição.
- `eventId` impede dupla contagem em retries.
- IP e user agent do clique são guardados apenas como hash.

## Certificação por casa

| Casa        | Identificador        | Situação                                          |
| ----------- | -------------------- | ------------------------------------------------- |
| Sorte Alta  | `data.userId`        | certificado com logs reais (63.406/63.407 em 7 dias) |
| ForrandoBet | a definir            | pendente (WHK-03)                                 |
| PixReals    | a definir            | pendente (WHK-03); sem fluxo financeiro observado |

Para certificar uma casa: coletar fixtures reais anonimizadas de cadastro, login, depósito aprovado, depósito pendente e saque; confirmar que todos resolvem para o mesmo player; registrar o caminho do identificador no contrato por tenant.

## Referências

- `src/lib/click-tracking.server.ts` (token, assinatura e redirect)
- `src/lib/conversion-attribution.server.ts` (janela e atribuição)
- `supabase/migrations/20261014201000_create_first_party_click_events.sql`
- `docs/AUDITORIA_TRACKING_ATRIBUICAO_ESCALA_2026-10-14.md`
- `docs/ESCOPO_ESCALA_TRACKING_ATRIBUICAO_2026-10-14.md`
