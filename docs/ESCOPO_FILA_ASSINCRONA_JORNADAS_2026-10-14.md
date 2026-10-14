# Escopo — fila assincrona e processamento confiavel de jornadas

**Data:** 14/10/2026

**Prioridade:** P0 operacional

**Ambientes:** desenvolvimento, homologacao e producao

**Canais envolvidos:** SMS, e-mail e voz

## Progresso da implantacao

Em 14/10/2026 foi iniciada a primeira entrega, ainda fail-closed:

- migration aditiva de `journey_scan_jobs` e RPCs de claim/conclusao/falha;
- scanner com cursor estavel, lease, retomada, lote e upsert idempotente;
- endpoint e cron separados do dispatcher;
- heartbeat em `dispatcher_runs` para scanner e dispatcher;
- flags e tamanhos de lote separados para canario;
- varredura removida do caminho de envio;
- testes de elegibilidade historica, `start_after`, audiencia, PIX e kill switch.

As migrations `20261014123000` e `20261014124000` foram aplicadas no Supabase
remoto em 14/10/2026. A nova rota ainda retornava 404 porque o container da VPS
permanecia na imagem anterior. As flags continuam pendentes de ativacao
controlada; a presenca do schema e do codigo nao autoriza disparos em producao.

## 1. Objetivo

Substituir o tick monolitico de jornadas por um pipeline assincrono, paginado,
idempotente e observavel. O sistema deve descobrir todos os jogadores elegiveis,
criar inscricoes sem duplicidade e processar cada etapa com workers concorrentes,
sem depender da duracao de uma unica requisicao HTTP.

## 2. Diagnostico confirmado em producao

Em 14/10/2026, o cron `betleads-dispatch-journey` estava ativo e executava a
cada minuto. O endpoint respondia HTTP 200, mas com:

```json
{ "enrolled": 0, "claimed": 0, "processed": 0, "failed": 0, "disabled": true }
```

A causa imediata e `JOURNEYS_DISPATCH_ENABLED` ausente ou diferente de `true`
no container de producao. As inscricoes existentes permaneciam vencidas para
execucao e sem `claimed_at`, demonstrando que nenhum worker as reivindicava.

O desenho atual tambem limita a capacidade mesmo depois da ativacao:

- um unico endpoint recupera locks, processa envios e depois varre elegibilidade;
- somente 5 inscricoes sao processadas por chamada;
- a varredura recebe limite 200 e o divide entre todos os tenants;
- com tres tenants, cada um recebe aproximadamente 66 jogadores por minuto;
- a avaliacao percorre jornadas e jogadores em loops sequenciais;
- uma falha ou timeout perde a pagina daquele ciclo ate a rotacao do cursor;
- o sucesso do pg_cron confirma o agendamento do HTTP, nao o processamento da fila;
- `Elegiveis agora` e uma fotografia da regra, enquanto `Na fila` conta somente
  inscricoes ja persistidas. Portanto, os numeros nao convergem imediatamente.

Tambem foram observados timeouts do provedor Short Brasil. Essa falha precisa de
retry e circuit breaker proprios, mas nao explica a fila global parada.

## 3. Arquitetura alvo

```text
cron/orquestrador
  -> cria jobs de varredura por tenant e jornada
  -> scanners paginam jogadores e fazem upsert de inscricoes
  -> fila de etapas recebe itens vencidos
  -> workers por canal reivindicam lotes com SKIP LOCKED
  -> provedor recebe envio idempotente
  -> callback/reconciliacao atualiza estado final
  -> retries e dead-letter preservam falhas
```

Scanner e dispatcher devem escalar de forma independente. Uma indisponibilidade
do provedor nao pode impedir novas inscricoes, e uma varredura grande nao pode
impedir o processamento da fila existente.

## 4. Requisitos funcionais

### RF-01 — Varredura persistente por tenant e jornada

- Criar tabela de jobs/cursors com tenant, jornada, cursor, estado, lease,
  tentativas e timestamps.
- Criar um job por jornada ativa, sem depender de uma unica lista global.
- Paginar por chave estavel (`players.id` ou `(updated_at,id)`), nunca por pagina
  calculada a partir do minuto.
- Persistir o cursor somente depois do lote confirmado.
- Retomar do ultimo cursor apos timeout ou reinicio.
- Reavaliar eventos novos depois de concluir o backfill.

