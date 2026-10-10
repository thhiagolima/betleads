# Escopo de resolução do levantamento do Betleads

**Status:** aprovado para planejamento e execução
**Dono:** a definir
**Última revisão:** 10/10/2026
**Ambientes:** desenvolvimento, homologação e produção
**Fonte canônica:** este documento é a fonte de prioridade e acompanhamento das resoluções identificadas no levantamento de 09/10/2026
**Documento de origem:** `docs/LEVANTAMENTO_DOCUMENTACAO_SISTEMA_2026-10-09.md`
**Baseline de código:** `main` no commit `119e557`
**Aceite funcional:** por entrega, conforme os critérios definidos neste documento

> **Concluído em 10/10/2026 — P0.1:** a rota de reconciliação, o serviço, a migration já aplicada e o callback de voz foram revisados e versionados no commit `02171a8` (`fix(voice): version callback reconciliation`), enviado para `main`. Foram adicionados testes que garantem que a reconciliação somente audita pendências e falha quando não consegue persistir a auditoria. `npm test` (17 arquivos/56 testes), `npx tsc --noEmit` e `npm run build -- --logLevel error` passaram na implementação inicial. A promoção posterior confirmou `npx supabase db push` sem pendências, migrations locais/remotas alinhadas e `npx supabase db lint --linked` sem erros de schema.

> **Progresso em 10/10/2026 — P0.2:** o despacho automático de voz passou a falhar fechado por `VOICE_DISPATCH_ENABLED`; a flag é `false` no exemplo de ambiente. O cron de reconciliação foi explicitamente separado do cron de despacho, pois só audita callbacks pendentes. A ativação em um ambiente continua condicionada ao aceite integral da matriz de voz. Após essa proteção, `npm test` (18 arquivos/58 testes), `npx tsc --noEmit`, `npm run lint` (667 avisos preexistentes, sem erros) e `npm run build -- --logLevel error` passaram.

> **Progresso em 10/10/2026 — P0.2 (limites):** foi identificada uma desativação global preexistente de cooldown e limite móvel de voz. A correção restaura a linha de base defensiva de 24 horas/1 chamada por destinatário e faz o runtime aplicar essa linha de base quando uma tenant ainda não possuir política persistida. A flag global de despacho continua `false`; esta correção não autoriza chamadas nem substitui o aceite operacional.

> **Progresso em 10/10/2026 — P0.2 (callback):** a rota de evento de voz agora é coberta para rejeição sem token, correlação e persistência do resultado final. Falhas ao gravar o histórico ou a fila deixam de ser reconhecidas como sucesso, permitindo nova tentativa do provedor. A prova com callback real do Infobip permanece obrigatória para o aceite.

> **Progresso em 10/10/2026 — P0.6:** o typecheck foi promovido a comando oficial e gate bloqueante do CI. A auditoria de dependências continua pendente da P0.5, pois há vulnerabilidades altas transitivas que exigem atualização incompatível do Nitro; os checks remotos de migrations permanecem obrigatórios no procedimento de deploy até que credenciais apropriadas sejam disponibilizadas ao CI.

## 1. Objetivo

Transformar o levantamento técnico e documental do Betleads em um plano executável, priorizando primeiro riscos de operação, envio indevido, divergência entre banco e código, segurança e atribuição financeira. Em seguida, consolidar a fonte de verdade documental, ampliar a cobertura de testes e concluir a experiência operacional.

Este escopo não considera presença de código como conclusão. Cada item deve ser classificado separadamente como:

- **implementado:** existe código ou migration correspondente;
- **validado tecnicamente:** passou por testes automatizados, typecheck, lint e build aplicáveis;
- **homologado:** foi exercitado com dados e integrações reais em ambiente controlado;
- **certificado em produção:** possui aceite, evidência, observabilidade e rollback comprovados.

## 2. Resultado esperado

Ao concluir este plano, o Betleads deve possuir:

1. banco, aplicação, migrations e Git reproduzíveis a partir do mesmo commit;
2. canais SMS, e-mail e voz com estado operacional inequívoco por ambiente;
3. atribuição de clique e conversão homologada de ponta a ponta;
4. documentação canônica suficiente para instalação, operação, evolução e resposta a incidentes;
5. CI proporcional aos riscos de um produto multitenant com disparos e dados financeiros;
6. jornadas, campanhas, Short.io e relatórios com testes negativos de tenant, concorrência, retry e idempotência;
7. aceite humano dos principais fluxos de operação;
8. backlog histórico separado do estado vivo do produto.

