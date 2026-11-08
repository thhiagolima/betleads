// Help article for "Automações" (/automacoes), o hub de jornadas. Sete abas:
// Jornadas, Mapa, Fila de envio, Falhas, Conflitos, Leads mortos e Fluxos de
// voz (o hash de cada uma é o id usado aqui como `tab`: jornadas, mapa, fila,
// falhas, conflitos, leads-mortos, fluxos-de-voz — confirmado em
// src/components/journeys/journeys-hub.tsx, HUB_VIEWS). O editor de jornada
// (/jornadas/nova, /jornadas/$journeyId) e o relatório da jornada são outra
// tela (Tarefa 14) — aqui só um apontador para "Nova jornada".
//
// Fontes: src/routes/automacoes.tsx; src/components/journeys/journeys-hub.tsx
// (cabeçalho, aba Jornadas, automações legadas, diálogos Pausar/Ativar/Ligar
// envio imediato?/Limites de contato/Como contamos, abas Fila de
// envio/Falhas/Conflitos); src/components/journeys/journey-map-card.tsx (aba
// Mapa); src/components/journeys/journey-status-control.tsx (diálogos Pausar
// e Ativar, compartilhados com o editor); src/components/journeys/dead-leads-panel.tsx
// (aba Leads mortos); src/components/ligacoes/flows-tab.tsx,
// flow-form-dialog.tsx e sequence-builder-dialog.tsx (aba Fluxos de voz — o
// mesmo componente não é usado em nenhuma outra rota, então as âncoras ficam
// com o prefixo automacoes. em vez de fluxos-voz.); mais os textos de
// src/lib/journey-express.ts, src/lib/dead-leads.shared.ts,
// src/components/journeys/journey-editor-config.ts e src/lib/player-journeys.ts.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "automacoes",
  route: "/automacoes",
  defaultTab: "jornadas",
  title: "Automações",
  purpose:
    "O painel de jornadas: criar, ativar/pausar, acompanhar quem está em cada etapa, ver falhas e conflitos de prioridade, a lista de leads mortos e os fluxos de ligação (voz). A aba Fluxos de voz só aparece com o canal de voz ligado para a casa.",
  roles: ["admin", "gestor", "member"],
  terms: [
    "grupo-de-controle",
    "reentrada",
    "gatilho",
    "ftd",
    "leads-mortos",
    "envio-imediato",
    "conflito-entre-jornadas",
  ],
  sections: [
    // ---------------------------------------------------------------
    // Cabeçalho (visível em quase todas as abas)
    // ---------------------------------------------------------------
    {
      id: "cabecalho",
      title: "Cabeçalho",
      tab: "jornadas",
      intro:
        "Os três controles do topo. \"Nova jornada\" fica sempre visível; \"Limites de contato\" aparece em todas as abas, exceto Mapa e Fluxos de voz; \"Como contamos\" aparece só na aba Jornadas.",
      items: [
        {
          anchor: "automacoes.header.nova-jornada",
          label: "Nova jornada",
          what: "Abre o editor de jornadas para criar uma do zero: gatilho, público, etapas (SMS, e-mail, voz, espera), saída e limites.",
          notes:
            "O editor completo (/jornadas/nova e /jornadas/$journeyId) é uma tela própria, com o seu próprio artigo de ajuda.",
        },
        {
          anchor: "automacoes.header.limites-contato",
          label: "Limites de contato",
          what: 'Abre o diálogo "Limites de contato", com o máximo de mensagens por pessoa e a regra de leads mortos. Vale para todas as jornadas, em todos os canais.',
          roles: ["admin", "gestor"],
        },
        {
          label: 'Diálogo "Limites de contato" — campos',
          what: '"Máximo em 24 h" e "Máximo em 7 dias": o total de SMS e e-mails já enviados pela casa (por qualquer jornada) que uma pessoa pode receber nessas janelas. Campo em branco = sem limite. Abaixo, a contagem inclui só os envios já realizados; mensagens ainda agendadas não entram no limite.',
          roles: ["admin", "gestor"],
          notes:
            '"Máximo em 24 h" aceita de 1 a 1000; "Máximo em 7 dias" aceita de 1 a 5000. Se os dois estiverem preenchidos e o de 7 dias for menor que o de 24 h, o salvamento é bloqueado com o aviso "O limite de 7 dias deve ser igual ou maior que o de 24 horas."',
        },
        {
          label: 'Diálogo "Limites de contato" — Leads mortos',
          what: 'Um interruptor "Leads mortos" liga/desliga a regra, e o campo "Mensagens seguidas sem ação (N)" define depois de quantas mensagens de jornada sem nenhuma ação (depósito, PIX gerado, saque, login, jogo ou clique) um lead sai de todas as jornadas e vai para o público Leads mortos.',
          roles: ["admin", "gestor"],
          notes:
            'N vai de 2 a 50 (padrão 5); um valor fora da faixa (ou que não seja um número inteiro) bloqueia o salvamento com o aviso "O limite de leads mortos deve ser um número entre 2 e 50." Jornadas de envio imediato disparadas pela ação do próprio jogador continuam valendo mesmo com a regra ligada. Ao ligar a regra pela primeira vez e salvar, o CRM leva você direto para a aba Leads mortos, com o aviso "Regra de leads mortos ligada. Use “Avaliar base atual agora” para marcar quem já se encaixa."; o botão do diálogo é "Salvar limites" ("Salvando…" enquanto grava).',
        },
        {
          anchor: "automacoes.header.como-contamos",
          label: "Como contamos",
          what: 'Abre o diálogo "Como a conta é feita", que explica o que entra no número "Recuperado pelo CRM" e o que fica de fora.',
        },
        {
          label: 'Diálogo "Como a conta é feita"',
          what: "Conta como recuperado o depósito do mesmo jogador feito em até 7 dias depois de um clique confirmado no link da jornada. Cada depósito é atribuído só à mensagem do último clique rastreado; depósitos entre o 8º e o 14º dia ficam registrados como assistidos e não entram no recuperado. Depósitos sem clique confirmado são operacionais e não aparecem nas telas de jornadas. Quem deposita em qualquer etapa sai da jornada na hora, e quem pediu para sair não volta a receber comunicações.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Jornadas
    // ---------------------------------------------------------------
    {
      id: "jornadas",
      title: "Jornadas",
      tab: "jornadas",
      intro:
        "A lista de todas as jornadas da casa, com os números gerais, filtro por status, busca e as ações de cada uma.",
      items: [
        {
          anchor: "automacoes.jornadas.kpis",
          label: 'Números do topo ("Recuperado pelo CRM", "Mensagens enviadas", "Em andamento", "Jornadas ativas")',
          what: '"Recuperado pelo CRM": depósitos com clique confirmado no link da jornada, até 7 dias depois do clique (some em grupo com "Como contamos"). "Mensagens enviadas": total de SMS, e-mail e voz enviados por todas as jornadas, desde o início. "Em andamento": jogadores dentro de alguma jornada agora. "Jornadas ativas": quantas das jornadas da casa estão ativas, de quantas no total.',
        },
        {
          anchor: "automacoes.jornadas.filtro",
          label: '"Todas" / "Ativas" / "Pausadas" / "Rascunhos"',
          what: "Filtra a lista de jornadas por status.",
        },
        {
          anchor: "automacoes.jornadas.busca",
          label: "Buscar por nome ou gatilho",
          what: "Filtra a lista pelo texto digitado, comparando com o nome da jornada e com o nome do gatilho de entrada.",
        },
        {
          anchor: "automacoes.jornadas.linha",
          label: "Linha da jornada — nome, status e selos",
          what: 'O nome é um link para o editor da jornada. Ao lado, o selo de status (Rascunho/Ativa/Pausada/Arquivada), e, quando existem, o selo de data de término ("Encerra em" ou "Encerrada em") e o selo laranja de Envio imediato. Abaixo, o gatilho de entrada (ex.: "Entrada manual", "Quando nada acontece: sem login há 3 dias") e um resumo das etapas: quantos SMS/e-mail/voz tem a sequência, o tempo total de espera, e uma fileira de pontos que mostra a ordem (passe o mouse para ver a sequência completa).',
          notes:
            'Uma jornada sem nenhuma etapa configurada mostra "Sem etapas configuradas" no lugar do resumo.',
        },
        {
          anchor: "automacoes.jornadas.metricas",
          label: '"Em andamento" / "Concluíram" / "Enviados" / "Recuperado pelo CRM" (por jornada)',
          what: '"Em andamento": quantos jogadores estão dentro desta jornada agora (aguardando a próxima etapa, a janela de envio ou pausados por prioridade — veja a aba Conflitos). "Concluíram": quantos terminaram ou saíram (por exemplo, ao depositar); quem saiu antes da primeira mensagem aparece também como "X sem mensagem". "Enviados": mensagens de fato enviadas por esta jornada. "Recuperado pelo CRM": o mesmo cálculo do topo, só desta jornada.',
          notes:
            'Cada número com o ícone de informação (i) mostra, ao passar o mouse, a explicação completa — por exemplo, o que faz alguém contar como "sem mensagem" (pagou antes do envio, limite diário, deixou de se encaixar ou grupo de controle).',
        },
        {
          anchor: "automacoes.jornadas.pausar-ativar",
          label: '"Pausar" / "Ativar"',
          what: 'Uma jornada ativa mostra "Pausar"; qualquer outro status (exceto Arquivada, que fica sem botão) mostra "Ativar".',
        },
        {
          label: 'Diálogo "Pausar [nome]?"',
          what: 'Avisa quantos jogadores estão na jornada agora (ou que ninguém está, se for o caso) e, quando há gente dentro, pergunta o que fazer com ela: "Manter os jogadores" (ao ativar de novo, cada um continua de onde parou, respeitando o limite de mensagens por pessoa) ou "Encerrar a participação de todos" (todos saem agora; ao ativar de novo, só entra quem cumprir o gatilho outra vez). Os botões são "Cancelar" e "Pausar" (ou "Pausar e encerrar" quando a 2ª opção está marcada).',
          notes:
            'Enquanto pausada, ninguém novo entra e nenhuma mensagem sai. O toast de confirmação mostra quantos jogadores saíram, quando a opção de encerrar foi usada.',
        },
        {
          label: 'Diálogo "Ativar [nome]"',
          what: 'Pergunta quem pode entrar: "Só casos novos, a partir de agora" (ninguém da base atual entra; quem já estava na jornada sai na próxima verificação) ou "Incluir a base atual" (jogadores que já cumprem o gatilho entram nos próximos minutos, dentro do limite de mensagens por pessoa). O botão é "Ativar".',
          notes:
            'Este diálogo só aparece para jornadas cujo gatilho não é "entrada manual" nem "jogador mudou de nível" — essas duas ativam direto, sem perguntar. Ao escolher "Incluir a base atual", o diálogo mostra uma estimativa: quantos jogadores entram agora e o custo aproximado do 1º envio e da jornada completa (se ninguém saísse antes) — a estimativa já considera o público, os filtros de entrada e a idade máxima do evento, e pode demorar um instante para calcular ("Calculando o impacto…").',
        },
        {
          anchor: "automacoes.jornadas.relatorio",
          label: "Relatório",
          what: "Abre o relatório detalhado daquela jornada (etapas, entradas, saídas e recuperação ao longo do tempo) — tela própria, com o seu artigo de ajuda.",
        },
        {
          anchor: "automacoes.jornadas.menu",
          label: 'Menu "…" (mais ações)',
          what: 'Abre um menu com "Editar" (vai para o editor da jornada), "Ligar envio imediato" / "Desligar envio imediato" e "Excluir" (ou "Excluir (pause antes)", desabilitado, quando a jornada está ativa).',
        },
        {
          label: 'Diálogo "Ligar envio imediato?"',
          what: 'Explica o que o envio imediato faz: passa na frente das outras jornadas na fila de envio; continua respeitando o limite diário da própria jornada e a reentrada; jogadores desta jornada que foram adiados pelo intervalo entre jornadas ou por limite global voltam para a fila agora. Avisa para usar só em jornadas urgentes, como saque pago ou PIX gerado. Os botões são "Cancelar" e "Ligar envio imediato".',
        },
        {
          label: 'Diálogo "Desligar o envio imediato?"',
          what: 'Avisa que a jornada volta a respeitar o intervalo entre jornadas, os limites de mensagens por pessoa e a prioridade, e que envios podem passar a ser adiados. Os botões são "Cancelar" e "Desligar envio imediato".',
        },
        {
          label: 'Diálogo "Excluir jornada?"',
          what: 'Avisa que a exclusão não pode ser desfeita. Os botões são "Cancelar" e "Excluir jornada".',
          notes:
            'Só é possível excluir uma jornada que não está ativa — pause-a primeiro.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Automações legadas (dentro da aba Jornadas)
    // ---------------------------------------------------------------
    {
      id: "legado",
      title: "Automações legadas",
      tab: "jornadas",
      intro:
        'Aparece só quando a casa ainda tem automações antigas de SMS ou e-mail (de antes das jornadas) de um canal que está ligado para a casa. Converta, revise o rascunho, ative a jornada e só então desative a origem — novas automações são sempre criadas como jornadas.',
      items: [
        {
          anchor: "automacoes.legado.item",
          label: "Linha da automação legada",
          what: 'Mostra o nome, o canal (SMS ou e-mail), o status ("Ativa"/"Desativada") e a entrada. Enquanto não foi convertida, tem o selo "Compatibilidade temporária" na seção e o botão "Converter em jornada". Depois de convertida, mostra o selo "Convertida" (ou "Migração concluída", se a origem já foi desativada), o botão "Abrir jornada" e, se a origem ainda está ativa, "Desativar legado".',
        },
        {
          label: 'Diálogo "Desativar a automação legada?"',
          what: 'Avisa que a automação para de enviar na hora e que os envios passam a sair só pela jornada convertida (já ativa). Os botões são "Cancelar" e "Desativar legado".',
          roles: ["admin", "gestor"],
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Mapa
    // ---------------------------------------------------------------
    {
      id: "mapa",
      title: "Mapa",
      tab: "mapa",
      intro:
        "Como as jornadas da casa se encaixam (por tipo de gatilho), lado a lado, e quantos jogadores estão em cada uma agora. Não mostra \"Limites de contato\" nem \"Como contamos\" no topo.",
      items: [
        {
          anchor: "automacoes.mapa.lanes",
          label: "Faixas do mapa",
          what: 'Cada faixa agrupa jornadas de um mesmo tipo de entrada (por exemplo, jornadas de depósito, ou de evento), com uma seta entre jornadas que seguem uma a outra na mesma faixa.',
        },
        {
          anchor: "automacoes.mapa.item",
          label: "Cartão da jornada no mapa",
          what: 'Um ponto verde (ativa) ou cinza tracejado (pausada/rascunho/arquivada) ao lado do nome, e o número de jogadores dentro dela agora. Quando a jornada tem grupo de controle, aparece também o selo "controle X%". Clicar no cartão abre o editor daquela jornada.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Fila de envio
    // ---------------------------------------------------------------
    {
      id: "fila",
      title: "Fila de envio",
      tab: "fila",
      intro:
        "Jogadores dentro de uma jornada, aguardando a próxima etapa. É uma lista só de leitura.",
      items: [
        {
          anchor: "automacoes.fila.linha",
          label: "Linha da fila",
          what: 'Mostra o jogador, a jornada, a etapa atual (ex.: "Etapa 2"), o status (ex.: "aguardando a próxima etapa") e, quando já está marcado, o horário do próximo envio.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Falhas
    // ---------------------------------------------------------------
    {
      id: "falhas",
      title: "Falhas",
      tab: "falhas",
      intro: "Jogadores cujo envio falhou depois de todas as tentativas. Lista só de leitura.",
      items: [
        {
          anchor: "automacoes.falhas.linha",
          label: "Linha da falha",
          what: 'Mostra o jogador, a jornada, a etapa e o motivo da falha (por exemplo, "sem telefone cadastrado").',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Conflitos
    // ---------------------------------------------------------------
    {
      id: "conflitos",
      title: "Conflitos",
      tab: "conflitos",
      intro:
        'Jogadores pausados por um conflito entre jornadas: outra jornada de maior prioridade está falando com eles agora. Quando há algum, o número aparece entre parênteses no nome da própria aba (ex.: "Conflitos (12)"). Lista só de leitura.',
      items: [
        {
          anchor: "automacoes.conflitos.linha",
          label: "Linha do conflito",
          what: 'Mostra o jogador, a jornada pausada, qual jornada tem prioridade (quando identificada) e desde quando está pausado.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Leads mortos
    // ---------------------------------------------------------------
    {
      id: "leads-mortos",
      title: "Leads mortos",
      tab: "leads-mortos",
      intro:
        'Jogadores marcados como leads mortos (ou já reativados), a regra que os marca e as ações disponíveis. O botão "Limites de contato" continua no topo; só "Como contamos" não aparece aqui.',
      items: [
        {
          anchor: "automacoes.leads-mortos.kpis",
          label: '"Leads mortos agora" / "Reativados em 30 dias" / "Regra"',
          what: '"Leads mortos agora": quantos estão fora de todas as jornadas por essa regra. "Reativados em 30 dias": quantos voltaram a agir ou foram reativados manualmente. "Regra": se está "Ligada" ou "Desligada" e, se ligada, depois de quantas mensagens sem ação alguém é marcado.',
        },
        {
          anchor: "automacoes.leads-mortos.ligar-regra",
          label: "Ligar em Limites de contato",
          what: 'Aparece só quando a regra está desligada, dentro do aviso "A regra de leads mortos está desligada." Abre o mesmo diálogo "Limites de contato" do topo, já pronto para ligar a regra.',
          roles: ["admin", "gestor"],
        },
        {
          anchor: "automacoes.leads-mortos.avaliar-base",
          label: "Avaliar base atual agora",
          what: 'Aparece só quando a regra está ligada. A regra passa a valer para as próximas mensagens; este botão marca, na hora, quem já recebeu as N mensagens sem agir antes da regra existir.',
          notes:
            'Mostra o progresso em tempo real ("Avaliando…", depois quantos jogadores foram avaliados e marcados) e roda em rodadas automáticas até não haver mais ninguém para marcar.',
          roles: ["admin", "gestor"],
        },
        {
          anchor: "automacoes.leads-mortos.filtro",
          label: '"Mortos" / "Reativados"',
          what: "Alterna entre a lista de leads mortos agora e a de quem já foi reativado.",
        },
        {
          anchor: "automacoes.leads-mortos.busca",
          label: "Nome, telefone, e-mail ou ID externo",
          what: "Busca um lead específico dentro da lista.",
        },
        {
          label: "Colunas da tabela",
          what: 'Lead (nome, contato e, se tiver, selo VIP), "Mensagens sem ação" (e de quantas jornadas saiu), "Última ação" (ou "Nunca agiu"), "Última jornada", "Depósitos" (valor total, se já fez o 1º depósito e a data do último), "Último login" e "Marcado"/"Reativado" (quando e, na aba Reativados, o motivo).',
          notes: 'O contato aparece mascarado (ex.: "j•••@gmail.com") para proteger o dado.',
        },
        {
          anchor: "automacoes.leads-mortos.reativar",
          label: "Reativar",
          what: "Tira o lead da lista de leads mortos e permite que volte a entrar nas jornadas.",
        },
        {
          label: 'Diálogo "Reativar este lead?"',
          what: 'Avisa que, se o lead voltar a receber as N mensagens seguidas sem agir, volta para a lista. Os botões são "Cancelar" e "Reativar lead".',
        },
        {
          anchor: "automacoes.leads-mortos.paginacao",
          label: '"Anterior" / "Próxima"',
          what: "Navega entre as páginas da lista, quando há mais leads do que cabem em uma página.",
        },
        {
          label: 'Link para "Campanhas"',
          what: 'Abaixo do título da lista, um aviso indica o público a usar para falar com esses leads numa campanha (o nome e o código do público, por exemplo "system:dead-leads"), com um link direto para a tela de Campanhas.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Fluxos de voz
    // ---------------------------------------------------------------
    {
      id: "fluxos-voz",
      title: "Fluxos de voz",
      tab: "fluxos-de-voz",
      intro:
        'As automações de ligação da casa — o cartão por dentro chama a si mesmo de "Fluxos de ligação": gatilho → sequência de ligações, delays e SMS condicionais → condições de saída. Não é uma jornada e não aparece nas outras abas; não mostra "Limites de contato" nem "Como contamos" no topo. Esta aba só aparece quando o canal de voz está ligado para a casa; com o canal desligado, ela desaparece do seletor de abas, mesmo com fluxos já criados.',
      items: [
        {
          anchor: "automacoes.fluxos.novo",
          label: "Novo fluxo",
          what: 'Abre o diálogo "Novo fluxo" (veja os campos abaixo) para criar um fluxo de ligação do zero.',
        },
        {
          anchor: "automacoes.fluxos.linha",
          label: "Linha do fluxo",
          what: 'Nome, selo "ativo"/"pausado", o gatilho e o resumo da sequência (quantas ligações, quantos delays e quantos SMS no total).',
        },
        {
          anchor: "automacoes.fluxos.ativo",
          label: "Interruptor ativo/pausado",
          what: "Liga ou pausa o fluxo sem abrir o editor.",
        },
        {
          anchor: "automacoes.fluxos.editar",
          label: "Editar (ícone de lápis)",
          what: 'Abre o mesmo diálogo de "Novo fluxo", já preenchido, para alterar o fluxo.',
        },
        {
          anchor: "automacoes.fluxos.excluir",
          label: "Excluir (ícone de lixeira)",
          what: 'Pede confirmação ("Excluir fluxo “[nome]”?", com os botões "Cancelar" e "Excluir fluxo") antes de remover o fluxo e todas as suas etapas, permanentemente.',
        },
        {
          label: 'Diálogo "Novo fluxo" / "Editar fluxo" — Configuração',
          what: 'Campos "Nome" e "Gatilho" (lista dos gatilhos de ligação cadastrados, ou "Nenhum"), e o interruptor "Fluxo ativo".',
        },
        {
          label: 'Diálogo "Novo fluxo" — Sequência de blocos',
          what: 'A sequência de blocos do fluxo, montada manualmente (sem randomização) com os botões "Ligação" e "Delay", que adicionam um bloco ao final; cada bloco tem botões para mover para cima/para baixo e remover (lixeira).',
          notes:
            'O botão "Gerar em sequência" abre um segundo diálogo, "Gerar fluxo em sequência": você escolhe, em ordem, os roteiros de ligação (ou clica em "Usar todos os roteiros"), um SMS opcional por etapa, a condição desse SMS, o delay entre etapas e a duração máxima de cada ligação. O botão "+ Etapa" adiciona mais uma linha de roteiro/SMS, e cada etapa tem os mesmos botões de mover para cima/para baixo e remover (lixeira) dos blocos principais. "Usar todos os roteiros" sem nenhum roteiro cadastrado mostra o aviso "Nenhum roteiro disponível"; ao clicar em "Gerar N blocos" sem nenhuma etapa com roteiro escolhido, aparece "Selecione ao menos 1 roteiro". Quando funciona, o sistema monta e adiciona esses blocos de uma vez à sequência do fluxo (sem apagar o que já existia).',
        },
        {
          label: "Bloco Ligação — campos",
          what: '"Nome interno" (só para identificar o bloco na lista), "Roteiro / áudio" (o roteiro de ligação a usar), "Voz" (opcional, sobrescreve a voz padrão do roteiro), "Tempo máximo (seg)" da ligação e "Tentativas" (quantas vezes tentar essa ligação).',
          notes:
            'Para criar um intervalo entre ligações (por exemplo, 1 dia antes da próxima tentativa), adicione um bloco de Delay logo depois — o campo "Tentativas" controla só repetições imediatas da mesma chamada, não o espaçamento entre blocos.',
        },
        {
          label: "Bloco Ligação — SMS pós-ligação por resultado",
          what: 'Dentro de cada bloco de Ligação, "Adicionar SMS" cria uma regra: uma condição (sempre; se atendeu; se não atendeu; se ouviu X segundos ou mais/menos; se desligou antes de X segundos; se caixa postal; se número ocupado; se chamada caiu/falhou; se não houve resposta — algumas pedem o campo "X seg"), o texto da mensagem (com um seletor de variáveis para inserir, como o primeiro nome) e o botão de remover (lixeira). A primeira condição que casar dispara o SMS correspondente.',
        },
        {
          label: "Bloco Delay — campos",
          what: 'Um valor numérico e a unidade (Segundos, Minutos, Horas ou Dias) de espera antes do próximo bloco.',
        },
        {
          label: 'Diálogo "Novo fluxo" — Condições de saída',
          what: 'Quatro opções que alternam entre ligada/desligada ao clicar: "se fizer login", "se depositar", "se fizer primeiro depósito" e "se voltar a jogar"; mais dois campos numéricos opcionais, "Sair se valor depositado ≥ (R$)" e "Sair se quantidade de apostas ≥". Quando qualquer condição marcada acontece, o jogador sai do fluxo na hora (verificação em tempo real).',
        },
        {
          label: 'Diálogo "Novo fluxo" — rodapé',
          what: 'Os botões "Cancelar" e "Salvar fluxo" ("Salvando..." enquanto grava).',
          notes:
            'Salvar bloqueia com um aviso quando: o nome está em branco ("Nome obrigatório"); não há nenhum bloco ("Adicione ao menos 1 bloco (Ligação ou Delay)"); ou um bloco de Ligação ficou sem roteiro escolhido ("Bloco N: selecione um roteiro de ligação", onde N é a posição do bloco na sequência).',
        },
      ],
    },
  ],

  states: [
    {
      id: "jornadas-vazio",
      title: "Nenhuma jornada ainda.",
      what: "Texto mostrado na aba Jornadas quando a casa não tem nenhuma jornada criada.",
      action: 'Clique em "Nova jornada" para criar a primeira.',
    },
    {
      id: "jornadas-filtro-vazio",
      title: "Nenhuma jornada nesta visão.",
      what: "Acontece quando existem jornadas, mas nenhuma cumpre o filtro de status ou a busca atual.",
      action: "Mude o filtro ou a busca para ver outras jornadas.",
    },
    {
      id: "mapa-vazio",
      title: "Nenhuma jornada no mapa.",
      what: "A casa ainda não tem jornadas para mostrar no mapa.",
      action: "Crie uma jornada para ver aqui como elas se encaixam.",
    },
    {
      id: "fila-vazia",
      title: "Fila de envio vazia.",
      what: "Nenhum jogador está aguardando envio nas jornadas agora.",
    },
    {
      id: "falhas-vazio",
      title: "Nenhuma falha registrada.",
      what: "Nenhum envio de jornada falhou.",
    },
    {
      id: "conflitos-vazio",
      title: "Nenhum conflito agora.",
      what: "Nenhum jogador está pausado por prioridade entre jornadas no momento.",
    },
    {
      id: "leads-mortos-regra-desligada",
      title: "A regra de leads mortos está desligada.",
      what: "Nenhum lead novo é marcado como morto enquanto a regra estiver desligada.",
      action: 'Ligue a regra em "Limites de contato" (ou pelo botão "Ligar em Limites de contato" desta aba).',
    },
    {
      id: "leads-mortos-vazio",
      title: "Nenhum lead morto / Nenhum lead reativado.",
      what: "Texto mostrado quando a lista (de leads mortos ou de reativados) está vazia. Com uma busca digitada, o texto muda para \"Nenhum lead encontrado\".",
    },
    {
      id: "leads-mortos-erro",
      title: "Não foi possível carregar os leads mortos.",
      what: "A lista não carregou por um erro de rede ou do servidor.",
      action: "Recarregue a página; se persistir, tente mais tarde.",
    },
    {
      id: "fluxos-vazio",
      title: 'Nenhum fluxo criado. Clique em "Novo fluxo" para começar.',
      what: "A casa ainda não tem nenhum fluxo de ligação cadastrado.",
    },
    {
      id: "fluxos-erro",
      title: "Não foi possível carregar os fluxos.",
      what: 'A lista de fluxos não carregou por um erro de rede ou do servidor. Abaixo do título aparece uma linha com o detalhe técnico do erro (a mensagem exata devolvida pelo servidor, ou "Erro desconhecido ao buscar os fluxos de ligação." quando não há detalhe).',
      action: 'Clique em "Tentar novamente".',
    },
    {
      id: "fluxos-dialogo-vazio",
      title: "Nenhum bloco. Adicione uma Ligação ou um Delay para começar.",
      what: 'Texto mostrado dentro do diálogo "Novo fluxo"/"Editar fluxo", na seção "Sequência de blocos", enquanto nenhum bloco foi adicionado ainda.',
      action: 'Clique em "Ligação" ou "Delay" (ou use "Gerar em sequência").',
    },
  ],

  tours: {
    jornadas: [
      {
        anchor: "automacoes.header.nova-jornada",
        title: "Nova jornada",
        body: "Cria uma jornada do zero: gatilho, público, etapas e saída.",
        articleSection: "cabecalho",
      },
      {
        anchor: "automacoes.jornadas.kpis",
        title: "Números gerais",
        body: "Recuperado pelo CRM, mensagens enviadas, jogadores em andamento e jornadas ativas — desde o início.",
        articleSection: "jornadas",
      },
      {
        anchor: "automacoes.jornadas.filtro",
        title: "Filtrar por status",
        body: "Veja só as ativas, pausadas ou rascunhos.",
        articleSection: "jornadas",
      },
      {
        anchor: "automacoes.jornadas.busca",
        title: "Buscar",
        body: "Encontre uma jornada pelo nome ou pelo gatilho de entrada.",
        articleSection: "jornadas",
      },
      {
        anchor: "automacoes.jornadas.linha",
        title: "A jornada",
        body: "Nome, status, gatilho de entrada e um resumo da sequência de etapas.",
        articleSection: "jornadas",
      },
      {
        anchor: "automacoes.jornadas.metricas",
        title: "Números da jornada",
        body: "Em andamento, concluíram, enviados e recuperado pelo CRM — passe o mouse no (i) para o detalhe.",
        articleSection: "jornadas",
      },
      {
        anchor: "automacoes.jornadas.pausar-ativar",
        title: "Pausar / Ativar",
        body: "Liga ou pausa a jornada. Ativar pode perguntar quem entra; pausar pode perguntar o que fazer com quem já está dentro.",
        articleSection: "jornadas",
      },
      {
        anchor: "automacoes.jornadas.relatorio",
        title: "Relatório",
        body: "Acompanhe entradas, saídas e recuperação desta jornada em detalhe.",
        articleSection: "jornadas",
      },
    ],
    mapa: [
      {
        anchor: "automacoes.mapa.lanes",
        title: "Faixas do mapa",
        body: "As jornadas da casa agrupadas por tipo de gatilho, lado a lado.",
        articleSection: "mapa",
      },
      {
        anchor: "automacoes.mapa.item",
        title: "Cada jornada",
        body: "O ponto mostra se está ativa, o número é quem está dentro agora, e clicar abre o editor.",
        articleSection: "mapa",
      },
    ],
    fila: [
      {
        anchor: "automacoes.header.limites-contato",
        title: "Limites de contato",
        body: "O máximo de mensagens por pessoa e a regra de leads mortos valem para esta fila também.",
        articleSection: "cabecalho",
      },
      {
        anchor: "automacoes.fila.linha",
        title: "Quem está na fila",
        body: "Jogador, jornada, etapa atual e o próximo horário de envio, quando já está marcado.",
        articleSection: "fila",
      },
    ],
    falhas: [
      {
        anchor: "automacoes.header.limites-contato",
        title: "Limites de contato",
        body: "O máximo de mensagens por pessoa e a regra de leads mortos valem para esta aba também.",
        articleSection: "cabecalho",
      },
      {
        anchor: "automacoes.falhas.linha",
        title: "Envios que falharam",
        body: "Jogador, jornada, etapa e o motivo da falha.",
        articleSection: "falhas",
      },
    ],
    conflitos: [
      {
        anchor: "automacoes.header.limites-contato",
        title: "Limites de contato",
        body: "O máximo de mensagens por pessoa e a regra de leads mortos valem para esta aba também.",
        articleSection: "cabecalho",
      },
      {
        anchor: "automacoes.conflitos.linha",
        title: "Pausados por prioridade",
        body: "Quando duas jornadas falam com o mesmo jogador, a de maior prioridade vence e a outra espera aqui.",
        articleSection: "conflitos",
      },
    ],
    "leads-mortos": [
      {
        anchor: "automacoes.header.limites-contato",
        title: "Limites de contato",
        body: "A regra de leads mortos é configurada aqui, no mesmo diálogo dos limites de mensagem.",
        articleSection: "cabecalho",
      },
      {
        anchor: "automacoes.leads-mortos.kpis",
        title: "Quantos leads mortos",
        body: "Quantos estão fora das jornadas agora, quantos voltaram em 30 dias e se a regra está ligada.",
        articleSection: "leads-mortos",
      },
      {
        anchor: "automacoes.leads-mortos.ligar-regra",
        title: "Ligar a regra",
        body: "Enquanto a regra estiver desligada, nenhum lead novo é marcado.",
        articleSection: "leads-mortos",
      },
      {
        anchor: "automacoes.leads-mortos.avaliar-base",
        title: "Avaliar a base atual",
        body: "A regra só vale para as próximas mensagens; use este botão para marcar agora quem já se encaixa.",
        articleSection: "leads-mortos",
      },
      {
        anchor: "automacoes.leads-mortos.filtro",
        title: "Mortos / Reativados",
        body: "Alterna entre quem está morto agora e quem já voltou a receber mensagens.",
        articleSection: "leads-mortos",
      },
      {
        anchor: "automacoes.leads-mortos.busca",
        title: "Buscar um lead",
        body: "Nome, telefone, e-mail ou ID externo.",
        articleSection: "leads-mortos",
      },
      {
        anchor: "automacoes.leads-mortos.reativar",
        title: "Reativar",
        body: "Tira o lead da lista e permite que volte a entrar nas jornadas.",
        articleSection: "leads-mortos",
      },
    ],
    "fluxos-de-voz": [
      {
        anchor: "automacoes.fluxos.novo",
        title: "Novo fluxo",
        body: "Cria um fluxo de ligação: gatilho, sequência de ligações/delays e condições de saída.",
        articleSection: "fluxos-voz",
      },
      {
        anchor: "automacoes.fluxos.linha",
        title: "O fluxo",
        body: "Nome, status, gatilho e o resumo da sequência (ligações, delays e SMS).",
        articleSection: "fluxos-voz",
      },
      {
        anchor: "automacoes.fluxos.ativo",
        title: "Ativo / pausado",
        body: "Liga ou pausa o fluxo sem precisar abrir o editor.",
        articleSection: "fluxos-voz",
      },
      {
        anchor: "automacoes.fluxos.editar",
        title: "Editar",
        body: "Abre o mesmo diálogo de criação, já preenchido.",
        articleSection: "fluxos-voz",
      },
      {
        anchor: "automacoes.fluxos.excluir",
        title: "Excluir",
        body: "Remove o fluxo e todas as suas etapas, de forma permanente.",
        articleSection: "fluxos-voz",
      },
    ],
  },
};

export default screen;
