// Help article for the campaign report (/campanhas/$campaignId/relatorio).
// Uma única tela sem abas, com duas variantes: o relatório comum (SMS/e-mail)
// e, para voz, um relatório mais simples com o resultado da ligação. Fonte:
// src/routes/campanhas.$campaignId.relatorio.tsx e a parte de campanha de
// src/components/conversion-report.tsx (a parte de jornada é a Tarefa 14).
// Todas as âncoras desta tela usam o prefixo `campanha-relatorio.` — mesmo o
// FunnelFilter, componente compartilhado com a estrutura, porque hoje ele só
// é renderizado pelo relatório de campanha (JourneyReport usa TrackedLeadList,
// não FunnelFilter); revisar se a Tarefa 14 passar a usá-lo também.
// src/lib/campaign-recipients.ts (motivos de "não enviados") e
// src/lib/channel-operation-state.ts (selo/motivo de parada).
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "campanha-relatorio",
  route: "/campanhas/$campaignId/relatorio",
  title: "Relatório da campanha",
  purpose:
    "O resultado completo de uma campanha de SMS, e-mail ou voz: quantos receberam, clicaram e depositaram, o custo e o retorno, e a lista de destinatários com o que cada um fez.",
  roles: ["admin", "gestor", "member"],
  terms: ["recuperado-pelo-crm", "retorno-do-envio", "ultimos-7-dias", "grupo-de-controle"],
  sections: [
    // ---------------------------------------------------------------
    // SMS / e-mail
    // ---------------------------------------------------------------
    {
      id: "cartoes",
      title: "Indicadores principais",
      intro:
        "Topo do relatório comum (SMS e e-mail). Os quatro indicadores somam a campanha inteira, desde o disparo, não só a lista carregada abaixo.",
      items: [
        {
          label: "Enviados / Clicaram / Depositaram / Recuperado pelo CRM",
          what: '"Enviados" conta quem recebeu a mensagem. "Clicaram" conta quem abriu o link (— quando o canal não mede clique). "Depositaram" conta jogadores com depósito atribuído à campanha. "Recuperado pelo CRM" soma o valor desses depósitos, pelo último clique em até 7 dias.',
        },
        {
          anchor: "campanha-relatorio.voltar",
          label: "Voltar para Campanhas",
          what: "Volta para a lista de campanhas.",
        },
        {
          label: 'Aviso de status (quando a campanha parou ou foi bloqueada)',
          what: 'Aparece acima dos indicadores com o nome do estado (ex.: "Falhou", "Cancelada", "Bloqueada") e o motivo, quando a campanha não terminou normalmente.',
        },
      ],
    },
    {
      id: "custo-retorno",
      title: "Custo e retorno",
      intro: "Total da campanha desde o disparo, pelo último clique em até 7 dias.",
      items: [
        {
          label: "Receita média por jogador que voltou",
          what: "O valor recuperado dividido pelo número de jogadores que depositaram.",
        },
        {
          label: "Custo em SMS / Consumo de e-mail",
          what: 'No SMS, o custo em R$ dos envios. No e-mail, "— envios" (sem custo financeiro calculado para e-mail ainda).',
        },
        {
          label: "Retorno",
          what: 'Recuperado pelo CRM ÷ custo em SMS, escrito como "Nx" (por exemplo "3,2x"). Sem custo em R$ calculado (e-mail, ou moeda da casa diferente do real), mostra "—".',
        },
        {
          label: "Receita assistida (fora do total)",
          what: "Depósitos em que esta campanha participou mas não foi o último clique antes do depósito. Fica fora do \"Recuperado pelo CRM\" de propósito, para não contar a mesma receita em duas campanhas.",
          notes: "Só aparece quando esse valor é maior que zero.",
        },
        {
          label: "Jogadores já ativos (fora da conta)",
          what: "Jogadores que já tinham depositado nas 48 horas antes do clique: o depósito deles depois do clique entra aqui, separado, nunca no total recuperado — ele não prova que foi a campanha que trouxe o depósito.",
        },
      ],
    },
    {
      id: "disparo",
      title: "Disparo",
      items: [
        {
          label: "Criada em / Disparo iniciado / Disparo concluído",
          what: "Quando a campanha foi criada, quando o envio começou e quando terminou de processar todos os destinatários.",
        },
        {
          label: "Repetidos ignorados",
          what: "Destinatários que apareciam mais de uma vez no público e receberam uma única mensagem.",
        },
        {
          label: "Prazo para contar o depósito",
          what: "Até 7 dias após o clique: um depósito depois desse prazo não entra no resultado da campanha.",
        },
      ],
    },
    {
      id: "por-que-nao-saiu",
      title: "Por que não saiu",
      intro: "Só aparece quando a campanha teve falhas.",
      items: [
        {
          label: "Lista de motivos de falha",
          what: 'Cada linha é um motivo que o provedor (SMS, e-mail ou voz) devolveu para não ter enviado, com a quantidade. Sem um motivo individual por destinatário, aparece só o total em "Não enviados".',
        },
      ],
    },
    {
      id: "nao-enviados",
      title: "Não enviados",
      intro:
        'ENV-06: quem a campanha nem tentou enviar — os demais receberam normalmente. Só aparece quando existe pelo menos um. A lista completa (incluindo o telefone sem máscara) fica no CSV.',
      items: [
        {
          label: "Motivos (Sem cadastro, Telefone inválido, Sem consentimento, Grupo de controle, Já é jogador)",
          what: '"Sem cadastro": o telefone não corresponde a nenhum jogador cadastrado. "Telefone inválido": não é um celular ou fixo brasileiro válido. "Sem consentimento": o destinatário revogou o consentimento para SMS. "Grupo de controle": o jogador está no grupo de controle de uma jornada e não recebe campanhas em massa enquanto o teste estiver aberto. "Já é jogador": só em campanhas para lista de números — o telefone já pertence a um jogador da casa, e essas campanhas só valem para quem ainda não se cadastrou.',
        },
        {
          anchor: "campanha-relatorio.nao-enviados.exemplos",
          label: "Ver os primeiros N",
          what: "Mostra uma amostra de telefones (mascarados) e o motivo de cada um, sem precisar baixar o CSV.",
        },
        {
          anchor: "campanha-relatorio.nao-enviados.csv",
          label: "Baixar CSV (não enviados)",
          what: "Baixa a lista completa de não enviados, com o telefone sem máscara.",
          notes:
            'Disponível só para administradores da operação; para quem não tem a permissão, o botão fica desabilitado com a dica "Disponível para administradores da operação".',
        },
      ],
    },
    {
      id: "mensagem",
      title: "A mensagem que foi enviada",
      items: [
        {
          anchor: "campanha-relatorio.mensagem.copiar",
          label: "Copiar mensagem",
          what: "Copia o texto original enviado, para colar numa campanha nova.",
        },
        {
          anchor: "campanha-relatorio.mensagem.nova-campanha",
          label: "Nova campanha",
          what: "Abre o compositor para criar uma nova campanha a partir desta.",
          notes:
            "Esta campanha não é alterada; para reaproveitar o texto é preciso copiar e colar na nova.",
        },
        {
          label: "Texto da mensagem",
          what: 'O conteúdo original. "O conteúdo original não está disponível para esta campanha." aparece quando ele não foi guardado.',
          notes:
            "Os links que saíram no envio real foram trocados por um link próprio de cada jogador, para contar o clique de cada um — o texto mostrado aqui é o original, antes dessa troca.",
        },
      ],
    },
    {
      id: "funil",
      title: "Funil e destinatários",
      intro: "Escolha uma etapa do funil para filtrar a lista de destinatários abaixo dela.",
      items: [
        {
          anchor: "campanha-relatorio.funil.filtro",
          label: "Etapas do funil",
          what: 'Público, Enviados, Entregues (só quando o canal confirma entrega — nunca em SMS/e-mail), Clicaram, Não clicaram, Cadastros, Login ou jogo, Primeiro depósito, Depositaram e Clicaram e não depositaram. Cada etapa mostra o total da campanha inteira, não só da lista carregada.',
        },
        {
          anchor: "campanha-relatorio.funil.csv",
          label: "Baixar CSV (destinatários)",
          what: "Baixa a lista completa de destinatários com o que cada um fez.",
          notes:
            'Disponível só para administradores da operação; para quem não tem a permissão, o botão fica desabilitado com a dica "Disponível para administradores da operação".',
        },
        {
          anchor: "campanha-relatorio.funil.lista",
          label: "Lista de destinatários",
          what: "Uma linha por destinatário, com o resultado de cada um na etapa escolhida.",
          notes:
            'A lista na tela carrega só os primeiros destinatários da campanha (até 500); o CSV traz todos. Nesse caso aparece "Mostrando N de M" e o aviso de que a lista é parcial.',
        },
        {
          anchor: "campanha-relatorio.funil.paginacao",
          label: "Anterior / Próxima",
          what: "Navega entre as páginas da lista de destinatários (50 por página).",
        },
      ],
    },
    {
      id: "quem-depositou",
      title: "Quem clicou e depositou",
      intro:
        "Só aparece quando existe pelo menos um depósito atribuído à campanha.",
      items: [
        {
          label: "Lista de quem depositou",
          what: "Só entra quem tem vínculo com o próprio clique desta campanha; depósitos sem esse vínculo não entram aqui nem no resultado, para não inflar o número.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Voz
    // ---------------------------------------------------------------
    {
      id: "voz",
      title: "Variante de voz",
      intro:
        "Campanhas de voz com uma única ligação mostram este relatório mais simples, em vez do funil. Campanhas de voz com mais de uma ligação não têm o botão \"Relatório\" no hub.",
      items: [
        {
          label: "Status / Atendida / Tempo de chamada / Tentativas",
          what: '"Status" é o estado atual da ligação (preparando áudio, na fila, chamando, concluída, falhou, cancelada, pausada...). "Atendida" é Sim, Não ou Aguardando. "Tempo de chamada" é só da ligação atendida — sem isso, "não informado pelo provedor". "Tentativas" conta quantas vezes o sistema tentou.',
        },
        {
          label: "Motivo da falha",
          what: "Aparece só quando a ligação falhou, com o motivo devolvido pelo provedor.",
        },
        {
          label: "Resultado da ligação",
          what: "Destinatário, telefone, resultado (Atendida, Concluída, Ocupado, Não atendida, Falhou ou Aguardando resultado), quando a campanha foi criada/agendada e quando a ligação foi iniciada.",
        },
        {
          anchor: "campanha-relatorio.voz.detalhes-tecnicos",
          label: "Detalhes técnicos",
          what: "Provedor de voz, status e código HTTP devolvidos por ele, e o identificador da ligação no provedor — útil só para investigar um problema específico.",
        },
        {
          label: "Conteúdo da ligação",
          what: 'O roteiro ou a referência do áudio usado. "O conteúdo original não está disponível para esta ligação." aparece quando ele não foi guardado.',
        },
      ],
    },
  ],

  states: [
    {
      id: "carregando",
      title: "Carregando relatório…",
      what: "A tela ainda está buscando os dados da campanha.",
    },
    {
      id: "erro-carregar",
      title: "Não foi possível carregar o relatório.",
      what: "A busca falhou (campanha não encontrada, ou erro de rede/servidor).",
      action: "Volte para Campanhas e abra o relatório de novo.",
    },
    {
      id: "sem-destinatarios",
      title: "Sem destinatários individuais",
      what: "Esta campanha não possui destinatários rastreáveis individualmente.",
    },
    {
      id: "lista-individual-indisponivel",
      title: "Os totais estão disponíveis, mas não foi possível carregar a lista individual.",
      what: "Os indicadores e o funil continuam corretos (vêm de uma busca separada); só a lista de destinatários linha a linha falhou ao carregar.",
      action: "Atualize a página para tentar carregar a lista de novo.",
    },
    {
      id: "funil-sem-ninguem",
      title: "Ninguém nesta etapa na lista",
      what: 'Nenhum destinatário, entre os carregados na tela, chegou à etapa escolhida do funil.',
      action: "Baixe o CSV para ver se alguém chegou lá na campanha inteira.",
    },
  ],

  tours: {
    default: [
      {
        anchor: "campanha-relatorio.funil.filtro",
        title: "Funil da campanha",
        body: "Cada etapa mostra o total da campanha inteira. Clique numa etapa para filtrar a lista de destinatários abaixo.",
        articleSection: "funil",
      },
      {
        anchor: "campanha-relatorio.funil.lista",
        title: "Lista de destinatários",
        body: "Uma linha por destinatário, com o que ele fez na etapa escolhida.",
        articleSection: "funil",
      },
      {
        anchor: "campanha-relatorio.funil.csv",
        title: "Baixar CSV",
        body: "Baixa a lista completa de destinatários. Disponível para administradores da operação.",
        articleSection: "funil",
      },
      {
        anchor: "campanha-relatorio.mensagem.copiar",
        title: "Copiar mensagem",
        body: "Copia o texto original enviado, para reaproveitar numa campanha nova.",
        articleSection: "mensagem",
      },
      {
        anchor: "campanha-relatorio.mensagem.nova-campanha",
        title: "Nova campanha",
        body: "Abre o compositor para criar uma campanha nova a partir desta.",
        articleSection: "mensagem",
      },
      {
        anchor: "campanha-relatorio.nao-enviados.csv",
        title: "Não enviados",
        body: "Quem a campanha não tentou enviar, com o motivo de cada um — e o CSV com a lista completa.",
        articleSection: "nao-enviados",
      },
      {
        anchor: "campanha-relatorio.voltar",
        title: "Voltar",
        body: "Volta para a lista de campanhas.",
        articleSection: "cartoes",
      },
    ],
  },
};

export default screen;
