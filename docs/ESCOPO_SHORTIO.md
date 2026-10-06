# Escopo de implantação — Short.io para encurtamento e rastreio de links

> O acompanhamento operacional e o status atualizado desta implantação ficam em
> `docs/PLANO_FECHAMENTO_SHORTIO.md`. Este documento permanece como referência do
> escopo original; decisões posteriores, como a retirada do WhatsApp do rollout,
> estão registradas no plano de fechamento.

## 1. Objetivo

Integrar a **Short.io** ao BETLEADS para que toda URL HTTP(S) enviada pelo CRM
seja substituída por uma URL curta, de domínio controlado pela operação, e possa
ser atribuída ao respectivo envio, contato, canal e contexto comercial.

O resultado esperado é responder, no próprio CRM:

- qual link foi enviado, para quem, quando e por qual canal;
- quantos links foram entregues e quantos receberam clique;
- quais campanhas, fluxos, jornadas, templates e CTAs geram mais engajamento;
- quais contatos já clicaram, para uso em segmentação e automações futuras.

O escopo não deve expor chaves da Short.io no navegador, nem gravar PII (telefone,
e-mail, nome ou ID externo do jogador) na URL, slug, parâmetros UTM ou tags da
Short.io.

## 2. Diagnóstico da base atual

O CRM é uma aplicação TypeScript/TanStack Start com Supabase e múltiplos
dispatchers de backend. Já há logs de envio por canal, isolamento por `tenant_id`
e renderização de variáveis de jogador no servidor.

### Canais e pontos de integração identificados

| Canal | Pontos atuais de envio | Ponto de acoplamento proposto |
| --- | --- | --- |
| SMS | teste, envio manual, campanhas imediatas/agendadas, fluxos SMS, jornadas e SMS de fluxos de ligação | `sendSmsInternal`, imediatamente antes da chamada ao provedor Short Brasil |
| WhatsApp | inbox/manual, automações, pré-call e jornadas/fluxos que enviam bloco de texto | serviço único de normalização antes de `Evolution /message/sendText`; adaptar também `sendFlowBlock` |
| E-mail | teste, campanha, automações/fluxos e jornadas | transformação de HTML antes de `callBusinessCodeEmail` / `callBusinessCodeEmailDispatch` / Infobip |
| Voz | ligações por BusinessCode/Infobip | fora do encurtamento por não transportar link clicável; incluir apenas o SMS complementar já coberto |

Hoje as variáveis `{link}` e `{link_deposito}` têm destino fixo em
`template-vars.server.ts`. Há também URLs livres inseridas pelo usuário em textos
de SMS/WhatsApp e em atributos `href` de e-mail. Portanto, tratar apenas as
variáveis existentes não atende ao requisito: o mecanismo deve localizar e trocar
**todas as URLs HTTP(S) elegíveis** no conteúdo final renderizado.

## 3. Decisões de produto que devem ser confirmadas antes do desenvolvimento

1. Domínio curto: aprovar um domínio/subdomínio de marca por tenant ou um domínio
   corporativo compartilhado (ex.: `go.marca.com`). O domínio precisa estar
   configurado e validado na Short.io antes do piloto.
2. Modelo de conta: uma conta/domínio Short.io central ou credenciais/dominios por
   tenant. A recomendação é configurar por tenant quando cada operação possuir
   marca e domínio próprios; somente superadministradores podem alterar essa
   configuração.
3. URLs elegíveis: por padrão, apenas `http`/`https`, com bloqueio de endereços
   internos, localhost, IPs privados e esquemas como `javascript:`, `data:`,
   `file:`, `mailto:` e `tel:`.
4. Granularidade: a recomendação é **um link por destinatário, por URL, por
   mensagem enviada**. Isso dá atribuição individual sem colocar identificadores
   pessoais na URL. Caso o custo/limite do plano seja impeditivo, poderá haver
   modo alternativo “por campanha + CTA”, explicitamente sem atribuição individual.
