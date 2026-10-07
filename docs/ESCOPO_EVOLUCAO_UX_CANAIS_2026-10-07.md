# Escopo de evolução de UX e operação dos canais

**Data:** 07/10/2026
**Canais:** SMS, e-mail e voz.
**Origem:** reavaliação do produto após a reauditoria de canais, com foco em permissões, criação de campanhas, audiência e arquitetura de informação.

## Decisão executiva

O produto já possui recursos importantes — composer multicanal, templates, histórico, consentimento e estados operacionais —, mas a experiência ainda expõe decisões de infraestrutura ao operador e fragmenta tarefas que deveriam ter um único ponto de entrada. A prioridade não é acrescentar botões: é separar com rigor **operação de campanha**, **administração da plataforma** e **gestão de ativos**.

Há dois riscos que bloqueiam a evolução sem correção:

1. A tela de e-mail permite CRUD de SMTP e remetentes no contexto do tenant; SMS e voz também expõem informações operacionais de provedor nas telas do canal. Isso contraria a regra de que somente superadmin pode gerir o provedor.
2. O composer resolve a audiência por uma função denominada `resolveSmsCampaignAudience` para todos os canais. Embora ela já retorne totais de e-mail, a interface usa `emailPlayerIds.length` para e-mail e `phones.length` para SMS/voz. A regra de elegibilidade precisa ficar explícita, testada e única no servidor.

## O que foi encontrado

| Área | Evidência atual | Impacto |
| --- | --- | --- |
| Configuração de provedor | `saveSmtpConfig`, `deleteSmtpConfig`, `setDefaultSmtpConfig` e CRUD de remetentes estão disponíveis na área de e-mail autenticada; SMS e voz mostram provedor/callback no espaço operacional. | Um papel de tenant pode perceber que tem autoridade sobre infraestrutura, e a proteção não está uniformemente centralizada no servidor. |
| Navegação | SMS, e-mail e voz exibem alternador de canal e um segundo menu local com visão geral, criar, biblioteca, campanhas/fluxos, histórico e configurações; a sidebar já oferece os canais e os hubs globais. | Duplicação de caminhos, maior carga cognitiva e risco de destinos divergentes. |
| Criação | O hub de campanhas tem “SMS individual”, enquanto o composer concentra as campanhas dos três canais. | Ação equivalente não é descoberta nem padronizada para e-mail e voz. |
| Templates/ativos | O composer seleciona templates/áudios existentes, mas não oferece criação no mesmo contexto. | O operador perde o preenchimento da campanha ao sair para criar o ativo. |
| Campanhas | Não existe ciclo de rascunho/autosalvamento transversal; o composer limpa o formulário quando é aberto. | Perda de trabalho, dificuldade de revisão e ausência de uma lista operacional de rascunhos. |
| Audiência | SMS/voz dependem de telefone; e-mail depende de e-mail. A RPC já expõe `recipientTotal` e `emailRecipientTotal`, mas o contrato e os testes não asseguram a apresentação e o bloqueio corretos por canal. | Contagens imprecisas, expectativa errada de custo/alcance e risco de enviar para cadastro inválido. |
| Jornada e sidebar | Campanhas, automações, canais, públicos e jornadas têm pontos de entrada próximos, mas o mapa de tarefas não é explícito. | Usuário procura onde criar, onde acompanhar e onde configurar; o sistema tende a acumular telas paralelas. |

## Princípios de produto aprovados para a execução

1. **Infraestrutura não é tarefa do tenant.** Credenciais, provedor, callback e seleção de rota de entrega pertencem ao superadmin e recebem auditoria; o tenant somente vê saúde, disponibilidade e instruções de ação que não revelem segredo.
2. **Uma intenção, um ponto de entrada.** “Criar” abre uma única superfície multicanal; envio individual é um modo dessa superfície, não um botão isolado de SMS.
3. **Nada digitado é perdido.** Campanha começa em rascunho, salva automaticamente de modo visível e só pode ser editada enquanto for rascunho.
4. **Elegibilidade é específica do canal.** Telefone válido é pré-requisito de SMS e voz; e-mail válido é pré-requisito de e-mail. A mesma regra deve calcular contador, custo, prévia e bloqueio de envio.
5. **Navegação global na sidebar; contexto na página.** A sidebar é a fonte de rotas. A página exibe somente abas que não tenham equivalente global e que sejam indispensáveis ao contexto atual.
6. **Estado explica a próxima ação.** Rascunho, agendada, em processamento, concluída, pausada, falha e cancelada são mutuamente exclusivos na interface e têm permissões explícitas.

## Priorização e escopo de entrega

### P0 — Governança de provedores e autorização

**Objetivo:** retirar toda alteração de provedor do alcance de roles de tenant e tornar a regra obrigatória no servidor, não apenas na interface.

**UX:**

- Remover dos canais as abas/cartões de configuração de provedor, endpoint, callback e SMTP.
- No canal, mostrar somente um card de saúde: disponibilidade, última atualização, capacidade de envio e caminho para suporte quando houver problema.
- Criar em Super Admin uma central “Provedores de canais” com SMS, e-mail e voz, estado, conexão de teste, callback e histórico de alteração. Ela só aparece para `super_admin`.

