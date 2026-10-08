# Escopo — Jornadas cruzadas e progressão de níveis

## Objetivo

Permitir que um jogador participe de jornadas de nível e de comportamento sem receber mensagens conflitantes, duplicadas ou fora de contexto.

O sistema deve tratar o nível como estado atual do jogador e as jornadas comportamentais como ações temporárias que podem coexistir com esse estado.

## Público-base

Campanhas e jornadas podem usar o público automático **Todos os leads**. Ele representa todos os jogadores cadastrados no tenant atual e é recalculado dinamicamente.

No caso de jornadas, esse público é apenas a base elegível: o jogador só entra após cumprir o gatilho de entrada. Consentimento, bloqueios e disponibilidade do canal continuam sendo validados no momento do envio.

## Progressão de níveis

Os níveis são calculados pelas faixas configuráveis de total depositado do tenant.

| Nível | Faixa padrão |
| --- | --- |
| Novato | Abaixo de R$ 10 |
| Bronze | R$ 10 a R$ 199,99 |
| Prata | R$ 200 a R$ 499,99 |
| Ouro | R$ 500 a R$ 999,99 |
| Diamante | R$ 1.000 a R$ 2.999,99 |
| Black VIP | R$ 3.000 ou mais |

As jornadas Bronze, Prata, Ouro, Diamante e Black pertencem à família exclusiva `progressao_niveis`.

### Regras

1. A mudança só é calculada a partir de depósito aprovado.
2. O jogador entra diretamente no nível resultante. Um depósito que atravesse várias faixas não percorre jornadas intermediárias.
3. Quando o nível muda, a jornada do nível anterior é encerrada imediatamente com o motivo `level_changed`.
4. A jornada do novo nível é iniciada com o histórico da transição (`nivel_anterior`, `nivel_atual`, depósito causador e data).
5. Cada nível só pode gerar uma entrada por jogador, exceto se uma futura configuração de reentrada autorizar o contrário.
6. Um jogador que fez o primeiro depósito abaixo de R$ 10 deixa a jornada “Cadastrou e não depositou”, mas permanece Novato. Uma jornada específica de Novato pode ser criada para cobrir esse caso.

## Jornadas cruzadas

Jornadas comportamentais não pertencem à família de níveis e podem coexistir com ela. Exemplos:

- Sumiu depois de depositar
- PIX gerado e não pago
- Saque pago
- Cashback — Reativação Automática

Coexistir não significa enviar mensagens ao mesmo tempo. O envio deve passar por uma arbitragem central.

### Resultado recomendado para conflitos

Quando duas jornadas possuem uma mensagem pronta para o mesmo jogador e canal:

1. A mensagem com maior prioridade é enviada.
2. A outra jornada fica em estado `paused_by_priority`, com o motivo e a jornada vencedora registrados.
3. Após a conclusão ou saída da jornada vencedora, a jornada pausada é reavaliada.
4. Ela só volta a executar se o jogador ainda satisfizer suas regras de entrada e saída.

Exemplo: um jogador Bronze fica inativo. A jornada “Sumiu depois de depositar” pode assumir prioridade; a sequência Bronze é pausada. Se ele continuar Bronze e inativo após a conclusão da retenção, a sequência Bronze pode ser retomada.

## Prioridade inicial de jornadas

| Prioridade | Classe | Exemplos | Comportamento |
| ---: | --- | --- | --- |
| 1 | Evento transacional | PIX pendente, saque pago, cashback | Pode pausar jornadas de menor prioridade. |
| 2 | Mudança de nível | Bronze, Prata, Ouro, Diamante, Black | Substitui exclusivamente o nível anterior. |
| 3 | Retenção comportamental | Sumiu depois de depositar | Pode pausar cadências gerais. |
| 4 | Cadência geral | Boas-vindas, reativação genérica | Aguarda jornadas prioritárias. |

## Cadência e proteção de contato

A cadência de uma jornada e a proteção global de contato devem ser regras diferentes.

- **Cadência interna:** define os tempos entre as etapas da mesma jornada, por exemplo 20 min, 45 min e 1 h.
- **Intervalo entre jornadas:** define o intervalo mínimo entre mensagens de jornadas diferentes no mesmo canal.
- **Limites por pessoa:** máximo de mensagens em 24 h e em 7 dias, somando jornadas e campanhas.
- **Limites por jornada:** limite diário de cada jornada para a operação.

O cooldown global atual não deve impedir a sequência interna planejada. Ele precisa passar a ser aplicado como proteção entre jornadas concorrentes, preservando a cadência da jornada vencedora.

## Escopo de implementação

### Fase 1 — Modelo e auditoria

- Adicionar à jornada os campos de família, prioridade e política de conflito.
- Criar os estados de pausa por prioridade e os motivos de saída correspondentes.
- Registrar eventos de entrada, saída, pausa, retomada e transição de nível.
- Exibir no relatório qual jornada bloqueou ou substituiu outra.

### Fase 2 — Gatilho de mudança de nível

- Criar o gatilho “Mudou de nível”.
- Permitir configurar o nível alvo na jornada.
- Calcular o nível a partir das configurações do tenant, sem valores fixos no código.
- Processar a transição de forma atômica após a confirmação de um depósito.

### Fase 3 — Arbitragem de jornadas cruzadas

- Centralizar a decisão antes da reserva de envio.
- Escolher a jornada vencedora por prioridade e família.
- Pausar, reavaliar e retomar jornadas concorrentes conforme as regras descritas.
- Garantir idempotência para evitar duas mensagens em concorrência.

### Fase 4 — Experiência de criação

- Adicionar seleção de público automático, família e prioridade no editor de jornada.
- Oferecer a saída “Sai ao mudar de nível” para jornadas de nível.
- Mostrar uma prévia de possíveis conflitos e a prioridade efetiva antes da publicação.

### Fase 5 — Proteções e operação

- Separar cadência interna de cooldown entre jornadas.
- Configurar limites globais por pessoa em 24 h e 7 dias.
- Criar monitoramento de jornadas pausadas, conflitos e mensagens adiadas.
- Validar cenários de salto de nível, depósito durante uma jornada e consentimento revogado.

## Critérios de aceite

- Um jogador nunca permanece simultaneamente em duas jornadas da família `progressao_niveis`.
- Ao subir de Bronze para Prata, nenhuma etapa pendente da Bronze é enviada depois da transição.
- Jornadas comportamentais podem coexistir com jornadas de nível sem enviar mensagens simultâneas no mesmo canal.
- Uma jornada pausada só é retomada se o jogador ainda for elegível.
- A auditoria registra o motivo de cada pausa, saída, retomada e transição.
- A cadência configurada dentro de uma jornada é respeitada sem ser bloqueada pelo cooldown entre jornadas.
