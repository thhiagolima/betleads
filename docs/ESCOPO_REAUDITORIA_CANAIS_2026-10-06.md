# Escopo de reauditoria — canais de comunicação

> **Fechamento técnico — 07/10/2026:** foram concluídos o painel operacional uniforme dos três canais, pausa/retomada e reprocessamento auditados, runbook por canal, biblioteca independente de áudios, separação entre áudio fixo e TTS, versões imutáveis de scripts e templates de e-mail e redução integral da dívida do typecheck. Permanecem abertos somente gates que exigem ambiente/credenciais produtivas ou participação humana; as migrations novas precisam ser promovidas no ambiente escolhido antes do aceite.

> **Atualização de implementação — 07/10/2026:** o lint passou a ser bloqueante no CI; foram adicionados testes mockados dos adaptadores Infobip de e-mail e voz; a configuração SMTP simulada deixou de ser exibida; templates SMS passaram a calcular GSM-7/UCS-2 e a manter histórico imutável de versões; jornadas agora selecionam e armazenam snapshot do template SMS. Os aceites reais de provedor e a execução do teste de usabilidade continuam pendentes.

**Data:** 06/10/2026  
**Escopo:** SMS, e-mail e ligações por voz. WhatsApp permanece fora desta auditoria: há código e telas, porém ele não compõe os três canais em operação solicitados e seu cron está desativado.

## Conclusão executiva

O código contém uma base madura para SMS e e-mail, com fila, limites, histórico, automações, saúde do provedor e execução agendada. Ambos estão **aptos a seguir para aceite operacional**, não automaticamente certificados em produção: este aceite ainda depende de testes reais de entrega e callback no tenant produtivo.

O canal de voz possui telas, scripts, geração de áudio, fila, callback e fluxos, mas **não está apto à automação contínua**. A migration `20261003141000_disable_unvalidated_channel_crons.sql` remove explicitamente os crons de voz e WhatsApp até que provedor, fila e relatórios sejam validados de ponta a ponta. Portanto, voz deve permanecer como piloto/manual até passar pelos gates P0 abaixo.

| Canal  | Situação encontrada                                                                                                   | Decisão de escopo                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| SMS    | Implementado e agendado por cron; Short Brasil, fila, créditos, histórico, supressão e rastreio de link presentes     | Validar em produção e evoluir biblioteca de templates                   |
| E-mail | Implementado e agendado por cron; templates, remetentes, entregabilidade, supressão, campanhas e automações presentes | Validar domínio/callback em produção e melhorar a experiência editorial |
| Voz    | Implementado parcialmente; geração/armazenamento/fila/callback existem, mas cron de despacho permanece desabilitado   | Fechar validação operacional antes de ativar automação                  |

## Evidências revisadas

- Documentos existentes: `docs/OPERACAO_SEGURA.md` e `docs/docker-deployment.md`.
- Código de envio, dispatchers, rotas públicas, telas e migrations de SMS, e-mail e ligações.
- Configuração local: as variáveis exigidas pelos canais estão declaradas/preenchidas no ambiente local. Valores e segredos não foram expostos ou validados contra fornecedores.
- Qualidade local atualizada em 07/10/2026: `npm test` passou (**10 arquivos / 28 testes**), `npm run lint` passou sem erros e `npm run build` passou. O workflow executa os três como gates bloqueantes, com timeout e saída preservada.
- Não houve envio real, alteração de cron, alteração de dados ou mudança de configuração externa nesta reauditoria.

## O que já está feito

### SMS

- Envio individual, em massa e agendado, com fila, campanha, controle de créditos e limite de partes.
- Integração Short Brasil, endpoint de webhook, histórico, indicadores de saúde e reenvio de falhas.
- Fluxos com gatilhos, espera, limite diário, cooldown, janela de envio e lista de supressão.
- Rastreamento opcional via Short.io, idempotência de dispatch e monitoramento de retomada de SMS às 06:00.
- Públicos salvos e resolução de audiência no banco.

### E-mail

- CRUD de templates (listar, criar, editar, duplicar e excluir), editor/preview, presets e seleção em campanhas e jornadas.
- Remetentes, configurações SMTP e alternativa de provedor; campanhas, automações, segmentação, histórico e dashboard.
- Sanitização de HTML, conversão de URLs relativas, descadastro/supressão, tratamento de falhas transitórias e rastreamento opcional de links.
- Dispatcher e cron por minuto, rotina de recuperação e monitoramento de retomada junto ao SMS.
- Bucket de imagens de e-mail e proxy público para imagens usadas nos templates.

### Voz

- CRUD de scripts e fluxos, seleção de lead, personalização por variáveis e geração de áudio por ElevenLabs com cache.
- Fila, disparo manual/em massa, histórico e atualização de status por webhook de voz.
- Infobip como provedor exclusivo de voz; a integração BusinessCode foi removida do sistema.
- Bucket privado `call-audios`, políticas de isolamento por tenant e uploads assinados.
- Jornadas multicanal permitem enviar e reutilizar um arquivo de voz já cadastrado como etapa de voz.

