# Teste de usabilidade — canais de comunicação

**Data de preparação:** 07/10/2026  
**Escopo:** SMS, e-mail e voz.  
**Participantes mínimos:** 3 operadores de CRM/operação que utilizem os canais no dia a dia.  
**Duração por pessoa:** 20 a 30 minutos.  
**Ambiente:** homologação ou tenant de teste, com audiência e conteúdo de teste. Não usar destinatários reais nem disparar campanhas em produção.

## Objetivo

Validar se um operador consegue concluir as tarefas rotineiras sem assistência e medir:

1. tempo para criar a primeira campanha;
2. taxa de erro de configuração;
3. capacidade de reutilizar um asset;
4. compreensão de uma falha e da próxima ação;
5. capacidade de reenviar após a correção.

## Preparação do facilitador

1. Crie ou selecione uma audiência de teste com até cinco destinatários autorizados.
2. Deixe disponível um template de SMS, um template de e-mail e um script ou áudio de voz ativos.
3. Garanta que o operador tenha acesso ao tenant de teste e abra `/campanhas` em uma janela anônima.
4. Para a tarefa de falha, use uma campanha previamente marcada como `failed` ou `paused_limit`; não induza falha em um provedor real.
5. Cronometre cada tarefa. O facilitador não deve ensinar o caminho; só pode ler o enunciado novamente.

## Roteiro por operador

| Etapa | Enunciado lido ao operador | Evidência de sucesso | Métrica |
| --- | --- | --- | --- |
| 1 | “Crie uma campanha de teste no canal que você conhece melhor, selecione uma audiência, revise o conteúdo e deixe-a agendada.” | Composer aberto, audiência selecionada, confirmação de risco marcada e campanha agendada. | Tempo até a primeira confirmação; erros de configuração. |
| 2 | “Agora crie uma segunda campanha reutilizando um template, script ou áudio já existente.” | Asset reutilizado e prévia exibida. | Tempo; número de tentativas incorretas. |
| 3 | “Encontre esta campanha com falha/limite e diga o que aconteceu e qual ação você tomaria.” | Operador identifica o estado e abre o atalho adequado. | Compreensão sem ajuda: sim/não; tempo. |
| 4 | “Após corrigir a causa, como você reenviaria ou criaria uma nova tentativa?” | Histórico/configurações acessado e ação de retentativa/reenvio corretamente indicada. | Conclusão sem ajuda: sim/não; erros. |

## Registro de resultados

Registre uma linha por operador e por tarefa. Não inclua telefone, e-mail, conteúdo de campanha ou dados pessoais.

| Operador (apelido) | Canal | Tarefa | Início | Fim | Segundos | Concluiu sem ajuda | Erro de configuração | Observação |
| --- | --- | --- | --- | --- | ---: | --- | --- | --- |
|  |  | 1 |  |  |  |  |  |  |
|  |  | 2 |  |  |  |  |  |  |
|  |  | 3 |  |  |  |  |  |  |
|  |  | 4 |  |  |  |  |  |  |

### Definições de métrica

- **Tempo para primeira campanha:** mediana, em segundos, da tarefa 1 concluída sem ajuda.
- **Taxa de erro de configuração:** `operadores que cometeram ao menos um erro de configuração / operadores que iniciaram a tarefa 1 × 100`.
- **Conclusão sem ajuda:** proporção de tarefas concluídas sem instrução de navegação, configuração ou interpretação do estado.
- **Erro de configuração:** seleção de audiência/conteúdo incompatível, ausência de confirmação obrigatória, tentativa com limite/consentimento ignorado ou configuração de provedor incorreta. Erro de digitação simples não conta.

## Critérios de aceite

- Pelo menos 3 operadores concluem o roteiro.
- Mediana da primeira campanha: até 5 minutos.
- Pelo menos 80% concluem as tarefas 1 e 2 sem ajuda.
- Taxa de erro de configuração: até 15%.
- Pelo menos 80% identificam corretamente a próxima ação em falha, limite ou retentativa.
- Qualquer problema de consentimento, envio real indevido ou interpretação ambígua de risco bloqueia o aceite até correção e reteste.

## Síntese e decisão do gerente de projeto

Ao terminar, o gerente deve registrar no escopo: participantes (apenas apelidos), métricas calculadas, três principais dificuldades, decisão de **go/no-go**, dono de cada correção, prazo e data do reteste. Priorizar correções pelo impacto em risco de envio, frequência e tempo perdido pelo operador.