5. Retenção: definir retenção de dados de clique granular (sugestão: 13 meses) e
   de agregados (sugestão: 25 meses), conforme política LGPD e contrato.
6. Consentimento e comunicação: validar com Jurídico/DPO a base legal, a política
   de privacidade, o opt-out de SMS/e-mail e a comunicação de medição de cliques.

## 4. Arquitetura funcional proposta

```text
template/conteúdo + variáveis do jogador
                 |
                 v
      renderização final no servidor
                 |
                 v
   extrator de URLs + política de elegibilidade
                 |
                 v
  registro "link a enviar" (idempotente, no Supabase)
                 |
                 v
       cliente servidor da Short.io (POST /links)
                 |
                 v
troca da URL pelo shortURL e envio pelo provedor de canal
                 |
                 +------> log do envio vinculado aos links

job de sincronização Short.io ----> snapshots/agregados de cliques ----> CRM
```

### Princípios técnicos

- A API key secreta fica exclusivamente em variável de ambiente do servidor.
- A Short.io cria links pelo endpoint `POST https://api.short.io/links`, com
  `Authorization` no header, `originalURL`, `domain` e `allowDuplicates: false`.
  O retorno relevante é `id`/`idString` e `shortURL`.
- O CRM gera um `tracking_token` aleatório (UUID/ULID) e associa-o no banco; ele
  pode ser usado em `utm_content` ou tag técnica, mas nunca o ID do jogador ou
  contato em texto claro. O token também deve ser ignorado pelo destino se a
  URL final já possuir UTMs de campanha.
- A criação precisa ser idempotente por `tenant + envio + posição_da_URL`. Retries
  não podem criar um segundo link nem reenviar a mensagem.
- A Short.io é dependência externa: em falha transitória, usar retry limitado com
  backoff e fila de tentativa; em falha definitiva, registrar erro e **não enviar
  a URL longa silenciosamente** no modo obrigatório. Um feature flag por tenant
  permite fallback controlado durante o piloto.
- O conteúdo persistido/logado deve manter a versão original e a versão efetiva
  enviada, pois a curta é a prova do clique e a original é necessária à auditoria.

## 5. Serviço de domínio a desenvolver

Criar `shortio.server.ts` e `link-tracking.server.ts` como a única porta de saída
para a Short.io. Nenhum canal deve chamar a API diretamente.

### Responsabilidades

1. Validar e normalizar a URL (preservando query string e fragmento).
2. Decidir se a URL deve ser encurtada: allowlist de domínios de destino,
   bloqueio de URL já pertencente ao domínio curto e exclusão de links técnicos
   de descadastro, opt-out, login de uso único e URLs assinadas/expiráveis.
3. Criar/recuperar o link curto idempotente.
4. Persistir a relação entre destino, Short.io, contexto do disparo e destinatário.
5. Reescrever texto simples com segurança (SMS e WhatsApp).
6. Reescrever somente atributos navegáveis de HTML (`a[href]`; opcionalmente botões
   VML) sem alterar imagens, CSS, pixels, `mailto`, `tel` ou o link de descadastro.
7. Aplicar UTMs com política de precedência: valores definidos pelo usuário não
   são sobrescritos; campos ausentes recebem `utm_source`, `utm_medium`,
   `utm_campaign` e `utm_content` padronizados.
8. Expor métricas e falhas em logs estruturados, sem chave/telefone/e-mail.

## 6. Modelo de dados proposto

As tabelas abaixo devem ter `tenant_id`, RLS alinhada às políticas existentes,
índices por tenant/data e auditoria de alterações de configuração.