## 3. Baseline consolidada

### 3.1 Qualidade técnica

| Verificação | Estado da baseline | Leitura |
| --- | --- | --- |
| Testes automatizados | 16 arquivos e 54 testes aprovados | cobertura ainda pequena para o tamanho e o risco do sistema |
| Typecheck | aprovado | ainda não é comando próprio nem gate dedicado do CI |
| Lint | aprovado com 667 warnings | bloqueia erros, mas não impede crescimento da dívida |
| Build de produção | aprovado | chunk principal aproximado de 1,22 MB antes de gzip |
| Auditoria de dependências | 8 vulnerabilidades, 4 altas e 4 moderadas | correção completa pode exigir atualização incompatível do Nitro |
| Supabase migrations | locais e remotas alinhadas | há migration aplicada remotamente ainda não versionada no Git |
| Supabase DB lint | sem erros | não substitui revisão de RLS/RBAC nem teste negativo por tenant |
| E2E | ausente | fluxos críticos não possuem certificação automatizada ponta a ponta |

### 3.2 Estado funcional

| Frente | Estado | Observação |
| --- | --- | --- |
| Governança de canais | implementada e validada tecnicamente | aceite produtivo dos canais permanece aberto |
| Composer e ativos | implementados | falta concluir teste manual e de usabilidade |
| Jornadas | motor e proteções principais implementados | falta certificação produtiva, E2E, carga e revisão de flags |
| Jornadas cruzadas e níveis | implementados no código e migrations | falta aceite formal por fase e cenários ponta a ponta |
| Funil de conversão | relatórios e atribuição implementados | vínculo determinístico depende de homologação com a casa |
| Short.io | piloto aceito e núcleo operacional | robustez, reconciliação, filtros e matriz completa continuam parciais |
| BusinessCode | removido do runtime | documentos históricos ainda precisam ser classificados |
| SMS | implementação disponível | aceite real bloqueado por conectividade/callback do provedor |
| E-mail | implementação Infobip disponível | falta homologar domínio, remetente, callback e supressão |
| Voz | chamada e reprodução aprovadas | callback final, reconciliação e decisão de cron permanecem abertas |

### 3.3 Estado documental

- Há 19 documentos Markdown em `docs`.
- Quinze estão versionados, dois estão não rastreados e dois estão ignorados.
- Não existe `README.md` principal nem `docs/INDEX.md`.
- Escopos, evidências, planos e estado operacional aparecem misturados.
- `PLANO_DE_ENTREGAS.md`, a auditoria original de jornadas e a reauditoria de 03/10 não representam o estado atual.
- O plano Short.io mistura aceite do piloto com conclusão integral do produto.

## 4. Regras de priorização

| Prioridade | Definição | Regra de entrada |
| --- | --- | --- |
| P0 | risco imediato de operação, segurança, envio, receita ou release | executar antes de novas funcionalidades |
| P1 | fonte de verdade, governança e capacidade segura de evolução | iniciar após contenção dos P0; pode avançar em paralelo quando não houver conflito |
| P2 | robustez, testes críticos e fechamento funcional | exige contratos e estados operacionais definidos |
| P3 | experiência, acessibilidade, desempenho e manutenção | executar sobre fluxos já estáveis |
| P4 | escala documental, produto e suporte | não bloqueia a contenção imediata, mas encerra a dependência de conhecimento oral |

Uma prioridade somente pode ser encerrada quando todos os seus bloqueadores estiverem concluídos ou quando uma exceção formal registrar risco aceito, responsável e prazo.

## 5. P0 — estabilização operacional e segurança de release

### P0.1 — Reconciliar Git, aplicação e banco remoto

**Problema:** a migration `20261008220000_schedule_infobip_voice_reconciliation.sql` está aplicada no Supabase remoto, mas permanece fora do Git junto com a rota e o serviço de reconciliação. Um deploy limpo do `main` pode não reproduzir o ambiente em execução.

**Entregas:**

