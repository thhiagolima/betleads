// Help article for the shell — the header, sidebar, mobile navigation and
// banners that wrap every house screen. Virtual screen (no route of its
// own, VIRTUAL_SCREENS "shell", coverage-config.ts): opened from the help
// panel's "Sobre o CRM" entry, below "Nesta tela" (help-panel.tsx), not from
// navigating anywhere — the elements it describes are whatever page is
// underneath when the panel opens. No tour: `tours` is empty on purpose
// (ruling R4) so this article never auto-starts a tour; each item can still
// be highlighted on the real screen via "mostrar na tela".
// Fonte: src/components/app-layout.tsx (recolher, trilha, indicador ao vivo,
// faixas), src/components/active-tenant-switcher.tsx (seletor de casa +
// diálogo "Trocar de casa?"), src/components/shell/account-menu.tsx,
// src/components/shell/mobile-nav.tsx (barra inferior + gaveta),
// src/components/shell/sidebar-collapse.ts, src/components/app-sidebar.tsx +
// src/components/shell/nav-list.tsx (navegação), src/lib/navigation.ts
// (SIDEBAR_SECTIONS/EXPERT_SECTIONS/GROUP_SECTIONS/MOBILE_TABS/canSee),
// src/components/billing/billing-banner.tsx, src/components/demo-banner.tsx,
// src/components/providers-paused-banner.tsx (âncora já existente,
// reaproveitada), src/components/demo-disabled-tooltip.tsx,
// src/components/help/help-button.tsx.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "shell",
  route: "shell",
  title: "Sobre o CRM",
  purpose:
    "O que fica sempre na tela em volta do conteúdo: o cabeçalho (recolher o menu, trilha, seletor de casa, indicador ao vivo, menu da conta e este \"?\"), as faixas de aviso, o menu lateral e, no celular, a barra inferior e a gaveta de navegação.",
  roles: ["admin", "gestor", "member", "expert"],
  terms: [],
  sections: [
    // ---------------------------------------------------------------
    // Cabeçalho
    // ---------------------------------------------------------------
    {
      id: "cabecalho",
      title: "Cabeçalho",
      intro:
        "A faixa fixa no topo de toda tela do CRM (menos no celular, onde a navegação vira a barra inferior e a gaveta — veja mais abaixo).",
      items: [
        {
          anchor: "shell.header.collapse",
          label: "Botão de recolher/expandir o menu",
          what: 'Encolhe o menu lateral para só os ícones (mais espaço para o conteúdo) ou volta a mostrar os nomes. Só aparece em telas largas (computador) — no celular a navegação já é a barra inferior.',
          notes:
            "A escolha fica salva no navegador e volta a valer da próxima vez que você abrir o CRM nesse aparelho.",
        },
        {
          anchor: "shell.header.trilha",
          label: "Trilha (\"Você está em\")",
          what: 'Mostra em qual área e em qual tela você está agora, por exemplo "Resultados › Resultados do CRM". Em telas estreitas (tablet, celular) só o nome da tela aparece.',
        },
        {
          anchor: "shell.header.tenant-switcher",
          label: "Seletor de casa",
          what: 'Mostra a casa atual (nome e seu papel nela, por exemplo "Gestor") e, quando você tem mais de uma casa ou algum grupo de casas, abre um menu para trocar.',
          notes:
            'Com uma casa só e nenhum grupo, aparece travado (sem seta, não abre nada) — não há para onde trocar. Com grupos, o menu mostra duas listas: "Grupos" (abre a área do grupo, em "/grupo") e "Suas casas" — nesta última, "Nenhuma casa." aparece no lugar da lista quando um gestor de grupo não tem nenhuma casa vinculada à própria conta (só grupos). No celular aparece uma versão compacta do mesmo controle: só o nome da casa (sem o papel), mais estreito. Escolher outra casa no menu pede confirmação no diálogo "Trocar de casa?" (abaixo); escolher um grupo entra direto em "/grupo", sem confirmação, porque não troca os dados carregados — só a navegação.',
        },
        {
          label: 'Diálogo "Trocar de casa?"',
          what: 'Pergunta "Você está saindo de <casa atual> e entrando em <casa nova>. Todos os dados e as próximas ações passam a ser da nova casa." com os botões "Cancelar" e "Confirmar troca" (que mostra "Entrando em <casa nova>…" enquanto troca).',
          notes:
            "A troca recarrega a página inteira de propósito — é a forma mais segura de descartar tudo que estava em cache (consultas, conexões em tempo real) da casa anterior. Se você estava dentro do relatório de uma campanha, a troca te leva para a lista de campanhas da casa nova (aquele relatório era da casa antiga).",
        },
        {
          anchor: "shell.header.indicador-tempo-real",
          label: "Indicador ao vivo",
          what: 'Mostra se a conexão em tempo real do CRM (que atualiza números e listas sem precisar recarregar a página) está funcionando. Em telas estreitas só a bolinha colorida aparece, sem o texto.',
          notes: "Veja os 4 estados possíveis em \"Situações que podem aparecer\".",
        },
        {
          anchor: "shell.header.help",
          label: '"?" (ajuda)',
          what: "Abre este painel de ajuda: a busca, o artigo da tela atual (\"Nesta tela\"), este artigo sobre o CRM, os guias passo a passo e o glossário.",
        },
        {
          anchor: "shell.header.conta",
          label: "Menu da conta",
          what: "Botão redondo com as duas primeiras letras do seu e-mail. Abre o menu da conta.",
          notes:
            'Dentro do menu: o e-mail completo da conta (e, se você for super admin, a marca "Super admin" abaixo dele); o link "Conta e equipe" (só para quem não é super admin nem expert — leva à tela /tenants); e o botão "Sair", que encerra a sessão. Nenhum desses itens internos tem destaque próprio — eles só aparecem depois de abrir o menu.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Faixas
    // ---------------------------------------------------------------
    {
      id: "faixas",
      title: "Faixas de aviso",
      intro:
        "Avisos que aparecem abaixo do cabeçalho, acima do conteúdo da tela. Nenhuma delas pode ser fechada manualmente — elas somem quando a situação que as causou é resolvida.",
      items: [
        {
          anchor: "shell.faixa.mensalidade",
          label: "Faixa da mensalidade",
          what: 'Aviso amarelo ou vermelho sobre o pagamento da casa, com um botão "Pagar agora" quando você pode pagar. Aparece em toda tela da casa, inclusive na própria tela de pagamento (só o botão some ali).',
          notes:
            'Quem não é administrador vê um texto mais curto, sem o botão "Pagar agora", e uma dica para pedir ao administrador que pague — a mensalidade só pode ser paga por um administrador da casa. Os textos exatos de cada situação (em dia, vencendo, vencida) ficam na tela "Plano e créditos". Em casos extremos de atraso, a casa pode ficar bloqueada por completo (uma tela de pagamento no lugar do conteúdo) em vez de só mostrar a faixa.',
        },
        {
          anchor: "shell.faixa.demo",
          label: "Faixa do ambiente de demonstração",
          what: '"Ambiente de demonstração — nenhuma mensagem é enviada e nada aqui é real", mostrada em toda tela quando a casa atual é a casa de demonstração.',
        },
        {
          anchor: "canal.pausado.retomar",
          label: "Faixa de canal pausado",
          what: 'Aviso "Disparos de <canal> pausados", com o motivo quando é conhecido (por exemplo "Saldo esgotado no provedor de envio.") e o botão "Retomar disparos" (pede confirmação antes de retomar). Diferente das outras duas faixas, esta só aparece dentro das telas de SMS, E-mail e Voz — não em toda tela do CRM.',
          notes:
            "Nada se perde enquanto o canal está pausado: campanhas e pendências continuam na fila e são processadas quando o envio for retomado.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Menu lateral e navegação
    // ---------------------------------------------------------------
    {
      id: "navegacao",
      title: "Menu lateral",
      intro:
        "No computador, a navegação principal é o menu lateral (a mesma lista de áreas aparece na gaveta do celular — veja a seção \"No celular\"). O que cada papel vê:",
      items: [
        {
          anchor: "shell.sidebar.nav",
          label: "Lista de áreas",
          what: 'Administrador vê tudo: Início; Resultados (Resultados do CRM, Aquisição e LTV, e também Rendimento da equipe e Financeiro quando a casa tem esses recursos); Jogadores (Jogadores, Públicos, Níveis e fidelização, Experts); Ações (Campanhas, Automações); Canais (SMS, Email, Voz, Consentimentos, e o grupo "Templates e áudios" com Templates de SMS/Templates de email/Áudios e scripts); IA (Assistente IA, Configurar IA); Configurações (Plano e créditos, Integrações, Configuração da casa, Configurações). Gestor e membro veem a mesma lista, menos "Rendimento da equipe", "Experts" e a seção "IA" inteira — essas são só do administrador; "Financeiro" só aparece para quem tem acesso liberado ao financeiro, e "Meu rendimento" só para quem tem um perfil de equipe cadastrado na casa.',
          notes:
            'O grupo "Templates e áudios" abre uma lista com um clique (no menu recolhido, abre ao lado, num balão). Quando a conexão com o Claude está disponível para você, um item extra "Conectar ao Claude" aparece no fim da lista. A seção "Administração" (só para super admin) não é descrita aqui.',
        },
        {
          label: "Papel: expert",
          what: 'Um expert não vê o menu da casa: vê só "Expert" (Início, Leads, Rendimento, Modelos) e "Envios" (Campanhas, Públicos — as mesmas telas da casa, mostrando só os envios e públicos do próprio expert).',
        },
        {
          label: "Papel: gestor de grupo",
          what: 'Ao entrar num grupo de casas (pelo seletor de casa, acima), o menu lateral inteiro troca para o menu do grupo: "Financeiro do grupo", "Metas", "Pessoas" e "Voltar às casas" (volta para o Início de uma casa).',
        },
      ],
    },

    // ---------------------------------------------------------------
    // No celular
    // ---------------------------------------------------------------
    {
      id: "mobile",
      title: "No celular",
      intro:
        "Em telas estreitas o menu lateral não aparece: a navegação vira uma barra fixa embaixo da tela, com um atalho para abrir a lista completa numa gaveta.",
      items: [
        {
          anchor: "shell.mobile.tabbar",
          label: "Barra inferior",
          what: 'Quatro atalhos fixos (Início, Jogadores, Ações, Resultados) mais o botão "Menu", sempre visíveis embaixo da tela. Para o expert, a barra tem cinco atalhos no lugar desses quatro: Início, Leads, Rendimento, Modelos, Envios.',
          notes:
            'Repete-se como um grupo de botões; a âncora marca só o primeiro. A barra do expert não tem o botão "Menu" — as cinco áreas do expert já cabem todas na barra, sem precisar de uma gaveta com mais itens.',
        },
        {
          anchor: "shell.mobile.menu-button",
          label: "Botão Menu",
          what: "Abre a gaveta com a lista completa de áreas (a mesma lista do menu lateral do computador, adaptada ao seu papel).",
          roles: ["admin", "gestor", "member"],
        },
        {
          anchor: "shell.sidebar.nav",
          label: "Gaveta de navegação",
          what: "A mesma lista de áreas do menu lateral (veja a seção \"Menu lateral\"), aberta em tela cheia. Fecha ao escolher uma área, ao tocar fora ou com o botão de voltar do aparelho.",
          roles: ["admin", "gestor", "member"],
        },
      ],
    },
  ],

  states: [
    {
      id: "tempo-real-ao-vivo",
      title: "Ao vivo",
      what: "Bolinha verde pulsando: a conexão em tempo real está funcionando — números e listas atualizam sozinhos.",
    },
    {
      id: "tempo-real-conectando",
      title: "Conectando…",
      what: "Bolinha amarela pulsando: o CRM está tentando estabelecer a conexão em tempo real (ao abrir a página, ou depois de uma queda).",
    },
    {
      id: "tempo-real-offline",
      title: "Offline",
      what: "Bolinha vermelha: a conexão em tempo real caiu. As telas continuam funcionando, mas números e listas só atualizam ao recarregar a página.",
      action: "Recarregue a página se precisar dos números mais recentes agora.",
    },
    {
      id: "tempo-real-em-espera",
      title: "Em espera",
      what: "Bolinha cinza: nenhuma tela aberta no momento está pedindo atualização em tempo real.",
    },
    {
      id: "demo-acao-bloqueada",
      title: "Ambiente de demonstração: esta ação não está disponível",
      what: 'Dica mostrada ao passar o mouse (ou focar, no teclado) sobre um botão desabilitado por causa do ambiente de demonstração — acontece em várias telas do CRM, não só numa específica. Alguns botões mostram um texto diferente para o mesmo motivo, como "Indisponível no ambiente de demonstração".',
      action: "Entre numa casa real para usar essa ação.",
    },
  ],

  tours: {},
};

export default screen;
