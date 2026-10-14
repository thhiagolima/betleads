# Auditoria de tracking, atribuição e escala

**Produto:** BetLeads  
**Data da coleta:** 14/10/2026  
**Escopo:** campanhas, jornadas, links, cliques, login, FTD/redepósito, webhooks, filas, relatórios e infraestrutura  
**Fontes:** código e migrations do repositório; banco de produção Supabase; API da conta Short.io; logs operacionais; documentação oficial dos fornecedores.

## 1. Resumo executivo

O produto ainda não possui uma cadeia de evidência confiável para declarar que uma conversão foi causada por uma campanha ou jornada. O envio está instrumentado, mas a etapa crítica — registrar o clique real e preservar sua identidade até o webhook de conversão — está incompleta.

O diagnóstico inicial de possível reutilização física de links entre campanhas e jornadas foi testado e **não se confirmou nos dados atuais**: 15.753 links utilizados correspondiam a 15.753 disparos e nenhum link tinha disparos de fontes diferentes. A separação lógica por `source_type`, `source_id`, destinatário e token já existe e deve ser preservada.

Os problemas determinantes são:

1. O Short.io fornece, no endpoint usado, estatística agregada por dia. O sistema grava o início do intervalo diário como se fosse o instante real do clique. Isso torna a janela de clique inexata e faz aparecer clique anterior ao envio.
2. A aplicação tentou depender de `bl_click_id`, mas esse parâmetro não precisa voltar dos cassinos: a Sorte Alta envia `data.userId`, que resolve de forma determinística para `players.player_external_id`. Há 18.133 ocorrências legadas de `missing_token` e zero conversões em `conversion_attributions` porque o atribuidor ainda exige o token no webhook.
3. A associação correta é `click_event → link_dispatch → recipient_player_id`; o webhook precisa apenas identificar o mesmo player. `utm_content` continua reservado para mídia/criativo e não deve ser usado como identidade.
4. Apenas Sorte Alta está configurada no Short.io. ForrandoBet e PixReals recebem/processam jornadas sem essa cobertura.
5. Quase todos os disparos de campanha não têm `recipient_player_id`: 14.033 foram enviados, mas apenas um possui vínculo direto com player. Mesmo um clique real não pode ser associado com segurança ao lead na maior parte das campanhas.
6. Há 19.472 inscrições vencidas e enviáveis nas três casas. A última hora completa enviou 2.741 itens, projetando aproximadamente 7,1 horas, se a taxa não cair. Esse desenho não atende dezenas de tenants.
7. O processamento de webhooks é síncrono e concorre com relatórios, scanner, dispatcher e polling de cliques no mesmo banco/aplicação. Já ocorreram timeouts, exaustão do pool e falta de espaço temporário em consultas.
8. Um bug na função `transition_journey_level_on_deposit` inverte `journey_id` e `enrollment_id`. Ele já gerou 109 falhas de `deposito-aprovado` em sete dias.
9. Nenhum tenant tem segredo HMAC de webhook configurado. A rota aceita apenas o token presente na URL quando o segredo está vazio.

**Conclusão:** Short.io pode continuar como encurtador e fonte auxiliar de analytics, mas não deve ser a fonte de verdade da atribuição. A correção estrutural é um redirect próprio da BetLeads, com evento de clique exato e token opaco/assinado ligado ao dispatch. Como todos os destinatários são players existentes, GTM, Stape e devolução de `bl_click_id` pela casa não são necessários. O requisito é persistir `recipient_player_id` em 100% dos disparos e resolver o identificador externo recebido no webhook para o mesmo player interno.

## 2. Semântica obrigatória

Antes de alterar telas, banco ou workers, todos os times devem usar as mesmas definições:

| Métrica               | Definição                                                                   | Fonte de verdade                          |
| --------------------- | --------------------------------------------------------------------------- | ----------------------------------------- |
| Elegível agora        | Player que satisfaz as regras neste instante e ainda pode entrar            | snapshot do scanner com `calculated_at`   |
| Na fila               | inscrição criada e não terminal; separar pronta, futura, pausada e em retry | `journey_enrollments`                     |
| Enviado               | provedor aceitou o disparo                                                  | execução/log do canal                     |
| Entregue              | callback do provedor confirmou entrega                                      | callback do canal                         |
| Enviado rastreado     | envio que contém ao menos um token/link rastreável                          | `link_dispatches`                         |
| Clique observado      | provedor externo informou contagem positiva, sem horário exato              | snapshot Short.io                         |
| Clique confirmado     | redirect BetLeads registrou evento individual com timestamp                 | `click_events`                            |
| Conversão atribuída   | conversão com evidência válida, identidade e janela temporal                | `conversion_attributions`                 |
| Conversão operacional | FTD/redepósito real, mas sem cadeia causal                                  | ledger financeiro; fora do ROI da jornada |

