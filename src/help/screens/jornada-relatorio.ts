// Help article for the journey report (/jornadas/$journeyId/relatorio).
// Uma única tela sem abas. Fonte: src/routes/jornadas.$journeyId_.relatorio.tsx
// e a parte de jornada (função JourneyReport) de
// src/components/conversion-report.tsx — a parte de campanha é a tela
// `campanha-relatorio` (Task 11). Também usa os componentes compartilhados
// de src/components/reports/* (report-parts.tsx, recipient-list.tsx) e
// src/lib/conversion-report.functions.ts (getConversionDataHealth, os
// avisos de saúde dos dados).
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "jornada-relatorio",
  route: "/jornadas/$journeyId/relatorio",
  title: "Relatório da jornada",
  purpose:
    "O resultado completo de uma jornada desde que foi criada: quantos entraram, o que cada etapa enviou e converteu, o que recuperou e a saúde dos dados usados nesse cálculo.",
  roles: ["admin", "gestor", "member"],
  terms: ["recuperado-pelo-crm", "ultimos-7-dias", "gatilho"],
  sections: [
    // ---------------------------------------------------------------
    // Cabeçalho
    // ---------------------------------------------------------------
    {
      id: "cabecalho",
      title: "Cabeçalho",
      intro:
        'O subtítulo mostra "Relatório da jornada", o status atual (Ativa/Pausada/Rascunho/Arquivada) e "Evento: <nome do gatilho>".',
      items: [
        {
          anchor: "jornada-relatorio.editar",
          label: "Editar jornada",
          what: "Abre o editor desta jornada.",
        },
        {
          anchor: "jornada-relatorio.voltar",
          label: "Voltar para Automações",
          what: "Volta para a aba Jornadas de Automações.",
        },
        {
          label: "Descrição da jornada",
          what: "Mostra a descrição cadastrada no editor, quando existir.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Saúde dos dados
    // ---------------------------------------------------------------
    {
      id: "saude-dos-dados",
      title: "Notas de saúde dos dados",
      intro:
        "Avisos que aparecem acima dos indicadores só quando algo no rastreio dos dados desta jornada pede atenção; sem nenhum problema, nenhum aviso aparece.",
      items: [
        {
          label: "Envios rastreados presos",
          what: '"N envio(s) rastreado(s) permanecem preparados há mais de 30 minutos." — um ou mais envios desta jornada ficaram parados na etapa de preparo do link, sem avançar.',
        },
        {
          label: "Eventos sem atribuição",
          what: '"N evento(s) desta origem ficaram sem atribuição determinística nas últimas 24 horas." — depósitos ou cliques recentes que o sistema não conseguiu ligar com segurança a um envio desta jornada.',
        },
        {
          label: "Mensagens sem link medido",
          what: '"Esta jornada enviou mensagens, mas nenhuma tinha link medido. Por isso cliques, depósitos e recuperado ficam em zero; não é falha de sincronização." Aparece quando a jornada enviou mensagens nos últimos 7 dias mas nenhuma tinha um link rastreável.',
        },
        {
          label: "Cliques do encurtador maiores que os confirmados",
          what: '"O encurtador de links registrou N cliques, mas só M foram confirmados pelo nosso link. Os não confirmados não entram no resultado." Mostra uma diferença entre o que o encurtador contou e o que o CRM conseguiu confirmar como clique de um link desta jornada.',
        },
        {
          label: "Volume muito alto",
          what: '"Volume muito alto: alguns números abaixo consideram apenas os primeiros 100 mil registros." Aparece em jornadas com um volume de envios muito grande, como aviso de que os números do relatório são parciais.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Desde a criação
    // ---------------------------------------------------------------
    {
      id: "desde-a-criacao",
      title: "Desde a criação",
      intro:
        "Resultado acumulado desta jornada, pelo último clique em até 7 dias. Inclui o resultado de etapas hoje desativadas.",
      items: [
        {
          label: "Enviados com link medido / Clicaram / Depósitos atribuídos / Recuperado pelo CRM",
          what: '"Enviados com link medido" conta só os envios que tinham um link rastreável (os outros não entram em clique/depósito/recuperado). "Clicaram" conta quem abriu o link (— quando o clique não é medido para o canal). "Depósitos atribuídos" conta jogadores com depósito atribuído a esta jornada. "Recuperado pelo CRM" soma o valor desses depósitos.',
        },
        {
          label: "Jogadores já ativos (fora da conta)",
          what: "Jogadores que já tinham depositado nas 48 horas antes do clique: o depósito deles depois do clique entra aqui, separado, nunca no total recuperado.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Agora e últimos 7 dias
    // ---------------------------------------------------------------
    {
      id: "agora-7-dias",
      title: "Agora e últimos 7 dias",
      items: [
        {
          label: "Em andamento na jornada",
          what: "Quantos jogadores estão dentro da jornada neste momento (ativos, aguardando a próxima etapa, ou pausados por prioridade).",
        },
        {
          label: "Entraram na jornada / Mensagens enviadas",
          what: "Quantos jogadores entraram e quantas mensagens a jornada enviou nos últimos 7 dias.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Etapas
    // ---------------------------------------------------------------
    {
      id: "etapas",
      title: "Etapas",
      intro:
        'Uma linha por etapa de comunicação (etapas de espera não aparecem como linha — o tempo delas some no "Espera de..." mostrado antes da etapa seguinte). O título muda para "Etapas e mensagens" quando alguma etapa sorteia entre mais de uma mensagem.',
      items: [
        {
          label: "Cabeçalho da etapa (número, tipo, nome, tempo de espera antes dela)",
          what: 'O tipo é SMS, E-mail, Voz ou Espera. O tempo de espera soma todas as etapas de espera entre a etapa anterior de comunicação e esta, escrito como "Envio na hora" (sem espera) ou "Espera de Xh/Xmin/X dias".',
        },
        {
          label: "Nesta etapa agora / Enviados em 7 dias",
          what: '"Nesta etapa agora" conta jogadores que já entraram e aguardam o envio ou o próximo passo desta etapa. "Enviados em 7 dias" conta os envios dela nos últimos 7 dias.',
        },
        {
          label: "Enviados / Entregues / Clicaram / Depósitos atribuídos / Recuperado pelo CRM",
          what: 'Totais desde a criação da etapa. "Entregues" só aparece em etapas de voz (SMS e e-mail não confirmam entrega). Os outros têm o mesmo significado do bloco "Desde a criação".',
        },
        {
          label: "Tabela de mensagens (rotação)",
          what: "Só aparece em etapas com mais de uma mensagem possível (template com variações). Uma linha por mensagem (ou \"Sem mensagem registrada\", para envios anteriores à rotação), com enviados, cliques, taxa de clique, depósitos e recuperado de cada uma.",
        },
        {
          label: "Etapas desativadas",
          what: "Tabela à parte, só quando existe pelo menos uma: etapas que já enviaram mensagens e depois foram removidas do editor. O resultado delas continua somado no total \"Desde a criação\" da jornada.",
        },
        {
          label: "Sem etapa identificada",
          what: 'Linha de texto, só quando existir: depósitos e valor recuperado cujo envio de origem não corresponde a nenhuma etapa atual da jornada.',
        },
        {
          label: "Envios que falharam ou foram cancelados",
          what: "Linha de texto com o total de envios que falharam ou foram cancelados nas etapas acima, desde a criação da jornada.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Jogadores que receberam
    // ---------------------------------------------------------------
    {
      id: "jogadores",
      title: "Jogadores que receberam",
      intro: "Clique, login e depósito só aparecem quando pertencem ao mesmo envio medido.",
      items: [
        {
          anchor: "jornada-relatorio.carregar-jogadores",
          label: "Carregar jogadores",
          what: "A lista individual carrega só quando você pede, para não atrasar o resto do relatório. Mostra \"Carregando…\" enquanto busca.",
        },
        {
          label: "Lista de jogadores",
          what: "Uma linha por jogador que recebeu, com quando foi enviado, se e quando clicou, se e quando fez login ou jogou, e se e quando depositou (com o valor).",
          notes: "Um depósito de um jogador já ativo antes do clique aparece marcado \"já ativo, não conta\" e não entra nos totais.",
        },
      ],
    },
  ],

  states: [
    {
      id: "carregando",
      title: "Carregando relatório…",
      what: "A tela ainda está buscando os dados da jornada.",
    },
    {
      id: "erro-carregar",
      title: "Não foi possível carregar o relatório.",
      what: "A busca falhou (jornada não encontrada, ou erro de rede/servidor).",
      action: "Volte para Automações e abra o relatório de novo.",
    },
    {
      id: "sem-etapas-comunicacao",
      title: "Sem etapas de comunicação",
      what: "Esta jornada ainda não possui etapas de comunicação configuradas (só tem, no máximo, etapas de espera).",
    },
    {
      id: "carregando-jogadores",
      title: "A lista individual carrega sob demanda, para não atrasar o relatório.",
      what: 'Mostrado no bloco "Jogadores que receberam" antes de clicar em "Carregar jogadores".',
      action: 'Clique em "Carregar jogadores".',
    },
    {
      id: "sem-envios-medidos",
      title: "Sem envios medidos",
      what: "Depois de carregar, a jornada ainda não tem nenhum envio com link medido.",
    },
    {
      id: "nome-tecnico-do-gatilho",
      title: "Evento: manual / Evento: inactivity",
      what: 'Para uma jornada de gatilho "Tempo sem atividade" ou "Entrada manual ou API", o subtítulo do relatório mostra o nome técnico (inactivity/manual) em vez do nome amigável usado no editor — não é um erro, é só uma diferença de rótulo entre as duas telas.',
    },
  ],

  tours: {
    default: [
      {
        anchor: "jornada-relatorio.editar",
        title: "Editar jornada",
        body: "Abre o editor desta jornada, para ajustar o gatilho, as etapas ou os limites.",
        articleSection: "cabecalho",
      },
      {
        anchor: "jornada-relatorio.carregar-jogadores",
        title: "Jogadores que receberam",
        body: "A lista individual carrega só quando você pede, para não atrasar o resto do relatório.",
        articleSection: "jogadores",
      },
      {
        anchor: "jornada-relatorio.voltar",
        title: "Voltar",
        body: "Volta para a aba Jornadas de Automações.",
        articleSection: "cabecalho",
      },
    ],
  },
};

export default screen;