| Entidade | Campos essenciais | Finalidade |
| --- | --- | --- |
| `shortio_settings` | `tenant_id`, `enabled`, `domain`, `domain_id`, `api_key_ciphertext` ou referência de segredo, `default_ttl_days`, `fallback_mode`, `allowed_destination_hosts` | configuração por tenant; nunca devolver a chave ao cliente |
| `tracked_links` | `id`, `tenant_id`, `shortio_link_id`, `short_url`, `original_url`, `canonical_url_hash`, `path`, `status`, `created_at`, `expires_at`, `last_synced_at` | inventário de links Short.io e deduplicação técnica |
| `link_dispatches` | `id`, `tenant_id`, `tracked_link_id`, `tracking_token`, `channel`, `recipient_player_id`, `recipient_hash`, `source_type`, `source_id`, `message_log_type`, `message_log_id`, `url_position`, `original_url`, `sent_url`, `send_status`, `sent_at` | ligação entre um clique e o envio/contexto do CRM |
| `link_click_snapshots` | `id`, `tenant_id`, `tracked_link_id`, `snapshot_at`, `clicks`, `human_clicks`, `payload` | séries de métricas agregadas e reprocessáveis |
| `link_click_events` (opcional) | `id`, `tenant_id`, `tracked_link_id`, `occurred_at`, `event_fingerprint`, atributos minimizados do clique | eventos brutos, somente se a API/plano retornar dado suficiente e a aprovação LGPD existir |
| `link_tracking_sync_runs` | `id`, `tenant_id`, `started_at`, `finished_at`, `status`, `cursor`, `links_processed`, `error` | observabilidade e retomada do sincronizador |

`link_dispatches` deve referenciar os logs existentes onde houver uma chave
adequada: `sms_send_logs`, `email_send_logs`, `whatsapp_messages` e execuções de
jornada. Onde o schema atual não disponibilizar ID no momento de envio, acrescentar
um `message_tracking_id` nos logs antes de chamar o provedor.

## 7. Regras de atribuição e taxonomia

Campos obrigatórios para cada `link_dispatch`:

- `channel`: `sms`, `whatsapp` ou `email`;
- `source_type`: `manual`, `test`, `campaign`, `sms_flow`, `email_flow`,
  `whatsapp_flow`, `journey`, `precall` ou `call_flow_sms`;
- `source_id`: ID da campanha/fluxo/jornada/template quando aplicável;
- `recipient_player_id`: interno, opcional para destinatários não vinculados;
- `url_position`: ordem da URL no conteúdo; e
- `sent_at` e estado final do envio.

UTMs recomendadas:

| Parâmetro | Valor padrão |
| --- | --- |
| `utm_source` | `betleads` |
| `utm_medium` | `sms`, `whatsapp` ou `email` |
| `utm_campaign` | slug estável da campanha/fluxo/jornada; `manual` quando não houver origem |
| `utm_content` | token opaco de dispatch/CTA, sem PII |

O painel deve reportar “cliques” como métrica da Short.io e “contatos que
clicaram” somente quando houver associação inequívoca do link individual. Não
inferir conversão financeira apenas a partir de um clique.

## 8. Alterações por canal

### SMS

- Renderizar variáveis primeiro e extrair todas as URLs do conteúdo final.
- Criar links antes da reserva/envio ao provedor; associar cada um ao log
  `sms_send_logs` e preservar o texto efetivamente enviado.
- Recalcular e exibir caracteres e segmentos após o encurtamento na prévia;
  link curto pode reduzir custo, mas a mensagem final é a fonte de verdade.
- Aplicar tanto a envios individuais/testes como a campanhas, fluxos, jornadas e
  notificações SMS originadas em fluxos de ligação.

### WhatsApp

- Cobrir o envio do inbox/manual e os blocos `text` das automações e pré-call.
- Renderizar antes de encurtar nos fluxos, pois as variáveis dependem do jogador.
- Persistir o texto curto efetivamente enviado em `whatsapp_messages` e ligar cada
  URL a `message_id`/`evolution_message_id` quando disponível.