- revisar e versionar a migration, o serviço de reconciliação, a rota pública protegida e as alterações de callback de voz;
- confirmar que `src/routeTree.gen.ts` corresponde às rotas versionadas;
- revisar as demais alterações locais e separar trabalho relacionado de mudanças independentes;
- executar testes, typecheck, lint, build, `supabase migration list --linked` e `supabase db lint --linked`;
- implantar a mesma revisão em ambiente controlado e registrar o commit efetivo;
- verificar que o cron recebe resposta válida da rota e não produz erro recorrente.

**Critério de aceite:** checkout limpo do commit aprovado gera a mesma rota, migration e comportamento existentes no ambiente; não há migration remota sem arquivo correspondente no repositório.

### P0.2 — Definir e aplicar o estado operacional de voz

**Problema:** a documentação manda manter o cron de voz desabilitado, enquanto migrations posteriores o habilitam. A chamada foi reproduzida, mas o callback final ainda não foi formalmente aceito.

**Entregas:**

- registrar por ambiente se o cron de voz está ativo, pausado ou restrito a tenant piloto;
- confirmar o valor efetivo de `JOURNEYS_DISPATCH_ENABLED` e remover qualquer diferença entre documentação e runtime;
- decidir se `JOURNEYS_PUBLISHING_ENABLED` será implementada como kill switch real ou removida do exemplo de ambiente;
- validar assinatura/autenticação, correlação, duração e estado final dos callbacks Infobip;
- validar retry, idempotência, pausa e retomada;
- concluir a reconciliação de callbacks sem inferir resultado inexistente;
- atualizar `OPERACAO_SEGURA.md` e `MATRIZ_ACEITE_CANAIS.md` com uma única orientação.

**Critério de aceite:** chamada autorizada produz histórico final correlacionado; uma falha preserva evidência e obedece à política de retry; pausa interrompe novos despachos; documentação, flags, cron e ambiente apresentam o mesmo estado.

### P0.3 — Concluir a matriz operacional dos canais

**Problema:** nenhum dos três canais possui a matriz oficial integralmente assinada.

**Entregas de SMS:**

- resolver ou documentar a conectividade com a Short Brasil;
- validar envio individual, campanha, automação, janela, limite, opt-out, callback e reprocessamento;
- comprovar que retry não duplica mensagem nem reserva.

**Entregas de e-mail:**

- homologar remetente e domínio Infobip, incluindo SPF, DKIM e DMARC;
- validar teste, campanha, renderização, links, descadastro, bounce, callback e reprocessamento;
- comprovar bloqueio posterior de destinatário suprimido.

**Entregas de voz:**

- concluir os cenários definidos em P0.2;
- validar relatório, rollback e ausência de chamada inesperada.

**Critério de aceite:** `MATRIZ_ACEITE_CANAIS.md` contém ambiente, tenant, commit, executor, IDs seguros e decisão de operação, engenharia e gestão para cada canal.

### P0.4 — Homologar atribuição determinística com a casa

**Problema:** o Betleads gera e recebe `bl_click_id`, mas a plataforma de destino ainda precisa comprovar a devolução do token e do instante de captura.

**Entregas:**

- executar cadastro com `bl_click_id` e `bl_click_captured_at` reais;
- executar depósito posterior sem repetir o token e confirmar reutilização pelo jogador;
- validar substituição pelo último clique do mesmo jogador;
- preservar `utm_content` quando usado como dado de criativo;
- repetir o mesmo webhook e comprovar idempotência;
- validar eventos nas fronteiras de 7 e 14 dias;
- validar evento sem token, token inexistente, tenant divergente e jogador divergente;
- registrar a origem oficial dos números do relatório somente após o aceite.

**Critério de aceite:** link → clique → cadastro → depósito aprovado gera uma única atribuição, na origem correta, no tenant correto, com janela e valor reproduzíveis; cenários inválidos não geram receita direta.

### P0.5 — Tratar vulnerabilidades de dependências

**Problema:** a auditoria encontrou vulnerabilidades altas em dependências transitivas, principalmente `sharp`, `undici` e `source-map-js`.

**Entregas:**