Não somar “conversão operacional” em “recuperado pela jornada”. Ela pode aparecer em uma tela geral de operação, claramente separada e sem associação causal.

## 3. Inventário do que já existe

### Implementado e aproveitável

- Links individuais com token determinístico por tenant, canal, fonte, entrega, destinatário e posição da URL.
- Links individuais com token opaco por dispatch; novos links não expõem `bl_click_id` ao destino.
- Separação de fontes em `source_type` (`campaign`, `journey`, `manual`) e `source_id`.
- Idempotência em `link_dispatches` e nas execuções de jornadas.
- Tabelas de links, disparos, snapshots de clique, execuções de sync e problemas de atribuição.
- Tabela `conversion_attributions` com janela direta de até sete dias e assistida até 14 dias.
- Recebimento de webhooks com deduplicação atômica e tentativa financeira auditável.
- Fila de jornadas com `SKIP LOCKED`, recuperação de claims órfãos, retry exponencial e limite de concorrência.
- Scanner de elegibilidade separado do dispatcher.
- Rota legada de webhook sem tenant desativada com HTTP 410.
- Comparação de HMAC em tempo constante implementada, embora não configurada nos tenants.
- Testes unitários de token, Short.io, scanner, política de jornadas, consentimento e relatórios.

### Parcialmente implementado

- A certificação do identificador externo foi concluída para Sorte Alta; falta executar a mesma coleta de evidência para ForrandoBet e PixReals.
- Short.io sincroniza contagens, mas não eventos individuais de clique.
- O relatório tem estruturas por degrau, mas usa fontes diferentes para “enviado” e “enviado rastreado”.
- A lista de jornadas e o relatório não compartilham o mesmo snapshot de elegibilidade/fila.
- Atribuição por último clique existe, mas o fallback usa um timestamp diário aproximado.
- O dispatcher ganhou lote e concorrência, porém uma chamada pode durar mais de 28 minutos e continuar após o gateway encerrar a requisição.
- O scanner é multi-tenant, mas não há isolamento de capacidade, pesos ou quotas por tenant.
- Há registros de erro e tentativas, mas não há SLO, alertas, DLQ operacional nem console de replay seguro.

### Ausente

- Certificação da estabilidade do identificador externo recebido no webhook para ForrandoBet e PixReals.
- Vínculo de destinatário de campanha com `player_id` ou identidade resolvível.
- HMAC ativo nos webhooks.
- Fila durável externa/assíncrona para ingestão e processamento de webhooks.
- Particionamento/retenção/arquivamento das tabelas de alto volume.
- Observabilidade distribuída com `trace_id` do envio até a conversão.
- Testes E2E multi-tenant e testes de carga/falha.
- Data warehouse ou camada analítica desacoplada do banco transacional.
- Política formal de evidência, reconciliação e correção de números.

## 4. Evidências de produção

Os números abaixo são um snapshot e mudam com o processamento. Nenhum dado pessoal foi incluído neste documento.

### 4.1 Links e cliques

- 15.827 links rastreados no Supabase no momento da primeira coleta.
- 15.827 links com `utm_source=betleads`.
- 14.823 links com `bl_click_id`; cerca de 1.004 links legados têm apenas `utm_content`.
- 15.753 links efetivamente usados tinham exatamente um disparo cada; zero links compartilhados entre fontes.
- Disparos enviados: campanha 14.033, jornada 1.774, manual 3.
- Jornada: todos os disparos possuem `recipient_player_id`.
- Campanha: somente 1 dos 14.033 enviados possui `recipient_player_id`.
- Links com clique positivo: 68 de campanha, 8 de jornada e 1 manual.
- Em todos esses grupos o timestamp armazenado podia aparecer anterior ao envio, pois era o início do bucket diário, não o instante do clique.
- 793 links ativos nunca haviam sido sincronizados; 14.858 estavam há mais de cinco minutos sem sync e 14.123 há mais de uma hora.
- Antes da mudança recente, eram sincronizados cerca de 190–200 links por hora; no primeiro horário após a alteração, 920. Ainda é insuficiente para 15,8 mil links ativos com promessa de “quase tempo real”.
- Execuções de sync observadas: 687 concluídas, 77 falhas e uma em andamento.

### 4.2 Atribuição

- `conversion_attributions`: **0 linhas**.
- `conversion_attribution_issues`: 18.133 linhas, todas `missing_token`.
- `player_attributions`:
  - ForrandoBet: 1.327 linhas, zero `bl_click_id`, zero `utm_content` UUID compatível.
  - Sorte Alta: 11.527 linhas, zero `bl_click_id`, zero `utm_content` UUID compatível; apenas uma coincidência textual com token de dispatch.