### RF-02 — Inscricao idempotente

- Manter chave unica por jornada, jogador e ocorrencia/regra de reentrada.
- Usar upsert/insert-on-conflict em lote; conflito esperado nao e erro.
- Salvar versao da jornada e motivo/ocorrencia que gerou a inscricao.
- Registrar analisados, elegiveis, inscritos, duplicados e bloqueados por motivo.
- Definir por gatilho se aceita backfill historico ou somente eventos posteriores
  a ativacao.

### RF-03 — Fila de etapas separada

- Materializar o proximo passo executavel sem chamar o provedor no scanner.
- Reivindicar itens atomicamente com `FOR UPDATE SKIP LOCKED` ou RPC equivalente,
  lease com expiracao e identificador do worker.
- Permitir concorrencia configuravel global, por tenant e por canal.
- Garantir ordenacao dentro da inscricao sem serializar tenants distintos.
- Aplicar janela, prioridade, cooldown e limites antes da reserva.

### RF-04 — Workers de canal

- Criar workers separados para SMS, e-mail e voz.
- Aplicar timeout, retry exponencial com jitter e limite de tentativas.
- Usar chave de idempotencia estavel em todas as chamadas ao provedor.
- Tratar timeout como estado desconhecido ate reconciliar pelo identificador ou
  chave idempotente; nao reenviar cegamente.
- Implementar circuit breaker por provedor/tenant.

### RF-05 — Dead-letter e reprocessamento

- Mover falhas definitivas para dead-letter sem apagar a execucao original.
- Exibir motivo normalizado, erro bruto restrito, tentativas e proxima acao.
- Reprocessar como nova tentativa vinculada ao mesmo envio logico.
- Exigir permissao administrativa e auditoria.

### RF-06 — Pausa e kill switches

- Preservar `JOURNEYS_DISPATCH_ENABLED` como kill switch global.
- Adicionar pausa operacional por tenant, jornada e canal.
- Pausar impede novos claims sem apagar fila ou historico.
- Publicar uma jornada nao pode alterar flags de infraestrutura.

## 5. Modelo de dados proposto

### `journey_scan_jobs`

- `id`, `tenant_id`, `journey_id`, `journey_version`
- `mode`: `backfill` ou `incremental`
- `cursor_value`, `status`, `next_run_at`
- `lease_owner`, `lease_expires_at`, `attempts`, `last_error`
- `scanned_count`, `eligible_count`, `enrolled_count`
- `started_at`, `completed_at`, `created_at`, `updated_at`

Restricao: no maximo um job aberto por jornada/versao/modo.

### Evolucao de `journey_step_executions`

- `available_at`, `lease_owner`, `lease_expires_at`
- `provider_idempotency_key`, `provider_state`
- `last_error_code`, `next_retry_at`, `dead_lettered_at`

Os indices devem cobrir estado, vencimento, tenant e canal. As migrations devem
ser aditivas; nenhuma fila existente pode ser truncada ou recriada.

## 6. Fases de implementacao

### P0 — Retomada controlada e observabilidade

- [ ] Configurar a flag no runtime e comprovar o valor no container.
- [ ] Restringir o piloto a tenant/jornada/destinatarios autorizados.
- [ ] Expor ultimo tick, sucesso, duracao, inscritos, claims, processados, falhas
      e backlog vencido.
- [ ] Alertar quando o cron responde `disabled`, quando nao ha heartbeat por 5
      minutos ou quando a fila vencida cresce por 10 minutos.
- [ ] Documentar rollback e responsavel go/no-go.

**Aceite:** o piloto processa uma inscricao uma unica vez, registra a execucao e
para imediatamente ao desligar o kill switch.

### P1 — Scanner assincrono com cursor

- [ ] Criar migration, RPC de claim e repositorio de jobs de varredura.
- [ ] Implementar backfill paginado em lote e incremental continuo.
- [ ] Fazer insert idempotente em lote, com contadores por motivo.
- [ ] Remover a varredura de `runJourneyDispatcher`.
- [ ] Cobrir retomada apos timeout entre leitura, upsert e commit do cursor.

**Aceite:** 100% de uma base de teste com pelo menos 100 mil jogadores e
processada sem perda nem duplicidade; reiniciar o worker continua do cursor.

