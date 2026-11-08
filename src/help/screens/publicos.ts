// Help article for "Públicos" (/publicos), versão da casa. Uma única tela
// sem abas: o editor de regras (à esquerda), "Seus públicos" e "Públicos
// automáticos" (à direita). A mesma tela também serve o expert
// (useCampaignDataSource().isExpert muda a fonte de dados, a carteira de
// leads e alguns textos), mas essa versão fica para a fase 4 — não
// documentada aqui. Fonte: src/routes/publicos.tsx e
// src/components/audiences/{audience-parts,criteria-labels}.ts, mais as
// mensagens de erro de src/lib/sms-audience-crud.functions.ts e
// src/lib/sms-audience-criteria.ts.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "publicos",
  route: "/publicos",
  title: "Públicos",
  purpose:
    "Criar e gerenciar grupos de jogadores (públicos) por regras de comportamento, usar os públicos automáticos por nível e enviar qualquer público direto para uma campanha ou (o 'Todos os jogadores') para uma jornada.",
  roles: ["admin", "gestor", "member"],
  terms: ["pix-gerado-pago", "leads-mortos"],
  sections: [
    // ---------------------------------------------------------------
    // Editor de público
    // ---------------------------------------------------------------
    {
      id: "editor",
      title: "Editor de público",
      intro:
        "O título muda entre \"Novo público\" e \"Editar público\" conforme você está criando ou alterando um já salvo. Abaixo, a pergunta \"Quem deve fazer parte deste público?\" guia as regras escolhidas ao lado.",
      items: [
        {
          anchor: "publicos.editor.nome",
          label: "Nome",
          what: 'O nome do público, como "Ouro que parou há 30 dias" (texto de exemplo do campo). Obrigatório: o botão de salvar só libera depois de preenchido.',
        },
        {
          anchor: "publicos.editor.descricao",
          label: "Descrição (opcional)",
          what: 'Um texto livre para lembrar quando usar esse público, como no exemplo do campo: "Quando este público deve ser usado?".',
        },
        {
          label: 'Aviso "Público de seleção"',
          what: 'Substitui todas as regras abaixo quando você está editando um público de seleção (uma lista fixa de jogadores escolhidos um a um em Jogadores, não um conjunto de regras): "Público de seleção: N jogadores escolhidos em Jogadores. As regras não se aplicam a ele; você pode alterar o nome e a descrição ou excluí-lo."',
          notes:
            "Um público de seleção só nasce em Jogadores (escolhendo jogadores na lista e enviando para um público). Aqui em Públicos você só pode renomear, mudar a descrição ou excluir — por isso o menu \"⋯\" dele não tem \"Duplicar\" (duplicar abriria o editor de regras, que não vale para uma lista fixa de jogadores).",
        },
        {
          label: 'Aviso "Escolhas incompatíveis se substituem"',
          what: '"O que o jogador fez": o grupo de chips liga/desliga das regras de atividade. O aviso abaixo do título diz "Escolhas incompatíveis se substituem; as demais podem ser combinadas." — ou seja, dentro do mesmo grupo (Depósito, ou Saques) só uma opção fica ativa por vez; entre grupos diferentes (Depósito + Pendências + Saques + Bônus, mais Nível e Tempo sem depositar) as escolhas se somam.',
        },
        {
          anchor: "publicos.editor.deposito-sim",
          label: "Já depositou",
          what: "Chip liga/desliga: só entram no público os jogadores que já fizeram pelo menos um depósito.",
          notes:
            'Clicar de novo no chip já ativo desliga a regra (volta para "qualquer"). O número ao lado do nome é a contagem ao vivo de jogadores que atendem a essa regra (sozinha, sem combinar com as outras) — veja "Prévia do público".',
        },
        {
          anchor: "publicos.editor.deposito-nunca",
          label: "Nunca depositou",
          what: "Chip liga/desliga: só entram os jogadores que nunca depositaram.",
          notes:
            'Ativar esta regra esconde os grupos "Nível" e "Tempo sem depositar" — quem nunca depositou não tem nível pago nem um "tempo sem depositar" para medir, então essas regras deixam de fazer sentido e são limpas automaticamente se estavam marcadas.',
        },
        {
          anchor: "publicos.editor.pix-nao-pago",
          label: "Gerou PIX e não pagou",
          what: "Chip liga/desliga: só entram os jogadores que geraram um código Pix de depósito e não chegaram a pagá-lo.",
          notes:
            'Abaixo do título do grupo "Pendências" aparece "PIX gerado e não pago, ou saque ainda em aberto.", com um "i" ao lado de PIX que explica o termo.',
        },
        {
          anchor: "publicos.editor.saque-pendente",
          label: "Saque pendente",
          what: "Chip liga/desliga: só entram os jogadores com um pedido de saque ainda não resolvido pela casa.",
        },
        {
          anchor: "publicos.editor.saque-sim",
          label: "Já sacou",
          what: "Chip liga/desliga: só entram os jogadores que já sacaram pelo menos uma vez.",
        },
        {
          anchor: "publicos.editor.saque-nunca",
          label: "Nunca sacou",
          what: "Chip liga/desliga: só entram os jogadores que nunca sacaram.",
        },
        {
          anchor: "publicos.editor.cashback",
          label: "Recebeu cashback",
          what: "Chip liga/desliga: só entram os jogadores que já receberam algum cashback (bônus de devolução).",
        },
        {
          anchor: "publicos.editor.nivel",
          label: "Nível (Bronze, Prata, Ouro, Diamante, Black VIP)",
          what: "Cinco chips, um por nível de fidelização; escolher um filtra o público para só esse nível. Pode ser combinado com o tempo sem depositar (texto de ajuda do grupo).",
          notes:
            'Some quando "Nunca depositou" está marcado. Repetem-se em linha; a âncora do tour marca só o primeiro (Bronze).',
        },
        {
          anchor: "publicos.editor.tempo-sem-depositar",
          label: "Tempo sem depositar (Esfriando, Dormindo, 30+ dias, 90+ dias)",
          what: 'Quatro chips com faixas prontas de inatividade desde o último depósito. O texto de ajuda do grupo explica: "Escolha uma faixa ou informe os dias. Quanto mais escura a bolinha, mais tempo parado."',
          notes:
            'Some quando "Nunca depositou" está marcado. Repetem-se em linha; a âncora do tour marca só o primeiro (Esfriando).',
        },
        {
          anchor: "publicos.editor.dias-personalizado",
          label: "Campo de dias (ao lado das faixas prontas)",
          what: 'Um número de dias sem depositar à sua escolha, no lugar de uma das faixas prontas. Mostra "dias ou mais" ao lado enquanto vazio.',
          notes: "Preencher este campo desmarca qualquer faixa pronta escolhida, e vice-versa: só uma forma de medir o tempo sem depositar vale por vez.",
        },
        {
          anchor: "publicos.editor.limpar-dias",
          label: "Limpar (campo de dias)",
          what: "Aparece só quando o campo de dias está preenchido; apaga o valor e volta o tempo sem depositar para \"qualquer\".",
        },
        {
          anchor: "publicos.editor.dias-sem-entrar",
          label: "Dias sem entrar",
          what: 'Só entram os jogadores que não acessam a casa há pelo menos esse número de dias. Mostra "Sem limite" (texto de exemplo) quando vazio.',
        },
        {
          anchor: "publicos.editor.dias-desde-cadastro",
          label: "Dias desde o cadastro",
          what: "Só entram os jogadores cadastrados há pelo menos esse número de dias.",
        },
        {
          anchor: "publicos.editor.previa",
          label: "Prévia do público",
          what: 'Caixa que recalcula ao vivo, a cada mudança nas regras (depois de uma pequena espera): mostra "Calculando público…" enquanto espera a resposta e, pronta, o texto "N jogadores atendem a estas regras" (ou "N jogadores da seleção nesta casa" para um público de seleção), seguido de um resumo curto das regras escolhidas.',
          notes:
            'Abaixo do total aparecem duas linhas: "N com telefone válido para receber SMS" e, só quando algum jogador não tem telefone válido, "M ficam de fora do envio por não terem telefone válido." — a contagem principal conta todos os jogadores da regra, mas só quem tem telefone válido recebe o envio de fato.',
        },
        {
          anchor: "publicos.editor.salvar",
          label: "Criar público / Salvar alterações",
          what: 'Grava o público. O texto do botão muda para "Salvar alterações" ao editar um já existente, ou fica "Criar público" para um novo.',
          notes:
            'Fica desabilitado sem um nome preenchido, enquanto salva ou enquanto a prévia ainda está calculando. Ao salvar, aparece o aviso "Público criado" (novo) ou "Público atualizado" (edição); se o servidor recusar, aparece a mensagem de erro dele.',
        },
        {
          anchor: "publicos.editor.cancelar",
          label: "Cancelar",
          what: "Aparece só ao editar um público existente; descarta as alterações e limpa o formulário para um novo público.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Seus públicos
    // ---------------------------------------------------------------
    {
      id: "seus-publicos",
      title: "Seus públicos",
      intro:
        'A lista dos públicos que você já salvou (por regras ou de seleção). O aviso "As quantidades são recalculadas no momento do envio" lembra que o número de jogadores de um público muda com o tempo — o que fica salvo são as regras, não a lista de jogadores do dia em que foi criado.',
      items: [
        {
          anchor: "publicos.lista.cartao",
          label: "Cartão do público",
          what: "Um cartão por público salvo, com o nome, a descrição (quando houver) e as etiquetas das regras usadas (ex.: \"Nunca depositou\", \"30+ dias sem depositar\") ou \"N jogadores escolhidos\" para um público de seleção. Um público sem nenhuma regra marcada mostra a etiqueta \"Todos com telefone válido\".",
          notes: "Repete-se em cada público salvo; a âncora do tour marca só o primeiro cartão.",
        },
        {
          anchor: "publicos.lista.usar-campanha",
          label: "Usar na campanha",
          what: "Leva direto para Campanhas com este público já escolhido, para montar e enviar uma campanha nova.",
          notes: "Repete-se em cada cartão; a âncora marca só o primeiro.",
        },
        {
          anchor: "publicos.lista.menu",
          label: 'Menu "⋯"',
          what: 'Abre as ações do público: "Editar" (ou "Renomear" para um público de seleção), "Duplicar" (ausente num público de seleção) e "Excluir".',
          notes: "Repete-se em cada cartão; a âncora marca só o primeiro.",
        },
        {
          label: 'Menu "⋯" — Editar / Renomear',
          what: "Carrega o público no editor à esquerda (nome, descrição e regras, ou só nome/descrição para uma seleção) e rola a tela para o topo.",
        },
        {
          label: 'Menu "⋯" — Duplicar',
          what: 'Carrega as mesmas regras no editor como um público novo, com "— cópia" acrescentado ao nome, para ajustar e salvar separado do original.',
        },
        {
          label: 'Menu "⋯" — Excluir',
          what: 'Pede confirmação: "Excluir “<nome do público>”?", com o texto "O público será removido da sua lista. Campanhas já enviadas não serão alteradas." e os botões "Cancelar" e "Excluir público".',
          notes:
            'Confirmando, some da lista e aparece o aviso "Público excluído". Se o servidor recusar, aparece a mensagem de erro dele no lugar.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Públicos automáticos
    // ---------------------------------------------------------------
    {
      id: "automaticos",
      title: "Públicos automáticos",
      intro:
        'Públicos prontos que o CRM mantém sozinho, sem precisar criar nem salvar nada: "Os níveis de fidelização estão sempre prontos para uso e acompanham a classificação atual dos jogadores."',
      items: [
        {
          anchor: "publicos.automaticos.cartao",
          label: 'Cartões "Todos os jogadores", Bronze, Prata, Ouro, Diamante, Black VIP e "Leads mortos (sem resposta às jornadas)"',
          what: '"Todos os jogadores": todos os jogadores cadastrados na casa. Os cinco de nível: só os jogadores classificados naquele nível no momento do envio. "Leads mortos (sem resposta às jornadas)": jogadores que receberam várias mensagens de jornada seguidas sem nenhuma ação na casa.',
          notes:
            "Nenhum deles tem o menu \"⋯\" de editar/duplicar/excluir (são automáticos, não editáveis) — só \"Usar na campanha\", e, no cartão \"Todos os jogadores\", também \"Usar em jornada\". A âncora do tour marca só o primeiro cartão (\"Todos os jogadores\").",
        },
        {
          anchor: "publicos.automaticos.menu",
          label: 'Menu "⋯" (só no cartão "Todos os jogadores")',
          what: 'Único cartão automático com um menu "⋯"; dentro dele, o item "Usar em jornada" leva para "Nova jornada" com esse público já escolhido como gatilho de entrada.',
        },
      ],
    },
  ],

  states: [
    {
      id: "previa-calculando",
      title: "Calculando público…",
      what: "Mostrado na caixa de prévia enquanto o CRM recalcula quantos jogadores atendem às regras escolhidas — toda mudança nas regras dispara um novo cálculo, com uma pequena espera antes de disparar.",
    },
    {
      id: "previa-erro",
      title: "Não foi possível calcular",
      what: 'Mostrado na caixa de prévia quando o cálculo falha; o texto completo é "Não foi possível calcular: " seguido da mensagem de erro do servidor.',
    },
    {
      id: "lista-carregando",
      title: "Carregando públicos…",
      what: 'Texto mostrado no lugar da lista "Seus públicos" na primeira vez que ela carrega.',
    },
    {
      id: "lista-atualizando",
      title: "Atualizando públicos…",
      what: "Aparece com um ícone girando, acima da lista já carregada, sempre que ela está sendo recarregada em segundo plano — por exemplo, logo depois de salvar ou excluir um público.",
    },
    {
      id: "lista-erro",
      title: "Não foi possível carregar os públicos",
      what: 'Mostrado no lugar da lista quando a busca falha; o texto completo é "Não foi possível carregar os públicos: " seguido da mensagem de erro do servidor.',
    },
    {
      id: "lista-vazia",
      title: "Você ainda não criou públicos personalizados.",
      what: 'Mostrado no lugar da lista "Seus públicos" quando a casa ainda não tem nenhum público salvo (por regras ou de seleção).',
      action: 'Preencha o editor à esquerda e clique em "Criar público".',
    },
  ],

  tours: {
    default: [
      {
        anchor: "publicos.editor.nome",
        title: "Nome do público",
        body: "Dê um nome ao público que você está criando ou editando.",
        articleSection: "editor",
      },
      {
        anchor: "publicos.editor.deposito-sim",
        title: "Chips de regras",
        body: 'Ative os chips que descrevem quem deve entrar. Dentro do mesmo grupo, escolhas incompatíveis se substituem; entre grupos, elas se combinam.',
        articleSection: "editor",
      },
      {
        anchor: "publicos.editor.tempo-sem-depositar",
        title: "Tempo sem depositar",
        body: "Escolha uma faixa pronta ou informe os dias exatos ao lado.",
        articleSection: "editor",
      },
      {
        anchor: "publicos.editor.previa",
        title: "Prévia ao vivo",
        body: "Acompanhe aqui, em tempo real, quantos jogadores atendem às regras escolhidas.",
        articleSection: "editor",
      },
      {
        anchor: "publicos.editor.salvar",
        title: "Salvar o público",
        body: "Grave o público para poder usá-lo nas suas campanhas.",
        articleSection: "editor",
      },
      {
        anchor: "publicos.lista.usar-campanha",
        title: "Usar na campanha",
        body: "Qualquer público salvo pode ir direto para o compositor de uma campanha nova.",
        articleSection: "seus-publicos",
      },
      {
        anchor: "publicos.automaticos.cartao",
        title: "Públicos automáticos",
        body: "Os níveis de fidelização e \"Todos os jogadores\" já vêm prontos, sem precisar criar nada.",
        articleSection: "automaticos",
      },
    ],
  },
};

export default screen;