- Não houve atribuições de PixReals na coleta.

Isso descreve o estado anterior à Fase 1. A partir de 14/10/2026, novos links passam pelo redirect próprio e novos webhooks somente são atribuídos quando houver um clique first-party confirmado. O legado não é reatribuído automaticamente.

#### Validação posterior do identificador da Sorte Alta

Uma segunda coleta confirmou que o formato atual da Sorte Alta contém `data.userId`, resolvido por `players.player_external_id`:

- últimas 24 horas: 17.873 de 17.873 webhooks com identificador e player interno resolvido;
- últimos sete dias: 63.406 de 63.407 com identificador e player resolvido;
- única exceção: um login de 08/10/2026 classificado como `sem_player`;
- todos os cadastros, depósitos aprovados, depósitos pendentes e saques do período resolveram para player.

Logo, a ausência de `bl_click_id` no webhook não é bloqueadora. O passivo histórico de `sem_player` pertence ao formato legado e deve ser tratado separadamente.

### 4.3 Filas de jornadas

Snapshot de itens vencidos em 14/10/2026:

| Tenant      | Ativos vencidos | Waiting vencidos | Enviáveis vencidos | Pausados por prioridade |
| ----------- | --------------: | ---------------: | -----------------: | ----------------------: |
| Sorte Alta  |           9.473 |            1.162 |             10.635 |                     565 |
| PixReals    |           6.540 |              765 |              7.305 |                     351 |
| ForrandoBet |           1.464 |               68 |              1.532 |                     294 |
| **Total**   |      **17.477** |        **1.995** |         **19.472** |               **1.210** |

Na última hora completa observada, o dispatcher:

- reivindicou 2.750;
- enviou 2.741;
- registrou 9 erros;
- teve duração média de 945.634 ms e máxima de 1.735.117 ms.

A taxa observada projeta 7,1 horas para os 19.472 enviáveis, sem contar novas entradas. O cron chama uma rota HTTP com timeout de 55 segundos, mas os jobs continuam por muitos minutos. Isso cria sobreposição, respostas 504 e dificuldade de saber se o worker morreu ou segue enviando.

Há também divergência de configuração: `.env.example` sugere concorrência 40, mas o código impõe teto 12. A produção usa 12. O limite por lote é 250, apesar da rota chamar `runJourneyDispatcher(1000)`.

### 4.4 Webhooks

Nos últimos sete dias:

- ForrandoBet teve 25 erros de `deposito-aprovado`, 1 de cadastro e 1 de depósito pendente.
- Sorte Alta teve 156 erros de `deposito-aprovado`, 56 de depósito pendente, 18 de login e erros adicionais em cadastro/saques.
- A maior origem não transitória foi a FK de `journey_events`: 86 ocorrências em Sorte Alta e 23 em ForrandoBet.
- Houve ainda `upstream request timeout`, `statement timeout`, `Timed out acquiring connection from connection pool`, respostas HTML de gateway e `JWT issued at future`.
- Sorte Alta acumulou 38.067 logs históricos `sem_player`; apenas um ocorreu nos últimos sete dias, sinal de melhora recente, mas o passivo deve ser explicado/arquivado.
- PixReals não apresentou fluxo de webhook financeiro na coleta, embora tenha jornadas ativas. Isso precisa de validação de integração.

**Bug confirmado:** em `20261008231000_add_journey_level_transitions.sql`, o `INSERT` declara `(tenant_id, journey_id, enrollment_id)` e seleciona `NEW.tenant_id, id, journey_id` da CTE `exited`. O correto é `NEW.tenant_id, journey_id, id`. A inversão faz o banco procurar uma jornada com UUID da inscrição e aborta a transação financeira.

**Segurança:** os seis tenants têm token na URL, mas nenhum possui `webhook_secret`. Logo, a validação HMAC existente nunca é exigida. Tokens em URL podem aparecer em proxy, browser, APM e access logs.

### 4.5 Supabase