- identificar a cadeia exata e as versões corrigidas compatíveis;
- corrigir primeiro atualizações sem quebra;
- criar branch/plano próprio para a atualização incompatível do Nitro, se necessária;
- executar regressão de build, SSR, rotas públicas, upload/processamento de imagem e workers;
- documentar risco residual quando não houver correção compatível imediata;
- adicionar auditoria de dependências ao processo de release.

**Critério de aceite:** não há vulnerabilidade alta corrigível sem quebra; exceções possuem justificativa, mitigação, responsável e prazo.

### P0.6 — Fechar controles mínimos de release

**Entregas:**

- adicionar script `typecheck` ao `package.json` e ao CI;
- incluir verificação de alinhamento/lint do banco quando houver migrations;
- impedir release com migration não rastreada ou worktree não revisado;
- registrar smoke test, backup, rollback e commit implantado;
- garantir que endpoints públicos retornem erros seguros e não exponham segredos, payloads ou infraestrutura.

**Critério de aceite:** uma release não pode ser promovida sem lint, typecheck, testes, build, revisão de migrations e checklist operacional rastreável.

## 6. P1 — recuperar a fonte de verdade

### P1.1 — Criar entrada principal e índice documental

**Entregas:**

- criar `README.md` com objetivo, módulos, stack, requisitos, setup, comandos, banco, testes e links canônicos;
- criar `docs/INDEX.md` com tipo, status, dono, última revisão e documento substituto;
- versionar documentação por padrão e ignorar apenas arquivos temporários ou sensíveis;
- adotar cabeçalho padrão de status em documentos vivos.

**Critério de aceite:** uma pessoa nova localiza a fonte atual de arquitetura, operação, produto, APIs e backlog sem interpretar auditorias antigas como estado vigente.

### P1.2 — Classificar e reconciliar os documentos existentes

**Entregas:**

- arquivar `REAUDITORIA_SISTEMA_2026-10-03.md` como fotografia histórica;
- arquivar ou marcar como substituída a auditoria original de jornadas;
- atualizar o escopo do funil de “proposto” para o estado efetivamente entregue/parcial;
- adicionar estado por fase ao escopo de jornadas cruzadas;
- encerrar formalmente a remoção BusinessCode;
- separar no Short.io: piloto aceito, produto mínimo, robustez pendente e melhorias futuras;
- atualizar `PLANO_DE_ENTREGAS.md` para referenciar este backlog, sem duplicar tarefas;
- manter evidências antigas imutáveis e identificadas como snapshots.

**Critério de aceite:** não existem dois documentos vivos que atribuam estados diferentes à mesma capacidade.

### P1.3 — Documentar ambientes, configuração e deploy

**Entregas:**

- catalogar variáveis obrigatórias, opcionais, legadas e exclusivas de scripts;
- incluir `INFOBIP_EMAIL_CALLBACK_TOKEN`, `APP_URL`, `IMPORT_TENANT_ID`, aliases Supabase e overrides Short Brasil quando aplicáveis;
- remover dados nominais, tenants e domínios legados do guia genérico;
- documentar desenvolvimento, homologação e produção;
- definir ownership, rotação e armazenamento de segredos;
- documentar promoção de migrations, health check, rollback e pós-deploy.

**Critério de aceite:** o `.env.example`, o código e a documentação usam os mesmos nomes e explicam o efeito real de cada variável.

### P1.4 — Documentar arquitetura, dados e integrações

**Entregas:**

- visão browser → TanStack/Nitro → Supabase → cron/workers → provedores → callbacks;
- fronteiras de tenant, autenticação e uso de service role;
- modelo crítico de players, eventos financeiros, campanhas, jornadas, envios, links e atribuições;
- catálogo de APIs, webhooks e jobs com método, autenticação, payload, idempotência, timeout, retry e observabilidade;
- ADRs para provedores, multitenancy, atribuição, jornadas, Short.io e workers.

**Critério de aceite:** arquitetura, fonte de verdade dos dados e responsabilidades de cada integração são verificáveis sem leitura exploratória do código.

### P1.5 — Formalizar segurança, RBAC e recuperação

**Entregas:**

- matriz de permissões para member, gestor, admin, superadmin e contas técnicas;
- matriz negativa de RLS/RPC/endpoint por tenant;
- política para funções privilegiadas e service role;
- política LGPD de retenção, anonimização, exportação e descarte;
- backup/restore testado, rollback de migration, RPO e RTO;
- inventário de endpoints públicos de diagnóstico e decisão de restringir ou remover cada um.

