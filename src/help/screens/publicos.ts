// Help article for "Públicos" (/publicos), versão da casa. Uma única tela
// sem abas: a biblioteca ("Prontos para usar" e "Seus públicos", cada público
// com quantos jogadores tem agora) e o botão "Novo público", que abre o editor
// de regras num painel lateral (tela cheia no celular). A mesma tela também
// serve o expert (useCampaignDataSource().isExpert muda a fonte de dados, a
// carteira de leads e alguns textos), mas essa versão fica para a fase 4 —
// não documentada aqui. Fonte: src/routes/publicos.tsx e
// src/components/audiences/{audience-parts,criteria-labels}.ts, mais as
// mensagens de erro de src/lib/sms-audience-crud.functions.ts e
// src/lib/sms-audience-criteria.ts.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "publicos",
  route: "/publicos",
  title: "Públicos",
  purpose:
    "Ver quantos jogadores tem cada público, mandar qualquer público direto para uma campanha (ou o 'Todos os jogadores' para uma jornada) e criar públicos por regras de comportamento.",
  roles: ["admin", "gestor", "member"],
  terms: ["pix-gerado-pago", "leads-mortos"],
  sections: [
    // ---------------------------------------------------------------
    // Prontos para usar
    // ---------------------------------------------------------------
    {
      id: "automaticos",
      title: "Prontos para usar",
      intro:
        'Públicos que o CRM mantém sozinho, sem precisar criar nem salvar nada: "Atualizados sozinhos, conforme o comportamento dos jogadores." Cada um mostra quantos jogadores tem agora e quantos têm celular para receber SMS. "Contado às HH:MM" diz de quando é a contagem; "Recontar" conta tudo de novo.',
      items: [
        {
          anchor: "publicos.automaticos.cartao",
          label: '"Todos os jogadores"',
          what: "Todos os jogadores cadastrados na casa, com o total e quantos têm celular válido.",
          notes:
            '"Usar" abre uma campanha nova com esse público. O menu "⋯" tem "Usar em jornada", que leva para "Nova jornada" com esse público já escolhido.',
        },
        {
          anchor: "publicos.automaticos.menu",
          label: 'Menu "⋯" de "Todos os jogadores"',
          what: 'Item "Usar em jornada": abre "Nova jornada" com "Todos os jogadores" como público de entrada.',
        },
        {
          anchor: "publicos.automaticos.niveis",
          label: "Por nível de fidelização (Bronze, Prata, Ouro, Diamante, Black VIP)",
          what: "Um bloco por nível, com o ícone, o nome e quantos jogadores estão nele agora. Tocar num nível abre uma campanha nova só para ele.",
          notes: "A âncora do tour marca só o primeiro bloco (Bronze).",
        },
        {
          label: '"Leads mortos"',
          what: "Jogadores que receberam várias mensagens de jornada seguidas sem nenhuma ação na casa. Mostra quantos são agora.",
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
        'A lista dos públicos que você já salvou (por regras ou de seleção), cada um com quantos jogadores tem agora. "No envio, a lista é contada de novo": o que fica salvo são as regras, não a lista de jogadores do dia em que foi criado. Com mais de 5 públicos aparece a busca pelo nome.',
      items: [
        {
          anchor: "publicos.lista.cartao",
          label: "Linha do público",
          what: 'O nome, as regras numa linha só (ex.: "Nunca depositou · Cadastrou ontem") ou "N jogadores escolhidos" para um público de seleção, a descrição (quando houver) e, à direita, "N jogadores" com "N com celular" embaixo.',
          notes: "Repete-se em cada público salvo; a âncora do tour marca só a primeira linha.",
        },
        {
          anchor: "publicos.lista.usar-campanha",
          label: "Usar",
          what: "Leva direto para Campanhas com este público já escolhido, para montar e enviar uma campanha nova.",
          notes: "Repete-se em cada linha; a âncora marca só a primeira.",
        },
        {
          anchor: "publicos.lista.menu",
          label: 'Menu "⋯"',
          what: 'Abre as ações do público: "Editar" (ou "Renomear" para um público de seleção), "Duplicar" (ausente num público de seleção) e "Excluir".',
          notes: "Repete-se em cada linha; a âncora marca só a primeira.",
        },
        {
          label: 'Menu "⋯" — Editar / Renomear',
          what: "Abre o editor com o público carregado (nome, descrição e regras, ou só nome/descrição para uma seleção).",
        },
        {
          label: 'Menu "⋯" — Duplicar',
          what: 'Abre o editor com as mesmas regras como um público novo, com "— cópia" no nome, para ajustar e salvar separado do original.',
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
    // Editor de público
    // ---------------------------------------------------------------
    {
      id: "editor",
      title: "Novo público (editor)",
      intro:
        'O botão "Novo público", no topo, abre o editor num painel ao lado (tela cheia no celular). O título muda entre "Novo público" e "Editar público". No rodapé do painel, sempre visível, ficam a contagem ao vivo e o botão de salvar.',
      items: [
        {
          anchor: "publicos.novo",
          label: "Novo público",
          what: "Abre o editor vazio para montar um público novo.",
        },
        {
          anchor: "publicos.editor.nome",
          label: "Nome",
          what: 'O nome do público, como "Ouro que parou há 30 dias" (texto de exemplo do campo). Obrigatório: sem ele, o rodapé avisa "Dê um nome para salvar."',
        },
        {
          anchor: "publicos.editor.descricao",
          label: "Para que serve (opcional)",
          what: "Um texto livre para lembrar quando usar esse público. Aparece na lista, embaixo das regras.",
        },
        {
          label: 'Aviso "Público de seleção"',
          what: 'Substitui todas as regras quando você está editando um público de seleção (uma lista fixa de jogadores escolhidos um a um em Jogadores): "Público de seleção: N jogadores escolhidos em Jogadores. As regras não se aplicam a ele; você pode alterar o nome e a descrição ou excluí-lo."',
          notes:
            'Um público de seleção só nasce em Jogadores. Aqui você só pode renomear, mudar a descrição ou excluir — por isso o menu "⋯" dele não tem "Duplicar".',
        },
        {
          label: '"Quem entra"',
          what: '"Toque para filtrar; dá para juntar filtros de grupos diferentes." Dentro do mesmo grupo (ex.: Depósito) só uma opção vale por vez; entre grupos as escolhas se somam. O número ao lado de cada opção mostra quantos jogadores ela traz junto com o que já está marcado.',
        },
        {
          anchor: "publicos.editor.deposito-sim",
          label: "Já depositou",
          what: "Só entram os jogadores que já fizeram pelo menos um depósito.",
          notes: 'Tocar de novo na opção marcada desmarca (volta para "qualquer").',
        },
        {
          anchor: "publicos.editor.deposito-primeiro",
          label: "Só fez o 1º depósito",
          what: "Só entram os jogadores que fizeram o primeiro depósito e nenhum outro depois dele.",
          notes:
            "Assim que o jogador faz um segundo depósito aprovado, ele sai do público. Combina com Nível e Tempo sem depositar.",
        },
        {
          anchor: "publicos.editor.deposito-dois",
          label: "Já fez 2 depósitos",
          what: "Só entram os jogadores que fizeram exatamente 2 depósitos aprovados: o 1º e mais um depois dele.",
          notes:
            'Assim que o jogador faz o 3º depósito, ele sai deste público. Conta os depósitos que chegaram pela integração da casa. Serve para campanhas avulsas para quem a jornada "Converter para o 3º depósito" também mira.',
        },
        {
          anchor: "publicos.editor.deposito-tres",
          label: "Já fez 3 depósitos",
          what: "Só entram os jogadores que fizeram exatamente 3 depósitos aprovados.",
          notes:
            'Assim que o jogador faz o 4º depósito, ele sai deste público. Mesma contagem de "Já fez 2 depósitos".',
        },
        {
          anchor: "publicos.editor.deposito-nunca",
          label: "Nunca depositou",
          what: "Só entram os jogadores que nunca depositaram.",
          notes:
            'Marcar esta opção esconde "Nível" e "Tempo sem depositar" — quem nunca depositou não tem nível nem tempo parado para medir.',
        },
        {
          anchor: "publicos.editor.pix-nao-pago",
          label: "Gerou PIX e não pagou",
          what: 'Grupo "Saques e pendências": só entram os jogadores que geraram um código Pix de depósito e não pagaram.',
          notes: 'O "i" ao lado de PIX, no texto do grupo, explica o termo.',
        },
        {
          anchor: "publicos.editor.saque-pendente",
          label: "Saque pendente",
          what: "Só entram os jogadores com um pedido de saque ainda não resolvido pela casa.",
        },
        {
          anchor: "publicos.editor.saque-sim",
          label: "Já sacou",
          what: "Só entram os jogadores que já sacaram pelo menos uma vez.",
        },
        {
          anchor: "publicos.editor.saque-nunca",
          label: "Nunca sacou",
          what: "Só entram os jogadores que nunca sacaram.",
        },
        {
          anchor: "publicos.editor.nivel",
          label: "Nível (Bronze, Prata, Ouro, Diamante, Black VIP)",
          what: "Uma opção por nível de fidelização; escolher uma filtra o público para só esse nível. Combina com o tempo sem depositar.",
          notes: 'Some quando "Nunca depositou" está marcado. A âncora do tour marca só Bronze.',
        },
        {
          anchor: "publicos.editor.tempo-sem-depositar",
          label: "Tempo sem depositar (Esfriando, Dormindo, 30+ dias, 90+ dias)",
          what: 'Faixas prontas de tempo desde o último depósito: "Quanto mais escura a bolinha, mais tempo parado. Ou digite os dias."',
          notes: 'Some quando "Nunca depositou" está marcado. A âncora do tour marca só Esfriando.',
        },
        {
          anchor: "publicos.editor.dias-personalizado",
          label: "Campo de dias",
          what: 'Um número de dias sem depositar à sua escolha, no lugar de uma faixa pronta. Mostra "dias ou mais" ao lado enquanto vazio.',
          notes: "Preencher este campo desmarca a faixa pronta, e vice-versa.",
        },
        {
          anchor: "publicos.editor.limpar-dias",
          label: "Limpar (campo de dias)",
          what: 'Aparece só com o campo de dias preenchido; apaga o valor e volta o tempo sem depositar para "qualquer".',
        },
        {
          anchor: "publicos.editor.cadastro-ontem",
          label: "Cadastrou ontem",
          what: 'Grupo "Cadastro e bônus": só entram os jogadores que se cadastraram ontem, no dia inteiro (00:00 a 23:59, horário de Brasília).',
          notes:
            'Quando vira o dia, quem se cadastrou anteontem sai e entram os cadastros do novo "ontem". Com "Nunca depositou", forma o público "cadastrou ontem e não depositou".',
        },
        {
          anchor: "publicos.editor.cashback",
          label: "Recebeu cashback",
          what: "Só entram os jogadores que já receberam algum cashback (bônus de devolução).",
        },
        {
          anchor: "publicos.editor.dias-sem-entrar",
          label: "Mais filtros — Dias sem entrar",
          what: 'Fica em "Mais filtros" (recolhido). Só entram os jogadores que não acessam a casa há pelo menos esse número de dias; vazio mostra "Sem limite".',
          notes: "Se já tiver um valor, o bloco abre sozinho.",
        },
        {
          anchor: "publicos.editor.dias-desde-cadastro",
          label: "Mais filtros — Dias desde o cadastro",
          what: "Só entram os jogadores cadastrados há pelo menos esse número de dias.",
        },
        {
          anchor: "publicos.editor.previa",
          label: "Contagem ao vivo (rodapé)",
          what: 'Recalcula a cada mudança nas regras: "Calculando…" enquanto espera e, pronta, "N jogadores · N com celular", com um resumo curto das regras embaixo.',
          notes:
            'Quando há jogadores sem telefone válido, o resumo acrescenta "N sem telefone válido ficam de fora do SMS" — a contagem conta todos, mas só quem tem telefone válido recebe o SMS.',
        },
        {
          anchor: "publicos.editor.salvar",
          label: "Salvar público / Salvar alterações",
          what: 'Grava o público e fecha o painel. O texto muda para "Salvar alterações" ao editar um já existente.',
          notes:
            'Fica desabilitado sem nome, enquanto salva ou enquanto a contagem ainda está calculando. Ao salvar, aparece "Público criado" ou "Público atualizado"; se o servidor recusar, aparece a mensagem de erro dele.',
        },
        {
          anchor: "publicos.editor.cancelar",
          label: "Cancelar",
          what: "Fecha o painel sem salvar.",
        },
      ],
    },
  ],

  states: [
    {
      id: "contagem-calculando",
      title: "Contando os públicos",
      what: 'Enquanto a tela conta os públicos, a contagem de cada linha aparece como uma barra cinza pulsando; o botão "Recontar" mostra "Contando…".',
    },
    {
      id: "contagem-erro",
      title: "Sem contagem agora",
      what: 'Aparece no lugar da contagem de um público quando o cálculo dele falha. O público continua usável; "Recontar" tenta de novo.',
    },
    {
      id: "previa-calculando",
      title: "Calculando…",
      what: "Mostrado no rodapé do editor enquanto o CRM recalcula quantos jogadores atendem às regras escolhidas.",
    },
    {
      id: "previa-erro",
      title: "Não foi possível contar",
      what: 'Mostrado no rodapé do editor quando o cálculo falha; o texto completo é "Não foi possível contar: " seguido da mensagem de erro do servidor.',
    },
    {
      id: "lista-carregando",
      title: "Carregando públicos…",
      what: 'Texto mostrado no lugar da lista "Seus públicos" na primeira vez que ela carrega.',
    },
    {
      id: "lista-atualizando",
      title: "Atualizando públicos…",
      what: "Aparece com um ícone girando acima da lista já carregada, quando ela está sendo recarregada — por exemplo, logo depois de salvar ou excluir um público.",
    },
    {
      id: "lista-erro",
      title: "Não foi possível carregar os públicos",
      what: 'Mostrado no lugar da lista quando a busca falha, seguido da mensagem de erro do servidor e do botão "Tentar novamente".',
    },
    {
      id: "lista-vazia",
      title: "Você ainda não criou públicos.",
      what: 'Mostrado no lugar de "Seus públicos" quando a casa ainda não tem nenhum público salvo.',
      action: 'Toque em "Criar meu primeiro público" (ou "Novo público", no topo).',
    },
  ],

  // v2 (2026-11-26): filtros "Já fez 2 depósitos" e "Já fez 3 depósitos".
  tourVersion: 2,
  tours: {
    default: [
      {
        anchor: "publicos.automaticos.cartao",
        title: "Prontos para usar",
        body: "Estes públicos o CRM mantém sozinho. Cada um mostra quantos jogadores tem agora e quantos têm celular.",
        articleSection: "automaticos",
      },
      {
        anchor: "publicos.automaticos.niveis",
        title: "Por nível",
        body: "Toque num nível para mandar uma campanha só para ele.",
        articleSection: "automaticos",
      },
      {
        anchor: "publicos.lista.usar-campanha",
        title: "Usar na campanha",
        body: 'Qualquer público salvo vai direto para uma campanha nova pelo botão "Usar".',
        articleSection: "seus-publicos",
      },
      {
        anchor: "publicos.lista.menu",
        title: "Editar, duplicar ou excluir",
        body: 'No "⋯" de cada público você edita as regras, duplica para ajustar ou exclui.',
        articleSection: "seus-publicos",
      },
      {
        anchor: "publicos.novo",
        title: "Criar um público",
        body: 'Monte um grupo com as regras que quiser. A contagem atualiza na hora, antes de salvar. Novos filtros: "Já fez 2 depósitos" e "Já fez 3 depósitos".',
        articleSection: "editor",
      },
    ],
  },
};

export default screen;