## Lacunas e melhorias obrigatórias

### P0 — bloqueiam a certificação de funcionamento pleno

1. **Aceite ponta a ponta de SMS e e-mail.** Criar uma matriz de testes por tenant/provedor: envio unitário, campanha, automação, janela de envio, limite, descadastro, falha transitória, callback de entrega e reenvio. Registrar evidência (ID de provedor, log, status final e horário).
2. **Certificar voz antes de reativar cron.** Validar chamada real com áudio armazenado, callback assinado, correlação idempotente, status final, duração, gravação quando aplicável, retentativa e relatório. Só então criar/agendar o worker de voz e incluir o canal no health check diário.
3. **Observabilidade uniforme — concluída em 07/10/2026, pendente de aceite operacional.** O hub possui painel único por canal com disponibilidade/configuração do provedor, fila pendente, itens presos, taxa de erro/entrega em 24 horas, atraso do último worker e ações de pausa/retomada e reprocessamento registradas em auditoria.
4. **CI de qualidade — concluído em 07/10/2026.** `lint`, testes e build são gates obrigatórios, com timeout explícito e saída preservada. Foram adicionados testes mockados dos adaptadores Short.io e Infobip de e-mail/voz. A dívida de avisos de tipagem continua registrada, sem mascarar erros de lint.
5. **Runbook de incidente — concluído em 07/10/2026.** `OPERACAO_SEGURA.md` documenta severidade, diagnóstico, pausa segura, recuperação/reprocessamento, rollback, comunicação, critérios de retorno por canal e retenção de áudios.

### P1 — alto valor funcional

1. **Biblioteca CRUD de templates SMS — implementada, pendente de aceite operacional.** A entidade é isolada por tenant e possui categorias/tags, estado ativo/arquivado, duplicação, cálculo GSM-7/UCS-2, partes, versionamento imutável e auditoria. Campanhas e jornadas armazenam snapshot do template. Ainda faltam evidência em banco produtivo e teste de regressão do ciclo completo após aplicação da migration.
2. **Biblioteca de áudios de voz — concluída em 07/10/2026, pendente de migration/aceite.** Há catálogo independente com upload direto, preview por URL assinada, duração automática, idioma/origem/tags, busca, renomear, arquivar/reativar e exclusão protegida por confirmação e verificação de referências. A retenção mínima e a proibição de descarte automático sem termo jurídico estão no runbook.
3. **Template de voz reutilizável — concluído em 07/10/2026, pendente de migration/aceite.** O composer separa áudio fixo da biblioteca e script dinâmico com TTS, apresenta versão, preview, cache, caracteres e regra de custo; o histórico imutável preserva script, voz e configuração.
4. **E-mail: maturidade de template — concluída em 07/10/2026, pendente de migration/aceite.** O ciclo possui rascunho/publicado/arquivado, versão, snapshot que bloqueia alteração retroativa em campanha, preview desktop/mobile, validação de links/imagens, relatório por template e novo histórico imutável de versões.
5. **Consolidação de provedores — concluída.** BusinessCode foi removida; Infobip é o provedor exclusivo de voz e e-mail.
6. **Conformidade e consentimento — concluída em 07/10/2026.** Consentimento, opt-out e base legal foram centralizados entre SMS/e-mail/voz, com importação/exportação, auditoria, sincronização das listas legadas e bloqueio antes de qualquer chamada ao provedor. Voz passou a respeitar janela por tenant, cooldown e limite móvel de 24 horas por destinatário; itens fora da política são adiados sem perda da fila.

#### Evidência da entrega de conformidade

- Tabelas tenant-aware `channel_consents`, `channel_consent_audit` e `voice_contact_policies`, protegidas por RLS.
- Backfill e normalização das supressões legadas de SMS/e-mail, incluindo telefone BR canônico.
- Bloqueio central nos envios individuais, campanhas, filas, fluxos e jornadas dos três canais.
- Descadastro público de e-mail sincronizado com a base central e registrado na auditoria.
- Tela **Canais → Consentimentos** para decisão individual, pesquisa, CSV, histórico e política de voz.
- Validação local: migrations aplicadas, build aprovado e 4 arquivos/13 testes aprovados.

### P2 — melhorias de produto e UX

