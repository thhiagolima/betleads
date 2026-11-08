// Help article for "Comparar casas" (/resultados/comparar), sem abas. Só
// aparece para quem é administrador em duas ou mais casas (comparableTenants,
// em src/lib/tenant-comparison.functions.ts). Fonte:
// src/routes/resultados_.comparar.tsx e
// src/components/crm-results/tenant-comparison.tsx.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "resultados-comparar",
  route: "/resultados/comparar",
  title: "Comparar casas",
  purpose:
    "As mesmas 19 métricas de Resultados do CRM, lado a lado, só nas casas em que você é administrador — para comparar o desempenho do CRM entre elas.",
  roles: ["admin"],
  terms: [
    "recuperado-pelo-crm",
    "recuperados-visao-ampla",
    "taxa-de-clique",
    "custo-por-jogador-convertido",
  ],
  sections: [
    {
      id: "comparacao",
      title: "Comparação",
      intro:
        "Uma tabela só, com uma coluna por casa e uma linha por métrica, agrupada em três blocos: Recuperado pelo CRM, Reativações após SMS e Base de jogadores (agora).",
      items: [
        {
          anchor: "resultados-comparar.periodo",
          label: "Período: 7 dias / 30 dias / 90 dias",
          what: "Escolhe a janela de tempo das métricas de envio (SMS, cliques, Recuperado pelo CRM, Reativações após SMS). O bloco \"Base de jogadores (agora)\" não muda com o período: ele é sempre a situação atual da base, exceto \"Cadastros no período\", que segue o período escolhido.",
        },
        {
          anchor: "resultados-comparar.tabela",
          label: "Tabela comparativa",
          what: 'Uma coluna por casa onde você é administrador (só aparece com duas ou mais). Em cada linha com uma direção clara de "melhor", a casa com o melhor valor fica destacada em verde. As 19 métricas, nos três grupos:',
          notes: [
            "Recuperado pelo CRM (8): SMS enviados; Custo em SMS; Taxa de clique (cliques no link ÷ SMS enviados); Jogadores que voltaram pelo link (depositaram até 7 dias depois de clicar); Cliques que viraram depósito (cliques do período que levaram a um depósito em até 7 dias ÷ cliques no link); Recuperado pelo CRM (valor, na moeda de cada casa — só destaca a melhor entre casas da mesma moeda); Custo por jogador que voltou; Cada R$ 1 em SMS trouxe (só em casas que operam em BRL — nas demais, aparece \"—\": receita e custo em moedas diferentes).",
            "Reativações após SMS (4): Reativações após SMS (jogadores, já inclui o Recuperado pelo CRM); Depositaram em até 3 dias (valor, na moeda da casa); Custo por reativação; Custo em quem já estava jogando (parte do custo enviada a quem depositou nos últimos 2 dias — aqui quanto menor, melhor).",
            "Base de jogadores, agora (7): Ativos (até 2 dias); Esfriando (2–7 dias); Dormindo (7–30 dias); Perdidos (30+ dias); Cadastros no período; Cadastro → 1º depósito; 2º depósito em 7 dias (da última semana de cadastro já fechada — sem destaque de melhor/pior nas quatro primeiras, porque o tamanho da base por si só não é bom nem mau).",
          ].join(" "),
        },
      ],
    },
  ],

  states: [
    {
      id: "carregando",
      title: "Carregando a comparação",
      what: "Esqueleto no lugar da tabela enquanto os dados de todas as casas carregam.",
    },
    {
      id: "sem-acesso",
      title: "A comparação está disponível apenas para administradores de duas ou mais casas.",
      what: 'Mostrado no lugar da tabela para quem acessa esta tela sem ser administrador em pelo menos duas casas.',
      action: "Peça para ser promovido a administrador em mais de uma casa, se precisar comparar.",
    },
    {
      id: "erro-carregar",
      title: "Não foi possível carregar a comparação. Tente novamente em instantes.",
      what: "Mostrado no lugar da tabela quando a busca falha por outro motivo (não o de acesso).",
      action: "Recarregue a página; se continuar, procure o suporte.",
    },
  ],

  tours: {
    default: [
      {
        anchor: "resultados-comparar.periodo",
        title: "Escolha o período",
        body: "7, 30 ou 90 dias. Só afeta as métricas de envio; a base de jogadores é sempre a de agora.",
        articleSection: "comparacao",
      },
      {
        anchor: "resultados-comparar.tabela",
        title: "Tabela comparativa",
        body: "As mesmas métricas de Resultados do CRM, lado a lado por casa. Em verde, a melhor casa em cada linha.",
        articleSection: "comparacao",
      },
    ],
  },
};

export default screen;