**Critério de aceite:** toda ação privilegiada possui papel, fronteira, evidência de negação e procedimento de recuperação correspondente.

## 7. P2 — robustez e fechamento funcional

### P2.1 — Fechar o produto Short.io além do piloto

**Entregas:**

- substituir o lock por reserva atômica ou advisory lock no banco;
- implementar reconciliação diária dos últimos sete dias;
- definir tratamento de `human_clicks` e bots conforme capacidade real da conta;
- criar fila de exceções e reprocessamento idempotente autorizado;
- ampliar filtros por período, canal, campanha, fluxo, jornada e CTA;
- documentar e corrigir o denominador do CTR;
- concluir testes ligado/desligado em todos os caminhos SMS e e-mail;
- cobrir múltiplas URLs, query, fragmento, Unicode, HTML malformado, imagens, descadastro, lotes e destinatário sem player;
- definir retenção e expurgo aprovado pela LGPD.

**Critério de aceite:** números reconciliam numa janela documentada; execuções concorrentes não se sobrepõem; falhas podem ser identificadas e reprocessadas sem duplicação.

### P2.2 — Certificar jornadas e conflitos

**Entregas:**

- E2E de criação, publicação, pausa, retomada, falha e arquivamento;
- E2E de mudança de nível, salto de faixa, encerramento da jornada anterior e não reentrada indevida;
- E2E de prioridade, pausa, retomada e reavaliação da jornada perdedora;
- teste de cadência interna versus intervalo entre jornadas;
- teste de limites de 24 horas, sete dias e limite diário da jornada;
- teste de claim órfão, retry/backoff, concorrência e duplicidade;
- teste de carga de matrícula, dispatcher e métricas;
- rollout gradual por tenant com kill switch e rollback comprovados.

**Critério de aceite:** nenhum cenário duplica envio, atravessa tenant, envia após saída/mudança de nível ou viola limites configurados.

### P2.3 — Certificar conversão e relatórios

**Entregas:**

- E2E da atribuição homologada no P0.4 até os relatórios de campanha e jornada;
- teste de múltiplos links na mesma mensagem sem duplicar entrega;
- teste de último clique, direta, assistida, fronteiras e evento duplicado;
- teste negativo de autorização para relatório, drill-down e CSV;
- separar claramente métricas históricas não atribuídas;
- implementar ou retirar da interface métricas ainda indisponíveis, como abertura de e-mail não rastreada;
- validar estados vazios, sincronização atrasada e alertas de inconsistência.

**Critério de aceite:** cada número exibido possui fonte, fórmula, janela, fuso e cenário automatizado reproduzível.

### P2.4 — Ampliar testes de segurança e integração

**Entregas:**

- testes negativos de IDs de outro tenant em tabelas, RPCs e endpoints críticos;
- testes por papel para configurações de provedor e ações operacionais;
- testes de idempotência de webhooks financeiros e callbacks;
- testes de reserva atômica de limite e concorrência de workers;
- fixtures padronizadas para telefone, e-mail, consentimento, supressão e dados financeiros;
- ambiente E2E reproduzível e isolado.

**Critério de aceite:** a suíte cobre os riscos críticos documentados, não apenas funções puras e renderizações locais.

### P2.5 — Observabilidade e SLO

**Entregas:**

- catálogo de jobs com frequência, lock, timeout, retry, kill switch e dono;
- SLO para atraso de fila, taxa de falha, callback e sincronização;
- alertas para cron atrasado, fila crescente, callback ausente e divergência de contagem;
- painel com próxima execução, última execução, itens presos e ação autorizada;
- procedimento de escalonamento e retenção de evidências.

**Critério de aceite:** uma falha crítica é detectada e encaminhada sem depender de inspeção manual casual.

## 8. P3 — UX, acessibilidade, desempenho e manutenção

### P3.1 — Executar aceite de usabilidade

**Entregas:**

- executar o protocolo com pelo menos três operadores;
- medir tempo da primeira campanha, conclusão sem ajuda, erro de configuração e interpretação de falhas;
- incluir tarefas de recuperar rascunho, criar ativo sem sair, interpretar saúde do canal e consultar relatório;
- registrar dificuldades, decisão go/no-go, responsáveis e reteste.

