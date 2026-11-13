// Help article for "Início" (/), a tela sem abas. Fonte: src/routes/index.tsx
// (o componente Dashboard), os blocos em src/components/home/dashboard-blocks.tsx
// (HomeHeader, HomeKpiCards, CashflowCrmRow/CashflowChart/CrmCard, SecondaryMetrics, LiveFeed —
// compartilhados com o Início do expert, /expert, que tem artigo próprio
// pendente), src/components/home/{home-cards,period-picker}.tsx,
// src/components/onboarding/{domain-verified-notice,house-setup-checklist}.tsx
// e as regras de cálculo em src/lib/{home-dashboard,dashboard.functions}.ts.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "inicio",
  route: "/",
  title: "Início",
  purpose:
    "Visão geral da casa no período escolhido: os 4 indicadores principais, o fluxo de depósitos e saques, o quanto o CRM recuperou, 4 métricas complementares e os eventos mais recentes dos jogadores.",
  roles: ["admin", "gestor", "member"],
  terms: ["ftd", "pix-gerado-pago", "pp", "redeposito", "ftd-redeposito"],
  sections: [
    // ---------------------------------------------------------------
    {
      id: "periodo",
      title: "Período",
      intro:
        'Todos os números da tela (menos "Ao vivo", que é sempre em tempo real) seguem o período escolhido aqui.',
      items: [
        {
          anchor: "inicio.periodo",
          label: "Hoje / Ontem / 7 dias / 30 dias / Este mês / Mês passado / Datas",
          what: 'Seis atalhos de período e o botão "Datas", que abre um calendário de dois meses para escolher qualquer intervalo manualmente (clique no primeiro dia e depois no último).',
          notes:
            'Os dias contam no horário de Brasília. Enquanto o período escolhido inclui o dia de hoje, a tela atualiza sozinha e mostra "hoje ainda está entrando" ao lado do título, porque os números de hoje ainda podem mudar.',
        },
        {
          label: 'Texto "Operação de X · atualizado Y"',
          what: 'Abaixo do título, mostra o período em texto e há quanto tempo os dados foram buscados pela última vez ("atualizado agora", "atualizado há 2 min"...). Um ícone giratório aparece ao lado enquanto busca de novo.',
          notes:
            'Quando o período é um único dia (Hoje, Ontem, ou duas datas iguais escolhidas em "Datas"), mostra só essa data (ex.: "Operação de 01/11"); quando é um intervalo de vários dias, mostra "de X a Y" (ex.: "Operação de 01/11 a 07/11").',
        },
      ],
    },

    // ---------------------------------------------------------------
    {
      id: "avisos",
      title: "Avisos no topo",
      intro:
        "Dois avisos que só aparecem quando fazem sentido e desaparecem sozinhos quando deixam de ser necessários.",
      items: [
        {
          anchor: "inicio.aviso-dominio.fechar",
          label:
            'Aviso "Domínio X verificado — já está sendo usado nos seus envios." e o X para fechar',
          what: 'Aparece um aviso por domínio que acabou de ficar verificado (encurtador ou e-mail), avisando que ele já está em uso nos envios. O X ("Fechar aviso") dispensa aquele aviso específico.',
          roles: ["admin"],
          notes:
            "Só quem é administrador vê este aviso — para os outros perfis ele nunca aparece, mesmo que exista um domínio recém-verificado.",
        },
        {
          anchor: "inicio.checklist.continuar",
          label: 'Cartão "Configure sua casa" e o link "Continuar configuração"',
          what: 'Lista três itens — "URL da casa e URLs rápidas", "Domínio do encurtador" e "Domínio e remetente de e-mail" — cada um com um ícone: certo verde (feito), relógio âmbar com o texto "· aguardando DNS" (a meio caminho, esperando o DNS) ou círculo pontilhado (ainda não feito). O número "N de M" no canto mostra quantos já estão prontos. O link "Continuar configuração" leva para /configuracoes/casa.',
          notes:
            "O cartão inteiro desaparece sozinho assim que os 3 itens ficam prontos. Quem não é administrador vê o mesmo cartão, só para acompanhar — não pode editar nada em Configuração da casa, mas o link funciona do mesmo jeito para consulta.",
        },
      ],
    },

    // ---------------------------------------------------------------
    {
      id: "kpis",
      title: "Os 4 indicadores do período",
      items: [
        {
          anchor: "inicio.kpis",
          label: "Depositado, Depositantes, Primeiros depósitos (FTD) e Conversão cadastro → FTD",
          what: 'Cada cartão tem o número principal e, logo abaixo, uma linha de apoio. Depositado: soma de todos os depósitos aprovados no período (com uma mini-linha mostrando a tendência), e abaixo quantos depósitos foram e o ticket médio (ex.: "8 depósitos · ticket R$ 28,13"; o ticket some quando não houve depósito). Depositantes: quantos jogadores diferentes depositaram, e abaixo quantos depósitos cada um fez em média (ex.: "1,3 depósito por jogador"). "Primeiros depósitos (FTD)": quantos jogadores fizeram o primeiro depósito da casa dentro do período — FTD é a sigla de "first time deposit" (primeiro depósito) —, e abaixo o valor somado desses primeiros depósitos e o ticket deles (ex.: "R$ 175,00 · ticket R$ 29,17"). Conversão cadastro → FTD: dos jogadores cadastrados no período, quantos % já fizeram o primeiro depósito, e abaixo "<FTD> de <cadastros> cadastros".',
          notes:
            'A seta no rodapé de cada cartão compara só o número principal (não a linha de apoio) com o período anterior de mesmo tamanho ("vs dia anterior" ou "vs N dias anteriores"): seta para cima e número verde é alta, seta para baixo e número vermelho é queda, seta para o lado é sem variação. Nos três primeiros a variação vem em porcentagem; na Conversão, que já é uma taxa, a variação vem em pontos percentuais (p.p.) — ver o termo no glossário. No FTD, a linha de apoio mostra "—" quando o primeiro depósito já foi contado mas o valor dele ainda não chegou da plataforma; ela some quando não houve FTD (e, em Depositantes, quando ninguém depositou).',
        },
      ],
    },

    // ---------------------------------------------------------------
    {
      id: "fluxo",
      title: "Depósitos e saques",
      items: [
        {
          anchor: "inicio.fluxo.grafico",
          label: '"Depósitos e saques" (gráfico)',
          what: 'Mostra a evolução de depósitos (linha cheia) e saques (linha de contorno) no período: dia a dia quando o período tem vários dias, e hora a hora (0h, 1h... 23h) quando é um dia só (Hoje, Ontem ou uma data; em Hoje, até a hora atual). A legenda acima do gráfico só identifica as duas linhas — os totais ficam nos indicadores e em "Líquido"; passar o mouse num ponto mostra o valor daquele dia ou daquela hora.',
          notes:
            'Quando há menos de dois pontos para desenhar, o gráfico não aparece e o cartão "Recuperado pelo CRM" ocupa a linha inteira.',
        },
      ],
    },

    // ---------------------------------------------------------------
    {
      id: "recuperado",
      title: "Recuperado pelo CRM",
      items: [
        {
          label: 'Cartão "Recuperado pelo CRM"',
          what: 'Mostra o valor recuperado e, abaixo, quantos jogadores foram recuperados ("<N> jogadores recuperados"). Em seguida, as linhas: "Custo em SMS" (preço por segmento vezes os segmentos enviados no período), "SMS enviados" (quantos SMS saíram no período e, quando houve envio, quantos cliques vieram deles e a taxa de clique, ex.: "1.234 · 56 cliques (4,5%)"), "Cada R$ 1 em SMS trouxe" (recuperado ÷ custo em SMS, em reais, por exemplo "R$ 7,90", em verde), "Em jornada agora" (quantos jogadores estão em jornada neste momento e quantas jornadas estão ativas do total) e "Saldo" (o saldo da carteira em R$).',
          notes:
            'Algumas linhas só aparecem quando fazem sentido: "Custo em SMS" e "SMS enviados", só com o canal SMS liberado para a casa; "Cada R$ 1 em SMS trouxe", só quando houve custo em SMS e algo recuperado; "Saldo", só para casa que não é isenta de cobrança. Recuperado pelo CRM considera só depósitos feitos em até 7 dias depois de um clique humano (não de robô) num link de campanha ou jornada, e não conta quem já estava ativo antes do clique (a regra também está na nota no fim da tela). Casas que não operam em reais (moeda diferente de BRL) não veem "Cada R$ 1 em SMS trouxe": o custo em SMS é sempre em reais, e não faz sentido dividir um valor recuperado em outra moeda por ele.',
        },
        {
          anchor: "inicio.recuperado.em-jornada",
          label: "Em jornada agora",
          what: "Quantos jogadores estão em alguma jornada neste momento e quantas jornadas estão ativas do total da casa. Leva para /jornadas ao clicar.",
        },
        {
          anchor: "inicio.recuperado.ver-resultados",
          label: "Ver resultados do CRM",
          what: "Leva para /resultados, o relatório completo de recuperação pelo CRM.",
        },
      ],
    },

    // ---------------------------------------------------------------
    {
      id: "metricas-secundarias",
      title: "4 métricas complementares",
      items: [
        {
          anchor: "inicio.metricas-secundarias",
          label: "Líquido, Redepósitos, FTDs que redepositaram e PIX não pagos",
          what: 'Líquido: depositado menos sacado no período (em vermelho quando os saques passam os depósitos), com o detalhe do total sacado e de quantos saques ("saques R$ 90,00 · 3 saques"). Redepósitos: valor depositado por jogadores que já tinham depositado antes, com o detalhe de quantos jogadores. FTDs que redepositaram: dos jogadores que fizeram o primeiro depósito no período, quantos % voltaram a depositar dentro do mesmo período, com o detalhe "<redepositaram> de <N> FTDs" (mostra "—" quando não houve FTD no período; a seta, em p.p., some quando o período anterior não teve FTD). PIX não pagos: quantos PIX gerados (QR Code/código emitido) ficaram sem pagamento no período — aparece em laranja quando maior que zero —, com o detalhe do valor dos que seguem pendentes e de quantos % dos gerados foram pagos ("R$ 450,00 · 88,9% pagos").',
          notes:
            'Líquido, Redepósitos e FTDs que redepositaram têm uma seta de variação contra o período anterior, igual aos indicadores principais (em FTDs que redepositaram, que já é uma taxa, a variação vem em p.p.). No Líquido, a seta só aparece quando o período anterior teve líquido positivo (de um líquido negativo para um positivo, a porcentagem não diria nada). Ticket médio e novos cadastros continuam na tela: o ticket fica abaixo de "Depositado" e os cadastros, abaixo da Conversão.',
        },
      ],
    },

    // ---------------------------------------------------------------
    {
      id: "ao-vivo",
      title: "Ao vivo",
      items: [
        {
          label: "Lista de eventos recentes",
          what: "Os 6 eventos mais recentes da casa, do mais novo para o mais antigo (no computador, desce a coluna da esquerda e depois a da direita). Cada linha tem um ícone do tipo de evento (pessoa = criou conta, QR code = gerou um PIX, seta verde = depositou, seta roxa = sacou), o nome do jogador, a ação e há quanto tempo aconteceu (no depósito e no saque, conta a hora em que foi pago, não a hora em que o PIX foi gerado) e, quando tiver valor, o valor à direita (verde quando é depósito).",
          notes: "Clique no nome do jogador para abrir a ficha dele.",
        },
        {
          anchor: "inicio.ao-vivo.ver-todos",
          label: "Ver todos os eventos",
          what: "Leva para /eventos, a lista completa com os últimos 100 eventos.",
        },
      ],
    },
  ],

  states: [
    {
      id: "carregando",
      title: "Carregando o painel",
      what: "A tela ainda está buscando os dados do período escolhido.",
    },
    {
      id: "erro-carregar",
      title: "Não foi possível carregar o painel",
      what: 'A busca falhou. A mensagem varia: "Nenhuma casa disponível para este usuário." (a conta não tem casa associada), "Não foi possível carregar os dados do painel." (erro genérico) ou o texto exato devolvido pelo servidor, quando existir.',
      action: 'Clique em "Tentar novamente".',
    },
    {
      id: "sem-recuperado",
      title: "0 jogadores recuperados",
      what: 'Mostrado no cartão "Recuperado pelo CRM" quando nenhum jogador depositou depois de clicar num link de campanha ou jornada no período escolhido.',
    },
    {
      id: "sem-eventos-ao-vivo",
      title: "Ainda sem eventos recentes para exibir.",
      what: 'Mostrado no lugar da lista do "Ao vivo" quando a casa não tem nenhum evento recente.',
    },
  ],

  tours: {
    default: [
      {
        anchor: "inicio.periodo",
        title: "Período",
        body: 'Seis atalhos (Hoje, Ontem, 7 dias, 30 dias, Este mês, Mês passado) e "Datas" para escolher qualquer intervalo. Todos os números da tela seguem este período.',
        articleSection: "periodo",
      },
      {
        anchor: "inicio.checklist.continuar",
        title: "Configure sua casa",
        body: "Enquanto a casa não tiver URL, domínio do encurtador e domínio/remetente de e-mail prontos, este cartão mostra o que falta e leva direto para a tela de configuração.",
        articleSection: "avisos",
      },
      {
        anchor: "inicio.kpis",
        title: "Os 4 indicadores",
        body: "Depositado, Depositantes, Primeiros depósitos (FTD) e Conversão cadastro → FTD. Abaixo de cada número vem uma linha de apoio (quantidade, ticket, cadastros); a seta compara só o número principal com o período anterior.",
        articleSection: "kpis",
      },
      {
        anchor: "inicio.fluxo.grafico",
        title: "Depósitos e saques",
        body: "A evolução de depósitos e saques no período escolhido: por dia, ou por hora quando o período é de um dia só.",
        articleSection: "fluxo",
      },
      {
        anchor: "inicio.recuperado.em-jornada",
        title: "Recuperado pelo CRM",
        body: 'O valor que o CRM recuperou: depósitos feitos em até 7 dias depois de um clique humano em link de campanha ou jornada. "Em jornada agora" mostra quantos jogadores estão em jornada neste momento — clique para ver em /jornadas.',
        articleSection: "recuperado",
      },
      {
        anchor: "inicio.recuperado.ver-resultados",
        title: "Resultados completos",
        body: "Clique aqui para ver o relatório completo de recuperação pelo CRM.",
        articleSection: "recuperado",
      },
      {
        anchor: "inicio.metricas-secundarias",
        title: "Métricas complementares",
        body: "Líquido (depositado menos sacado), redepósitos, quantos FTDs voltaram a depositar e os PIX gerados que ficaram sem pagamento.",
        articleSection: "metricas-secundarias",
      },
      {
        anchor: "inicio.ao-vivo.ver-todos",
        title: "Ao vivo",
        body: "Os eventos mais recentes dos jogadores. Clique aqui para ver a lista completa em Eventos.",
        articleSection: "ao-vivo",
      },
    ],
  },
};

export default screen;
