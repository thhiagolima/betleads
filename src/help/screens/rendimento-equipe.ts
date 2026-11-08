// Help article for "Rendimento da equipe" (/rendimento/equipe), só para o
// admin da casa: o topo com a fatia da equipe sobre a casa e o ranking de
// todos os perfis (experts e equipe, inclusive inativos). Clicar num nome do
// ranking leva ao relatório individual (/rendimento/equipe/$expertId, artigo
// "rendimento-pessoa"). Fonte: src/routes/rendimento.equipe.tsx,
// src/components/rendimento/team-ranking.tsx e
// src/components/experts/expert-settings-dialog.tsx, mais
// src/lib/expert-report.functions.ts (getTeamReport/exportTeamReportCsv) e
// src/lib/expert-metrics.functions.ts (saveExpertSettings).
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "rendimento-equipe",
  route: "/rendimento/equipe",
  title: "Rendimento da equipe",
  purpose:
    "Quanto a equipe (experts e perfis de equipe) creditou no total, comparado com a casa, e o ranking de cada pessoa — para comparar quem está trazendo mais resultado e abrir o relatório individual de qualquer um.",
  roles: ["admin"],
  terms: ["creditado", "janela-de-clique", "clique-x-afiliado", "ftd", "reativado", "redeposito"],
  sections: [
    {
      id: "topo",
      title: "Topo",
      intro:
        'O subtítulo mostra "Atualizado às hh:mm" (ou "Atualizado em dd/mm às hh:mm" fora de hoje), ou "Os créditos são calculados a cada 10 minutos." antes do primeiro cálculo.',
      items: [
        {
          anchor: "equipe.periodo",
          label: "Período",
          what: "Escolhe a janela do relatório (Hoje, Ontem, 7/30/90 dias, Este mês, Mês passado). Os cartões e o ranking seguem esse período.",
          notes: 'O padrão ao abrir a tela é "Este mês".',
        },
        {
          anchor: "equipe.regras-credito",
          label: "Regras de crédito",
          what: 'Abre o diálogo "Regras de crédito", onde se configura a janela de clique da casa (ver o termo "Janela de clique" no glossário).',
        },
        {
          anchor: "equipe.csv",
          label: "Exportar CSV",
          what: 'Baixa o ranking inteiro do período (todas as colunas da tabela) num arquivo "equipe-{de}-a-{até}.csv".',
          notes: 'Mostra "Exportando…" enquanto gera; ao terminar aparece o toast "CSV exportado." e o download começa sozinho.',
        },
      ],
    },
    {
      id: "cartoes",
      title: "Cartões",
      items: [
        {
          anchor: "equipe.cards",
          label: "Total creditado à equipe, FTDs da equipe, Redepósitos, Reativados",
          what: '"Total creditado à equipe" é a soma do que foi creditado a todas as pessoas no período, com o detalhe "X% do depositado na casa" (a fatia da equipe sobre o total depositado na casa inteira, sem esse detalhe quando a casa não teve depósito no período). "FTDs da equipe" soma os primeiros depósitos creditados, com "X% dos FTDs da casa" no detalhe. "Redepósitos" e "Reativados" somam os mesmos números da equipe inteira (ver os termos no glossário).',
        },
      ],
    },
    {
      id: "ranking",
      title: "Ranking",
      items: [
        {
          anchor: "equipe.ranking",
          label: "Ranking",
          what: "Uma linha por perfil da casa (expert ou equipe), inclusive os inativos (com o badge \"Inativo\" ao lado do nome). Colunas: Pessoa (nome, link para o relatório individual), Tipo (\"Expert restrito\", \"Expert total\" ou \"Equipe (Admin/Gestor/Membro)\"), Creditado, Variação vs período anterior, FTD, Redepósitos, Reativados, Clique→depósito (%) e Ticket médio.",
          notes:
            '"Clique→depósito" é a fração de leads que clicaram no período e depositaram por clique dentro da janela (mesma definição do funil do relatório individual — passe o mouse sobre o número para ver o texto completo); "—" sem nenhum clique no período. "Ticket médio" é o valor creditado total dividido pela quantidade de depósitos creditados; "—" sem nenhum depósito.',
        },
        {
          anchor: "equipe.ranking.ordenar",
          label: "Cabeçalhos da tabela (ordenar)",
          what: 'Clicar num cabeçalho ordena a tabela por aquela coluna; clicar de novo inverte a direção (a seta ao lado mostra crescente/decrescente). Padrão: Creditado, do maior para o menor.',
          notes: "A ordenação é só na tela (sobre as linhas já carregadas), sem nova chamada ao servidor.",
        },
        {
          label: "Sem nenhum perfil",
          what: 'Mostra "Nenhum perfil cadastrado." quando a casa ainda não tem nenhum expert nem perfil de equipe.',
        },
      ],
    },
    {
      id: "regras-credito",
      title: 'Diálogo "Regras de crédito"',
      intro: 'Aberto pelo botão "Regras de crédito" do topo.',
      items: [
        {
          label: 'Campo "Janela de clique (horas)"',
          what: 'Define quantas horas depois do clique num link seu um depósito ainda conta como "por clique" (ver o termo "Janela de clique" no glossário). Aceita um número inteiro de 1 a 720 (30 dias).',
          notes:
            'Erros possíveis: "Informe a janela em horas." (campo vazio) e "A janela precisa ser um número inteiro entre 1 e 720 horas." (fora da faixa ou não inteiro). O texto de ajuda avisa: "Padrão 72h. Vale para os próximos cálculos e recalcula os últimos 8 dias." — ao salvar, os créditos dos últimos 8 dias são recalculados com a nova janela; antes disso, nada muda retroativamente.',
        },
        {
          label: "Salvar / Cancelar",
          what: 'Salvar grava a nova janela (toast "Janela de clique atualizada.") e atualiza os relatórios (individual e da equipe) e a lista de experts. Cancelar fecha sem salvar.',
          notes: "O campo começa desabilitado, mostrando \"Carregando…\", até a janela salva da casa chegar do servidor.",
        },
      ],
    },
  ],

  states: [
    {
      id: "carregando",
      title: "Carregando…",
      what: "Mostrado enquanto o relatório da equipe ainda não voltou do servidor, no lugar dos cartões e do ranking.",
    },
    {
      id: "erro",
      title: "Erro ao carregar",
      what: "A mensagem de erro do servidor aparece no lugar dos cartões e do ranking quando a chamada falha.",
    },
  ],

  tours: {
    default: [
      {
        anchor: "equipe.periodo",
        title: "Período",
        body: "Escolhe a janela do relatório. Os cartões e o ranking seguem esse período.",
        articleSection: "topo",
      },
      {
        anchor: "equipe.regras-credito",
        title: "Regras de crédito",
        body: "Configura a janela de clique da casa — quanto tempo depois do clique um depósito ainda conta como crédito por clique.",
        articleSection: "topo",
      },
      {
        anchor: "equipe.csv",
        title: "Exportar CSV",
        body: "Baixa o ranking inteiro do período escolhido.",
        articleSection: "topo",
      },
      {
        anchor: "equipe.cards",
        title: "Total da equipe",
        body: "Quanto a equipe creditou no total, e a fatia sobre o total depositado na casa.",
        articleSection: "cartoes",
      },
      {
        anchor: "equipe.ranking",
        title: "Ranking",
        body: "Uma linha por pessoa, inclusive inativos. Clique num nome para abrir o relatório dela.",
        articleSection: "ranking",
      },
      {
        anchor: "equipe.ranking.ordenar",
        title: "Ordenar",
        body: "Clique num cabeçalho para ordenar por aquela coluna; clique de novo para inverter.",
        articleSection: "ranking",
      },
    ],
  },
};

export default screen;