- Projeto: `fnonshammxhurrwwqkcp`, região `ca-central-1`, Postgres 17.6, estado saudável na coleta.
- Banco: aproximadamente 1.748 MB; relações públicas: aproximadamente 1.683 MB.
- 31 conexões ativas no snapshot.
- 5.529.483 commits e 833.968 rollbacks acumulados: cerca de 13,1% das transações terminaram em rollback.
- 9.601 arquivos temporários e cerca de 23 GB escritos em temporários acumulados.
- Uma consulta de auditoria não otimizada recebeu `no space left on device` ao criar arquivo temporário. Isso é evidência de risco de spill/headroom, não de que os 1,7 GB de tabelas esgotaram toda a capacidade contratada.
- Maiores relações: `webhook_logs` 432 MB, `sms_send_logs` 390 MB, `events` 242 MB, `deposits` 164 MB, `financial_webhook_attempts` 138 MB e `link_click_snapshots` 89 MB.
- `webhook_logs` tinha ~164 mil linhas vivas e ~25 mil mortas; `deposits`, ~92 mil vivas e ~15 mil mortas.
- O plano da organização aparenta ser Pro, mas o compute e o disco provisionado não puderam ser confirmados por API/CLI. Essa informação deve ser registrada no runbook antes de prometer capacidade.

Segundo a documentação oficial do Supabase, discos pagos crescem automaticamente a 90%, em passos de 50%, limitados a quatro alterações em 24 horas; a 95% sem quota de expansão o projeto pode entrar em read-only. Micro tem CPU compartilhada, 1 GB de RAM e recomendação de até 10 GB; Small 2 GB/50 GB; Medium 4 GB/100 GB; Large passa a 2 vCPU dedicadas, 8 GB/200 GB. O compute real precisa ser confirmado no dashboard antes do load test.