### P2 — Dispatcher concorrente e justo

- [ ] Separar filas/workers por canal.
- [ ] Tornar concorrencia e lote configuraveis.
- [ ] Aplicar fair scheduling entre tenants.
- [ ] Preservar ordem por inscricao, idempotencia e limites de contato.
- [ ] Recuperar leases orfaos automaticamente.

**Aceite:** dois ou mais workers processam o mesmo backlog sem duplicar envio;
todos os tenants avancam dentro do SLA.

### P3 — Resiliencia de provedor

- [ ] Classificar erros em transitorios, permanentes e estado desconhecido.
- [ ] Implementar retry com jitter, circuit breaker e dead-letter.
- [ ] Reconciliar timeout Short Brasil antes de permitir nova tentativa.
- [ ] Medir aceite, entrega, falha, latencia e throttling por provedor.

**Aceite:** indisponibilidade simulada nao bloqueia scanners nem outros canais;
a recuperacao nao produz mensagens duplicadas.

### P4 — Produto e operacao

- [ ] Mostrar no relatorio: elegiveis, analisados, inscritos, aguardando,
      reivindicados, enviados, bloqueados, retries e dead-letter por etapa.
- [ ] Exibir cursor/progresso do backfill e previsao por throughput real.
- [ ] Adicionar pausa/retomada e reprocessamento auditado.
- [ ] Diferenciar `Elegiveis agora`, `Inscritos` e `Na fila`.

**Aceite:** a operacao identifica pelo produto por que um elegivel ainda nao foi
inscrito ou por que uma inscricao ainda nao foi enviada.

### P5 — Implantacao gradual

- [ ] Executar testes unitarios, integracao, concorrencia e carga.
- [ ] Rodar shadow scan e comparar com a funcao atual sem criar inscricoes.
- [ ] Liberar um tenant/jornada canario com limite baixo.
- [ ] Ampliar 5% -> 25% -> 50% -> 100%, com janela de observacao.
- [ ] Desativar o caminho monolitico somente apos estabilizacao.

**Aceite:** backlog converge sem aumento anormal de falhas, duplicidades,
opt-outs ou contatos fora da janela.

## 7. Metas operacionais iniciais

- Heartbeat do worker: no maximo 2 minutos.
- Inicio de item vencido: p95 menor que 2 minutos sem backoff.
- Scanner: pelo menos 5 mil jogadores/minuto por worker em teste de carga.
- Envio: capacidade configuravel e limitada pelo provedor, nao por constante.
- Duplicidade de envio logico: zero.
- Job sem progresso: alerta em 5 minutos.
- Backlog crescente: alerta em 10 minutos.
- Dead-letter e erro disponiveis por tenant, jornada, etapa e canal.

## 8. Testes obrigatorios

- duas replicas reivindicando simultaneamente;
- crash antes e depois da chamada ao provedor;
- timeout com aceite tardio do provedor;
- reinicio durante backfill e envio;
- conflito de inscricao/reentrada;
- pausa global, por tenant e por jornada;
- consentimento revogado e janela fechada;
- tenant massivo concorrendo com tenant pequeno;
- jornada versionada durante varredura;
- provedor indisponivel e recuperacao do circuit breaker;
- migration e rollback preservando filas existentes.

## 9. Implantacao e rollback

1. Aplicar migrations aditivas com workers novos desligados.
2. Executar shadow scan e reconciliar contagens por tenant/jornada.
3. Ativar scanner canario, mantendo o dispatcher fora do recorte.
4. Ativar um worker/canal com concorrencia minima e destinatario autorizado.
5. Aumentar gradualmente e acompanhar dashboards/alertas.
6. No rollback, desligar novos workers, interromper claims e manter dados/leases
   para diagnostico. Nunca apagar inscricoes ou execucoes.

## 10. Fora de escopo

- alterar copys ou regras comerciais das jornadas;
- trocar o provedor de SMS/e-mail/voz;
- atribuir conversao por modelo probabilistico;
- apagar historico antigo para reduzir backlog.

## 11. Definicao de pronto

O trabalho termina quando elegibilidade, inscricao e envio forem processos
independentes; todos possuirem cursor/lease, idempotencia, metricas, alertas e
rollback; o backlog dos tres tenants convergir dentro do SLA; e a interface
explicar cada divergencia sem consulta manual ao banco.
