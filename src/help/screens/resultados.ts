// Help article for "Resultados do CRM" (/resultados), três abas: Visão
// geral, Origens e Prova e método. Fonte: src/routes/resultados.tsx,
// src/components/crm-results/central-results.tsx (cabeçalho, abas, CSV),
// health.tsx (pílula de saúde), overview.tsx (Visão geral), origins.tsx e
// retention.tsx (SpendByState, aba Origens), reactivations.tsx e holdout.tsx
// (aba Prova e método), e as regras de cálculo em src/lib/crm-results.ts,
// src/lib/crm-recommendations.ts e src/lib/crm-results-csv.ts.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "resultados",
  route: "/resultados",
  defaultTab: "visao",
  title: "Resultados do CRM",
  purpose:
    "Quanto cada jornada e campanha de SMS traz de volta jogadores parados e quanto isso custa: o valor recuperado, de onde ele vem, e a prova (com grupo de controle) de que o efeito é real, não coincidência.",
  roles: ["admin", "gestor", "member"],
  terms: [
    "recuperado-pelo-crm",
    "recuperados-visao-ampla",
    "teste-de-controle",
    "retorno-do-envio",
    "custo-por-jogador-convertido",
    "grupo-de-controle",
    "ultimos-7-dias",
    "custo-do-envio",
  ],
  sections: [
    // ---------------------------------------------------------------
    // Cabeçalho — aparece em todas as abas
    // ---------------------------------------------------------------
    {
      id: "cabecalho",
      title: "Cabeçalho (aparece em todas as abas)",
      intro:
        "Fica acima das abas e não muda quando você troca de aba: o período escolhido, a saúde dos dados, a explicação dos números, o atalho para comparar casas e o CSV.",
      items: [
        {
          anchor: "resultados.periodo.picker",
          label: "Período: Hoje / Ontem / 7 dias / 30 dias / 90 dias",
          what: "Escolhe a janela de tempo dos números da tela inteira (as três abas usam o mesmo período).",
          notes:
            '"Hoje" e "Ontem" comparam com o mesmo dia da semana anterior (uma terça com a terça passada); os demais períodos comparam com o período anterior de mesmo tamanho. Em períodos de 1 dia, o retorno ("Cada R$ 1 em SMS trouxe") é calculado sobre os últimos 7 dias, não só aquele dia — veja o item "Cada R$ 1 em SMS trouxe" na Visão geral.',
        },
        {
          anchor: "resultados.saude.indicador",
          label: 'Pílula "Atualizado há..." / "Divergência nos dados" / "Sem atualização"',
          what: "Abre a gaveta \"Saúde dos dados\", com quatro informações: a hora da última atualização da tabela de resultados (recalculada a cada 10 minutos); os SMS enviados na tela comparados com o registro bruto de SMS, com a diferença em %; a checagem diária de consistência mais recente (SMS enviados, custo e voltas pelo link comparados com a origem, do dia anterior, roda todo dia às 03h40) e, se houver, quantas das últimas 14 checagens deram divergência; e, se o período pedido for muito longo para carregar tudo, um aviso de que parte dos dados não entrou na conta.",
          notes:
            'O ponto é verde quando a última atualização tem até 30 minutos, a checagem mais recente não divergiu e os dados não foram truncados; senão fica amarelo ("Divergência nos dados") ou, sem nenhuma atualização registrada ainda, mostra "Sem atualização". Se o registro bruto de SMS não puder ser lido para comparar, a linha "SMS enviados conferidos com o registro de SMS" mostra "não disponível" em vez do número e da diferença. A gaveta explica no rodapé: "O registro inclui mensagens de hoje que entram na próxima atualização; diferenças pequenas nas últimas horas são esperadas. Custo considera o preço do SMS da sua conta. WhatsApp, e-mail e voz ainda não entram no custo."',
        },
        {
          anchor: "resultados.como-ler.abrir",
          label: '"Como ler"',
          what: 'Abre a gaveta "Como ler os números", com a definição de cada termo usado na tela: Recuperado pelo CRM, Já estavam jogando, Cliques no link, Cliques que viraram depósito, Custo por jogador que voltou, Cada R$ 1 em SMS trouxe, Comparação, Parcial, Reativações após SMS, Teste de controle e Custo.',
        },
        {
          anchor: "resultados.comparar.abrir",
          label: "Comparar casas",
          what: 'Vai para a tela "Comparar casas" (/resultados/comparar), com as mesmas métricas lado a lado de todas as casas onde você é administrador.',
          notes:
            "Só aparece para quem é administrador de duas ou mais casas (não importa o papel na casa atual: o que conta é ser administrador em pelo menos duas casas na plataforma). Com uma casa só, ou sem ser administrador em nenhuma, o botão não aparece.",
        },
        {
          anchor: "resultados.csv.baixar",
          label: "CSV",
          what: 'Baixa um CSV do período aberto, com uma linha "Todas as origens" (o total), uma linha por jornada/campanha e uma linha por etapa de cada jornada, nas mesmas colunas mostradas na tela (SMS enviados, custo, cliques, Recuperado pelo CRM, custo por jogador que voltou, retorno, Reativações após SMS e outras). O nome do arquivo é resultados-crm-<período>-<data início>-a-<data fim>.csv.',
          notes:
            'As colunas de valor em reais da casa (Recuperado pelo CRM, Reativações após SMS) levam a moeda da casa no nome da coluna; o custo é sempre em BRL. Fora do Brasil (casa em outra moeda), as colunas de retorno ("reais_por_real_em_sms", "retorno_reativacoes") saem vazias, porque não há câmbio entre a receita da casa e o custo em BRL.',
        },
        {
          anchor: "resultados.abas",
          label: "Abas Visão geral / Origens / Prova e método",
          what: '"Visão geral" traz o resultado principal, o gráfico e o que fazer agora; "Origens" lista cada jornada/campanha e para quem foi o dinheiro; "Prova e método" mostra Reativações após SMS e o teste de controle.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Visão geral
    // ---------------------------------------------------------------
    {
      id: "visao",
      title: "Visão geral",
      tab: "visao",
      intro:
        "O resultado principal do período — Recuperado pelo CRM — com o selo de prova, o gráfico diário, os destaques e as recomendações.",
      items: [
        {
          label: "Recuperado pelo CRM (cartão principal)",
          what: 'O valor em destaque: quanto os jogadores parados (2 dias ou mais sem depositar, ou que nunca depositaram) que clicaram no link do SMS depositaram em até 7 dias depois do clique, e quantos jogadores isso foi. Cada jogador conta uma vez, no dia do seu primeiro depósito depois do clique — quem deposita 3 vezes nesses 7 dias conta 1 jogador, mas soma os 3 depósitos no valor. Jogador que já estava jogando (depositou nos 2 dias antes do clique) não entra aqui: ele "iria depositar de qualquer forma".',
          notes:
            'Abaixo do valor, a variação contra o período de comparação (ver item "Período" no cabeçalho): com menos de 20 jogadores que voltaram ou menos de 1.000 SMS enviados em qualquer um dos dois períodos, mostra a diferença em reais em vez de porcentagem (a % seria ruído com volume baixo).',
        },
        {
          label: '"Cada R$ 1 em SMS trouxe"',
          what: "Recuperado pelo CRM ÷ custo em SMS do período, mostrado em reais (ex.: R$ 7,90 para cada R$ 1 gasto). Verde quando paga o envio (R$ 1 ou mais), vermelho quando não paga.",
          notes:
            'Com menos de 5 jogadores que voltaram pelo link, mostra "amostra pequena" em cinza e não entra em comparação com o período anterior. Em "Hoje" e "Ontem" (1 dia), o retorno é calculado sobre os últimos 7 dias em vez do dia único, com o aviso "conta dos últimos 7 dias (<período>)": no dia isolado, o custo do SMS enviado hoje e o depósito de quem clicou há dias ainda misturado não combinam.',
        },
        {
          label: 'Faixa "Parcial"',
          what: 'Aparece quando o período termina nos últimos 7 dias corridos (inclui "Hoje", "Ontem", "7 dias" e o fim de "30/90 dias" quando cai nos últimos dias). Avisa que os números ainda podem subir: quem clicou tem até 7 dias para depositar.',
        },
        {
          label: "Aviso de queda de envio",
          what: 'Aparece quando o período enviou menos da metade dos SMS do período de comparação: "Foram enviados X% menos SMS que em <período anterior>. Custo e retorno mudam por isso." Evita que uma queda de envio pareça uma queda de desempenho.',
        },
        {
          label: "SMS e cliques do período",
          what: 'A linha "SMS enviados (custo) → cliques no link (taxa sobre os SMS) → desses cliques já viraram depósito (taxa sobre os cliques)". A taxa de conversão de cliques pode aumentar depois: quem clicou tem 7 dias para depositar, e esse aviso aparece junto quando o período é parcial.',
        },
        {
          label: "Barra Recuperado pelo CRM × Já estavam jogando",
          what: "Só aparece quando houve algum depósito de quem já estava jogando depois de clicar. Mostra, lado a lado, quanto do total depositado após o clique é Recuperado pelo CRM (jogadores parados, em verde) contra quanto é de quem já estava jogando e não conta como recuperação (em cinza).",
        },
        {
          anchor: "resultados.visao.ver-prova",
          label: "Selo de prova + \"Ver prova e método\"",
          what: 'Uma frase com o ícone de escudo dizendo se o grupo de controle já comprovou o efeito do CRM: "Efeito comprovado pelo grupo de controle em N jornada(s)[: X jogadores a mais do que sem SMS]" (verde), "Grupo de controle: N jornada(s) com resultado pior que não enviar" (vermelho), "Grupo de controle em andamento: ainda sem diferença comprovada" ou "Sem prova de efeito ainda: ative o grupo de controle nas jornadas" (cinza, sem nenhum teste rodando). O botão "Ver prova e método" leva para a aba Prova e método.',
        },
        {
          label: "Gráfico \"Custo × recuperado pelo CRM por dia\"",
          what: "Barras do custo em SMS e linha do Recuperado pelo CRM por dia do depósito, um ponto por dia do período.",
          notes:
            'Só aparece a partir de 7 dias de período; com 1 dia ("Hoje"/"Ontem") o lugar do gráfico mostra "O gráfico diário aparece a partir de 7 dias. Para um único dia, veja o resultado de cada origem na aba "Origens"." Fora do Brasil (casa em outra moeda), o Recuperado pelo CRM ganha um eixo à direita na moeda da casa, separado do eixo do custo (sempre em BRL).',
        },
        {
          label: "Destaques do período",
          what: 'Até três avisos automáticos: a origem que trouxe jogadores de volta mais barato (com 5 ou mais jogadores que voltaram, para não comparar amostra pequena); quantas origens gastaram R$ 50 ou mais sem trazer ninguém de volta (nem pelo link, nem pela Reativação após SMS), e quanto gastaram; e, quando 20% ou mais do custo foi para jogadores que já estavam jogando, quanto isso representa. Clicar no nome de uma origem abre a aba Origens já filtrada por ela.',
          notes:
            'Sem nenhuma origem com 5 ou mais jogadores que voltaram pelo link, o primeiro destaque mostra "Ainda não há origem com 5 ou mais jogadores que voltaram pelo link para comparar eficiência." em vez do melhor desempenho. O aviso de origens que gastaram sem retorno muda de texto conforme a quantidade: com uma só, "<nome da origem> gastou <valor> sem trazer nenhum jogador de volta."; com duas ou mais, "<N> origens gastaram <valor> sem trazer nenhum jogador de volta."',
        },
        {
          anchor: "resultados.visao.recomendacoes.ver-todas",
          label: '"O que fazer agora" + "Ver todas (N)" / "Ver menos"',
          what: 'Lista de recomendações automáticas, cada uma com um rótulo de gravidade ("Ação", "Atenção" ou "Oportunidade") e o número que a gerou — por exemplo, uma origem que gastou sem ninguém voltar, uma etapa de jornada cara, uma origem muito mais barata ou mais cara que a mediana, uma taxa de clique muito baixa, ou um resultado do teste de controle. Mostra as 3 primeiras por padrão; o botão abre o resto quando há mais de 3.',
          notes:
            "O cartão inteiro só aparece quando existe pelo menos uma recomendação; sem nenhuma, nada é mostrado nesse lugar.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Origens
    // ---------------------------------------------------------------
    {
      id: "origens",
      title: "Origens",
      tab: "origens",
      intro:
        "Cada jornada e campanha do período, lado a lado, e para quem foi o dinheiro pela situação do jogador no envio.",
      items: [
        {
          anchor: "resultados.origens.tipo",
          label: "Filtro Todas / Jornadas / Campanhas",
          what: "Restringe a tabela por tipo de origem.",
        },
        {
          anchor: "resultados.origens.busca",
          label: "Buscar origem...",
          what: "Filtra a tabela pelo nome da jornada ou campanha, sem diferenciar maiúsculas/minúsculas ou acento.",
        },
        {
          anchor: "resultados.origens.ordenar",
          label: "Ordenar colunas",
          what: 'Clicar no título de uma coluna ordena a tabela por ela (de novo no mesmo título inverte a ordem). Em empate, a ordem cai para custo e depois para o nome. Por padrão, a tabela abre ordenada por "Recuperado pelo CRM", do maior para o menor.',
        },
        {
          anchor: "resultados.origens.expandir",
          label: "Expandir (seta ›) uma jornada",
          what: "Abre, embaixo da linha da jornada, uma linha por etapa de envio (\"1ª mensagem · na entrada\", \"2ª mensagem · +2 dias\"...), com as mesmas colunas. Só aparece em jornadas com mais de uma etapa de envio; campanhas e jornadas de etapa única não expandem.",
          notes:
            'Uma etapa que o CRM não conseguiu ligar a nenhuma mensagem configurada na jornada (por exemplo, uma etapa removida do fluxo depois do envio) aparece como "Sem etapa identificada" em vez do nome da mensagem.',
        },
        {
          label: "Colunas da tabela",
          what: 'SMS enviados; Custo em SMS; Cliques no link (e a taxa sobre os SMS enviados); Recuperado pelo CRM (jogadores que voltaram pelo link e o valor, com uma barra comparando com a origem que mais recuperou); Custo por jogador que voltou; R$ por R$ 1 em SMS (mesma regra de cor e "amostra pequena" da Visão geral); e Reativações após SMS (jogadores e valor, sempre igual ou maior que o Recuperado pelo CRM da mesma linha, porque já o inclui).',
          notes:
            'Uma origem sem nenhum jogador que voltou mostra "nenhum" na coluna Recuperado pelo CRM. Uma origem que gastou R$ 50 ou mais sem trazer ninguém de volta (nem pelo link, nem pela Reativação após SMS) ganha o selo "gasta sem trazer ninguém" ao lado do nome.',
        },
        {
          label: "Sem envio no período",
          what: '"Nenhuma jornada ou campanha com envio neste período." quando a aba inteira está vazia; "Nenhuma origem com esse filtro." quando o filtro de tipo ou a busca não encontra nada.',
        },
        {
          label: '"Para quem vai o dinheiro"',
          what: "Custo em SMS e Recuperado pelo CRM agrupados pela situação do jogador no momento em que recebeu a mensagem (Sem 1º depósito, Esfriando, Dormindo, Perdido — que contam como reativação — e Ativo, que é relacionamento, não reativação, e fica marcado assim na tabela). Cada linha mostra a parte do custo total, quantos jogadores receberam, quantos voltaram pelo link, o custo por jogador que voltou, o retorno e a Reativação após SMS (vazia na linha Ativo, porque reativação não se aplica a quem já estava jogando).",
          notes: "Esta tabela só aparece quando existe pelo menos uma situação com envio ou com recuperação no período.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Prova e método
    // ---------------------------------------------------------------
    {
      id: "controle",
      title: "Prova e método",
      tab: "controle",
      intro:
        "A visão ampla de quem voltou depois de um SMS (com ou sem clique) e o teste de controle, que mostra o efeito real da jornada.",
      items: [
        {
          anchor: "resultados.controle.reativacoes",
          label: "Reativações após SMS",
          what: "Jogadores que estavam parados (2 dias ou mais sem depositar, ou nunca depositaram), receberam um SMS e voltaram a depositar em até 3 dias — clicando ou não no link. O valor é tudo o que depositaram nesses 3 dias, e o terceiro número é o custo em SMS dividido pelo total de jogadores que voltaram (clicando ou não).",
          notes:
            "Este número já inclui o Recuperado pelo CRM (quem clicou no link): por isso é sempre igual ou maior, e os dois nunca devem ser somados. Voltar depois do SMS não prova que foi por causa dele — essa prova vem só do teste de controle, abaixo.",
        },
        {
          anchor: "resultados.controle.explicacao",
          label: "Como funciona o teste de controle",
          what: "Os três passos: (1) Sorteio — ao entrar na jornada, cada jogador cai no grupo que recebe mensagens ou no grupo de controle, que não recebe nada daquela jornada; (2) 7 dias — os dois grupos são acompanhados por 7 dias depois da entrada; (3) Resultado — a diferença na volta entre os dois grupos é o que a jornada realmente causou, sem contar quem voltaria de qualquer jeito.",
          notes:
            'Jogadores do grupo de controle ficam fora das campanhas em massa da jornada, mas continuam podendo receber envios individuais de outras jornadas ou campanhas. Sem nenhuma jornada com grupo de controle ativo, aparece "Nenhuma jornada com grupo de controle", com um atalho para ativar.',
        },
        {
          label: "Tabela de resultados",
          what: 'Uma linha por jornada com resultado fechado: "Receberam: voltaram" e "Controle: voltaram" (a % que depositou de novo em 7 dias em cada grupo, com o tamanho de cada grupo embaixo); "Diferença" (a diferença entre as duas taxas, com o intervalo de confiança de 95% embaixo); "Jogadores a mais" e "Valor a mais" (o quanto a mais a jornada trouxe, estimado a partir da diferença); e "Leitura".',
          notes:
            'A coluna "Leitura" mostra um selo: "amostra insuficiente" (menos de 100 jogadores em algum grupo, ou menos de 10 retornos somando os dois), "traz jogadores de volta" (diferença positiva e fora do intervalo de 95%, ou seja, estatisticamente significativa), "pior que não enviar" (diferença negativa e significativa) ou "sem diferença comprovada" (amostra suficiente, mas sem significância).',
        },
        {
          label: "Testes em andamento",
          what: "Jornadas com grupo de controle ativo cujo resultado ainda não fechou: nenhum jogador completou os 7 dias de acompanhamento. Cada cartão mostra quantos jogadores recebem mensagens e quantos estão no controle, o percentual sorteado para o controle, uma barra com o progresso até os 100 jogadores mínimos no controle, e a data prevista do primeiro resultado (ou \"aguardando a primeira entrada\").",
          notes:
            "Uma jornada desligada depois de ativar o grupo de controle mostra \"jornada desligada\" na mesma linha, mas continua acompanhando quem já entrou até completar os 7 dias.",
        },
        {
          anchor: "resultados.controle.ir-jornadas",
          label: "Ir para Jornadas",
          what: 'Aparece só quando nenhuma jornada tem grupo de controle ativo e nenhum teste está em andamento ("Nenhuma jornada com grupo de controle"). Leva para a tela de Jornadas para ativar o grupo de controle em uma delas (editar → Grupo de controle).',
        },
      ],
    },
  ],

  states: [
    {
      id: "carregando",
      title: "Carregando resultados",
      what: 'Esqueleto no formato do cartão principal (aria-label "Carregando resultados"), para a tela não "pular" quando os dados chegam.',
    },
    {
      id: "erro-carregar",
      title: "Não foi possível carregar os resultados. Tente novamente em instantes.",
      what: "Mostrado no lugar das abas quando a busca dos resultados falha ou não retorna dados.",
      action: "Recarregue a página; se continuar, procure o suporte.",
    },
    {
      id: "sem-envios",
      title: "Nenhum envio de jornada ou campanha neste período.",
      what: 'Mostrado na Visão geral quando o período não teve nenhum SMS enviado nem nenhum jogador recuperado ou influenciado. O texto completo acrescenta: "Os resultados aparecem até 10 minutos depois dos primeiros envios. Retenção e cadastros ficam em Aquisição e LTV, aba "Retenção"."',
      action: "Espere os primeiros envios do período ou escolha um período com envio.",
    },
    {
      id: "queda-de-envio",
      title: "Foram enviados X% menos SMS que em <período anterior>. Custo e retorno mudam por isso.",
      what: "Aviso na Visão geral quando o período enviou menos da metade dos SMS do período de comparação.",
    },
    {
      id: "saude-sem-atualizacao",
      title: "Sem atualização",
      what: "A pílula de saúde mostra isso quando ainda não existe nenhum registro de atualização da tabela de resultados para a casa.",
    },
    {
      id: "saude-divergencia",
      title: "Divergência nos dados",
      what: "A pílula de saúde fica amarela com este texto quando a checagem diária de consistência mais recente encontrou alguma divergência (SMS, custo ou voltas pelo link diferentes do registro de origem).",
      action: 'Abra a gaveta de saúde para ver qual checagem divergiu e em qual dia; normalmente se resolve sozinho na atualização seguinte.',
    },
    {
      id: "saude-checagem-pendente",
      title: "ainda não rodou (roda todo dia às 03h40 para o dia anterior)",
      what: 'Mostrado na gaveta de saúde, no lugar da checagem diária, enquanto a checagem de consistência nunca rodou para esta casa.',
    },
    {
      id: "origens-vazio",
      title: "Nenhuma jornada ou campanha com envio neste período.",
      what: "A aba Origens inteira fica assim quando não há nenhuma origem com envio no período escolhido.",
    },
    {
      id: "origens-filtro-vazio",
      title: "Nenhuma origem com esse filtro.",
      what: "Mostrado na tabela de Origens quando o filtro de tipo e/ou a busca não encontram nenhuma origem.",
      action: 'Troque o filtro de tipo para "Todas" ou limpe a busca.',
    },
    {
      id: "controle-sem-grupo",
      title: "Nenhuma jornada com grupo de controle",
      what: 'Mostrado na aba Prova e método quando nenhuma jornada tem grupo de controle ativo e não há nenhum teste em andamento. O texto completo: "Ative em Jornadas → editar → Grupo de controle. Os primeiros resultados aparecem 7 dias depois das primeiras entradas."',
      action: 'Clique em "Ir para Jornadas" e ative o grupo de controle em uma jornada.',
    },
    {
      id: "controle-testes-andamento",
      title: "Testes em andamento",
      what: "Jornadas com grupo de controle ativo, mas cujo resultado ainda não fechou (nenhum jogador completou os 7 dias de acompanhamento).",
      action: "Aguarde a janela de 7 dias fechar para o primeiro grupo de jogadores.",
    },
  ],

  tours: {
    visao: [
      {
        anchor: "resultados.periodo.picker",
        title: "Escolha o período",
        body: "Hoje, Ontem, 7, 30 ou 90 dias. As três abas usam o mesmo período.",
        articleSection: "cabecalho",
      },
      {
        anchor: "resultados.abas",
        title: "Visão geral, Origens e Prova e método",
        body: "Visão geral traz o resultado principal; Origens lista cada jornada e campanha; Prova e método mostra o teste de controle.",
        articleSection: "cabecalho",
      },
      {
        anchor: "resultados.saude.indicador",
        title: "Saúde dos dados",
        body: "Mostra quando os números foram atualizados e se a checagem diária encontrou alguma divergência.",
        articleSection: "cabecalho",
      },
      {
        anchor: "resultados.como-ler.abrir",
        title: "Como ler",
        body: "Explica cada termo usado na tela, do Recuperado pelo CRM ao Teste de controle.",
        articleSection: "cabecalho",
      },
      {
        anchor: "resultados.comparar.abrir",
        title: "Comparar casas",
        body: "Se você administra duas ou mais casas, compare as mesmas métricas lado a lado.",
        articleSection: "cabecalho",
      },
      {
        anchor: "resultados.csv.baixar",
        title: "Baixar CSV",
        body: "Exporta o total e cada jornada/campanha do período, com as mesmas colunas da tela.",
        articleSection: "cabecalho",
      },
      {
        anchor: "resultados.visao.ver-prova",
        title: "Selo de prova",
        body: "Diz se o grupo de controle já comprovou o efeito do CRM. Clique para ver o teste completo.",
        articleSection: "visao",
      },
      {
        anchor: "resultados.visao.recomendacoes.ver-todas",
        title: "O que fazer agora",
        body: "Recomendações automáticas, da mais urgente à mais leve. Veja todas quando houver mais de 3.",
        articleSection: "visao",
      },
    ],
    origens: [
      {
        anchor: "resultados.origens.tipo",
        title: "Filtrar por tipo",
        body: "Todas, só Jornadas ou só Campanhas.",
        articleSection: "origens",
      },
      {
        anchor: "resultados.origens.busca",
        title: "Buscar origem",
        body: "Filtra a tabela pelo nome da jornada ou campanha.",
        articleSection: "origens",
      },
      {
        anchor: "resultados.origens.ordenar",
        title: "Ordenar a tabela",
        body: "Clique no título de uma coluna para ordenar por ela; de novo para inverter.",
        articleSection: "origens",
      },
      {
        anchor: "resultados.origens.expandir",
        title: "Ver cada mensagem",
        body: "Em jornadas com mais de uma etapa, expanda para ver o resultado de cada mensagem.",
        articleSection: "origens",
      },
    ],
    controle: [
      {
        anchor: "resultados.controle.reativacoes",
        title: "Reativações após SMS",
        body: "A visão ampla: quem voltou depois de um SMS, clicando ou não no link. Já inclui o Recuperado pelo CRM.",
        articleSection: "controle",
      },
      {
        anchor: "resultados.controle.explicacao",
        title: "Como funciona o teste",
        body: "Uma parte sorteada não recebe mensagens. Comparar os dois grupos em 7 dias mostra o efeito real.",
        articleSection: "controle",
      },
      {
        anchor: "resultados.controle.ir-jornadas",
        title: "Ativar o grupo de controle",
        body: "Sem nenhum teste rodando ainda? Ative o grupo de controle em uma jornada para começar a medir.",
        articleSection: "controle",
      },
    ],
  },
};

export default screen;