Fontes: [Database and disk size](https://supabase.com/docs/guides/platform/database-size), [Compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk), [Performance tuning](https://supabase.com/docs/guides/platform/performance).

### 4.6 Short.io

Dados da API da organização conectada:

- plano retornado: `large`, mensal;
- 4 domínios;
- 15.952 links, sendo 15.948 pagos;
- 3.991.821 bytes de storage;
- próxima recomposição de limite de links: 27/05/2027;
- domínio BetLeads usado no tenant Sorte Alta: `bmkt.click`;
- limite público atual da API: 50 requisições/segundo em todos os planos.

No mínimo teórico, consultar 15.952 links individualmente a 50 req/s exige cerca de 5,3 minutos, sem latência, retries ou outras chamadas. A configuração atual processa 200 links por minuto; um passe completo exigiria cerca de 80 minutos. Priorizar links recentes reduz a latência dos novos, mas pode deixar links antigos indefinidamente defasados.

O plano público atual chama as camadas Pro, Team e Enterprise; a API devolveu o nome legado/contratual `large`. É necessário confirmar no contrato/dashboard se a conta corresponde a Team/Enterprise e se possui exportação bruta para S3. A página pública informa 99,9% de SLA no Team e exportação de cliques brutos para S3 no Enterprise. Mesmo com exportação, o arquivo diário não atende tracking em tempo real.

Fontes: [Short.io pricing and limits](https://short.io/pricing/?currency=USD), [Short.io API reference](https://docs.short.io/api-reference), [Short.io link/domain usage](https://docs.short.io/articles/managing-your-account-and-domains/manage-your-account/how-to-check-the-number-of-created-short-links-and-domains).

## 5. Causa raiz por fluxo

### 5.1 Envio

`journey_enrollments` → claim SQL → execução do canal → log do provedor → `link_dispatches`.

Pontos frágeis:

- Uma requisição HTTP longa executa centenas de operações e chamadas externas.
- Cron de um minuto não é uma fila; ele apenas dispara o consumidor.
- Não existe backpressure global por provedor nem fairness por tenant.
- O mesmo Postgres atende workload transacional, scanner, relatório, sync e auditoria.
- “Enviado” às vezes é inferido por link rastreado; mensagens sem URL somem desse número.

### 5.2 Clique

SMS/e-mail → Short.io → redirect BetLeads → destino final.

Pontos frágeis:

- A BetLeads não observa o redirect.
- O endpoint consumido retorna série agregada diária.
- `shortio_first_clicked_at`/`last_clicked_at` recebem o timestamp do bucket.
- Polling O(n links) cresce linearmente com o número de disparos.
- Não há evento único, IP/UA hash, bot classification, `occurred_at` exato ou idempotency key de clique.

### 5.3 Identidade e conversão

Cadastro/login/depósito → webhook BetLeads com identificador externo do player.

Pontos frágeis:

- O histórico anterior exigia `bl_click_id`; o novo atribuidor usa somente clique first-party confirmado + `data.userId` resolvido para player.
- `utm_content` tem dupla função: criativo de mídia e compatibilidade de tracking.
- Campanhas quase nunca informam `recipient_player_id`.
- O fallback busca “último clique” por contagem/timestamp aproximado.
- Se a atribuição falha, há caminhos em que o webhook inteiro pode falhar/retry, acoplando ledger financeiro a analytics.

O ledger financeiro precisa ser confirmado independentemente da atribuição. Atribuição é um consumidor assíncrono, nunca uma condição para aceitar o depósito.

## 6. Auditoria por disciplina

### 6.1 Produto e design

#### Problemas

- A mesma palavra representa universos diferentes em lista e relatório.
- “Elegíveis agora” é `—` na lista e cálculo ao vivo no relatório.
- “Na fila” mistura pronto, futuro, pausado e retry.
- “Enviados” mistura envio operacional com envio rastreado.
- Alertas técnicos de sincronização são expostos como erro de negócio ao usuário final.
- Valor financeiro sem evidência aparecia dentro da jornada, induzindo causalidade inexistente.
- Não há indicação de atualização (`dados de X min atrás`) nem nível de confiança.
- Não há drill-down do clique até lead, envio, URL, evento e conversão.

#### Proposta de experiência

Dividir o relatório em dois blocos:

1. **Operação da jornada:** elegíveis, aguardando criação, fila pronta, fila futura, pausados, retries, enviados, entregues, falhas.
2. **Resultado atribuível:** envios rastreados, cliques confirmados, logins pós-clique, FTD/redepósitos atribuídos e valor.

Todo card deve mostrar fonte, definição e `atualizado há`. Dados defasados exibem estado “atualizando”, não um aviso alarmista. Inconsistências internas vão para observabilidade/admin.

No drill-down do clique, exibir:

- lead mascarado e ID;
- tenant, origem e jornada/campanha;
- degrau e canal;
- enviado em, clique em, login em, depósito em;
- janela aplicada;
- evidência A/B/C/D;
- motivo quando não atribuído.

### 6.2 Engenharia

#### P0

- Corrigir a inversão de UUIDs no trigger de mudança de nível e reprocessar os webhooks afetados de forma idempotente.
- Desacoplar sucesso financeiro de sucesso da atribuição/jornada.
- Parar de tratar bucket Short.io como `clicked_at` exato.
- Desabilitar atribuição por fallback com timestamp agregado.
- Configurar e exigir HMAC por tenant, com rotação e período de transição monitorado.
- Unificar “enviado” em execução/log do canal; `link_dispatches` vira “rastreado”.
- Instrumentar queue age, throughput, erro e duração por tenant/jornada/provedor.

#### P1

- Criar redirect first-party: `https://go.betleads.io/r/{token-assinado}`.
- Persistir evento de clique antes do 302 em storage de baixa latência; publicar evento durável para processamento.
- Usar token opaco/assinado, com rotação de chave e sem PII.
- Certificar que o identificador externo de cada tenant resolve para o mesmo player interno em todos os eventos.
- Tornar `recipient_player_id` obrigatório para campanhas e jornadas; falhar antes do envio se o destinatário não puder ser resolvido.
- Criar snapshot materializado de elegibilidade e contadores, atualizado pelo scanner.
- Transformar dispatcher em worker pull contínuo com leases curtos; a requisição cron apenas acorda/escala workers.

#### P2

- Fila durável com DLQ, retry policy e isolamento por tenant/provedor.
- Particionar tabelas de eventos/logs por mês e tenant quando apropriado.
- Política de retenção: quente no Postgres, bruto comprimido em object storage.
- Réplica/read model ou warehouse para relatórios pesados.
- Tracing distribuído com `correlation_id`, `dispatch_id`, `click_id`, `provider_event_id` e `conversion_id`.
- Reconciliação periódica entre provedor, logs, ledger e atribuições.

### 6.3 QA

Cobertura existente é principalmente unitária. Faltam testes de contrato, integração, E2E, carga, caos e recuperação.

Matriz mínima obrigatória:

- mesma URL enviada por campanha e jornada ao mesmo player;
- duas jornadas e uma campanha para o mesmo player;
- múltiplas URLs na mesma mensagem;
- mensagem sem URL;
- clique antes/depois dos limites de 7 e 14 dias;
- clique exatamente no limite e mudança de horário de verão/timezone;
- clique de bot, preview de SMS e múltiplos cliques humanos;
- token ausente, inválido, expirado, adulterado e de outro tenant;
- cadastro sem player, merge posterior e reatribuição;
- login sem depósito, FTD e redepósito;
- webhook duplicado, fora de ordem e reprocessado;
- HMAC ausente, errado, rotacionado e replay de payload;
- Short.io 429/500/timeout e partial batch;
- provedor SMS aceitou, rejeitou, entregou e callback duplicado;
- worker morre após claim, após envio e antes do commit;
- duas instâncias concorrentes e ausência de duplicação;
- tenant ruidoso sem bloquear tenants menores;
- volume de 10, 50 e 100 tenants;
- relatório durante carga sem degradar ingestão;
- replay do bug de nível e regressão da ordem de UUIDs.

Gates de release:

- teste E2E prova envio → clique → login → depósito com evidência A;
- zero conversão atribuída sem evento de clique exato;
- zero envio duplicado em teste de falha;
- p95/p99 dentro dos SLOs por 60 minutos de soak test;
- reconciliação fecha 100% dos eventos de fixture.

### 6.4 Gerência de projeto e operação

Falta um dono explícito para cada fronteira: canal, link, cassino, financeiro, atribuição e relatório. O projeto deve manter RACI e contratos versionados.

Artefatos obrigatórios:

- catálogo de eventos e dicionário de métricas;
- ADR da arquitetura de tracking;
- contrato de webhook por cassino;
- runbook de incidente e replay;
- matriz de tenant × integração × versão × certificação;
- painel de SLO e error budget;
- checklist de onboarding/offboarding;
- política LGPD, retenção e anonimização;
- changelog de regras de atribuição.

## 7. Arquitetura-alvo

```text
Canal (SMS/e-mail/push)
        |
        v
go.betleads.io/r/{token assinado}
        |
        +--> grava click_event exato e idempotente
        +--> publica evento na fila
        +--> 302 para o destino final, sem depender de token no cassino
                              |
                              v
                    cadastro/login/depósito
                              |
                              v
                  webhook autenticado (HMAC)
                              |
                    ACK rápido + fila durável
                              |
              normalização por player externo / ledger
                              |
              atribuição assíncrona e reprocessável
                              |
              read model / relatório / warehouse
```

### Modelo mínimo novo

`click_events`

- `id`, `tenant_id`, `dispatch_id`, `tracking_token_hash`;
- `occurred_at`, `received_at`;
- `ip_hash`, `user_agent_hash`, `bot_classification`;
- `source_type`, `source_id`, `recipient_player_id`;
- `idempotency_key`, `redirect_status`, `trace_id`.

Não é necessária uma camada provisória de `recipient_identities` enquanto a regra de negócio garantir que todos os destinatários já são players. O dispatcher deve resolver telefone/e-mail para `player_id` antes de criar o envio e recusar alvos não resolvidos.

`webhook_inbox`

- payload bruto cifrado/retido por prazo definido;
- assinatura, versão do contrato, provider event ID;
- status, attempts, lease, next retry e DLQ.

### Níveis de evidência

| Grau | Evidência                                             | Uso permitido                        |
| ---- | ----------------------------------------------------- | ------------------------------------ |
| A    | clique first-party exato + token + player + janela    | conversão direta e receita atribuída |
| B    | link individual com contagem externa, horário inexato | clique observado; sem receita causal |
| C    | envio rastreado sem clique confirmado                 | exposição/view-through separada      |
| D    | conversão operacional sem cadeia                      | operação geral; nunca ROI da fonte   |

## 8. Serviços recomendados

Escolher um fornecedor por função; não adotar todos.

| Função                 | Recomendação inicial                 | Alternativas                                            | Decisão                                                            |
| ---------------------- | ------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------ |
| Redirect first-party   | Cloudflare Workers + domínio próprio | AWS CloudFront/API Gateway + Lambda@Edge                | Cloudflare reduz latência e já há configuração Wrangler            |
| Fila durável           | AWS SQS Standard + DLQ               | Cloudflare Queues, Upstash QStash, Supabase Queues/pgmq | SQS para isolamento e escala; pgmq serve como transição            |
| Click/event storage    | DynamoDB para ingestão + export      | Cloudflare D1/Queues, Postgres particionado             | evitar escrita síncrona de cada redirect no Postgres principal     |
| Object storage         | Cloudflare R2 ou AWS S3              | Supabase Storage                                        | bruto de webhooks, clicks e logs com lifecycle                     |
| Erros frontend/backend | Sentry                               | Rollbar                                                 | prioridade alta                                                    |
| Logs e tracing         | OpenTelemetry + Grafana Cloud/Axiom  | Datadog, Better Stack                                   | usar trace IDs ponta a ponta                                       |
| Uptime/synthetic       | Checkly + Better Uptime              | Pingdom                                                 | testar redirect e webhook continuamente                            |
| Produto/feature flags  | PostHog                              | LaunchDarkly/Unleash                                    | analytics, flags e session replay com cuidado de PII               |
| Warehouse              | ClickHouse Cloud                     | BigQuery, Snowflake                                     | adotar após read model/retention; BigQuery é opção simples para BI |
| Secrets                | AWS Secrets Manager ou Doppler       | 1Password Secrets, Supabase Vault                       | retirar secrets de URL/env compartilhado                           |
| Contratos              | JSON Schema + Pact                   | AsyncAPI                                                | versionar o identificador externo e payload por cassino            |
| Carga/E2E              | k6 + Playwright                      | Artillery                                               | integrar ao CI                                                     |

**Firebase:** não é recomendado como segundo backend de autenticação/banco/realtime, pois duplicaria estado e consistência com Supabase. Usar apenas FCM se houver requisito real de push mobile.

**Kafka/Redpanda:** não é necessário agora. SQS/Queues atende o estágio atual. Reavaliar quando houver múltiplos consumidores independentes, replay de alto volume e dezenas de milhões de eventos/dia.

**Short.io:** manter para URL de marca e analytics auxiliar durante a transição. Não usá-lo como relógio ou ledger de clique. Se o contrato atual oferecer exportação bruta S3, ativar como reconciliação, não como caminho crítico.

## 9. SLOs e alertas

| Indicador                            |               Meta inicial |                       Alerta |
| ------------------------------------ | -------------------------: | ---------------------------: |
| redirect p95                         |                   < 150 ms |           > 300 ms por 5 min |
| click disponível no relatório p95    |                      < 5 s |                       > 30 s |
| ACK de webhook p95                   |                      < 2 s |                        > 5 s |
| processamento webhook p95            |                     < 30 s |                      > 2 min |
| idade da fila pronta p95             |                    < 5 min |                     > 10 min |
| duplicação de envio                  |                          0 |          qualquer ocorrência |
| falha de dispatch                    |                       < 1% |               > 2% por 5 min |
| dispatches com `recipient_player_id` |                       100% |            qualquer ausência |
| atribuição sem grau A                |                          0 |          qualquer ocorrência |
| DLQ sem resolução                    |                 0 > 15 min |          qualquer ocorrência |
| staleness de métricas                |         < 60 s operacional |                      > 5 min |
| rollback DB                          | baseline + limite definido |                    desvio 2x |
| disco/temp                           |           < 70% sustentado | > 80% ou crescimento anormal |

## 10. Roadmap e escopo executável

### Fase 0 — contenção (0–3 dias)

**Objetivo:** parar perda financeira, números enganosos e falhas evitáveis.

**Complemento identificado na auditoria da jornada FTD:**

- [ ] Corrigir “Enviados 7d” para usar `completed_at`/`updated_at` quando `executed_at` estiver nulo; cobrir execução terminal com teste de regressão.
- [ ] Rotular “Depósitos” na lista como “Depósitos operacionais”; deixar depósitos atribuídos exclusivamente no relatório com clique confirmado.

- [ ] Corrigir trigger de nível e criar migration de regressão.
- [ ] Identificar/reprocessar 109+ webhooks afetados, com dry-run e idempotência.
- [ ] Tornar ledger financeiro independente da atribuição e das jornadas.
- [ ] Remover timestamp “exato” derivado de bucket diário.
- [ ] Desabilitar fallback de receita pelo último clique Short.io.
- [ ] Alterar UI para “cliques observados” quando a evidência for B.
- [ ] Exibir “enviados” pela execução do canal e “rastreados” em métrica separada.
- [ ] Configurar HMAC nos tenants ativos, rotação e monitoramento.
- [ ] Confirmar compute/disk/plan do Supabase e contrato/plano Short.io.
- [ ] Alertar fila envelhecida, webhook erro/recebido, job > 55 s e sync stale.
- [ ] Reduzir consultas pesadas concorrentes e revisar queries que geram temp spill.

**Aceite:** nenhum depósito falha por lógica de jornada; nenhum valor é atribuído sem grau A; webhooks autenticados; métricas operacionais coerentes.

### Fase 1 — tracking confiável (1–2 semanas)

**Status em 14/10/2026:** migrations aplicadas em produção; ativação depende da publicação desta versão da aplicação.

- [x] Implementar redirect first-party e `click_events`.
- [x] Assinar tokens e proteger contra cross-tenant/replay.
- [x] Fazer Short.io apontar novos links para o redirect BetLeads.
- [x] Certificar a resolução do identificador externo da Sorte Alta com logs reais.
- [ ] Certificar ForrandoBet e PixReals com fixtures e logs reais.
- [x] Bloquear novos dispatches rastreados de campanha sem `recipient_player_id`; campanhas legadas tentam resolver e persistir o player antes do envio, ou são bloqueadas.
- [ ] Implementar read model de relatório e drill-down.
- [ ] Backfill conservador: legado recebe grau B/C/D, nunca A inventado.

**Aceite:** E2E envio → clique → login → depósito funciona por tenant e fonte; p95 de clique < 5 s; nenhuma mistura campanha/jornada.

### Fase 2 — escala e resiliência (2–4 semanas)

- [ ] Migrar dispatch e webhooks para fila durável com DLQ.
- [ ] Workers independentes por canal/provedor, autoscaling e fairness por tenant.
- [ ] Fazer ACK de webhook após validação/persistência mínima.
- [ ] Particionar e definir retention para logs/snapshots/attempts/runs.
- [ ] Arquivar payload bruto em S3/R2.
- [ ] Implementar OpenTelemetry, Sentry e dashboards de SLO.
- [ ] Load test com 10, 50 e 100 tenants e picos simultâneos.
- [ ] Remover jobs HTTP longos; cada unidade de trabalho deve caber no lease/timeout.

**Aceite:** um tenant ruidoso não aumenta p95 dos demais; recovery sem duplicação; fila pronta p95 < 5 min durante carga contratada.

### Fase 3 — analytics e governança (4–8 semanas)

- [ ] Warehouse/read replica e modelos incrementais.
- [ ] Reconciliação diária entre envio, clique, cassino, ledger e atribuição.
- [ ] Multi-touch/assistida apenas após evidência confiável.
- [ ] Holdout/control groups para medir incremento real.
- [ ] Portal de qualidade por tenant e versão da integração.
- [ ] Política LGPD, acesso, retenção e deleção auditável.

## 11. Backlog priorizado

### P0 — bloqueia confiança/operação

1. Trigger de nível com UUIDs invertidos.
2. Ledger financeiro acoplado à jornada/atribuição.
3. Bucket Short.io tratado como timestamp de clique.
4. Ausência de HMAC.
5. Atribuidor ainda depende de `bl_click_id` embora o player já esteja identificado.
6. Campanhas sem `recipient_player_id` persistido.
7. Jobs acima do timeout e backlog com sete horas de projeção.
8. Métrica “recuperado” sem evidência causal.

### P1 — necessário antes de escalar tenants

1. Redirect first-party.
2. Fila durável e DLQ.
3. Snapshot consistente de elegibilidade/fila.
4. Read model para relatórios.
5. Observabilidade e tracing.
6. Retention/particionamento.
7. Certificação do identificador externo por tenant/cassino.

### P2 — maturidade

1. Warehouse.
2. Experimentação/holdout.
3. Multi-touch governado.
4. Forecast de capacidade e chargeback por tenant.

## 12. Riscos e decisões abertas

- Qual é o volume máximo contratado por SMS/e-mail? A velocidade de software não pode violar TPS do provedor ou regras anti-spam.
- Qual compute/disco Supabase está provisionado? Sem isso não há capacidade formal.
- O plano Short.io `large` inclui raw export S3 e SLA contratual? Confirmar por escrito.
- O identificador externo é imutável e consistente entre cadastro, login e eventos financeiros em todos os tenants?
- Qual período legal de retenção de payload, IP hash e eventos financeiros?
- A regra de negócio proíbe definitivamente campanhas para contatos sem `player_id`? A Fase 1 assume que sim e deve bloquear exceções.
- A janela de sete dias usa último clique confirmado, primeiro clique ou regra por objetivo? Deve ser versionada por evento.
- Cliques de bots/previews contam apenas para diagnóstico ou também para taxa bruta? Recomenda-se separar.

## 13. Definition of Done do programa

O trabalho estará concluído quando:

- toda conversão atribuída tiver trilha consultável envio → clique exato → identidade → conversão;
- campanha e jornada nunca compartilhem identidade de atribuição, mesmo usando a mesma URL final;
- nenhum dado operacional sem prova apareça como receita recuperada pela jornada;
- fila, enviados e elegíveis tenham definição única em todas as telas;
- os três tenants produtivos estejam certificados e protegidos por HMAC;
- o sistema sustente o cenário de dezenas de tenants no teste de carga;
- relatórios não concorram com ingestão crítica;
- falhas sejam reprocessáveis, observáveis e sem duplicar envio/financeiro;
- SLOs, runbooks, ownership e alertas estejam ativos.

## 14. Limitações desta auditoria

- O compute e o disco provisionado do Supabase não estavam disponíveis via CLI/API usada; precisam ser confirmados no dashboard.
- O plano Short.io retornou `large`, nomenclatura diferente da página pública atual; limites contratuais devem ser validados com a conta/suporte.
- A auditoria usou snapshots de produção, não um teste de carga controlado.
- Não foi alterado dado de produção nem reprocessado webhook durante esta análise.
- Logs provam sintomas e ocorrências, mas uma revisão de segurança completa deve incluir proxy/CDN, deploy, IAM, backups, secrets e pentest.