**Critério de aceite:** metas de `TESTE_USABILIDADE_CANAIS_2026-10-07.md` atendidas e ausência de erro crítico de consentimento ou envio.

### P3.2 — Fechar acessibilidade e consistência de interação

**Entregas:**

- substituir os dois usos restantes de `window.confirm` pelos dialogs do sistema;
- revisar teclado, foco, labels, contraste e estados dependentes de cor;
- validar modais, drawers, popovers e editores com leitor de tela;
- testar desktop e mobile para loading, vazio, erro e sucesso.

**Critério de aceite:** fluxos críticos podem ser concluídos por teclado, possuem foco previsível e comunicam estado sem depender apenas de cor.

### P3.3 — Simplificar navegação e código

**Entregas:**

- concluir consolidação entre Campanhas, Automações, Jornadas e páginas dos canais;
- preservar redirects e medir uso de rotas legadas antes da remoção;
- dividir `email.tsx`, `sms.tsx`, `whatsapp.tsx`, `players.tsx` e `midia-ltv.tsx` em módulos menores;
- remover rotas e controles sem operação real ou marcá-los explicitamente como indisponíveis.

**Critério de aceite:** cada intenção possui ponto de entrada único e os módulos críticos podem ser testados sem carregar uma rota monolítica inteira.

### P3.4 — Reduzir dívida de qualidade e desempenho

**Entregas:**

- criar baseline de warnings e impedir crescimento no CI;
- reduzir progressivamente `no-explicit-any`, dependências de hooks e avisos de Fast Refresh;
- aplicar code splitting ao chunk principal;
- definir orçamento de bundle e desempenho;
- medir consultas lentas, paginação e agregações que ainda carregam conjuntos completos.

**Critério de aceite:** CI rejeita aumento de warnings e regressão do orçamento de bundle; principais telas possuem metas mensuráveis de carregamento.

## 9. P4 — escala de produto, suporte e conhecimento

### P4.1 — Manuais e glossário

- manual do operador organizado por tarefa;
- guia administrativo e troubleshooting por código/estado seguro;
- glossário de campanha, jornada, automação, régua, público, conversão e atribuição;
- catálogo de métricas com fórmula, fonte, fuso, granularidade e limitações;
- changelog e notas de release orientadas à operação.

### P4.2 — Domínios ainda pouco documentados

- Meta, mídia, aquisição e LTV;
- WhatsApp/Evolution, sessão, consentimento e distribuição de leads;
- IA, dados enviados, modelos/provedores, custos, retenção, avaliação e fallback;
- CRM, públicos, gamificação, alertas e regras de players.

### P4.3 — Governança contínua

- revisão mensal de documentos vivos;
- alerta para documento sem dono ou revisão vencida;
- checagem automatizada de links, cabeçalhos e arquivos ignorados;
- template único para RFC, evidência, runbook e ADR.

**Critério de aceite de P4:** operação e suporte localizam procedimentos e limitações sem depender do autor original da funcionalidade.

## 10. Dependências e ordem de execução

```text
P0.1 Paridade Git/banco
  ├─> P0.2 Voz e callbacks
  ├─> P0.3 Aceite dos canais
  └─> P0.6 Release segura

P0.4 Homologação com a casa
  └─> P2.3 Certificação dos relatórios

P1.1 Índice e fonte de verdade
  ├─> P1.2 Reconciliação dos documentos
  ├─> P1.3 Ambientes e deploy
  ├─> P1.4 Arquitetura e integrações
  └─> P1.5 RBAC e recuperação

P0 + P1 concluídos
  └─> P2 Robustez e testes críticos
       └─> P3 UX, acessibilidade e desempenho
            └─> P4 Escala de conhecimento e suporte
```

Ordem recomendada dentro da execução:

1. preservar e versionar o estado que já está aplicado remotamente;
2. eliminar ambiguidade operacional de voz e flags;
3. concluir os aceites reais dos canais e da atribuição;
4. corrigir riscos de dependência e gates de release;
5. recuperar a fonte documental de verdade;
6. ampliar testes, observabilidade e robustez;
7. executar usabilidade, acessibilidade e otimização;
8. completar manuais e governança contínua.