**Engenharia:**

- Aplicar `assertSuperAdmin` a toda leitura e escrita sensível de provedor, SMTP, remetente global, callback e credencial; cobrir também APIs que hoje dependem somente de RLS.
- Definir a propriedade de configuração: global de plataforma versus por tenant. Se houver remetente por tenant, ele deve ser tratado como identidade editorial aprovada, não como escolha de provedor, e a aprovação/validação deve ser auditável.
- Migrar ou descontinuar `email_smtp_configs` conforme a decisão de Infobip exclusiva; não manter uma rota alternativa de entrega ativa sem autorização explícita.
- Testar servidor com `super_admin`, `admin`, `gestor` e `member`: os três últimos recebem negação tanto na URL/API quanto por manipulação direta da requisição.

**Gestão de projeto:** risco alto de segurança e governança; não depende de teste humano. Confirmar o responsável pela conta Infobip e o modelo de remetentes aprovados antes da migração de dados.

**Aceite:** nenhuma role de tenant vê nem consegue chamar mutações de provedor; superadmin consegue consultar, testar e auditar; o canal continua exibindo saúde sem expor segredo.

### P1 — Ciclo confiável de campanha: rascunho e autosalvamento

**Objetivo:** transformar a criação em uma atividade recuperável e auditável nos três canais.

**UX:**

- Ao iniciar “Criar”, criar/recuperar um rascunho e indicar “Salvando…”, “Salvo agora” ou “Falha ao salvar”.
- Lista de campanhas separa visualmente **Rascunhos** de campanhas enviadas/agendadas, com busca, canal, última edição e ação “Continuar edição”.
- Apenas `draft/rascunho` permite editar ou excluir. `scheduled/agendada` permite cancelar conforme a regra do canal; demais estados são somente leitura, com duplicação como novo rascunho.
- Fechar o modal com alterações pendentes pede confirmação; reabrir restaura o rascunho em vez de zerar o formulário.

**Engenharia:**

- Criar um modelo de rascunho unificado ou adaptadores por canal com: canal, nome, audiência/critério versionado, asset/template snapshot, conteúdo, agendamento, rastreamento, estado, versão e `updated_at`.
- Autosave com debounce, idempotency key, controle de conflito por versão e recuperação após falha/reload. Nunca disparar ou reservar crédito a partir de rascunho.
- Transição de estado validada no servidor. Uma campanha não volta a rascunho após agendamento/disparo; editar campanha finalizada cria cópia nova.
- Cobrir migração, políticas tenant-aware, transições inválidas e recuperação do composer com testes automatizados.

**Gestão de projeto:** alto valor para operação diária e redução de perda de trabalho. Entregar primeiro o contrato/estado e depois a interface; medir rascunhos recuperados, falhas de autosave e abandono do composer.

**Aceite:** preenchimento sobrevive a reload/navegação; rascunho aparece no CRUD; estado não editável rejeita alteração no servidor; não há envio a partir de rascunho.

### P2 — Entrada única de criação, templates e envio individual

**Objetivo:** tornar campanhas, testes/envios individuais e criação de ativos coerentes em SMS, e-mail e voz.

**UX:**

- Substituir “SMS individual” por um botão **Criar** no hub de campanhas. O menu abre: Campanha, Envio individual/teste e, quando aplicável, Automação. O canal é escolhido dentro da mesma experiência.
- Cada envio individual informa claramente que não é campanha, usa a mesma política de consentimento, janela e rastreamento, e registra histórico.
- Em cada seletor de asset, incluir “Criar novo template” (SMS/e-mail) ou “Criar novo áudio/script” (voz). Abrir em drawer/modal sobre o composer, salvar, selecionar o item criado e preservar os campos já preenchidos.
- O toggle de encurtamento/rastreamento deve aparecer de maneira consistente nos fluxos aplicáveis, com texto por canal e estado salvo no rascunho/campanha.

**Engenharia:**

- Extrair o envio individual para um contrato compartilhado com adaptadores de SMS, e-mail e voz; validar destinatário e consentimento no servidor.
- Expor criação rápida de template/ativo como componentes controlados, com invalidação da query e seleção do ID retornado.
- Persistir snapshot imutável de template/áudio/script quando a campanha sai de rascunho, evitando que edição futura altere a campanha já aprovada.

**Gestão de projeto:** reduz treinamento e duplicação de código. Decidir previamente quais casos de voz são “teste” e se existe chamada individual autorizada; não inventar um fluxo de chamada real sem política operacional e créditos definidos.

**Aceite:** os três canais oferecem o mesmo ponto de criação; criar ativo não perde formulário; o novo ativo já fica selecionado; envio individual deixa trilha de auditoria e respeita as mesmas barreiras de segurança.

### P3 — Audiência correta por canal e transparência de alcance

**Objetivo:** garantir que os quantitativos exibidos e enviados correspondam ao identificador válido de cada canal.

**UX:**