1. **Navegação unificada de canais — concluída em 07/10/2026.** SMS, e-mail e voz usam o mesmo modelo: **Visão geral → Criar → Biblioteca → Campanhas/Fluxos → Histórico → Configurações**. O componente compartilhado inclui troca direta de canal, estado ativo acessível, rolagem horizontal em telas pequenas e destinos reais para cada etapa. Configurações de SMS foram consolidadas; remetentes/SMTP formam a configuração de e-mail; áudios/scripts formam a biblioteca de voz.
2. **Composer multicanal — concluído em 07/10/2026.** Foi criado um único fluxo para SMS, e-mail e voz, com seleção de audiência salva ou sistêmica, prévia, validação de variáveis, estimativa de alcance (e créditos de SMS), agendamento e confirmação obrigatória de risco antes do envio. O e-mail e a voz exibem o volume previsto, pois a precificação depende do contrato do provedor. Campanhas de voz agendadas deixam o áudio preparado na fila; o despacho automático permanece condicionado ao gate operacional de voz definido na prioridade P0.
3. **Estados operacionais orientados à ação — concluído em 07/10/2026.** SMS, e-mail e voz agora traduzem os estados técnicos em linguagem de produto: “pronto para enviar”, “aguardando provedor”, “pausado por limite”, “em retentativa” e “ação necessária”. Cada estado apresenta contexto, próxima ação e atalho para campanhas, histórico, créditos ou configurações do canal.
4. **Empty states e consolidação de fluxos — concluído em 07/10/2026.** O hub de campanhas agora diferencia a ausência inicial de campanhas de filtros sem resultado e oferece a ação correta em cada situação. A criação de voz foi direcionada ao composer multicanal, eliminando o desvio para o fluxo legado. Os diálogos antigos de campanha de SMS e e-mail, sem referências ativas, foram removidos para manter um único fluxo de criação.
5. **Teste de usabilidade com operadores — preparado em 07/10/2026, aguardando execução humana.** O roteiro, planilha de registro, definições de métrica, critérios de aceite e gate de go/no-go estão em `docs/TESTE_USABILIDADE_CANAIS_2026-10-07.md`. A conclusão desta prioridade requer ao menos três operadores autorizados em ambiente de teste; resultados não devem ser simulados.
6. **Acessibilidade do composer — concluída em 07/10/2026.** O composer multicanal recebeu labels associados, nomes de campo, estados `aria-invalid`, mensagens de validação vinculadas e anunciadas, grupos de seleção acessíveis, foco visível herdado dos controles do sistema e footer responsivo. O diálogo passou a respeitar a largura de telas pequenas, sem perder a prévia e as ações.

## Papéis e cadência

| Papel              | Responsabilidade contínua                                                                                    | Entregável/ritual                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Dev sênior         | Arquitetura de filas, idempotência, segurança, testes de integração, observabilidade e revisão de migrations | PR com plano de rollback, métricas e evidência de teste por mudança de canal |
| Designer UX        | Jornada operacional, protótipos, sistema de estados, acessibilidade e testes com usuários                    | Fluxo validado e especificação de comportamento/erro antes da implementação  |
| Gerente de projeto | Repriorizar backlog com dados, eliminar bloqueios de fornecedores, controlar dependências e propor melhorias | Revisão semanal de métricas, riscos, hipóteses e decisão de go/no-go         |
| Operação/CRM       | Aceite em produção, conteúdo, consentimento, qualidade de audiência e acompanhamento de conversão            | Checklist de campanha e evidências de entrega/callback                       |

### Ritual proposto para o gerente de projeto

- **Diário:** acompanhar alertas, filas presas, erro de provedor e campanhas pausadas.
- **Semanal:** revisar funil por canal (enviado → aceito → entregue → clique/resposta → conversão), incidentes, custo unitário e as cinco maiores oportunidades.
- **A cada release:** conduzir go/no-go baseado nos gates P0, UX aprovada, plano de rollback e dono operacional definido.
- **Mensal:** reavaliar provedores, regras de contato, opt-out, template/áudio mais eficaz e priorização do backlog. Toda melhoria proposta deve indicar problema, evidência, impacto esperado, esforço, risco e métrica de sucesso.

## Plano de execução recomendado

1. **Estabilização e aceite (P0):** concluir matriz de testes reais, observabilidade e CI; manter voz sem cron.
2. **Ativos reutilizáveis (P1):** entregar CRUD de templates SMS e biblioteca de áudio, depois endurecer versão/publicação de e-mail.
3. **Voz automatizada (P0/P1):** só após aceite do provedor, habilitar worker com rate limit, janela de contato, retentativa idempotente, health check e rollback documentado.
4. **Experiência unificada (P2):** implementar o composer e o novo modelo de navegação a partir do fluxo UX testado.

## Gates para declarar “funcionamento pleno”

Um canal somente recebe esse status quando todos os itens abaixo tiverem evidência no ambiente produtivo:

- configuração e credencial validadas sem expor segredo;
- envio real e status final de entrega/callback correlacionados;
- limites, janela de contato, supressão/opt-out e idempotência testados;
- falha transitória, recuperação e reprocessamento testados;
- métricas, alerta e responsável de plantão definidos;
- teste de regressão automatizado, build e lint aprovados;
- aceite de UX e do operador responsável;
- rollback executável e documentado.

Até os gates serem concluídos, a classificação correta é **“implementado e pendente de aceite operacional”**, e não “plenamente funcional”.