## 11. Fora de escopo imediato

Estes itens não devem disputar capacidade com P0 e P1 sem decisão explícita:

- novos canais ou provedores;
- atribuição probabilística ou causalidade sem evidência determinística;
- WhatsApp no Short.io;
- novos modelos de IA ou expansão de automações;
- redesign visual amplo sem teste de usabilidade;
- reatribuição retroativa de histórico sem token confiável;
- funcionalidades comerciais que não reduzam risco ou concluam aceites existentes.

## 12. Riscos de execução

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| versionar alterações locais misturadas | regressão ou commit com escopo indevido | revisar diff por arquivo e separar commits temáticos |
| ativar voz antes do callback final | chamadas sem resultado auditável ou duplicadas | tenant piloto, pausa disponível e go/no-go formal |
| upgrade incompatível do Nitro | quebra de SSR/build/runtime | branch isolada, regressão completa e rollback |
| homologação depender da casa | bloqueio do funil oficial | contrato de payload, payloads de exemplo e responsável externo definido |
| documentos continuarem duplicados | retorno da divergência de estado | índice canônico e documentos históricos imutáveis |
| testes passarem sem cobrir tenant/concorrência | falsa confiança | matriz negativa e E2E obrigatórios antes da certificação |

## 13. Protocolo de encerramento por item

Nenhum item deve ser marcado como concluído sem registrar:

- código e revisão relacionados;
- migration aplicada e confirmada, quando houver;
- ambiente e tenant usados na validação;
- testes automatizados relevantes;
- typecheck, lint e build;
- cenário funcional com resultado;
- isolamento por tenant e papel, quando aplicável;
- estado vazio, erro, timeout e retry;
- observabilidade e rollback;
- commit/release implantado;
- responsável pelo aceite e data.

## 14. Quadro inicial de acompanhamento

| ID | Entrega | Estado inicial | Bloqueia |
| --- | --- | --- | --- |
| P0.1 | paridade Git/aplicação/banco | concluída em `02171a8`; migration e schema remoto validados | voz, release reproduzível |
| P0.2 | estado operacional de voz | parcial | aceite de voz e jornadas com voz |
| P0.3 | matriz real dos canais | parcial/bloqueada | certificação dos canais |
| P0.4 | atribuição homologada com a casa | parcial/bloqueada externamente | receita oficial e aceite do funil |
| P0.5 | vulnerabilidades de dependências | pendente | release segura |
| P0.6 | controles mínimos de release | parcial | promoção confiável |
| P1.1 | README e índice | pendente | onboarding e governança documental |
| P1.2 | reconciliação dos documentos | pendente | fonte de verdade |
| P1.3 | ambientes/configuração/deploy | parcial | operação reproduzível |
| P1.4 | arquitetura/dados/integrações | pendente | evolução segura |
| P1.5 | RBAC/LGPD/recuperação | parcial | segurança e continuidade |
| P2.1 | fechamento integral Short.io | parcial | produto suportado além do piloto |
| P2.2 | certificação de jornadas | parcial | rollout amplo |
| P2.3 | certificação de conversão | parcial | uso oficial dos relatórios |
| P2.4 | testes de segurança/integração | pendente | certificação multitenant |
| P2.5 | observabilidade/SLO | parcial | operação previsível |
| P3.1 | usabilidade com operadores | pendente | aceite humano |
| P3.2 | acessibilidade/interações | parcial | qualidade de UX |
| P3.3 | navegação e modularização | parcial | manutenção e clareza |
| P3.4 | warnings/bundle/performance | parcial | sustentabilidade técnica |
| P4.1–P4.3 | manuais e governança ampliada | pendente | escala de suporte |

## 15. Decisão executiva recomendada

Suspender novas frentes funcionais até concluir P0.1, P0.2 e P0.6. Manter campanhas, jornadas e voz limitadas ao estado já autorizado por ambiente até que a matriz de canais e a homologação da atribuição produzam evidência real. Executar P1 em paralelo apenas onde não houver conflito com a estabilização operacional.

O produto possui base suficiente para avançar sem reescrita ampla. A prioridade é tornar o que já existe reproduzível, homologado, observável e documentado antes de ampliar o escopo.
