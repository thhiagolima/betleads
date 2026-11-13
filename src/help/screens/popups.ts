// Help article for "Popups no site" (/popups). Fonte: src/routes/popups.tsx,
// src/components/popups/popup-editor.tsx e popup-preview.tsx; regras de
// entrega em src/lib/popups/public.server.ts e popup-runtime.ts.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "popups",
  route: "/popups",
  title: "Popups no site",
  purpose:
    "Criar avisos e promoções que aparecem dentro do site da casa (por exemplo, o bônus do dia) e escolher quem vê, em quais páginas, com que frequência e por quanto tempo. O popup chega ao site pelo mesmo script do Web Push: nada precisa mudar no site.",
  roles: ["admin", "gestor", "member"],
  sections: [
    {
      id: "lista",
      title: "Lista de popups",
      intro:
        "Mostra todos os popups da casa, primeiro os ativos. Os números são dos últimos 7 dias, contados pelo navegador de quem visitou o site.",
      items: [
        {
          anchor: "popups.novo",
          label: "Novo popup",
          what: "Abre o editor para criar um popup. Ele nasce como rascunho e só aparece no site quando você escolher Ativar.",
          roles: ["admin"],
          notes: "Só aparece depois que o script do Web Push está instalado no site.",
        },
        {
          anchor: "popups.instalacao",
          label: "Faixa do site",
          what: "Mostra o endereço do site, quando o script foi visto pela primeira vez e se o site já informou algum jogador logado.",
          notes:
            'Se "Jogador logado informado pelo site" estiver "ainda não", popups para "Só jogadores logados" ou para um público do CRM não aparecem para ninguém. Peça à plataforma o trecho "Jogador logado" da instalação do Web Push.',
        },
        {
          anchor: "popups.lista",
          label: "Tabela de popups",
          what: "Nome, situação, quem vê, período, exibições, cliques e taxa de clique de cada popup. O menu “…” de cada linha tem Editar, Números por dia, Ativar, Pausar, Duplicar, Encerrar e Apagar.",
          notes:
            "Exibição = o popup apareceu na tela de alguém. Clique = a pessoa clicou no botão. Taxa de clique = cliques ÷ exibições. Agendado = ativo, mas a data de início ainda não chegou.",
        },
        {
          label: "Ativar, Pausar e Encerrar",
          what: "Ativar coloca o popup no site; Pausar tira sem perder nada (dá para ativar de novo); Encerrar tira de vez e trava o popup. Rascunho pode ser apagado; o que já rodou só pode ser encerrado, para os números ficarem guardados.",
          notes: "Toda mudança chega ao site em até 5 minutos.",
          roles: ["admin"],
        },
      ],
    },
    {
      id: "editor",
      title: "Editor do popup",
      intro: "O editor tem a prévia ao lado, no computador e no celular, igual ao que aparece no site.",
      items: [
        {
          anchor: "popups.editor.conteudo",
          label: "Conteúdo",
          what: "Formato (janela no meio da tela, faixa no rodapé ou cartão no canto), imagem, título, texto e botão com link.",
          notes:
            "Precisa de um título ou de uma imagem. Links e imagens precisam começar com https://. Sem botão, o popup só tem o “×” para fechar.",
        },
        {
          anchor: "popups.editor.publico",
          label: "Quem vê",
          what: "Todos os visitantes, só jogadores logados, só visitantes não logados, ou um público do CRM (os mesmos da tela Públicos).",
          notes:
            "O público do CRM é atualizado de hora em hora: quem entra no público passa a ver o popup em até 1 hora. Logado = o site informou o jogador naquela página.",
        },
        {
          anchor: "popups.editor.paginas",
          label: "Onde aparece",
          what: 'Em todas as páginas, só nas listadas, ou em todas menos as listadas. "/" é a página inicial; terminar com "/*" vale também para tudo abaixo.',
        },
        {
          label: "Quando e quantas vezes",
          what: "Quantos segundos depois de abrir a página o popup aparece e quantas vezes a mesma pessoa vê: uma vez por visita, uma vez por dia, a cada N dias, ou em toda visita até clicar no botão.",
          notes:
            "A contagem é por navegador: quem limpa os dados ou usa aba anônima pode ver de novo. Se o convite do Web Push for aparecer, o popup espera ele ser respondido.",
        },
        {
          label: "Período e prioridade",
          what: "Datas de início e fim (horário de Brasília) e a prioridade. Quando dois popups valem para a mesma pessoa e página, aparece o de maior prioridade.",
          notes: "Na data de fim, o popup sai do site e é encerrado automaticamente na hora seguinte.",
        },
      ],
    },
  ],
  states: [
    {
      id: "nao-instalado",
      title: "O script ainda não está no site",
      what: "Os popups usam o script do Web Push, que ainda não foi instalado nesta casa.",
      action: "Peça ao suporte da Betleads para ativar o Web Push e siga a instalação em Integrações → Web Push.",
    },
    {
      id: "vazio",
      title: "Nenhum popup ainda",
      what: "A casa ainda não criou popups.",
      action: 'Use "Novo popup". Ele começa como rascunho.',
    },
  ],
  tours: {
    default: [
      {
        anchor: "popups.instalacao",
        title: "O site da casa",
        body: "Aqui você confere se o script está no site e se o site já informa o jogador logado.",
        articleSection: "lista",
      },
      {
        anchor: "popups.novo",
        title: "Criar um popup",
        body: "Todo popup começa como rascunho. Ele só aparece no site quando você ativar.",
        articleSection: "lista",
      },
      {
        anchor: "popups.lista",
        title: "Acompanhar e controlar",
        body: "Veja exibições e cliques dos últimos 7 dias e use o menu “…” para ativar, pausar, duplicar ou encerrar.",
        articleSection: "lista",
      },
    ],
  },
};

export default screen;
