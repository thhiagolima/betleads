// Help article for "Eventos" (/eventos), tela sem abas. Fonte:
// src/routes/eventos.tsx e src/lib/webhook-events.ts (rótulos de cada tipo de
// evento). Tela quase só de leitura — por isso o tour tem menos de 5 passos
// (constraints.md, "abas quase só de leitura podem ter menos passos").
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "eventos",
  route: "/eventos",
  title: "Eventos",
  purpose:
    "Os últimos 100 eventos dos jogadores da casa escolhida — cadastros, logins, depósitos, saques e jogos — atualizando sozinha.",
  roles: ["admin", "gestor", "member", "expert"],
  sections: [
    {
      id: "lista",
      title: "Últimos 100 eventos",
      intro:
        'Lista do mais recente para o mais antigo, sempre da casa escolhida no topo. O texto "Atualiza sozinho a cada 15 s" junto com a hora da última atualização fica acima da lista.',
      items: [
        {
          anchor: "eventos.lista",
          label: "Linha de evento",
          what: 'Cada linha mostra um ícone colorido por tipo de evento (cadastro, login, logout, depósito, saque, jogo, bônus, ou um ícone neutro de "falhou"/evento desconhecido), o nome do jogador (ou "Jogador sem cadastro", quando o evento não está ligado a nenhum cadastro), a ação, o jogo quando existir (depois de "·"), o ID do jogador quando existir ("ID <id> · "), há quanto tempo aconteceu e, quando o evento tiver valor, o valor em destaque à direita.',
          notes:
            "Repete-se em cada linha da lista; a âncora marca a lista inteira, não uma linha específica.",
        },
        {
          anchor: "eventos.mostrar-mais",
          label: "Mostrar mais N",
          what: 'A lista mostra só os 30 primeiros eventos de cada vez, para não ficar enorme no celular. O botão "Mostrar mais <N>" mostra o resto; <N> é quanto ainda falta mostrar. Só aparece quando há mais de 30 eventos.',
        },
      ],
    },
  ],

  states: [
    {
      id: "carregando",
      title: "Carregando eventos",
      what: "A tela ainda está buscando os eventos da casa escolhida.",
    },
    {
      id: "erro-carregar",
      title: "Não foi possível carregar os eventos",
      what: 'A busca falhou. Mostra a descrição "Tente novamente em instantes." e o botão "Tentar novamente".',
      action: 'Clique em "Tentar novamente".',
    },
    {
      id: "sem-eventos",
      title: "Nenhum evento recebido ainda",
      what: 'Mostrado quando a casa ainda não tem nenhum evento. Mostra a descrição "Os eventos chegam quando a plataforma de apostas está conectada." e o botão "Abrir Integrações".',
      action: 'Clique em "Abrir Integrações" para ir a /webhooks e conferir a conexão com a plataforma.',
    },
  ],

  tours: {
    default: [
      {
        anchor: "eventos.lista",
        title: "Os últimos eventos",
        body: "Cada linha é um evento de um jogador: cadastro, login, depósito, saque ou jogo, com o ícone e a cor de cada tipo, o valor (quando existir) e há quanto tempo aconteceu. Atualiza sozinha a cada 15 segundos.",
        articleSection: "lista",
      },
      {
        anchor: "eventos.mostrar-mais",
        title: "Mostrar mais",
        body: "A lista começa mostrando só 30 eventos. Clique aqui para ver o resto.",
        articleSection: "lista",
      },
    ],
  },
};

export default screen;
