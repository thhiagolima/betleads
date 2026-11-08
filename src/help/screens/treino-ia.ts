// Help article for "Configurar IA" (/treino-ia), tela só de admin, três
// abas: Exemplos, Assuntos e sinônimos, Avaliações. Fonte:
// src/routes/treino-ia.tsx (ExemplosTab, IntentsTab, FeedbackTab). As
// avaliações desta aba são as mesmas registradas no 👍/👎 do Assistente IA
// (screens/inteligencia.ts, itens "ia.feedback.*").
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "treino-ia",
  route: "/treino-ia",
  defaultTab: "exemplos",
  title: "Configurar IA",
  purpose:
    "Ensina o Assistente IA com exemplos de resposta, com as palavras que a casa usa no dia a dia e acompanha as avaliações (👍/👎) que a equipe deu às respostas.",
  roles: ["admin"],
  sections: [
    // ---------------------------------------------------------------
    // Aba Exemplos
    // ---------------------------------------------------------------
    {
      id: "exemplos",
      title: "Exemplos",
      tab: "exemplos",
      intro:
        'Exemplos de pergunta + resposta ideal que orientam o assistente. Cada exemplo pode estar ligado ou desligado (só os ligados valem) e tem uma origem: "manual" (cadastrado aqui direto) ou "feedback" (veio de uma avaliação ruim na aba Avaliações).',
      items: [
        {
          anchor: "exemplos.pergunta",
          label: "Pergunta",
          what: 'A pergunta de exemplo, como seria perguntada no Assistente IA — por exemplo "os 5 que mais depositaram hoje".',
        },
        {
          anchor: "exemplos.assunto",
          label: "Assunto (opcional)",
          what: 'Um texto livre para marcar de qual assunto esse exemplo é (por exemplo "top_depositantes"). Serve só de anotação — não precisa ser um dos assuntos cadastrados na aba "Assuntos e sinônimos".',
        },
        {
          anchor: "exemplos.resposta",
          label: "Resposta ideal",
          what: "O texto que o assistente deveria responder para essa pergunta. Aceita **negrito** e listas em markdown simples.",
        },
        {
          anchor: "exemplos.importar",
          label: "Importar do histórico",
          what: 'Abre a lista "Últimas perguntas feitas à IA" (as últimas 30), para aproveitar uma pergunta real já feita no Assistente IA como ponto de partida de um exemplo novo.',
          notes: 'Lista vazia mostra "Nenhuma pergunta ainda."',
        },
        {
          anchor: "exemplos.importar-lista",
          label: 'Lista "Últimas perguntas feitas à IA"',
          what: "Cada linha mostra a pergunta e um trecho da resposta que a IA deu na hora (até 120 caracteres). Clicar numa linha copia a pergunta para o campo Pergunta e tenta aproveitar o resumo da resposta (ou o texto bruto, se não for possível) no campo Resposta ideal, fecha a lista e mostra o aviso \"Edite a resposta e clique em Salvar para virar exemplo\". O botão \"Fechar\", no topo, fecha a lista sem escolher nada.",
        },
        {
          anchor: "exemplos.importar-item",
          label: "Linha da lista de importação",
          what: "Importa aquela pergunta e resposta para o formulário. Repete-se em cada linha; a âncora marca só a primeira.",
        },
        {
          anchor: "exemplos.salvar",
          label: "Salvar exemplo",
          what: "Cadastra o exemplo com a pergunta, o assunto (se preenchido) e a resposta ideal, já ligado, com a origem \"manual\". Ao salvar com sucesso, aparece o aviso \"Exemplo cadastrado\" e os três campos são limpos.",
          notes:
            'Erro possível: "Preencha a pergunta e a resposta ideal." quando um dos dois campos obrigatórios está vazio. Se a gravação falhar por outro motivo, o erro mostrado é o texto que vier do banco de dados (varia caso a caso).',
        },
        {
          anchor: "exemplos.lista",
          label: 'Cartão "Exemplos cadastrados"',
          what: 'Lista todos os exemplos (até 200, mais recentes primeiro), cada um com a pergunta, um resumo de 2 linhas da resposta ideal, e etiquetas: o assunto (quando preenchido), a origem ("manual" ou "feedback") e "inativo" quando a chave está desligada.',
          notes:
            'Lista vazia mostra "Nenhum exemplo ainda." (ou, no ambiente de demonstração, "Nenhum dado neste ambiente de demonstração").',
        },
        {
          anchor: "exemplos.item.ligar",
          label: "Chave ligar/desligar (por exemplo)",
          what: "Liga ou desliga aquele exemplo sem apagá-lo — só exemplos ligados valem para o assistente. Repete-se em cada exemplo da lista; a âncora marca só o primeiro.",
        },
        {
          anchor: "exemplos.item.excluir",
          label: "Excluir (ícone de lixeira, por exemplo)",
          what: 'Pede confirmação ("Excluir este exemplo?", com os botões "Cancelar" e "Excluir exemplo") antes de apagar de vez. A descrição explica: \'O exemplo "<pergunta>" será apagado e deixa de orientar as respostas da IA. Para só pausar, use a chave ao lado.\' Repete-se em cada exemplo da lista; a âncora marca só o primeiro.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Assuntos e sinônimos
    // ---------------------------------------------------------------
    {
      id: "assuntos",
      title: "Assuntos e sinônimos",
      tab: "assuntos",
      intro:
        'Um "assunto" é um tipo de pergunta que o assistente já sabe responder sem exemplo (por exemplo, "quem tem saldo na banca" ou "quem depositou hoje"); um "sinônimo" é uma palavra que a sua casa usa no dia a dia (como "banca") ligada ao termo que o assistente já conhece internamente (como saldo_carteira), para que ele entenda do mesmo jeito que a equipe fala, mesmo sem um exemplo cadastrado para aquela palavra.',
      items: [
        {
          anchor: "assuntos.lista",
          label: 'Cartão "Assuntos que o assistente entende"',
          what: 'Lista todos os assuntos cadastrados, cada um com o nome, uma descrição curta, até 6 palavras-chave que o acionam (etiquetas) e, quando existir, a linha "Ordena por <campo> · mostra até N" — o campo é o dado usado para ordenar a lista de jogadores daquela resposta (por exemplo total_depositado) e N é quantos jogadores aparecem por padrão.',
          notes:
            'Os assuntos de fábrica da casa incluem, por exemplo: "Players com saldo disponível na banca" (ordena por saldo_carteira), "Maiores depositantes" (ordena por total_depositado, mostra até 10), "Players VIP" (ordena por vip) e "Players em risco de abandono". Com mais de 6 palavras-chave cadastradas, só as 6 primeiras aparecem na tela — não há indicação de que existem mais.',
        },
        {
          anchor: "assuntos.item.ligar",
          label: "Chave ligar/desligar (por assunto)",
          what: "Liga ou desliga aquele assunto — desligado, o assistente deixa de reconhecer essas palavras-chave como aquele tipo de pergunta. Repete-se em cada assunto da lista; a âncora marca só o primeiro.",
        },
        {
          anchor: "assuntos.syn.termo",
          label: "Palavra da casa",
          what: 'A palavra ou expressão que a equipe usa no dia a dia, por exemplo "banca".',
        },
        {
          anchor: "assuntos.syn.canonico",
          label: "Termo conhecido",
          what: 'O termo interno que o assistente já reconhece e para o qual a palavra da casa deve apontar, por exemplo saldo_carteira.',
        },
        {
          anchor: "assuntos.syn.tipo",
          label: "Tipo",
          what: 'De que tipo de coisa é o sinônimo: "Geral", "Dado do jogador" (um campo do jogador, como saldo ou depósito), "Expert" (o nome de um expert da casa) ou "Período" (uma expressão de tempo, como "essa semana").',
        },
        {
          anchor: "assuntos.syn.adicionar",
          label: "Adicionar (sinônimo)",
          what: "Cadastra o novo sinônimo, já ligado.",
          notes:
            'Erro possível: "Preencha a palavra da casa e o termo conhecido" quando um dos dois campos está vazio.',
        },
        {
          anchor: "assuntos.syn.lista",
          label: "Lista de sinônimos",
          what: 'Cada linha mostra o tipo (etiqueta), a palavra da casa, uma flecha e o termo conhecido (em destaque), com uma chave de ligar/desligar e um botão de excluir.',
          notes:
            'Alguns sinônimos de fábrica da casa: "banca", "saldo na conta" e "dinheiro parado" todos apontando para saldo_carteira; "depositantes" para total_depositado; "sacadores" para total_sacado; "hoje", "ontem", "essa semana" e "esse mes" como períodos; e nomes de experts da casa (ex.: "Queiroz" → expert:Queiroz).',
        },
        {
          anchor: "assuntos.syn.item.ligar",
          label: "Chave ligar/desligar (por sinônimo)",
          what: "Liga ou desliga aquele sinônimo. Repete-se em cada linha da lista; a âncora marca só a primeira.",
        },
        {
          anchor: "assuntos.syn.item.excluir",
          label: "Excluir (ícone de lixeira, por sinônimo)",
          what: 'Pede confirmação ("Excluir este sinônimo?", com os botões "Cancelar" e "Excluir sinônimo") antes de apagar de vez. A descrição explica: \'"<palavra da casa>" deixa de ser reconhecido como "<termo conhecido>". Para só pausar, use a chave ao lado.\' Repete-se em cada linha da lista; a âncora marca só a primeira.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Avaliações
    // ---------------------------------------------------------------
    {
      id: "avaliacoes",
      title: "Avaliações",
      tab: "avaliacoes",
      intro:
        'As avaliações que a equipe dá às respostas no Assistente IA (👍/👎, ver "ia.feedback.bom"/"ia.feedback.ruim" no artigo do Assistente IA). Mostra sempre as últimas 100 avaliações — os números desta aba não são o total histórico quando a casa já passou de 100.',
      items: [
        {
          anchor: "avaliacoes.kpi.aprovacao",
          label: "Aprovação",
          what: "A porcentagem de avaliações boas entre as últimas 100 (boas ÷ total, em %). Mostra 0% quando ainda não há nenhuma avaliação.",
        },
        {
          anchor: "avaliacoes.kpi.boas",
          label: "Respostas boas",
          what: "Quantas das últimas 100 avaliações foram 👍.",
        },
        {
          anchor: "avaliacoes.kpi.ruins",
          label: "Respostas ruins",
          what: "Quantas das últimas 100 avaliações foram 👎.",
        },
        {
          anchor: "avaliacoes.lista",
          label: 'Cartão "Avaliações recentes"',
          what: 'Lista as últimas 100 avaliações, cada uma com o ícone de polegar (para cima/boa ou para baixo/ruim), a pergunta que gerou a resposta avaliada ("—" quando a pergunta original não está mais disponível) e, se preenchido, o motivo entre aspas.',
          notes:
            'Lista vazia mostra "Nenhuma avaliação ainda. Avalie as respostas no Assistente IA (👍 ou 👎)." (ou, no ambiente de demonstração, "Nenhum dado neste ambiente de demonstração").',
        },
        {
          anchor: "avaliacoes.criar-exemplo",
          label: "Criar exemplo",
          what: 'Aparece só nas avaliações ruins. Cria um rascunho de exemplo em Exemplos com a mesma pergunta, usando o motivo escrito na avaliação como resposta ideal (ou o texto "(preencher a resposta ideal)" quando não havia motivo escrito) — sempre desligado, com a origem "feedback".',
          notes:
            'Ao criar, mostra o aviso "Rascunho criado em Exemplos — abra para editar e ativar". Se a avaliação não tiver mais a pergunta original vinculada, mostra o erro "Sem pergunta vinculada" e não cria nada.',
        },
      ],
    },
  ],

  states: [
    {
      id: "exemplos-vazio",
      title: "Nenhum exemplo ainda.",
      what: 'Texto mostrado na aba Exemplos quando não há nenhum exemplo cadastrado.',
      action: "Cadastre um exemplo no formulário acima ou importe uma pergunta do histórico.",
    },
    {
      id: "importar-vazio",
      title: "Nenhuma pergunta ainda.",
      what: 'Texto mostrado na lista de importação quando o Assistente IA ainda não recebeu nenhuma pergunta nesta casa.',
    },
    {
      id: "avaliacoes-vazio",
      title: "Nenhuma avaliação ainda. Avalie as respostas no Assistente IA (👍 ou 👎).",
      what: "Texto mostrado na aba Avaliações quando a equipe ainda não avaliou nenhuma resposta.",
      action: "Avalie as respostas do Assistente IA com 👍 ou 👎 para alimentar esta aba.",
    },
  ],

  tours: {
    exemplos: [
      {
        anchor: "exemplos.pergunta",
        title: "Pergunta de exemplo",
        body: "Escreva a pergunta exatamente como seria feita no Assistente IA.",
        articleSection: "exemplos",
      },
      {
        anchor: "exemplos.resposta",
        title: "Resposta ideal",
        body: "A resposta que o assistente deveria dar para essa pergunta. Aceita negrito e listas.",
        articleSection: "exemplos",
      },
      {
        anchor: "exemplos.importar",
        title: "Importar do histórico",
        body: "Em vez de escrever do zero, aproveite uma pergunta real já feita no Assistente IA.",
        articleSection: "exemplos",
      },
      {
        anchor: "exemplos.salvar",
        title: "Salvar exemplo",
        body: "Cadastra o exemplo já ligado, pronto para orientar o assistente.",
        articleSection: "exemplos",
      },
      {
        anchor: "exemplos.lista",
        title: "Exemplos cadastrados",
        body: "Todos os exemplos já cadastrados, com a origem (manual ou feedback) e se estão ligados.",
        articleSection: "exemplos",
      },
      {
        anchor: "exemplos.item.ligar",
        title: "Ligar e desligar",
        body: "Só exemplos ligados valem para o assistente. Desligue sem apagar para pausar um exemplo.",
        articleSection: "exemplos",
      },
    ],
    assuntos: [
      {
        anchor: "assuntos.lista",
        title: "Assuntos que o assistente entende",
        body: "Os tipos de pergunta que o assistente já reconhece sem precisar de exemplo, com as palavras-chave que os acionam.",
        articleSection: "assuntos",
      },
      {
        anchor: "assuntos.item.ligar",
        title: "Ligar e desligar um assunto",
        body: "Desligado, o assistente deixa de reconhecer aquelas palavras-chave.",
        articleSection: "assuntos",
      },
      {
        anchor: "assuntos.syn.termo",
        title: "Palavra da casa",
        body: 'A palavra que a sua equipe usa, por exemplo "banca".',
        articleSection: "assuntos",
      },
      {
        anchor: "assuntos.syn.canonico",
        title: "Termo conhecido",
        body: "O termo interno para o qual essa palavra deve apontar.",
        articleSection: "assuntos",
      },
      {
        anchor: "assuntos.syn.adicionar",
        title: "Adicionar sinônimo",
        body: "Cadastra o novo sinônimo, já ligado.",
        articleSection: "assuntos",
      },
      {
        anchor: "assuntos.syn.lista",
        title: "Sinônimos cadastrados",
        body: "Cada linha mostra a palavra da casa e o termo conhecido, com a chave de ligar/desligar e o excluir.",
        articleSection: "assuntos",
      },
    ],
    avaliacoes: [
      {
        anchor: "avaliacoes.kpi.aprovacao",
        title: "Aprovação",
        body: "Porcentagem de avaliações boas entre as últimas 100.",
        articleSection: "avaliacoes",
      },
      {
        anchor: "avaliacoes.kpi.boas",
        title: "Respostas boas",
        body: "Quantas das últimas 100 avaliações foram 👍.",
        articleSection: "avaliacoes",
      },
      {
        anchor: "avaliacoes.kpi.ruins",
        title: "Respostas ruins",
        body: "Quantas das últimas 100 avaliações foram 👎.",
        articleSection: "avaliacoes",
      },
      {
        anchor: "avaliacoes.lista",
        title: "Avaliações recentes",
        body: "A pergunta avaliada e, quando preenchido, o motivo da avaliação ruim.",
        articleSection: "avaliacoes",
      },
      {
        anchor: "avaliacoes.criar-exemplo",
        title: "Criar exemplo",
        body: "Numa avaliação ruim, transforma o motivo em um rascunho de exemplo em Exemplos.",
        articleSection: "avaliacoes",
      },
    ],
  },
};

export default screen;
