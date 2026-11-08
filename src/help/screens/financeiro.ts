// Help article for "Financeiro" (/financeiro), quatro abas: Painel,
// Lançamentos, Outros custos e Configurações. Fonte: src/routes/financeiro.tsx
// e os componentes em src/components/finance/ (dashboard/*, finance-month-grid,
// day-list, day-modal, finance-other-costs, finance-settings-panel,
// finance-monthly-ggr), mais as mensagens de erro de src/lib/finance.functions.ts
// e src/lib/finance-dashboard.functions.ts. As âncoras do Painel usam o
// prefixo neutro "financeiro." porque o mesmo painel (finance-dashboard.tsx)
// é reaproveitado por /grupo (fase 4) — ver docs/superpowers/sdd
// /2026-11-08-tutorial-crm-fase3/constraints.md. O seletor "Ver:" (super
// admin) e as visões "Lucro por casa"/placar de metas (escopo de grupo ou de
// todas as casas) ficam fora: esta tela só é vista por quem administra ou
// tem acesso liberado a UMA casa.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "financeiro",
  route: "/financeiro",
  defaultTab: "painel",
  title: "Financeiro",
  purpose:
    "O resultado da casa: o que entrou, o que saiu e quanto sobrou — o painel com o resumo do período, os lançamentos diários de Anúncios e GGR, os outros custos e as taxas cobradas sobre o GGR e a movimentação.",
  roles: ["admin", "gestor"],
  terms: [
    "lucro-liquido",
    "net",
    "ggr",
    "taxa-de-ggr",
    "taxa-de-movimentacao",
    "envios",
    "mensalidade",
    "outros-custos",
    "roi",
    "margem",
    "ctr",
  ],
  sections: [
    // ---------------------------------------------------------------
    // Aba Painel
    // ---------------------------------------------------------------
    {
      id: "painel",
      title: "Painel",
      tab: "painel",
      intro:
        "O resumo visual do período escolhido: a faixa de resultado, a cascata do depósito ao lucro, os blocos de KPIs e o gráfico de 12 meses. Todo valor em dinheiro vem na moeda da casa; envios e mensalidade são sempre em reais (BRL).",
      items: [
        {
          anchor: "financeiro.painel.periodo",
          label: "Período",
          what: 'Mostra o atalho escolhido e as datas. Clicar abre um menu com os atalhos agrupados em Dias (Hoje, Ontem, Últimos 7/15/30 dias), Semanas (Esta semana, Semana passada) e Meses (Este mês, Mês passado, Últimos 3 meses, Este ano), mais um calendário: clique na data inicial e depois na final, e "Aplicar" confirma.',
          notes:
            'O período máximo é 366 dias — acima disso "Aplicar" fica desabilitado e aparece "máximo 366 dias". No celular (menos de 640px de largura) o menu abre como uma folha na parte de baixo da tela, com os mesmos atalhos e "Escolher datas…" no lugar do calendário; o calendário mostra 2 meses lado a lado a partir de 768px de largura, e 1 mês abaixo disso.',
        },
        {
          anchor: "financeiro.painel.periodo-atalhos",
          label: "Atalhos rápidos",
          what: 'Um clique nos botões "Hoje", "Ontem", "7 dias", "30 dias", "Este mês" e "Mês passado", abaixo dos campos de Período e Comparar com — o atalho ativo fica destacado.',
        },
        {
          anchor: "financeiro.painel.comparar",
          label: "Comparar com",
          what: "Escolhe a janela usada para calcular as variações mostradas nos números. As opções mudam com o tipo do período: um único dia oferece Dia anterior, Mesmo dia da semana passada, Mesmo dia do ano passado e Sem comparação; um mês oferece Mês anterior, Mesmo mês do ano passado e Sem comparação; qualquer outro intervalo oferece Período anterior, Mesmo período do ano passado e Sem comparação.",
          notes:
            'Escolhendo "Sem comparação", nenhum número mostra variação e a nota embaixo de cada um passa a dizer "Sem comparação" em vez de calcular contra um período anterior.',
        },
        {
          anchor: "financeiro.painel.pendencias",
          label: "Banner de pendências",
          what: 'Faixa em amarelo que aparece quando há dias passados sem Anúncios ou GGR lançados (hoje nunca entra nessa contagem). O texto é "N dia(s) de <mês> sem anúncios ou GGR lançados." — ou, quando a casa usa o total do GGR do mês e ele está desatualizado, "GGR atualizado até DD/MM — atualize para fechar o lucro."',
          notes:
            'Sob o primeiro texto aparece "Enquanto não forem lançados, contam como zero e o lucro abaixo fica incompleto." (some quando é o caso do GGR do mês). Uma segunda linha, independente, pode aparecer com "Pode haver custo Betleads contado duas vezes. Revise em Outros custos." — quando algum outro custo lançado parece ser uma cobrança automática da Betleads já contada à parte.',
        },
        {
          anchor: "financeiro.painel.lancar-agora",
          label: '"Lançar agora"',
          what: "Abre a aba Lançamentos já no primeiro dia pendente, pronto para digitar Anúncios e GGR.",
        },
        {
          anchor: "financeiro.painel.resultado-lucro",
          label: "Lucro líquido",
          what: 'O cartão principal da faixa de resultado — maior e com fundo verde ou vermelho conforme o sinal. Tem o "Como calculamos" (ícone de informação ao lado do nome) explicando a conta. Abaixo do valor, a variação contra o período de comparação, ou "Sem período anterior para comparar"/"Sem comparação" quando não há o que comparar.',
          notes:
            'Fora do BRL (receita da casa numa moeda, custos da Betleads em BRL) não existe Lucro líquido: o cartão mostra "—" com a nota "Receita em <moeda> e custos em BRL: sem conversão de câmbio".',
        },
        {
          anchor: "financeiro.painel.resultado-margem",
          label: "Margem",
          what: 'Lucro líquido ÷ Net, com "Como calculamos". Abaixo, "lucro ÷ net", ou "sem lucro líquido" quando a casa está fora do BRL.',
        },
        {
          anchor: "financeiro.painel.resultado-roi",
          label: "Retorno (ROI)",
          what: 'Lucro líquido ÷ Anúncios, com "Como calculamos". Abaixo, o ROI do mês calendário anterior como referência fixa ("mês anterior: X%"), ou "Sem anúncios no período" quando não houve investimento em anúncios na janela.',
        },
        {
          anchor: "financeiro.painel.resultado-anuncios",
          label: "Anúncios",
          what: "O total investido em anúncios no período (vem da conta de anúncios ligada à casa). Abaixo, a variação, ou \"Nenhum dia lançado\" quando a casa ainda não lançou nenhum dia no período.",
        },
        {
          anchor: "financeiro.painel.cascata",
          label: '"Do depósito ao lucro"',
          what: "O gráfico em colunas que mostra, em ordem, Depósitos → Saques → Net (subtotal) → Taxa de GGR → Taxa de movimentação → Anúncios → Envios → Mensalidade → Outros custos → Lucro líquido (total). Entradas em azul-acinzentado, saídas e custos em vermelho, o subtotal (Net) em cinza e o total em verde ou vermelho conforme o sinal; o valor de cada coluna aparece acima dela (ou abaixo, quando a coluna fica sob a linha zero). A legenda e a nota \"Passos sem valor no período não aparecem.\" ficam abaixo do gráfico.",
          notes:
            'Fora de um mês fechado, aparece "Resultado sem a mensalidade do mês (entra no fechamento do mês)." — a mensalidade só entra quando o período é exatamente um mês já terminado. Quando algum envio do período não tem custo de provedor cadastrado, a coluna muda o nome para "Envios (parcial)" e aparece mesmo que o valor calculado seja R$ 0. Fora do BRL, a cascata para antes dos Envios, com a nota de câmbio seguida de "Envios e mensalidade (BRL) ficam fora do gráfico." Sem nenhum valor no período, aparece só "Sem dados no período."',
        },
        {
          anchor: "financeiro.painel.kpi-movimentacao",
          label: "Movimentação",
          what: 'Bloco com Depósitos e Saques (cada um com a contagem de operações abaixo) e Net — destacado, com "Como calculamos". Em "Comportamento": Ticket médio, Saque médio, Depositantes por dia, "Saques ÷ depósitos" e "Pix gerado → pago".',
        },
        {
          anchor: "financeiro.painel.kpi-aquisicao",
          label: "Aquisição",
          what: 'Bloco com Anúncios, Cadastros, FTDs ("primeiros depósitos"), "Cadastro → FTD" e FTD médio; quando a casa tem dados de anúncios com impressões no período, aparecem também CPM, CTR e Custo por clique. Em "Custo por jogador": Custo por cadastro e Custo por FTD, que mostram "sem anúncios" no lugar do valor quando não houve investimento no período.',
        },
        {
          anchor: "financeiro.painel.kpi-ggr",
          label: "GGR",
          what: 'Bloco com GGR (Perdas na casa, com "Como calculamos"), Taxa de GGR e "GGR ÷ depósitos". Quando o GGR do período ainda não foi lançado, os dois primeiros mostram "não lançado" no lugar do valor.',
          notes:
            'Quando o período usa o total do GGR do mês (GGR do mês, em Lançamentos) em vez do lançamento diário, aparece a nota "GGR estimado a partir do total do mês." no rodapé do bloco.',
        },
        {
          anchor: "financeiro.painel.kpi-envios",
          label: "Envios e CRM",
          what: 'Uma linha por canal usado (SMS, Voz, E-mail) com a quantidade, o custo, o custo unitário e a variação; "Total de envios" (destacado, com "Como calculamos"); em "Retorno do CRM", Receita direta ("clique → depósito") e Receita influenciada ("regra da Central de Resultados"), cada uma com o retorno em múltiplo (ex.: "retorno 2,3×"). Sem nenhum envio no período, aparece só "Sem envios no período."',
          notes:
            'Um canal sem custo de provedor cadastrado mostra "custo do provedor não cadastrado" no lugar de R$ 0 (ou somado ao valor parcial, com "+ custo do provedor não cadastrado"); o total e os retornos ficam marcados "parcial" nesse caso. Numa casa isenta, cada canal mostra a etiqueta "custo do provedor" e o rodapé traz "Casa isenta: custo do provedor (situação atual da casa)". Sem dado de uso antes de uma data, o rodapé mostra "Sem dado de custo Betleads antes de <mês/ano>" (ou "Sem dado de custo Betleads", sem data, quando não há nenhum dado ainda).',
        },
        {
          anchor: "financeiro.painel.grafico-12-meses",
          label: '"Últimos 12 meses"',
          what: "Um gráfico de barras, uma por mês, com um seletor de métrica acima (Lucro líquido | Net | Depósitos — sem Lucro líquido fora do BRL). Um mês negativo aparece em vermelho; um mês sem nenhum dado aparece como um traço fino na linha zero em vez de uma barra; o mês em andamento (ainda não terminou) fica em negrito e mais claro, assim como um mês incompleto. Passar o mouse (ou tocar) numa barra mostra o mês, Lucro líquido, Net, Depósitos, Anúncios e ROI.",
          notes:
            'Com menos de 3 meses com algum dado, aparece "Os dados financeiros desta casa começam em <mês> de <ano>." Sem nenhum mês com dado, o gráfico mostra só "Sem dados para o gráfico." Quando algum mês não tem dado de custo Betleads, aparece a mesma nota "Sem dado de custo Betleads..." do bloco Envios e CRM.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Lançamentos
    // ---------------------------------------------------------------
    {
      id: "lancamentos",
      title: "Lançamentos",
      tab: "lancamentos",
      intro:
        "O fechamento financeiro da casa, dia a dia: Anúncios e GGR são digitados aqui (ou lançados de uma vez com a Meta ou o GGR do mês), e cada dia mostra o seu próprio resultado num modal. Só o administrador digita; o gestor liberado só acompanha.",
      items: [
        {
          anchor: "financeiro.lancamentos.mes",
          label: "Mês",
          what: 'Escolhe o mês mostrado na lista de dias. Ao lado, quando existe algum dia sem lançamento, aparece "1 dia pendente" ou "N dias pendentes".',
        },
        {
          anchor: "financeiro.lancamentos.usar-meta",
          label: '"Usar gasto da Meta nos dias vazios"',
          what: "Lança de uma vez, em todos os dias vazios (sem Anúncios, antes de hoje) que têm uma sugestão de gasto trazida da conta de anúncios, o valor sugerido para cada um. Só aparece quando existe pelo menos um dia assim.",
          roles: ["admin"],
          notes:
            'Toast de sucesso: "Gasto da Meta lançado em 1 dia" ou "Gasto da Meta lançado em N dias".',
        },
        {
          anchor: "financeiro.lancamentos.ggr-mes",
          label: "GGR do mês (Perdas na casa acumulado)",
          what: 'Um total único de GGR para o mês inteiro, em vez de lançar dia a dia — o CRM espalha esse total pelos dias sozinho. Tem o campo do valor, o campo "atualizado até" (a data até onde esse total vale) e o botão "Salvar GGR do mês". Abaixo, o status: "Total do mês R$ X, atualizado até DD/MM." ou "Sem total do mês: o GGR vem dos dias."',
          roles: ["admin"],
          notes:
            'Toast de sucesso: "GGR do mês salvo". Deixar o campo de valor vazio e salvar remove o total do mês e volta a usar o GGR lançado dia a dia. Erros possíveis: "Valor inválido" (texto que não forma um número), "Informe a data de atualização", "A data deve estar dentro do mês" e "Data futura não permitida". Enquanto existe um total do mês, a coluna de GGR de cada dia (no modal do dia) fica travada e marcada "usando o total do mês".',
        },
        {
          anchor: "financeiro.lancamentos.dias",
          label: "Lista de dias",
          what: "Um dia por linha, com o selo de status, Net, Envios e Lucro líquido; clicar numa linha abre o modal daquele dia.",
          notes: "Sem nenhum dia no mês, aparece só \"Nenhum dia neste mês ainda.\"",
        },
        {
          anchor: "financeiro.lancamentos.dia-linha",
          label: "Linha do dia",
          what: 'A data ("28/10 · ter"), o selo de status ("completo", "estimado", "falta anúncios", "falta GGR", "falta anúncios e GGR", "falta GGR do mês" ou "falta anúncios e GGR do mês"), Net, Envios (ou "custo do provedor não cadastrado" quando falta preço de algum canal) e Lucro líquido (em vermelho quando negativo; "—" fora do BRL). Repete-se por dia; a âncora marca só a primeira linha.',
          notes:
            '"estimado" é o GGR vindo do total do mês ainda sem Anúncios lançado para aquele dia específico; "falta GGR do mês" significa que falta o total do mês (não o lançamento diário).',
        },
        {
          label: 'Modal do dia — "Veio do CRM"',
          what: 'Os números automáticos do dia: Cadastros, FTDs, "Valor de FTD", Depósitos (com a contagem de depósitos), Saques (com a contagem de saques) e Net (com "Como calculamos"); quando a conta de anúncios sugeriu um gasto para o dia, aparece também "Gasto da Meta". Abaixo, "Envios" lista cada canal usado no dia com a quantidade e o custo, ou "Nenhum envio neste dia."',
        },
        {
          label: 'Modal do dia — "Você lança"',
          what: 'O campo Anúncios (com o botão "Usar valor da Meta (R$ X)" quando há sugestão) e o campo de GGR (com "Como calculamos"), travado e mostrando "usando o total do mês" quando a casa usa o GGR do mês. Abaixo, "Outros custos deste dia" lista os custos já lançados nesse dia (ou "Nenhum custo neste dia.") com o link "Editar em Outros custos" (abre a aba Outros custos, no mesmo mês) e, para quem edita, um formulário para adicionar um custo direto por aqui: Descrição, Categoria, Valor e "Repetir todo mês", com o botão "Adicionar".',
          roles: ["admin"],
          notes:
            'Para quem só lê (gestor liberado, ou a casa demo), os dois campos mostram "pendente" em itálico no lugar de um campo vazio, e não há formulário de novo custo.',
        },
        {
          label: 'Modal do dia — "Resultado do dia"',
          what: "A mesma cascata do Painel, em miniatura, já prevendo o que foi digitado e ainda não salvo nos campos Anúncios e GGR acima.",
        },
        {
          label: 'Modal do dia — "Dia anterior" / "Próximo dia"',
          what: "Troca para o dia vizinho salvando primeiro o que foi digitado (se houver algo), sem precisar fechar o modal. Ficam desabilitados no primeiro e no último dia disponíveis do mês (nunca depois de hoje).",
        },
        {
          label: 'Modal do dia — "Salvar"',
          what: 'Grava o Anúncios e/ou o GGR do dia aberto. Toast de sucesso: "Dia salvo". Fica desabilitado quando nada foi alterado.',
          roles: ["admin"],
        },
        {
          label: 'Confirmação "Descartar alterações?"',
          what: 'Aparece ao fechar o modal do dia (ou trocar o mês) com algo digitado e ainda não salvo. Texto: "O que você digitou neste dia ainda não foi salvo e será perdido.", com os botões "Cancelar" e "Descartar".',
          roles: ["admin"],
          notes:
            "Enquanto um salvamento está em andamento, fechar o modal ou trocar de dia espera ele terminar em vez de perguntar.",
        },
        {
          label: "Nota da mensalidade",
          what: '"A mensalidade entra só no total do mês fechado, não nos dias." — texto fixo abaixo da lista de dias.',
        },
        {
          anchor: "financeiro.lancamentos.resumo",
          label: "Resumo do mês",
          what: "Lado a lado: Taxa de movimentação, Taxa de GGR, Outros custos, Envios (com a nota de uso quando faltam dados antes de uma data), Mensalidade e Lucro líquido do mês inteiro.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Outros custos
    // ---------------------------------------------------------------
    {
      id: "outros-custos",
      title: "Outros custos",
      tab: "outros-custos",
      intro:
        "Custos com data (afiliados, equipe, ferramentas, impostos...) que entram em qualquer período que contenha a data deles — diferente de Anúncios e GGR, que são lançados por dia em Lançamentos.",
      items: [
        {
          anchor: "financeiro.outros-custos.mes",
          label: "Mês",
          what: "Escolhe o mês mostrado na tabela de custos.",
        },
        {
          anchor: "financeiro.outros-custos.tabela",
          label: "Tabela de custos",
          what: 'Colunas Data (com o selo "todo mês" quando o custo se repete), Descrição, Categoria e Valor. Sem nenhum custo no mês, "Nenhum custo lançado neste mês."',
          notes:
            'Um custo que parece ser uma cobrança automática da Betleads (o texto ou a categoria contém "sms", "voz", "e-mail", "mensalidade", "crm" ou "betleads") mostra a etiqueta "parece duplicado com o custo Betleads automático", com um botão "Remover" ao lado — porque esse custo já entra sozinho na cascata, sem precisar ser lançado aqui.',
        },
        {
          anchor: "financeiro.outros-custos.editar",
          label: "Editar (ícone de lápis)",
          what: "Carrega esse custo no formulário abaixo, para alterar. Repete-se por linha; a âncora marca só a primeira.",
          roles: ["admin"],
        },
        {
          anchor: "financeiro.outros-custos.excluir",
          label: "Excluir (ícone de lixeira)",
          what: 'Remove o custo direto quando ele não se repete. Repete-se por linha; a âncora marca só a primeira.',
          roles: ["admin"],
          notes:
            'Num custo que se repete todo mês, abre antes a confirmação "Excluir custo recorrente" ("Este custo se repete todo mês. Excluir só este mês ou encerrar a repetição?") com os botões "Excluir só este mês (continua nos próximos)", "Excluir este e encerrar a repetição" e "Cancelar". Toasts: "Custo removido", "Mês pulado" ou "Repetição encerrada". Um mês pulado passa a mostrar "pulado neste mês" no lugar do valor, sem apagar a linha da série.',
        },
        {
          anchor: "financeiro.outros-custos.descricao",
          label: "Descrição",
          what: 'O texto do custo, por exemplo "Designer" ou "Afiliado X".',
          roles: ["admin"],
          notes:
            'Digitar algo que parece uma cobrança da Betleads mostra o aviso "o custo Betleads já entra sozinho" abaixo do formulário.',
        },
        {
          anchor: "financeiro.outros-custos.categoria",
          label: "Categoria",
          what: 'Escolhe entre as categorias fixas (Afiliados e influenciadores, Equipe, Ferramentas, Impostos, Outros) e as que a casa já usou antes, ou cria uma nova digitando o nome e escolhendo "Criar categoria "<nome>"".',
          roles: ["admin"],
        },
        {
          anchor: "financeiro.outros-custos.data",
          label: "Data",
          what: 'A data do custo, sempre dentro do mês mostrado e nunca depois de hoje. Ao lado, "Repetir todo mês" copia o custo para o mesmo dia de cada mês novo, automaticamente.',
          roles: ["admin"],
        },
        {
          anchor: "financeiro.outros-custos.valor",
          label: "Valor",
          what: "O valor do custo, na moeda da casa.",
          roles: ["admin"],
        },
        {
          anchor: "financeiro.outros-custos.adicionar",
          label: '"Adicionar" / "Salvar custo"',
          what: "Grava o novo custo, ou as alterações ao editar um já existente. Enquanto edita, aparece também um botão \"Cancelar\" ao lado.",
          roles: ["admin"],
          notes:
            'Erro possível: "Esse custo recorrente já tem um lançamento nesse mês" (outro lançamento da mesma série repetida já existe no mês da data escolhida). Toast de sucesso: "Custo salvo".',
        },
        {
          label: "Total do mês",
          what: "A soma de todos os custos do mês mostrado, abaixo da tabela.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Configurações
    // ---------------------------------------------------------------
    {
      id: "configuracoes",
      title: "Configurações",
      tab: "configuracoes",
      intro:
        "As taxas cobradas sobre o GGR e sobre a movimentação da casa, com o histórico de mudanças, e quais gestores podem ver este financeiro (só leitura). Só o administrador edita.",
      items: [
        {
          anchor: "financeiro.configuracoes.taxas-atuais",
          label: "Taxas atuais",
          what: "Taxa de GGR e Taxa de movimentação em vigor hoje, cada uma com seu \"Como calculamos\" explicando onde entram na cascata do Painel.",
        },
        {
          anchor: "financeiro.configuracoes.historico",
          label: "Histórico de taxas",
          what: 'Uma tabela com "Vale a partir de", Taxa de GGR e Taxa de movimentação de cada mudança anterior. Some quando a casa nunca teve uma mudança de taxa.',
        },
        {
          anchor: "financeiro.configuracoes.taxa-ggr",
          label: "Taxa de GGR (%)",
          what: "O novo valor da taxa de GGR.",
          roles: ["admin"],
        },
        {
          anchor: "financeiro.configuracoes.taxa-movimentacao",
          label: "Taxa de movimentação (%)",
          what: "O novo valor da taxa de movimentação.",
          roles: ["admin"],
        },
        {
          anchor: "financeiro.configuracoes.vale-a-partir-de",
          label: "Vale a partir de",
          what: "A partir de que dia a nova taxa passa a valer; nunca antes de hoje — o passado não é recalculado.",
          roles: ["admin"],
          notes:
            'Erro possível: "A data de início não pode ser no passado".',
        },
        {
          anchor: "financeiro.configuracoes.salvar-taxas",
          label: '"Salvar taxas"',
          what: "Grava a nova taxa a partir da data escolhida, mantendo as taxas antigas no histórico para os dias anteriores.",
          roles: ["admin"],
          notes: 'Toast de sucesso: "Taxas atualizadas".',
        },
        {
          anchor: "financeiro.configuracoes.gestores",
          label: "Liberação para gestores",
          what: 'A lista dos gestores da casa, cada um com um interruptor. Sem nenhum gestor na casa, "Nenhum gestor nesta casa ainda."',
          roles: ["admin"],
        },
        {
          anchor: "financeiro.configuracoes.liberar-gestor",
          label: "Interruptor do gestor",
          what: "Liga ou desliga, para aquele gestor, o acesso de só leitura a este financeiro. Repete-se por gestor; a âncora marca só o primeiro.",
          roles: ["admin"],
        },
      ],
    },
  ],

  states: [
    {
      id: "sem-acesso",
      title: "Você não tem acesso ao financeiro desta casa.",
      what: "Mostrado no lugar das abas para quem não é administrador, nem um gestor liberado, nem super admin.",
      action:
        "Peça a um administrador da casa para liberar o seu acesso em Configurações → Liberação para gestores.",
    },
    {
      id: "gestor-so-leitura",
      title: "Gestor liberado: só leitura",
      what: 'Um gestor liberado vê as quatro abas normalmente, mas os controles de escrita (GGR do mês, Anúncios/GGR do dia, "Usar gasto da Meta", o formulário de Outros custos, "Salvar taxas" e "Liberação para gestores") ficam fora do seu alcance — os campos aparecem só com o valor, sem caixa de digitar.',
    },
    {
      id: "ambiente-demo",
      title: "Ambiente de demonstração: esta ação não está disponível",
      what: 'Aviso (ao passar o mouse ou tocar) sobre um botão ou interruptor desabilitado na casa demo: "Usar gasto da Meta nos dias vazios", adicionar/editar/excluir um outro custo, "Salvar taxas" e o interruptor de liberação do gestor.',
      action: "Numa casa real (não demo) esses controles funcionam normalmente.",
    },
    {
      id: "erro-ao-carregar",
      title: 'Não foi possível carregar o painel. / Não foi possível carregar o financeiro.',
      what: "Mostrado no lugar do Painel ou de Lançamentos quando a tela não conseguiu carregar os dados do financeiro (ex.: perda de conexão); quando o erro traz uma mensagem própria (como as duas abaixo), ela aparece no lugar deste texto padrão.",
      action: "Recarregue a tela; se persistir, tente novamente em alguns minutos.",
    },
    {
      id: "sem-permissao",
      title: "Sem permissão",
      what: 'Mensagem de erro (no lugar do painel, da lista de dias ou ao salvar) quando o acesso ao financeiro desta casa foi revogado durante o uso — por exemplo, um administrador desligou a liberação do gestor, ou a casa ativa foi trocada para uma em que o usuário não tem mais acesso ao financeiro — entre o momento em que a tela abriu e o clique que disparou essa checagem no servidor.',
      action: "Recarregue a tela. Se o acesso continuar negado, peça a um administrador da casa para liberar de novo em Configurações → Liberação para gestores.",
    },
    {
      id: "casa-nao-encontrada",
      title: "Casa não encontrada",
      what: "Mensagem de erro quando a casa ativa (lida da sessão) deixou de existir ou de estar associada à conta — por exemplo, foi removida ou a casa ativa guardada no navegador ficou desatualizada.",
      action: "Recarregue a tela ou troque a casa ativa pelo seletor; se persistir, peça ajuda a um administrador.",
    },
    {
      id: "sem-dados-periodo",
      title: "Sem dados no período.",
      what: 'Mostrado no lugar da cascata "Do depósito ao lucro" quando nenhum passo tem valor na janela escolhida.',
    },
    {
      id: "sem-dados-grafico",
      title: "Sem dados para o gráfico.",
      what: 'Mostrado no lugar do gráfico "Últimos 12 meses" quando nenhum mês tem dado ainda.',
    },
    {
      id: "custo-betleads-duplicado",
      title: "Pode haver custo Betleads contado duas vezes. Revise em Outros custos.",
      what: "Segunda linha do banner de pendências do Painel, quando algum custo lançado em Outros custos parece repetir uma cobrança (SMS, voz, e-mail, mensalidade) que a Betleads já soma automaticamente.",
      action: 'Abra Outros custos e, se for o caso, use "Remover" na etiqueta do custo duplicado.',
    },
    {
      id: "nenhum-dia-mes",
      title: "Nenhum dia neste mês ainda.",
      what: "Mostrado no lugar da lista de dias, em Lançamentos, quando o mês escolhido ainda não tem nenhum dia com dados.",
    },
    {
      id: "nenhum-custo-mes",
      title: "Nenhum custo lançado neste mês.",
      what: "Mostrado no lugar da tabela, em Outros custos, quando o mês escolhido não tem nenhum custo.",
    },
    {
      id: "custo-pulado-mes",
      title: "pulado neste mês",
      what: 'Na coluna Valor de Outros custos, no lugar do valor: esse mês de um custo recorrente foi excluído com "Excluir só este mês (continua nos próximos)" — a série continua nos meses seguintes.',
    },
    {
      id: "nenhum-gestor",
      title: "Nenhum gestor nesta casa ainda.",
      what: "Mostrado no lugar da lista de \"Liberação para gestores\", em Configurações, quando a casa não tem nenhum usuário com o papel de gestor.",
    },
  ],

  tours: {
    painel: [
      {
        anchor: "financeiro.painel.periodo",
        title: "Período",
        body: "Escolha o intervalo de datas: atalhos prontos ou um calendário, com o máximo de 366 dias.",
        articleSection: "painel",
      },
      {
        anchor: "financeiro.painel.comparar",
        title: "Comparar com",
        body: "A janela usada para calcular as variações mostradas nos números abaixo.",
        articleSection: "painel",
      },
      {
        anchor: "financeiro.painel.resultado-lucro",
        title: "Lucro líquido",
        body: "O resultado final do período: depósitos menos saques, taxas, anúncios, envios e outros custos.",
        articleSection: "painel",
      },
      {
        anchor: "financeiro.painel.cascata",
        title: "Do depósito ao lucro",
        body: "A mesma conta do Lucro líquido, passo a passo, do primeiro depósito até o resultado final.",
        articleSection: "painel",
      },
      {
        anchor: "financeiro.painel.kpi-movimentacao",
        title: "Movimentação",
        body: "Depósitos, saques e o Net (a diferença entre os dois), com o comportamento dos jogadores.",
        articleSection: "painel",
      },
      {
        anchor: "financeiro.painel.kpi-ggr",
        title: "GGR",
        body: "O GGR (Perdas na casa) do período e a taxa cobrada sobre ele.",
        articleSection: "painel",
      },
      {
        anchor: "financeiro.painel.kpi-envios",
        title: "Envios e CRM",
        body: "O custo dos envios do período e o quanto eles trouxeram de volta em depósitos.",
        articleSection: "painel",
      },
      {
        anchor: "financeiro.painel.grafico-12-meses",
        title: "Últimos 12 meses",
        body: "O histórico mês a mês, para comparar Lucro líquido, Net ou Depósitos ao longo do tempo.",
        articleSection: "painel",
      },
    ],
    lancamentos: [
      {
        anchor: "financeiro.lancamentos.mes",
        title: "Mês",
        body: "Escolha o mês que vai lançar ou revisar.",
        articleSection: "lancamentos",
      },
      {
        anchor: "financeiro.lancamentos.usar-meta",
        title: "Usar gasto da Meta",
        body: "Lança de uma vez, nos dias vazios, o gasto que a conta de anúncios já sugeriu.",
        articleSection: "lancamentos",
      },
      {
        anchor: "financeiro.lancamentos.ggr-mes",
        title: "GGR do mês",
        body: "Em vez de lançar o GGR dia a dia, dá para lançar o total acumulado do mês de uma vez.",
        articleSection: "lancamentos",
      },
      {
        anchor: "financeiro.lancamentos.dias",
        title: "Lista de dias",
        body: "Cada dia do mês, com o status, Net, Envios e Lucro líquido.",
        articleSection: "lancamentos",
      },
      {
        anchor: "financeiro.lancamentos.dia-linha",
        title: "Abrir um dia",
        body: "Clique num dia para ver os números que vieram do CRM e lançar Anúncios e GGR.",
        articleSection: "lancamentos",
      },
      {
        anchor: "financeiro.lancamentos.resumo",
        title: "Resumo do mês",
        body: "As taxas, os outros custos, os envios, a mensalidade e o Lucro líquido do mês inteiro.",
        articleSection: "lancamentos",
      },
    ],
    "outros-custos": [
      {
        anchor: "financeiro.outros-custos.mes",
        title: "Mês",
        body: "Escolha o mês mostrado na tabela de custos.",
        articleSection: "outros-custos",
      },
      {
        anchor: "financeiro.outros-custos.tabela",
        title: "Tabela de custos",
        body: "Cada custo lançado, com a data, a descrição, a categoria e o valor.",
        articleSection: "outros-custos",
      },
      {
        anchor: "financeiro.outros-custos.descricao",
        title: "Descrição",
        body: "O que é esse custo, por exemplo \"Designer\" ou \"Afiliado X\".",
        articleSection: "outros-custos",
      },
      {
        anchor: "financeiro.outros-custos.categoria",
        title: "Categoria",
        body: "Escolha uma categoria existente ou crie uma nova.",
        articleSection: "outros-custos",
      },
      {
        anchor: "financeiro.outros-custos.data",
        title: "Data e repetição",
        body: "A data do custo (dentro do mês, nunca no futuro) e se ele se repete todo mês.",
        articleSection: "outros-custos",
      },
      {
        anchor: "financeiro.outros-custos.valor",
        title: "Valor",
        body: "O valor do custo, na moeda da casa.",
        articleSection: "outros-custos",
      },
      {
        anchor: "financeiro.outros-custos.adicionar",
        title: "Adicionar",
        body: "Grava o custo. Ele entra em qualquer período que contenha a sua data.",
        articleSection: "outros-custos",
      },
    ],
    configuracoes: [
      {
        anchor: "financeiro.configuracoes.taxas-atuais",
        title: "Taxas atuais",
        body: "A Taxa de GGR e a Taxa de movimentação em vigor hoje.",
        articleSection: "configuracoes",
      },
      {
        anchor: "financeiro.configuracoes.historico",
        title: "Histórico de taxas",
        body: "Toda mudança de taxa anterior, com a data em que passou a valer.",
        articleSection: "configuracoes",
      },
      {
        anchor: "financeiro.configuracoes.taxa-ggr",
        title: "Taxa de GGR",
        body: "O novo valor da taxa de GGR.",
        articleSection: "configuracoes",
      },
      {
        anchor: "financeiro.configuracoes.vale-a-partir-de",
        title: "Vale a partir de",
        body: "A partir de quando a nova taxa passa a valer — nunca antes de hoje.",
        articleSection: "configuracoes",
      },
      {
        anchor: "financeiro.configuracoes.salvar-taxas",
        title: "Salvar taxas",
        body: "Grava a nova taxa, mantendo as antigas no histórico para os dias anteriores.",
        articleSection: "configuracoes",
      },
      {
        anchor: "financeiro.configuracoes.liberar-gestor",
        title: "Liberar um gestor",
        body: "Liga o acesso de só leitura deste financeiro para aquele gestor.",
        articleSection: "configuracoes",
      },
    ],
  },
};

export default screen;
