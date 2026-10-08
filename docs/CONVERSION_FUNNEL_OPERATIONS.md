# Funil de conversão — operação e rollback

## Modelo publicado

- Origem rastreável: campanha ou jornada com UUID válido e existente no mesmo tenant.
- Atribuição principal: último link rastreado, janela inclusiva de 7 dias.
- Atribuição assistida: dias 8 a 14, sempre exibida separadamente.
- Idempotência: um evento do provedor e um envio lógico contam apenas uma vez.
- Receita: valor do depósito aprovado; FTD é identificado pelo campo `isFtd` do webhook.
- Dados individuais e CSV: somente admin do tenant ou super admin, com evento de auditoria.
- Experimentos: divisão determinística 50/50; a variante permanece estável por destinatário.

## Webhooks esperados

Os eventos `auth.signup.success`, `auth.login.success` e
`payments.deposit.completed` usam `data.userId`. O cadastro captura
`data.signupAttribution.utmContent`; login e depósito reutilizam a atribuição
armazenada do jogador. Eventos sem token, token sem envio, origem inválida ou
envio ainda não confirmado geram alertas sem armazenar o payload ou PII.

## Monitoramento

O relatório alerta envios preparados há mais de 30 minutos, sincronização de
cliques atrasada e rejeições de atribuição nas últimas 24 horas. Cliques são
agregados pelo provedor e não são apresentados como pessoas únicas.

## Rollback seguro

1. Pause novos envios rastreados e experimentos ativos.
2. Reverta primeiro o código para a versão anterior.
3. Preserve `conversion_attributions`, auditoria e snapshots para rastreabilidade.
4. Se a migration `20261008210000` precisar ser revertida, remova apenas o
   trigger `trg_validate_conversion_dispatch_source` e as duas colunas de etapa
   depois de confirmar que nenhuma integração as utiliza. A tabela de alertas
   pode ser mantida sem efeito funcional.
5. Nunca reescreva snapshots de funil publicados; crie uma nova campanha ou
   revisão de jornada.
