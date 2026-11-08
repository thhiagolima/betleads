// Help article for "Aquisição e LTV" (/midia-ltv), duas abas: Mídia e
// Retenção. Fonte: src/routes/midia-ltv.tsx, src/components/midia-ltv/
// ad-account-filter.tsx e src/components/crm-results/retention.tsx, mais os
// tipos/erros de src/lib/marketing-overview.ts, src/lib/marketing.functions.ts,
// src/lib/meta.functions.ts e src/lib/crm-results.functions.ts (getCrmRetention).
//
// A conexão com a Meta (chave, contas, sincronização automática) é tratada em
// Integrações (/webhooks#meta, screens/webhooks.ts) — aqui só o atalho
// "Conectar Meta" e o "Atualizar agora" desta tela.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "midia-ltv",
  route: "/midia-ltv",
  defaultTab: "midia",
  title: "Aquisição e LTV",
  purpose:
    "Cada jogador carrega o anúncio que o trouxe: a aba Mídia mostra quem trouxe cadastro barato, quem trouxe dinheiro e qual anúncio devolveu mais do que custou; a aba Retenção mostra onde a base de jogadores está, o funil de cadastro ao 1º depósito e a retenção (cohorts) de quem acabou de depositar por 1ª vez.",
  roles: ["admin", "gestor", "member"],
  terms: ["roas", "cpa-cac", "ctr", "impressoes", "bm", "utm", "ads-read", "cohort", "ltv"],
  sections: [
    // ---------------------------------------------------------------
    // Aba Mídia — cabeçalho: conectar, sincronizar, período, filtro
    // ---------------------------------------------------------------
    {
      id: "midia-header",
      title: "Conectar, sincronizar e período",
      tab: "midia",
      intro:
        "Linha de cima da aba Mídia: conectar a Meta quando falta, acompanhar/disparar a sincronização, escolher o período e filtrar por BM ou conta.",
      items: [
        {
          anchor: "midia.header.conectar-meta",
          label: "Conectar Meta",
          what: "Aparece só quando a casa ainda não tem nenhuma chave da Meta conectada. Leva para Integrações (/webhooks, aba Meta Ads), onde a conexão de fato é feita.",
          notes:
            "Depois que a 1ª chave é conectada, o botão some desta tela — chaves e contas passam a ser geridas só em Integrações; aqui elas só aparecem já prontas, no filtro BM/conta e nos relatórios.",
        },
        {
          anchor: "midia.sync.atualizar",
          label: "Atualizar agora",
          what: "Coloca na fila uma releitura do gasto da Meta para o mesmo intervalo de dias do período aberto na tela.",
          roles: ["admin"],
          notes:
            'Fica desativado no ambiente de demonstração (mostra a dica "Ambiente de demonstração: esta ação não está disponível"), para quem não é administrador da casa (ao lado aparece "Só o administrador da casa sincroniza a Meta."), enquanto já existe uma sincronização na fila ou em andamento (o texto muda para "sincronização na fila", com um ícone girando) e quando não há nenhuma conta de anúncio marcada. Ao clicar, mostra "Sincronização adicionada à fila" ou, se já havia uma pendente, "A sincronização já está na fila"; falhando, mostra a mensagem do servidor (por exemplo "Apenas administradores da casa podem sincronizar a Meta.") ou, sem mensagem específica, "Erro ao agendar sincronização".',
        },
        {
          label: 'Faixa "Última sincronização: ..."',
          what: 'Aparece depois da 1ª sincronização, com o status mais recente — "na fila", "sincronizando", "concluída", "concluída com atenção" (parcial, com alguma conta com erro), "falhou" ou "cancelada" — mais quantas contas já foram processadas e quantas linhas foram importadas.',
          notes:
            'Enquanto está "na fila" ou "sincronizando", mostra uma barra de progresso e a % no lugar da hora; terminando, mostra a data e a hora em que terminou. Uma sincronização com erro mostra o motivo embaixo, em vermelho.',
        },
        {
          anchor: "midia.sync.historico",
          label: "Ver histórico recente",
          what: "Abre a lista das até 5 sincronizações anteriores a essa: status, se foi manual, automática ou a importação inicial, quantas contas e quando rodou.",
          notes: "Só aparece quando a casa já tem mais de uma sincronização registrada.",
        },
        {
          anchor: "midia.periodo.presets",
          label: "Período (Hoje / Ontem / 7 dias / 30 dias / Este mês / Mês passado)",
          what: "Escolhe o intervalo de datas usado pela tela inteira: indicadores, abas internas e avisos.",
          notes: "Escolher um período pronto solta a data personalizada, se havia uma marcada.",
        },
        {
          anchor: "midia.periodo.data-inicial",
          label: 'Datas personalizadas ("Data inicial" até "Data final")',
          what: "Dois campos de data para escolher um intervalo fora dos períodos prontos.",
          notes:
            'A "Data final" não pode ser depois de hoje, nem antes da "Data inicial"; escolher uma data aqui desmarca o período pronto que estava ativo.',
        },
        {
          anchor: "midia.filtro.bm-conta",
          label: "Filtro BM / conta",
          what: 'Botão "BM / conta: Todas as contas" (ou o nome da conta, ou "N contas", quando algum filtro está marcado) que abre uma busca ("Buscar BM, conta ou act_") com as contas agrupadas por BM — a Business Manager de cada uma. Dentro: "Todas as contas" (limpa o filtro), "Toda a BM" (marca/desmarca o grupo inteiro de uma vez, só aparece com mais de uma conta na BM) e cada conta, com o ID (act_...) ao lado do nome.',
          notes:
            'Só lista as contas marcadas em Integrações; sem nenhuma conta marcada na casa, o botão nem aparece. Sem resultado na busca, mostra "Nenhuma conta encontrada." Com o filtro ativo aparece embaixo o aviso "Com filtro, entram só os jogadores atribuídos a essas contas; tráfego sem atribuição fica de fora."',
        },
        {
          label: 'Linha "Gasto: Meta Ads, N conta(s)..."',
          what: 'Resume de onde vêm os números: "Gasto: Meta Ads, N conta(s), última leitura em <data e hora>" (ou ", aguardando a primeira leitura" sem nenhuma sincronização ainda) e "Cadastros, 1º depósito e depósitos: integração da casa." — avisando que o gasto vem da Meta e o resto vem dos webhooks da casa.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Mídia — os 5 indicadores
    // ---------------------------------------------------------------
    {
      id: "midia-kpis",
      title: "Os 5 indicadores",
      tab: "midia",
      intro:
        "Os números do período escolhido, só sobre jogadores ligados a um anúncio ou campanha das contas conectadas (ou filtradas).",
      items: [
        {
          anchor: "midia.kpis.investido",
          label: "Investido no período",
          what: "Soma do gasto em reais das contas de anúncio marcadas (ou filtradas) no período.",
          notes: 'Detalhe: "<valor> por dia, em média" (investido ÷ dias do período).',
        },
        {
          anchor: "midia.kpis.roas",
          label: "ROAS líquido",
          what: "Depósitos (1º depósito + redepósito) dos jogadores vindos de anúncio, menos os saques deles, dividido pelo investido.",
          notes:
            'Detalhe: a fórmula em palavras ("depósitos − saques ÷ investido") e o ROAS bruto ao lado, como referência (sem subtrair os saques — por isso é sempre igual ou maior que o líquido). Numa casa que opera em moeda diferente de real, mostra "—": a receita está numa moeda e o custo (Meta) em reais, sem conversão de câmbio.',
        },
        {
          anchor: "midia.kpis.custo-1o-deposito",
          label: "Custo por 1º depósito",
          what: "Investido ÷ 1º depósitos vindos de anúncio.",
          notes:
            "Detalhe: quantos 1º depósitos vieram de anúncio e quantos a casa teve no total (com e sem anúncio).",
        },
        {
          anchor: "midia.kpis.custo-cadastro",
          label: "Custo por cadastro",
          what: "Investido ÷ cadastros vindos de anúncio.",
          notes:
            "Detalhe: quantos cadastros vieram de anúncio e quantos a casa teve no total (com e sem anúncio).",
        },
        {
          anchor: "midia.kpis.deposito-liquido",
          label: "Depósito líquido",
          what: "Tudo o que os jogadores vindos de anúncio depositaram no período, menos o que sacaram.",
          notes: "Detalhe: o valor depositado e o valor sacado, separados.",
        },
        {
          label: '"Como o ROAS é calculado"',
          what: "Linha com a conta por extenso, logo abaixo dos indicadores: 1º depósitos + redepósito − saques = depósito líquido, dividido pelo investido = ROAS líquido.",
          notes:
            "Conta só os jogadores que se cadastraram no período por um anúncio (dia de Brasília) — por isso o valor pode diferir de uma soma manual de depósitos de todos os jogadores vindos de anúncio em qualquer data.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Mídia — abas internas
    // ---------------------------------------------------------------
    {
      id: "midia-abas",
      title: "Abas internas: Por criativo, Por público, Por campanha, Evolução e Diagnóstico",
      tab: "midia",
      intro:
        "Abaixo dos indicadores, cinco visões do mesmo período, trocadas sem recarregar a tela.",
      items: [
        {
          anchor: "midia.subabas.tabs",
          label: "Por criativo / Por público da Meta / Por campanha da Meta / Evolução / Diagnóstico",
          what: "Troca a tabela ou o gráfico mostrado abaixo, sem mudar o período nem o filtro de BM/conta escolhidos.",
        },
        {
          label: "Por criativo",
          what: "Uma linha por anúncio (criativo): miniatura, nome e campanha; investido e impressões; cliques no link e CTR (cliques ÷ impressões); cadastros; 1º depósito; custo por 1º depósito; depósito líquido (e o bruto, sem subtrair saques, ao lado); ROAS líquido. Uma linha \"Outros N criativos\" soma o que não entrou na lista, e a linha final \"Total\" soma tudo.",
          notes:
            'Vazio mostra "Sem dados atribuídos" (ou "Carregando criativos" durante o carregamento) — na casa de demonstração, o texto troca para o padrão de demonstração.',
        },
        {
          label: "Por público da Meta",
          what: 'Uma linha por conjunto de anúncios (público/segmentação da Meta): nome, investido, quantos anúncios existem dentro dele, e as mesmas colunas de negócio das outras abas (cadastros, custo por cadastro, 1º dep., custo por 1º dep., depósito líquido, ROAS líquido). Linha "Outros N públicos" e linha "Total".',
          notes: 'Vazio mostra "Sem públicos no período" (ou "Carregando públicos").',
        },
        {
          label: "Por campanha da Meta",
          what: 'Uma linha por campanha: nome (com o ID da campanha, ou "sem gasto importado no período" quando a campanha não tem leitura de gasto importada), investido, cliques no link e as colunas de negócio. Linha "Outras N campanhas" e linha "Total".',
          notes:
            'Um texto abaixo da tabela explica que campanhas de contas de anúncio não conectadas ficam sem investimento e sem ROAS, mostrando quanto isso representa em depósitos quando existem órfãos. Vazio mostra "Sem campanhas no período".',
        },
        {
          label: "Evolução",
          what: 'Dois gráficos de área — "Investimento por dia" e "1º depósito de anúncio por dia", ambos pelos dias do período — e o cartão "Onde o dinheiro está": a participação de cada criativo nos depósitos do período (1º depósito e redepósito), em barras de %.',
          notes: 'Sem receita atribuída, o cartão mostra "Sem receita atribuída" em vez das barras.',
        },
        {
          anchor: "midia.evolucao.money-map-paginacao",
          label: 'Paginação de "Onde o dinheiro está"',
          what: "Números de página para percorrer a lista de criativos do cartão, 8 por página (até 10 números de página mostrados por vez).",
        },
        {
          label: "Diagnóstico",
          what: 'Com o filtro de BM/conta limpo, mostra 6 indicadores sobre a qualidade da atribuição e a tabela "Marcações sem anúncio correspondente". Com o filtro marcado, mostra só um aviso em vez dos números (ver estados da tela).',
        },
        {
          anchor: "midia.diagnostico.kpis",
          label: "Indicadores do Diagnóstico",
          what: '"Cadastros" (todos no período), "Com marcação" (chegaram com UTM ou um ID de anúncio), "Ligados a anúncio" (bateram com um anúncio/campanha das contas conectadas, com a % dos marcados ao lado), "Sem anúncio correspondente" (soma órfãos + nomes repetidos em mais de um anúncio), "Vindos do CRM" (SMS ou WhatsApp, não é mídia paga) e "Sem UTM" (não trazem nenhuma marcação, não permitem atribuição).',
        },
        {
          label: 'Tabela "Marcações sem anúncio correspondente"',
          what: 'Uma linha por combinação de campanha/criativo/público declarados que não bateu com nenhum anúncio das contas conectadas: campanha declarada, criativo, conjunto, origem (com o selo "fora das contas" ou "nome repetido"), jogadores, 1º depósitos e depósitos; as colunas Investido e ROAS aparecem como "não encontrado" e "não calculado" — não há gasto importado para ligar a essas linhas.',
          notes:
            'Vazio mostra "Nenhuma marcação sem anúncio no período" (ou "Conferindo atribuições" durante o carregamento) com a explicação "Quando uma UTM chegar de uma campanha fora das BMs conectadas, ela aparece aqui sem gerar ROAS artificial."',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Retenção
    // ---------------------------------------------------------------
    {
      id: "retencao-periodo",
      title: "Período",
      tab: "retencao",
      intro:
        "A aba Retenção tem seu próprio seletor de período, independente do da aba Mídia.",
      items: [
        {
          anchor: "midia.retencao.periodo",
          label: "Período (Hoje / Ontem / 7 dias / 30 dias / 90 dias)",
          what: "Escolhe o intervalo usado pelo funil de cadastros, pela tabela de origem e pela evolução da base.",
          notes:
            'A base agora e a retenção dos novos depositantes (cohorts) não mudam com este período — veja o selo "não muda com o período" nos dois cartões.',
        },
      ],
    },
    {
      id: "retencao-base",
      title: "Onde a base está e sua evolução",
      tab: "retencao",
      items: [
        {
          anchor: "midia.retencao.base-agora",
          label: '"Onde a base está agora"',
          what: 'Barras com a base inteira da casa (não muda com o período) pelo tempo desde o último depósito de cada jogador: "Sem 1º depósito", "Ativo (< 2 dias)", "Esfriando (2–7 dias)", "Dormindo (7–30 dias)", "Perdido (30+ dias)" e "Sem histórico" — cada uma com a contagem e o % da base.',
        },
        {
          anchor: "midia.retencao.evolucao-base",
          label: '"Evolução da base"',
          what: "Gráfico de linhas com quantos jogadores estavam em cada situação (Ativo, Esfriando, Dormindo, Perdido) ao fim de cada dia do período escolhido.",
          notes:
            'Esfriando e Dormindo são os jogadores que o CRM precisa trazer de volta. Com o período escolhido tendo só 1 dia de dados, o cartão não aparece e mostra em vez disso "A evolução da base aparece em períodos de 7 dias ou mais."',
        },
      ],
    },
    {
      id: "retencao-funil",
      title: "Funil de cadastros e origem",
      tab: "retencao",
      items: [
        {
          anchor: "midia.retencao.funil",
          label: '"Funil dos cadastros"',
          what: "Barras com os cadastros do período e até onde chegaram: Cadastros, 1º depósito, 2º depósito e 3 ou mais depósitos. Mostra também a mediana de tempo do cadastro ao 1º depósito.",
          notes: 'Sem nenhum cadastro no período, mostra "Nenhum cadastro hoje/ontem/nos últimos N dias." em vez das barras.',
        },
        {
          anchor: "midia.retencao.origem",
          label: '"Por origem do cadastro"',
          what: "Tabela com a origem informada no cadastro (a marcação utm_source): cadastros, quantos viraram depositantes (% e contagem), quantos fizeram o 2º depósito (% e contagem) e o tempo mediano até o 1º depósito.",
          notes:
            'Mostra até 15 origens; o resto some numa linha "Outras (N origens)" que soma os números das origens que ficaram de fora.',
        },
      ],
    },
    {
      id: "retencao-cohort",
      title: "Retenção dos novos depositantes (cohorts)",
      tab: "retencao",
      items: [
        {
          anchor: "midia.retencao.cohort",
          label: '"Retenção dos novos depositantes"',
          what: "Uma linha por semana do 1º depósito, nas últimas 12 semanas: quantos jogadores fizeram o 1º depósito naquela semana, a % que fez o 2º depósito em 7, 14 e 30 dias (cor mais forte = % maior), o tempo mediano até o 2º depósito e quanto esse grupo já depositou em 30 dias.",
          notes:
            'A % de 2º depósito só aparece depois que a janela se fecha para todo o grupo — a taxa em 30 dias de uma semana muito recente, por exemplo, ainda não é mostrada. Sem nenhum 1º depósito nas últimas 12 semanas, mostra "Sem primeiros depósitos no período." Rodapé fixo da tabela: "O histórico de depósitos começa em 02/09/2026; jogadores que já depositavam antes disso não entram como novos."',
        },
      ],
    },
  ],

  states: [
    {
      id: "numeros-em-validacao",
      title:
        "Os cálculos desta tela foram refeitos e estão sendo conferidos com o Gerenciador de Anúncios. Até o fim da conferência, use os valores como referência.",
      what: "Aviso fixo no topo da aba Mídia, mostrado sempre enquanto a conferência dos números com o Gerenciador de Anúncios da Meta não termina.",
    },
    {
      id: "contas-outra-moeda",
      title: "Contas em outra moeda",
      what: "Mostrado na aba Mídia quando alguma conta de anúncio marcada (ou filtrada) opera em moeda diferente de real, com o gasto de cada uma.",
      action:
        "Esse gasto fica fora do investido, do ROAS e do custo por 1º depósito, que ficam só em reais.",
    },
    {
      id: "conta-sem-gasto",
      title: "A conta conectada ainda não está entregando gasto",
      what: "Mostrado na aba Mídia quando alguma conta marcada nunca teve uma sincronização concluída com sucesso.",
      action:
        '"O token pode estar válido, mas sem leitura recente para uma conta de anúncio. Enquanto isso o gasto dessa conta não entra, e o ROI aparece melhor do que é." Aguarde a próxima sincronização automática ou clique em "Atualizar agora".',
    },
    {
      id: "cadastros-sem-anuncio",
      title: "N cadastros marcados sem anúncio correspondente nas contas conectadas",
      what: "Mostrado na aba Mídia quando existe depósito ou cadastro com UTM que não bateu com nenhum anúncio ou campanha das contas conectadas.",
      action: "Veja os detalhes na aba Diagnóstico.",
    },
    {
      id: "erro-midia",
      title: "Não foi possível carregar os dados de mídia deste período.",
      what: "Mostrado no lugar dos avisos, indicadores e abas quando a leitura do período falha; o texto entre parênteses, quando existe, é o motivo devolvido pelo servidor.",
      action: 'Clique em "Tentar novamente".',
    },
    {
      id: "sync-nao-admin",
      title: "Só o administrador da casa sincroniza a Meta.",
      what: 'Mostrado ao lado do botão "Atualizar agora" para quem não é administrador da casa (nem super admin) — o botão aparece desabilitado para esse perfil.',
      action: "Peça a um administrador da casa para sincronizar, se os dados estiverem desatualizados.",
    },
    {
      id: "diagnostico-com-filtro",
      title: "O diagnóstico de atribuição considera todo o tráfego. Limpe o filtro de BM / conta para ver.",
      what: 'Mostrado no lugar dos indicadores e da tabela da aba Diagnóstico quando o filtro de BM/conta está ativo: com filtro, só entra tráfego já atribuído a essas contas, e a saúde da atribuição daria 100% e 0 órfãos de forma artificial.',
      action: 'Escolha "Todas as contas" no filtro para ver o diagnóstico real.',
    },
    {
      id: "retencao-erro",
      title: "Não foi possível carregar retenção e aquisição.",
      what: "Mostrado na aba Retenção quando a leitura de qualquer uma das consultas (base, funil ou cohorts) falha.",
    },
    {
      id: "evolucao-sem-receita",
      title: "Sem receita atribuída",
      what: 'Mostrado no cartão "Onde o dinheiro está" (aba Mídia, Evolução) quando nenhum depósito do período chegou com uma marcação (UTM) ligada a um criativo.',
    },
    {
      id: "funil-sem-cadastro",
      title: "Nenhum cadastro hoje / ontem / nos últimos N dias.",
      what: 'Mostrado no lugar do "Funil dos cadastros" (aba Retenção) quando não houve nenhum cadastro no período escolhido.',
    },
    {
      id: "cohort-vazio",
      title: "Sem primeiros depósitos no período.",
      what: 'Mostrado na tabela "Retenção dos novos depositantes" (aba Retenção) quando nenhuma das últimas 12 semanas teve 1º depósito.',
    },
    {
      id: "evolucao-base-curta",
      title: "A evolução da base aparece em períodos de 7 dias ou mais.",
      what: 'Mostrado no lugar do gráfico "Evolução da base" (aba Retenção) quando o período escolhido tem só 1 dia de dados.',
    },
  ],

  tours: {
    midia: [
      {
        anchor: "midia.header.conectar-meta",
        title: "Conectar a Meta",
        body: "Sem nenhuma chave conectada ainda, este botão leva direto para Integrações, onde a conexão é feita.",
        articleSection: "midia-header",
      },
      {
        anchor: "midia.sync.atualizar",
        title: "Atualizar agora",
        body: "Pede uma releitura do gasto da Meta para o período aberto, sem esperar a sincronização automática. Só o administrador da casa pode clicar.",
        articleSection: "midia-header",
      },
      {
        anchor: "midia.periodo.presets",
        title: "Período",
        body: "Escolha o intervalo de datas: a tela inteira (indicadores, abas e avisos) muda junto.",
        articleSection: "midia-header",
      },
      {
        anchor: "midia.filtro.bm-conta",
        title: "Filtro BM / conta",
        body: "Olhe só uma BM ou uma conta de anúncio específica. Com o filtro ativo, só entra tráfego já atribuído a essas contas.",
        articleSection: "midia-header",
      },
      {
        anchor: "midia.kpis.roas",
        title: "ROAS líquido",
        body: "Depósitos menos saques dos jogadores vindos de anúncio, dividido pelo investido. Acima de 1x, o anúncio devolveu mais do que custou.",
        articleSection: "midia-kpis",
      },
      {
        anchor: "midia.subabas.tabs",
        title: "Abas internas",
        body: "Por criativo, por público, por campanha, a evolução diária e o diagnóstico de atribuição (que mostra os órfãos, sem anúncio correspondente).",
        articleSection: "midia-abas",
      },
    ],
    retencao: [
      {
        anchor: "midia.retencao.periodo",
        title: "Período da Retenção",
        body: "Escolha o intervalo usado pelo funil de cadastros e pela evolução da base. A base agora e os cohorts (retenção dos novos depositantes) não mudam com este período.",
        articleSection: "retencao-periodo",
      },
      {
        anchor: "midia.retencao.base-agora",
        title: "Onde a base está agora",
        body: "A base inteira da casa, pelo tempo desde o último depósito de cada jogador — não muda com o período escolhido acima.",
        articleSection: "retencao-base",
      },
      {
        anchor: "midia.retencao.evolucao-base",
        title: "Evolução da base",
        body: "Quantos jogadores estavam em cada situação (ativo, esfriando, dormindo, perdido) ao fim de cada dia do período.",
        articleSection: "retencao-base",
      },
      {
        anchor: "midia.retencao.funil",
        title: "Funil dos cadastros",
        body: "Quem se cadastrou no período e até onde chegou: 1º depósito, 2º depósito, 3 ou mais depósitos.",
        articleSection: "retencao-funil",
      },
      {
        anchor: "midia.retencao.origem",
        title: "Por origem do cadastro",
        body: "A origem informada no cadastro (utm_source) e quantos desses cadastros viraram depositantes.",
        articleSection: "retencao-funil",
      },
      {
        anchor: "midia.retencao.cohort",
        title: "Retenção dos novos depositantes",
        body: "Por semana do 1º depósito, quantos jogadores fizeram o 2º depósito em 7, 14 e 30 dias — a cor mais forte marca a maior retenção.",
        articleSection: "retencao-cohort",
      },
    ],
  },
};

export default screen;
