// Help article for "Web Push" (/webpush), duas abas: Visão geral e
// Histórico. Fonte: src/routes/webpush.tsx,
// src/components/webpush/webpush-channel-tabs.tsx,
// src/components/channels/channel-page.tsx e channel-overview.tsx (barra
// compartilhada com SMS/Email/Ligações, prefixo "canal."; o Web Push não tem
// faixa de disparos pausados) e
// src/lib/webpush/channel-overview.server.ts (de onde vêm os números).
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "webpush",
  route: "/webpush",
  defaultTab: "visao-geral",
  title: "Web Push",
  purpose:
    "Acompanhar as notificações no navegador (Web Push) da casa: quantas pessoas estão inscritas, quantos pushes saíram, quantos foram clicados e o histórico das campanhas de Web Push.",
  roles: ["admin", "gestor", "member"],
  sections: [
    // ---------------------------------------------------------------
    // Barra superior — compartilhada com /sms, /email e /ligacoes
    // ---------------------------------------------------------------
    {
      id: "canal",
      title: "Barra superior (aparece nas 2 abas)",
      intro:
        "Mesma faixa das outras páginas de canal, com o botão de nova campanha e o aviso de saldo. O Web Push não tem pausa de disparos, então esse aviso não aparece aqui.",
      items: [
        {
          anchor: "canal.header.nova-campanha",
          label: "Nova campanha",
          what: 'Leva para /campanhas já com o canal "Web Push" pré-selecionado no compositor.',
          notes:
            'Só aparece depois que o Web Push está instalado no site da casa (veja a situação "Web Push ainda não instalado").',
        },
        {
          anchor: "canal.abas",
          label: "Abas Visão geral / Histórico",
          what: "Alternam entre o painel de números e a lista de campanhas de Web Push. A aba escolhida fica na URL (#visao-geral, #historico).",
          notes: "O endereço /webpush#configuracoes leva direto para Integrações, aba Web Push.",
        },
        {
          anchor: "canal.carteira.aviso",
          label: 'Aviso de saldo ("Seu saldo acabou" / "Saldo baixo")',
          what: "Aparece quando a carteira da casa está zerada ou abaixo do limite de aviso. Cada push enviado é cobrado da carteira; sem saldo, a campanha fica Pausada até a casa recarregar.",
        },
        {
          anchor: "webpush.nao-instalado.integracoes",
          label: 'Botão "Abrir Integrações" do aviso "Web Push ainda não instalado"',
          what: "Aparece no lugar das abas enquanto o Web Push não está instalado no site da casa. Leva para Integrações, aba Web Push, onde fica o passo a passo da instalação.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Visão geral
    // ---------------------------------------------------------------
    {
      id: "visao-geral",
      title: "Visão geral",
      tab: "visao-geral",
      intro: "Números do período escolhido, o gráfico de envios e as últimas campanhas.",
      items: [
        {
          anchor: "canal.periodo",
          label: 'Seletor de período ("Hoje", "Ontem", etc.)',
          what: 'Escolhe a janela de tempo de "Pushes enviados", "Cliques", "Recusados" e do gráfico.',
          notes: '"Inscrições ativas" não depende do período: é sempre o número de agora.',
        },
        {
          anchor: "canal.kpis",
          label: 'KPIs: "Inscrições ativas", "Pushes enviados", "Cliques" e "Recusados"',
          what: '"Inscrições ativas" conta os navegadores que aceitaram receber notificações e continuam ativos, com quantos já estão ligados a um jogador e o total já registrado. "Pushes enviados" conta os pushes aceitos pelo OneSignal no período. "Cliques" conta os pushes clicados por uma pessoa (cliques de robôs ficam de fora), com a taxa sobre os pushes enviados. "Recusados" conta os pushes que o OneSignal não aceitou.',
          notes:
            "O clique é contado no dia em que aconteceu, que pode ser depois do dia do envio — por isso a taxa de um período curto é aproximada.",
        },
        {
          anchor: "canal.grafico.envios",
          label: 'Gráfico "Envios por dia" / "Envios por hora"',
          what: 'Mostra "Enviados" e "Recusados" por dia. Quando o período é um único dia (ex.: "Hoje"), muda para "Envios por hora", com todas as tentativas por hora no horário de Brasília.',
        },
        {
          anchor: "webpush.campanhas.recentes",
          label: 'Bloco "Campanhas recentes"',
          what: 'As 5 últimas campanhas de Web Push, com data, quantos pushes saíram do público previsto, o status e o botão "Relatório". "Ver todas" abre a aba Histórico.',
        },
        {
          anchor: "webpush.integracoes.link",
          label: 'Bloco "Instalação e permissão" e botão "Abrir Integrações"',
          what: "Leva para Integrações, aba Web Push, onde ficam o script do site, a mensagem que pede a permissão ao visitante e o push de teste.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Histórico
    // ---------------------------------------------------------------
    {
      id: "historico",
      title: "Histórico",
      tab: "historico",
      intro: "Todas as campanhas de Web Push da casa, da mais nova para a mais antiga.",
      items: [
        {
          anchor: "webpush.historico.tabela",
          label: "Tabela de campanhas",
          what: 'Uma linha por campanha: nome, status (Agendada, Enviando, Enviada, Falhou, Cancelada ou Pausada), quando foi agendada, o público, quantos pushes saíram, quantos falharam e o botão "Relatório".',
          notes:
            "Mostra até as 200 campanhas mais recentes. Para cancelar ou retomar uma campanha, use /campanhas.",
        },
      ],
    },
  ],
  states: [
    {
      id: "nao-instalado",
      title: "Web Push ainda não instalado",
      what: 'O canal está ligado para a casa, mas o Web Push ainda não foi instalado no site. Sem instalação não há inscrições nem envio, então a página mostra só este aviso e o botão "Nova campanha" fica escondido.',
      action: 'Clique em "Abrir Integrações" e siga o passo a passo da aba Web Push.',
    },
    {
      id: "canal-desabilitado",
      title: "Canal Web push desabilitado",
      what: "O canal Web Push está desligado para esta casa. A página não mostra abas nem ações, e o item some do menu.",
      action: "Fale com o suporte para ligar o canal.",
    },
    {
      id: "campanha-pausada",
      title: "Campanha Pausada",
      what: "A campanha parou porque a carteira da casa ficou sem saldo no meio do envio.",
      action: 'Recarregue a carteira e clique em "Retomar" na campanha, em /campanhas.',
    },
  ],
  tours: {
    "visao-geral": [
      {
        anchor: "canal.header.nova-campanha",
        title: "Nova campanha",
        body: "Começa uma campanha de Web Push já no canal certo.",
        articleSection: "canal",
      },
      {
        anchor: "canal.abas",
        title: "Abas",
        body: "Visão geral e Histórico — a aba escolhida fica na URL.",
        articleSection: "canal",
      },
      {
        anchor: "canal.periodo",
        title: "Período",
        body: "Escolha a janela de tempo dos números e do gráfico abaixo.",
        articleSection: "visao-geral",
      },
      {
        anchor: "canal.kpis",
        title: "KPIs",
        body: "Inscrições ativas, pushes enviados, cliques e recusados.",
        articleSection: "visao-geral",
      },
      {
        anchor: "canal.grafico.envios",
        title: "Envios por dia",
        body: "Enviados e Recusados por dia (ou por hora, num único dia).",
        articleSection: "visao-geral",
      },
      {
        anchor: "webpush.campanhas.recentes",
        title: "Campanhas recentes",
        body: "As últimas campanhas de Web Push, com status e relatório.",
        articleSection: "visao-geral",
      },
      {
        anchor: "webpush.integracoes.link",
        title: "Instalação e permissão",
        body: "O script do site e a mensagem de permissão ficam em Integrações.",
        articleSection: "visao-geral",
      },
    ],
    historico: [
      {
        anchor: "webpush.historico.tabela",
        title: "Campanhas de Web Push",
        body: "Cada linha mostra status, público, enviados e falhas, com o relatório.",
        articleSection: "historico",
      },
    ],
  },
};

export default screen;
