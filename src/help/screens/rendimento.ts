// Help article for "Meu rendimento" (/rendimento): o relatório de rendimento
// do próprio usuário — um perfil de equipe (admin, gestor ou membro) vinculado
// à casa ativa. Quem é "expert" tem a mesma tela em /expert/rendimento (fase
// 4, article próprio); por isso os blocos compartilhados do `ReportView` usam
// o prefixo neutro "rendimento." aqui e em rendimento-pessoa.ts (o mesmo
// `ReportView`, visto pelo admin sobre outra pessoa). Fonte:
// src/routes/rendimento.tsx, src/components/rendimento/report-view.tsx e os
// blocos em src/components/rendimento/ (report-cards, report-funnel,
// report-chart, portfolio-table, credit-statement, lead-history-sheet), mais
// as mensagens de erro de src/lib/expert-report.functions.ts,
// src/lib/expert-metrics.functions.ts e
// src/lib/expert-report-subject.server.ts.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "rendimento",
  route: "/rendimento",
  title: "Meu rendimento",
  purpose:
    "O relatório do seu próprio rendimento: quanto foi creditado a você no período, de onde veio (clique num link ou vínculo de afiliado), a evolução por dia, os leads que mais depositaram, o extrato de créditos e a lista completa de leads com crédito.",
  roles: ["admin", "gestor", "member"],
  terms: ["creditado", "janela-de-clique", "clique-x-afiliado", "ftd", "reativado", "redeposito"],
  sections: [
    {
      id: "cabecalho",
      title: "Cabeçalho",
      intro:
        "O nome mostrado é o seu; o badge ao lado é o seu tipo de perfil (ex.: \"Equipe (Admin)\", \"Equipe (Gestor)\", \"Equipe (Membro)\"). Em seguida vem o nome da casa ativa e \"Atualizado às hh:mm\" (ou \"Atualizado em dd/mm às hh:mm\", fora do dia de hoje) — ou, antes do primeiro cálculo, \"Os créditos são calculados a cada 10 minutos.\"",
      items: [
        {
          anchor: "rendimento.header.periodo",
          label: "Período",
          what: 'Escolhe a janela do relatório: Hoje, Ontem, 7/30/90 dias, Este mês ou Mês passado. Todos os blocos da tela (cartões, funil, gráfico, leads que mais depositaram, extrato e leads do período) seguem esse período.',
          notes: "O padrão ao abrir a tela é \"Este mês\".",
        },
        {
          anchor: "rendimento.header.csv",
          label: "Exportar CSV",
          what: 'Baixa o extrato de créditos completo do período (o mesmo conteúdo do bloco "Extrato de créditos", sem paginação) num arquivo "extrato-{seu nome}-{de}-a-{até}.csv".',
          notes:
            'Mostra "Exportando…" enquanto gera o arquivo. Ao terminar, aparece o toast "CSV exportado." e o download começa sozinho.',
        },
      ],
    },
    {
      id: "resultado",
      title: "Resultado do período",
      intro:
        "Os quatro números do período, cada um com a variação (▲/▼) contra o período anterior de mesma duração — \"—\" quando não há período anterior para comparar, e \"0,0%\" cinza quando não houve variação.",
      items: [
        {
          anchor: "rendimento.cards",
          label: "Depositado creditado, FTDs, Redepósitos, Reativados",
          what: '"Depositado creditado" é o total que foi creditado a você no período (ver o termo "Creditado" no glossário), com o detalhe "clique R$ X · afiliado R$ Y" mostrando quanto veio de cada origem. "FTDs" conta quantos leads fizeram o primeiro depósito ("1º depósito") creditado a você, com o valor total desses primeiros depósitos no detalhe. "Redepósitos" conta os depósitos que não são o primeiro, com o valor total e o "ticket" (valor ÷ quantidade, "—" sem nenhum redepósito) no detalhe. "Reativados" conta os leads que estavam dormindo e voltaram a depositar (ver o termo "Reativado").',
        },
      ],
    },
    {
      id: "funil-grafico",
      title: "Funil e evolução",
      items: [
        {
          anchor: "rendimento.funnel",
          label: '"Do contato ao depósito" (funil)',
          what: 'Três passos, de cima para baixo: "Links gerados" (quantos links de rastreio seus foram criados no período), "Leads que clicaram (X%)" (quantos leads clicaram nesses links, e a fração sobre os links gerados) e "Depositaram em até {janela}h (Y% dos que clicaram)" (quantos desses cliques resultaram em depósito dentro da janela de clique da casa — ver o termo). Abaixo, "Contatos registrados" conta quantas vezes você (ou a equipe) registrou um contato com um lead no período.',
          notes:
            'As porcentagens são limitadas a 100% na tela (o cálculo pode passar disso, porque um depósito do período pode vir de um clique de antes do período) — passe o mouse sobre a linha do depósito para ver a definição completa ("Leads que depositaram por clique no período ÷ leads que clicaram no período").',
        },
        {
          anchor: "rendimento.chart",
          label: '"Evolução por dia" (gráfico)',
          what: 'Barras empilhadas de FTD (valor) e Redepósito (valor) creditados por dia, mais uma linha com o número de depositantes distintos daquele dia. Passar o mouse num ponto mostra os três valores do dia.',
          notes: 'Sem nenhum crédito no período, mostra "Nenhum crédito neste período." no lugar do gráfico.',
        },
      ],
    },
    {
      id: "top-leads",
      title: "Leads que mais depositaram",
      items: [
        {
          anchor: "rendimento.topleads",
          label: "Leads que mais depositaram",
          what: 'Os 10 leads com mais valor creditado a você no período, do maior para o menor: nome, valor creditado, quantidade de depósitos e a origem (Clique/Afiliado/Ambos — ver "Clique × afiliado" no glossário). Um badge "FTD" aparece quando o lead fez o primeiro depósito no período, e "Reativado" quando ele estava dormindo e voltou.',
          notes:
            'Clicar no nome do lead abre o histórico dele com você (painel lateral, ver "Lead do período" abaixo). Sem nenhum crédito no período, mostra "Nenhum lead com crédito neste período."',
        },
      ],
    },
    {
      id: "extrato",
      title: "Extrato de créditos",
      items: [
        {
          anchor: "rendimento.extrato",
          label: "Extrato de créditos",
          what: 'A base da sua comissão, linha a linha: Data, Lead, Valor, Origem (Clique/Afiliado), Oferta (o nome da oferta do link, "—" sem oferta), Clique em (quando o lead clicou, "—" sem clique registrado), Primeiro depósito (Sim/Não) e Reativação (Sim/Não). O total do topo ("Total depositado creditado") é sempre o período inteiro, não só a página visível.',
          notes:
            'Paginado de 100 em 100 ("Página anterior"/"Próxima página"). Sem nenhum crédito, mostra "Nenhum crédito no período."',
        },
      ],
    },
    {
      id: "leads-periodo",
      title: "Leads do período",
      intro:
        'A carteira: todo lead com crédito seu no período, com busca e filtros, 50 por página.',
      items: [
        {
          anchor: "rendimento.portfolio.busca",
          label: "Buscar por nome ou telefone",
          what: "Filtra a lista pelo texto digitado (nome ou telefone do lead). A busca tem uma pequena espera (debounce) antes de aplicar, e volta a lista para a primeira página.",
        },
        {
          anchor: "rendimento.portfolio.so-ftd",
          label: "Só FTD",
          what: "Mostra só os leads que fizeram o primeiro depósito (FTD) dentro do período.",
        },
        {
          anchor: "rendimento.portfolio.so-reativados",
          label: "Só reativados",
          what: 'Mostra só os leads marcados como "Reativado" no período (ver o termo no glossário).',
          notes: "Os dois filtros podem ser ligados juntos; a busca funciona com qualquer combinação deles.",
        },
        {
          anchor: "rendimento.portfolio.csv",
          label: "Exportar CSV (leads do período)",
          what: 'Baixa a carteira inteira (já com a busca e os filtros aplicados) num arquivo "carteira-{seu nome}-{de}-a-{até}.csv", com uma linha de total no fim.',
        },
        {
          anchor: "rendimento.portfolio",
          label: "Tabela de leads do período",
          what: "Colunas: Lead, Creditado, Depósitos, Origem, 1º crédito, Último depósito, Último contato (resultado do contato e data, \"—\" sem contato registrado).",
          notes:
            'Clicar no nome do lead abre o histórico dele com você. Carregando mostra "Carregando…"; um erro mostra a mensagem do servidor; sem nenhum resultado mostra "Nenhum lead com crédito neste período." Paginação de 50 em 50, com "Página X de Y" e os botões de página anterior/próxima — a página volta para a primeira sempre que o período, a busca ou um filtro muda, e recua sozinha se a página atual ficar vazia (o total pode cair entre uma consulta e outra, com os créditos recalculados).',
        },
      ],
    },
    {
      id: "historico-lead",
      title: "Histórico do lead",
      intro:
        'Painel lateral aberto ao clicar no nome de um lead (em "Leads que mais depositaram" ou em "Leads do período"). No celular ocupa a tela inteira.',
      items: [
        {
          label: "Histórico do lead com a pessoa (painel)",
          what: 'Mostra, no topo, um resumo de todo o histórico (não só o período escolhido): Creditado (soma de tudo já creditado a você para esse lead), Depósitos (quantidade) e Desde (data do primeiro crédito, "—" sem nenhum). Abaixo, a linha do tempo do mais novo para o mais antigo: links gerados, cliques, contatos registrados e depósitos. Cada depósito mostra um selo — "Creditado" (verde, com o valor e o motivo ao lado, por exemplo a origem), "Outra pessoa" (foi creditado a outra pessoa da equipe), "Não creditado" (cinza, nenhum crédito) ou "Aguardando cálculo" (ainda não processado, o próximo cálculo é em até 10 minutos).',
          notes:
            '"Abrir ficha do lead" leva à ficha completa do jogador (/players/$playerId). "Carregar mais" busca a página seguinte (100 itens por vez); sem nada no histórico mostra "Nada no histórico."',
        },
      ],
    },
  ],

  states: [
    {
      id: "sem-perfil",
      title: "Sem relatório — perfil não encontrado",
      what: 'Quando a chamada ao servidor falha (por exemplo o seu usuário não tem mais um perfil de equipe vinculado à casa ativa), a tela mostra a mensagem de erro do servidor no lugar do conteúdo, em vez dos blocos do relatório.',
    },
    {
      id: "carregando",
      title: "Carregando…",
      what: "Mostrado enquanto o relatório ainda não voltou do servidor, no lugar de todos os blocos.",
    },
  ],

  tours: {
    default: [
      {
        anchor: "rendimento.header.periodo",
        title: "Período",
        body: "Escolhe a janela do relatório. Todos os blocos abaixo seguem esse período.",
        articleSection: "cabecalho",
      },
      {
        anchor: "rendimento.header.csv",
        title: "Exportar CSV",
        body: "Baixa o extrato de créditos completo do período escolhido.",
        articleSection: "cabecalho",
      },
      {
        anchor: "rendimento.cards",
        title: "Resultado do período",
        body: "Depositado creditado, FTDs, Redepósitos e Reativados, cada um com a variação contra o período anterior.",
        articleSection: "resultado",
      },
      {
        anchor: "rendimento.funnel",
        title: "Do contato ao depósito",
        body: "Links gerados → leads que clicaram → depositaram dentro da janela de clique da casa.",
        articleSection: "funil-grafico",
      },
      {
        anchor: "rendimento.chart",
        title: "Evolução por dia",
        body: "FTD e redepósito creditados por dia, e o número de depositantes distintos.",
        articleSection: "funil-grafico",
      },
      {
        anchor: "rendimento.topleads",
        title: "Leads que mais depositaram",
        body: "Os 10 leads com mais valor creditado a você no período. Clique num nome para ver o histórico dele com você.",
        articleSection: "top-leads",
      },
      {
        anchor: "rendimento.extrato",
        title: "Extrato de créditos",
        body: "A base da sua comissão, linha a linha, com o total do período inteiro no topo.",
        articleSection: "extrato",
      },
      {
        anchor: "rendimento.portfolio",
        title: "Leads do período",
        body: "Todo lead com crédito seu no período, com busca, filtros \"Só FTD\"/\"Só reativados\" e exportação em CSV.",
        articleSection: "leads-periodo",
      },
    ],
  },
};

export default screen;