- Exibir sempre três números quando necessário: total no público, elegíveis para o canal e excluídos, com motivo agregado (sem telefone, telefone inválido, sem e-mail, e-mail inválido, sem consentimento).
- Para SMS e voz, usar o rótulo “telefones válidos”; para e-mail, “e-mails válidos”. O botão de agendar/enviar mostra o mesmo total da confirmação final.
- Se não houver elegíveis, bloquear a progressão com orientação para corrigir público, não com contador “0” ambíguo.

**Engenharia:**

- Renomear/generalizar o contrato de resolução de audiência e retornar uma estrutura por canal, em vez de uma semântica de SMS reutilizada implicitamente.
- Validar normalização E.164/BR para SMS e voz e e-mail sintaticamente válido + não suprimido para e-mail; aplicar consentimento e políticas de contato antes do total final.
- Garantir que a fila revalide elegibilidade no momento do envio e registre a razão de exclusão, pois o dado pode mudar entre agendamento e disparo.
- Criar fixtures com contatos: só telefone, só e-mail, ambos inválidos, suprimidos e válidos; testar contador, preview, bloqueio e destinatários realmente enfileirados.

**Gestão de projeto:** prioridade alta de confiança e custo. Medir diferença entre elegíveis no preview, enfileirados e aceitos pelo provedor; qualquer divergência acima da tolerância definida abre incidente de dados.

**Aceite:** o contador de cada canal é reproduzível por teste; confirmação, fila e histórico concordam sobre o volume; exclusões são explicáveis sem expor PII desnecessária.

### P4 — Arquitetura de informação: canais, sidebar, campanhas e jornadas

**Objetivo:** eliminar menus redundantes e estabelecer uma navegação orientada a tarefas.

**Decisão de UX proposta:**

- Remover o alternador SMS/E-mail/Voz e o menu secundário de seis itens das páginas de canal. A sidebar permanece como rota global para Canais, Campanhas, Automações/Jornadas, Públicos e Consentimentos.
- Cada página de canal fica com cabeçalho curto, saúde/resumo, ações relevantes e somente abas locais que não existam na sidebar (por exemplo: métricas versus histórico dentro do próprio canal, se isso for necessário após teste).
- Hub **Campanhas**: criar, rascunhos, agendadas, execução e resultados. Hub **Automações/Jornadas**: fluxos recorrentes e seus ativos. **Canais**: saúde, capacidades e histórico específico. **Bibliotecas**: templates/áudios/scripts por canal, acessíveis pela sidebar ou por atalho contextual, nunca duplicados por dois menus concorrentes.
- Usar breadcrumbs/título de contexto apenas quando o usuário entra em um detalhe profundo; não repetir título global, título da página e menu que dizem a mesma coisa.

**Engenharia:**

- Mapear e substituir links/hash legados antes de remover a navegação; manter redirects compatíveis e telemetria temporária de rota quebrada.
- Consolidar as rotas destino usadas por estados operacionais para não enviar usuário a uma configuração que ele não pode alterar.
- Avaliar extração das grandes rotas monolíticas de SMS/e-mail em módulos de página, preservando contratos e testes existentes.

**Gestão de projeto:** executar após P0–P3, pois a nova informação arquitetural depende dos estados, rascunhos e pontos de entrada definidos. Rodar teste moderado com três operadores usando o protocolo existente e acrescentar tarefas de achar rascunho, criar template sem sair e interpretar saúde do canal.

**Aceite:** não há duplicação de menu para o mesmo destino; operador encontra criar campanha, continuar rascunho, localizar ativo e consultar resultado sem ajuda dentro das metas de usabilidade; rotas legadas continuam resolvendo durante a transição.

## Ordem de execução e dependências

| Prioridade | Dependência | Justificativa |
| --- | --- | --- |
| P0 | Decisão sobre remetentes por tenant e responsável Infobip | Segurança/autorização antecede qualquer melhoria visual. |
| P1 | P0 para separar configuração de conteúdo de infraestrutura | Rascunho é a base para não perder trabalho na criação. |
| P2 | P1 para preservar criação rápida dentro de rascunho | Unifica a entrada e elimina desvios de SMS. |
| P3 | P1/P2 para calcular e exibir o contrato final de campanha | Evita prometer um volume incorreto. Pode ter a camada de testes iniciada em paralelo. |
| P4 | P0–P3 | A navegação final deve refletir os fluxos já consolidados, não antecipá-los. |

## Plano de validação por entrega

Para cada prioridade concluída:

1. executar lint, testes relevantes e build de produção;
2. reiniciar o servidor local e validar as rotas/cenários alterados sem chamar provedores reais;
3. registrar evidência, limitações e roteiro de teste humano quando aplicável;
4. revisar o diff, manter alterações alheias fora do commit, fazer push para `main` e confirmar o CI;
5. informar o que foi entregue, onde testar e qual é a próxima prioridade.

## Governança contínua

O gerente de projeto deve reavaliar semanalmente as prioridades com três lentes: risco de envio indevido/segurança, tempo perdido pelo operador e impacto mensurável em entrega/conversão. Toda nova melhoria deve entrar neste formato: problema observado, evidência, hipótese, prioridade, dono, dependência, métrica e critério de aceite. Nenhum resultado de teste com operadores será declarado sem participantes e evidências reais.