- Não alterar URLs de mídia assinada usadas internamente para a Evolution e não
  tentar encurtar anexos sem URL textual/caption elegível.

### E-mail

- Renderizar variáveis por destinatário e reescrever links por destinatário antes
  de sanitização/absolutização e antes de cada entrega ao provedor.
- Cobrir `a[href]` do HTML, inclusive CTAs criados pelo editor; texto cru de URL
  pode ser tratado opcionalmente apenas se houver regra clara para não quebrar
  conteúdo HTML.
- O disparo em lote existente não pode compartilhar um único HTML se a exigência
  for rastreamento individual. Nesse modo, substituir a chamada bulk por envios
  individuais, em lotes com concorrência limitada; manter o bulk somente no modo
  agregado por campanha.
- Excluir links de descadastro e links de imagens/pixels do encurtamento.

## 9. Sincronização e análise de cliques

A documentação atual da Short.io disponibiliza estatísticas por link, incluindo
`POST /statistics/link/{linkId}/by_interval`, e listas de cliques recentes por
domínio, além de métricas de cliques humanos por domínio. A integração deve usar
pull periódico; webhooks de clique não são pressupostos neste escopo sem validação
contratual/documental da conta.

- Job autenticado a cada 15 minutos para links recentes/ativos; diariamente para
  reconciliação dos últimos 7 dias (atrasos, bots e reclassificações).
- Para painéis, consumir snapshots agregados; para evento individual, somente
  armazenar atributos aprovados pela LGPD e deduplicar por fingerprint.
- Salvar cursor/data de corte, proteger sobreposição com lock e tornar o job
  reiniciável.
- Criar métricas: links criados, falhas de encurtamento, mensagens com link,
  cliques totais, humanos, CTR de entrega, CTR por canal/origem/CTA e contatos
  únicos que clicaram.

## 10. Interfaces e relatórios

1. **Configurações > Rastreamento de links** (admin): status da integração,
   domínio, conexão validada, modo individual/agregado, TTL, allowlist, fallback
   e último sync. A chave jamais é reexibida.
2. **Prévia de envio**: URL original → curta, quantidade de links e impacto de
   segmentos SMS; aviso para URLs inelegíveis/falhas.
3. **Detalhe de campanha/fluxo/jornada**: enviados, entregues, links enviados,
   cliques, CTR e top CTAs; filtros de data/canal.
4. **Ficha do jogador**: histórico de links enviados e último clique atribuído,
   sujeito às permissões do tenant.
5. **Fila de exceções**: falhas de criação/sync, tentativas, mensagem associada e
   ação de reprocessar por usuário autorizado.

## 11. Segurança, privacidade e conformidade

- Guardar a chave em secret manager/variável de ambiente. Caso seja por tenant,
  criptografar em repouso com chave de aplicação dedicada e desencriptar apenas
  no processo servidor autorizado.
- Nunca registrar header `Authorization` nem URLs assinadas completas em logs.
- Validar destino contra SSRF/open redirect: só `https`/`http`, DNS/host seguro,
  lista de destinos permitidos por tenant quando possível e bloqueio de rede
  privada/local.
- Usar 302/307 enquanto o destino puder mudar; 301/308 somente para links
  verdadeiramente permanentes. Definir TTL e URL expirada por categoria.
- Aplicar RLS por tenant e RBAC para configuração, auditoria e reprocessamento.
- Documentar finalidade, retenção e atendimento a solicitações LGPD; o token de
  atribuição é pseudônimo, não elimina a necessidade de proteção de dados.

## 12. Resiliência e operação

- Limitar concorrência da criação de links e respeitar os limites da Short.io
  (a referência atual expõe 20 req/s para update; validar os limites do plano
  para criação antes do go-live).
- Timeout curto, até 3 retries para 429/5xx/rede com backoff e jitter; nenhuma
  repetição para erro de validação/4xx definitivo.
