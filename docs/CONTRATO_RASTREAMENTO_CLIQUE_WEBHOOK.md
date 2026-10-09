# Contrato de rastreamento de clique e atribuição

**Versão:** 1.0

**Data:** 09/10/2026

**Status:** implementação iniciada, aguardando homologação com a casa

## Objetivo

Vincular de forma determinística um clique originado por SMS ou e-mail da BetLeads aos eventos posteriores enviados pela casa, sem reutilizar campos de marketing como identificadores técnicos.

## URL enviada ao jogador

A BetLeads acrescenta os parâmetros ausentes de campanha e sempre define um identificador técnico individual:

```text
https://casa.example/cadastro
  ?utm_source=betleads
  &utm_medium=sms
  &utm_campaign=<uuid-da-campanha-ou-jornada>
  &utm_content=<criativo-existente-ou-token-legado>
  &bl_click_id=<uuid-do-dispatch>
```

- `bl_click_id` é a chave canônica de atribuição e deve ser persistida pela casa.
- `utm_content` não deve ser interpretada como chave técnica no contrato novo. Ela permanece aceita quando contiver um UUID para compatibilidade com links anteriores.
- UTMs preexistentes não são sobrescritas.
- Um novo envio ao mesmo jogador recebe seu próprio `bl_click_id`; retries do mesmo envio reutilizam o identificador.

## Comportamento esperado da casa

Ao abrir a página de destino, a casa deve:

1. capturar `bl_click_id` e o horário UTC da captura;
2. manter o último clique válido durante cadastro/login;
3. associá-lo ao jogador no cadastro;
4. devolver os campos no webhook de cadastro e, quando possível, nos eventos seguintes;
5. preservar um `eventId` estável e único por evento.

Payload recomendado:

```json
{
  "eventId": "signup-123",
  "occurredAt": "2026-10-09T14:35:00Z",
  "data": {
    "playerId": "player-456",
    "tracking": {
      "bl_click_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bl_click_captured_at": "2026-10-09T14:30:00Z",
      "utm_source": "betleads",
      "utm_medium": "sms",
      "utm_campaign": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "utm_content": "video-01"
    }
  }
}
```

Também são aceitos os nomes camelCase `blClickId` e `blClickCapturedAt`, nos objetos `data`, `data.tracking` ou `data.signupAttribution`.

## Janela e precedência

- Campo canônico: `bl_click_id`.
- Compatibilidade: `utm_content` somente quando for UUID válido.
- Eventos sem token podem reutilizar o `bl_click_id` persistido no jogador durante o cadastro.
- A janela começa em `bl_click_captured_at` quando o horário for válido, posterior ao envio e não estiver no futuro em relação ao evento.
- Na ausência de horário válido, a janela começa em `sent_at` e o registro fica marcado com `attribution_window_anchor=sent_at`.
- Dias 0–7: atribuição direta.
- Após 7 e até 14 dias: atribuição assistida.
- Após 14 dias: fora da janela.

## Segurança e integridade

- O token não contém PII.
- A resolução exige o mesmo tenant.
- Quando o dispatch já possui jogador, o webhook precisa resolver para o mesmo jogador.
- Somente dispatches enviados de campanha ou jornada com UUID válido são atribuídos.
- A chave única do evento impede dupla contagem em retries.
- Horários de captura anteriores ao envio ou posteriores ao evento são ignorados.

## Homologação necessária

Antes de ativar como fonte oficial de receita, validar com payloads reais:

1. cadastro com `bl_click_id` e `bl_click_captured_at`;
2. depósito posterior sem repetir o token;
3. novo clique do mesmo jogador substituindo o clique anterior;
4. URL com `utm_content` de criativo preservado;
5. retry do mesmo webhook sem duplicação;
6. eventos nas fronteiras de 7 e 14 dias.

## Implantação

1. Aplicar a migration `20261009130000_add_betleads_click_attribution.sql`.
2. Publicar a aplicação que gera e recebe `bl_click_id`.
3. Homologar a captura com a casa em ambiente controlado.
4. Monitorar eventos sem token e eventos usando fallback `sent_at`.
5. Tornar a nova atribuição oficial somente depois da evidência ponta a ponta.