- Circuit breaker por tenant/domínio e alertas para erro elevado, fila acumulada,
  sync atrasado e taxa de clique anômala.
- Feature flags: global, por tenant, por canal e por modo de atribuição; rollback
  desativa reescrita para novos envios sem invalidar links já enviados.
- Backfill não é recomendado para mensagens históricas: não há como substituir
  URL já entregue. Importar apenas métricas de links Short.io preexistentes quando
  houver mapeamento confiável.

## 13. Plano de entrega

| Fase | Entregas | Critério de aceite |
| --- | --- | --- |
| 0. Descoberta (2–3 dias) | credenciais, domínio, plano/limites, política LGPD, inventário de destinos e decisão individual/agregado | decisões da seção 3 aprovadas |
| 1. Fundação (3–4 dias) | migrations, RLS, client Short.io, segredo, health check, idempotência, auditoria e testes unitários | link de teste criado sem vazar chave/PII |
| 2. SMS e WhatsApp (4–6 dias) | reescrita, logs, prévia, fluxos/campanhas/manual e feature flags | mensagem final tem URL curta; reprocessamento não duplica |
| 3. E-mail (4–6 dias) | parser/rewrite HTML, envio individual quando aplicável, campanha/fluxos/teste | CTAs curtos funcionam e descadastro não é alterado |
| 4. Métricas (3–5 dias) | sync, snapshots, painel, ficha do jogador e alertas | números reconciliam com Short.io em janela definida |
| 5. Piloto e rollout (5–7 dias) | tenant/canal piloto, carga, monitoramento, treinamento e expansão gradual | CTR, entregabilidade e erros dentro das metas |

Estimativa: **21 a 31 dias úteis** para produção, condicionada à disponibilidade
do domínio, acesso à Short.io, decisão de granularidade e homologação dos canais.
O rastreamento individual de e-mail aumenta custo/tempo por exigir personalização
e entrega individual em vez de lote compartilhado.

## 14. Testes e critérios de aceite globais

- Cada URL elegível em SMS, WhatsApp e e-mail vira uma URL curta HTTPS do domínio
  do tenant, com destino e query string preservados.
- Links já curtos e URLs não elegíveis não são recriados nem alterados.
- Um mesmo retry não cria outro link, não duplica `link_dispatch` e não reenvia a
  mensagem.
- As páginas de destino recebem UTMs esperadas sem substituir UTMs informadas.
- O clique sincronizado é visível no recorte correto de tenant, canal, campanha e
  jogador, sem cross-tenant leakage.
- Opt-out/descadastro, links de login único, mídia assinada e URLs internas não
  são encurtados por padrão.
- Queda/429 da Short.io deixa evidência rastreável e segue a política de fallback
  configurada; não há segredo ou PII sensível nos logs.
- Testes abrangem URL com query/fragmento, HTML malformado, múltiplas URLs,
  caracteres Unicode, mensagens no limite SMS, destinatário sem player, lotes,
  concorrência, retries, RLS e rollback por feature flag.

## 15. Itens fora deste escopo

- Alterar URLs já recebidas por usuários ou atribuir retroativamente cliques de
  mensagens históricas sem mapeamento confiável.
- Garantir conversão após o clique (depende de eventos do site/plataforma de
  destino, a ser tratado em projeto separado de atribuição).
- Encurtar anexos, áudio de ligação, mídia de WhatsApp ou URLs técnicas internas.
- Migrar o provedor SMS, WhatsApp, e-mail ou voz.

## Referências técnicas

- [Short.io — criação de links](https://developers.short.io/docs/creating-your-first-short-link)
- [Short.io — referência de criação/atualização](https://developers.short.io/reference/post_links)
- [Short.io — estatísticas por link](https://developers.short.io/reference/postlinklinkidby_interval)
- [Short.io — cliques recentes por domínio](https://developers.short.io/reference/postdomaindomainidlast_clicks)
