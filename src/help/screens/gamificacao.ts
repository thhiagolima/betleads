// Help article for "Níveis e fidelização" (/gamificacao). Uma única tela sem
// abas: a faixa dos 6 níveis, "VIPs que pararam de depositar", o ranking "Quem
// mais depositou" (busca/filtro/ordenação/paginação) e, ao lado, "Faixas e
// regras" (os limites de cada nível e as regras de Esfriando/Dormindo/VIP).
// "/regras" só redireciona para "/gamificacao" (src/routes/regras.tsx) — por
// isso está em EXCLUDED_ROUTES, não aqui. Fonte: src/routes/gamificacao.tsx,
// src/components/gamification/level-sections.tsx e level-rules.ts, e as
// mensagens de erro/validação de src/lib/gamification.functions.ts. A regra de
// nível/situação do jogador é a mesma usada em /players (src/lib/player-level.ts,
// src/lib/player-situation.ts).
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "gamificacao",
  route: "/gamificacao",
  title: "Níveis e fidelização",
  purpose:
    "O nível de cada jogador (Novato a Black VIP, pelo total depositado), quem são os VIPs que pararam de depositar, o ranking de quem mais depositou e as faixas/regras que definem os níveis e quando um jogador está esfriando, dormindo ou é considerado VIP.",
  roles: ["admin", "gestor", "member"],
  sections: [
    // ---------------------------------------------------------------
    // Cabeçalho
    // ---------------------------------------------------------------
    {
      id: "cabecalho",
      title: "Cabeçalho",
      intro:
        'Abaixo do título "Níveis e fidelização" aparece sempre a mesma frase: "O nível de cada jogador vem do total que ele já depositou."',
      items: [
        {
          anchor: "gamificacao.cabecalho.criar-campanha",
          label: "Criar campanha",
          what: "Abre o compositor de campanhas (tela Campanhas) já pronto para criar uma nova campanha.",
        },
        {
          anchor: "gamificacao.cabecalho.atualizar",
          label: "Atualizar dados",
          what: "Busca de novo os níveis, os VIPs parados e o ranking, sem recarregar a página.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Faixa dos 6 níveis
    // ---------------------------------------------------------------
    {
      id: "niveis",
      title: "Níveis de jogadores",
      intro:
        "Um cartão por nível — Novato, Bronze, Prata, Ouro, Diamante e Black VIP — na ordem de quem depositou menos para quem depositou mais. O nível de um jogador é só o total que ele já depositou na casa comparado às faixas definidas em \"Faixas e regras\"; não depende de quando ele depositou, nem de estar ativo, esfriando ou dormindo.",
      items: [
        {
          label: "Quantidade e % da base (por nível)",
          what: 'Quantos jogadores estão nesse nível agora e qual % eles são do total de jogadores da casa (por exemplo "412" e "18% da base").',
        },
        {
          label: "Faixa de depósito (por nível)",
          what: 'A faixa de total depositado daquele nível, na moeda da casa — por exemplo "R$ 10 a R$ 200" para Bronze, "abaixo de R$ 10" para Novato, ou "R$ 3.000 ou mais" para Black VIP. Vem direto das faixas cadastradas em "Faixas e regras".',
        },
        {
          anchor: "gamificacao.niveis.ver-jogadores",
          label: "Ver jogadores",
          what: "Leva para a tela Jogadores.",
          notes:
            'Hoje este link não filtra pelo nível do cartão clicado: ele sempre abre a tela Jogadores sem nenhum filtro aplicado, mostrando todos os jogadores da casa — é preciso filtrar por nível manualmente lá. Repete-se em cada um dos 6 cartões; a âncora marca só o primeiro (Novato).',
        },
      ],
    },

    // ---------------------------------------------------------------
    // VIPs que pararam de depositar
    // ---------------------------------------------------------------
    {
      id: "vip",
      title: "VIPs que pararam de depositar",
      intro:
        'Jogadores do nível configurado em "VIP a partir de" (ou acima) que não depositam há pelo menos os dias configurados em "Esfriando após" — ou seja, já esfriaram ou já dormiram. Mostra até 8 jogadores, do que depositou mais para o que depositou menos.',
      items: [
        {
          label: "Frase de contagem",
          what: 'Quantos VIPs pararam, no formato "N jogador(es) de <nível mínimo> para cima sem depositar há <dias> dias ou mais" — os números vêm de "VIP a partir de" e "Esfriando após", em "Faixas e regras".',
        },
        {
          anchor: "gamificacao.vip.criar-campanha",
          label: "Criar campanha",
          what: "Abre o compositor de campanhas, igual ao do cabeçalho.",
          notes: "Só aparece quando existe pelo menos um VIP parado.",
        },
        {
          anchor: "gamificacao.vip.linha",
          label: "Linha do jogador (VIP parado)",
          what: 'Nome, total depositado, o selo do nível e "último depósito há N dias" (ou "sem depósito", ou "depositou hoje"). Clique na linha para abrir a ficha do jogador.',
          notes:
            "Ao contrário da linha do ranking \"Quem mais depositou\", aqui não aparece a situação (Esfriando/Dormindo) ao lado do nível — já está implícito em estar nesta lista. Repete-se em cada jogador da lista; a âncora marca só o primeiro.",
        },
        {
          anchor: "gamificacao.vip.ver-todos",
          label: "Ver todos que pararam no ranking",
          what: 'Rola a tela até "Quem mais depositou" e já aplica o filtro "Só quem parou" nele, para ver a lista completa (sem o limite de 8).',
          notes: "Só aparece quando há mais VIPs parados do que os 8 mostrados aqui.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Quem mais depositou
    // ---------------------------------------------------------------
    {
      id: "ranking",
      title: "Quem mais depositou",
      intro:
        "O ranking de todos os jogadores da casa por total depositado. Sem nenhum filtro aplicado, mostra os 200 maiores depositantes da base, lidos do snapshot (atualizado a cada atualização de dados); com busca, nível ou \"Só quem parou\", a consulta passa a procurar na base inteira da casa, não só nesses 200.",
      items: [
        {
          anchor: "gamificacao.ranking.busca",
          label: "Buscar jogador (campo de busca)",
          what: 'Filtra por nome, telefone ou ID do jogador (o campo mostra "Nome, telefone ou ID"). A busca espera você parar de digitar por um instante antes de procurar.',
        },
        {
          anchor: "gamificacao.ranking.nivel",
          label: "Filtrar por nível",
          what: '"Todos os níveis" ou um nível específico (Novato, Bronze, Prata, Ouro, Diamante, Black VIP).',
        },
        {
          anchor: "gamificacao.ranking.ordenar",
          label: "Ordenar",
          what: '"Mais depositaram" (padrão), "Mais tempo parados" (do maior para o menor número de dias sem depósito) ou "Nome" (ordem alfabética).',
          notes:
            "A ordenação é aplicada só na lista já carregada na tela (os 200 maiores, com ou sem filtro) — não muda quais 200 jogadores aparecem, só a ordem deles.",
        },
        {
          anchor: "gamificacao.ranking.so-parou",
          label: "Só quem parou",
          what: "Mostra só jogadores que não estão ativos: sem nenhum depósito, ou cujo último depósito (ou o primeiro, se nunca houve outro) foi há pelo menos os dias de \"Esfriando após\".",
          notes: 'Fica destacado enquanto ligado. Ligar qualquer filtro (busca, nível ou este) volta a página 1 da lista automaticamente.',
        },
        {
          label: 'Linha de contagem ("Buscando na base…" / "X–Y de N jogadores")',
          what: 'Enquanto uma busca com filtro está em andamento, mostra "Buscando na base…". Sem isso, mostra o intervalo visível e o total, por exemplo "1–10 de 200 jogadores"; quando o total real da base é maior que os 200 trazidos, soma " · os 200 maiores de N que atendem ao filtro" (com filtro) ou " · os 200 maiores de N na base" (sem filtro).',
        },
        {
          anchor: "gamificacao.ranking.ver-todos-jogadores",
          label: "Ver todos em Jogadores",
          what: "Leva para a tela Jogadores, para ver a base completa sem o limite de 200.",
          notes: 'Só aparece junto da linha de contagem quando o total real é maior do que os 200 (ou menos) jogadores mostrados.',
        },
        {
          anchor: "gamificacao.ranking.linha",
          label: "Linha do jogador (ranking)",
          what: 'Posição (1º, 2º...), nome, total depositado, o selo do nível, a situação (Ativo/Esfriando/Dormindo/Sem depósito) e "último depósito há N dias" (ou "sem depósito"/"depositou hoje"). Clique na linha para abrir a ficha do jogador.',
          notes: "Repete-se em cada jogador visível na página atual; a âncora marca só o primeiro.",
        },
        {
          anchor: "gamificacao.ranking.pagina-anterior",
          label: "Página anterior",
          what: "Volta uma página na lista.",
          notes: 'Fica desabilitado na primeira página. Só aparece quando a lista tem mais de uma página (mais de 10 jogadores visíveis).',
        },
        {
          anchor: "gamificacao.ranking.pagina",
          label: "Número da página",
          what: "Vai direto para aquela página. A página atual aparece destacada.",
          notes:
            'Com muitas páginas, os números do meio são resumidos com "…", mostrando sempre a primeira, a última e as páginas perto da atual. Repete-se por página; a âncora marca só o primeiro botão de número mostrado.',
        },
        {
          anchor: "gamificacao.ranking.proxima-pagina",
          label: "Próxima página",
          what: "Avança uma página na lista.",
          notes: "Fica desabilitado na última página.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Faixas e regras
    // ---------------------------------------------------------------
    {
      id: "regras",
      title: "Faixas e regras",
      intro:
        "Define os limites de depósito de cada nível pago e as regras de Esfriando, Dormindo e VIP usadas em toda a tela (e também na ficha do jogador e nos filtros de Jogadores). Só é gravado quando você clica em Salvar — editar os campos não muda nada até esse clique.",
      items: [
        {
          anchor: "gamificacao.regras.limite",
          label: "Total depositado para entrar no nível (Bronze / Prata / Ouro / Diamante / Black VIP)",
          what: "Os 5 limites de total depositado que definem onde cada nível pago começa, na moeda da casa. Um jogador que nunca atingiu o limite de Bronze é Novato.",
          notes:
            'Cada nível vale a partir do seu próprio limite até o limite do próximo (o de Black VIP não tem limite de cima). Repete-se nos 5 campos (Bronze, Prata, Ouro, Diamante, Black VIP); a âncora marca só o primeiro (Bronze).',
        },
        {
          anchor: "gamificacao.regras.esfriando",
          label: "Esfriando após",
          what: "Depois de quantos dias sem depositar (desde o último depósito, ou desde o primeiro depósito se nunca houve outro) um jogador passa a contar como \"Esfriando\".",
          notes: 'O campo mostra o texto fixo "dias sem depositar" ao lado do número.',
        },
        {
          anchor: "gamificacao.regras.dormindo",
          label: "Dormindo após",
          what: 'Depois de quantos dias sem depositar um jogador passa a contar como "Dormindo" (substitui o status "Esfriando").',
          notes: 'Também mostra "dias sem depositar" ao lado do número. Precisa ser maior ou igual ao valor de "Esfriando após".',
        },
        {
          anchor: "gamificacao.regras.vip-min",
          label: "VIP a partir de",
          what: 'A partir de qual nível (Bronze a Black VIP) um jogador conta como "VIP" para o cartão "VIPs que pararam de depositar".',
        },
        {
          anchor: "gamificacao.regras.salvar",
          label: "Salvar / Tudo salvo",
          what: 'Grava as faixas e as regras. O botão mostra "Salvar" enquanto há alguma alteração não salva, "Salvando…" durante a gravação, e "Tudo salvo" (desabilitado) quando o que está na tela já é igual ao que foi salvo.',
          notes:
            'Erros possíveis ao salvar: "As faixas precisam ser crescentes: Bronze < Prata < Ouro < Diamante < Black VIP." (algum limite ficou igual ou menor que o anterior), "Esfriando precisa ser pelo menos 1 dia." e "Dormindo precisa ser maior ou igual a Esfriando." Ao salvar com sucesso aparece "Faixas e regras salvas."; se a gravação falhar por outro motivo, aparece "Não foi possível salvar as faixas." (ou a mensagem específica do erro, quando houver uma) — inclusive "A tabela de gamificacao ainda nao foi criada. Aplique as migrations antes de salvar." quando a casa ainda não tem essa configuração criada no banco (veja o estado correspondente, mais abaixo).',
        },
        {
          label: '"O que fazer com isso" (dica)',
          what: 'Um bloco só de leitura com 3 sugestões fixas: "Black VIP e Diamante que pararam: atendimento pessoal, não disparo em massa.", "Quem subiu de nível: uma mensagem de reconhecimento no dia em que sobe." e "Novato há mais de 7 dias: cadastrou e nunca depositou; oferta de primeiro depósito, não de reativação."',
        },
      ],
    },
  ],

  states: [
    {
      id: "erro-carregar",
      title: "Não foi possível carregar os níveis",
      what: 'Tela inteira (níveis, VIPs, ranking e faixas) não carrega. Mostra também o texto "Verifique a conexão e tente de novo." e o botão "Tentar novamente".',
      action: 'Clique em "Tentar novamente"; se persistir, verifique sua conexão.',
    },
    {
      id: "vip-nenhum",
      title: "Nenhum VIP parado pela regra atual.",
      what: 'Texto mostrado em "VIPs que pararam de depositar" quando não há nenhum jogador do nível mínimo configurado parado de depositar.',
    },
    {
      id: "ranking-buscando",
      title: "Buscando na base…",
      what: 'Aparece na linha de contagem (e no lugar da lista, se ainda não há resultado) enquanto uma busca com filtro (busca, nível ou "Só quem parou") está em andamento.',
    },
    {
      id: "ranking-vazio",
      title: "Nenhum jogador encontrado.",
      what: "Nenhum jogador corresponde à busca e/ou aos filtros aplicados no ranking.",
      action: "Ajuste ou limpe a busca, o nível ou \"Só quem parou\".",
    },
    {
      id: "ranking-erro-busca",
      title: "Não foi possível buscar na base: ...",
      what: 'Mostrado no lugar da lista do ranking quando a busca com filtro falha (erro de rede ou do servidor); depois dos dois pontos aparece a mensagem do erro, ou "tente novamente." quando não há uma mensagem específica.',
      action: "Tente de novo; se persistir, verifique sua conexão.",
    },
    {
      id: "faixas-nao-crescentes",
      title: "As faixas precisam ser crescentes: Bronze < Prata < Ouro < Diamante < Black VIP.",
      what: 'Bloqueia o "Salvar" de "Faixas e regras" quando algum limite de nível não é estritamente maior que o do nível anterior.',
      action: "Ajuste os 5 campos de total depositado para cada um ser maior que o anterior.",
    },
    {
      id: "esfriando-minimo",
      title: "Esfriando precisa ser pelo menos 1 dia.",
      what: 'Bloqueia o "Salvar" quando "Esfriando após" é menor que 1.',
      action: 'Use 1 ou mais em "Esfriando após".',
    },
    {
      id: "dormindo-minimo",
      title: "Dormindo precisa ser maior ou igual a Esfriando.",
      what: 'Bloqueia o "Salvar" quando "Dormindo após" é menor que "Esfriando após".',
      action: 'Aumente "Dormindo após" até ficar igual ou maior que "Esfriando após".',
    },
    {
      id: "faixas-salvas",
      title: "Faixas e regras salvas.",
      what: 'Confirmação mostrada depois de salvar "Faixas e regras" com sucesso.',
    },
    {
      id: "faixas-erro-salvar",
      title: "Não foi possível salvar as faixas.",
      what: 'Mensagem genérica mostrada quando "Salvar" falha por um motivo sem mensagem própria (por exemplo, erro de rede).',
      action: "Tente salvar de novo; se persistir, verifique sua conexão.",
    },
    {
      id: "faixas-tabela-nao-criada",
      title: "A tabela de gamificacao ainda nao foi criada. Aplique as migrations antes de salvar.",
      what: 'Mostrado em vez de "Faixas e regras salvas." quando a casa ainda não tem a configuração de gamificação criada no banco (uma pendência de implantação, não algo que o uso normal da tela provoca).',
      action: "Fale com o suporte — é preciso aplicar uma atualização pendente no banco da casa antes de conseguir salvar.",
    },
  ],

  tours: {
    default: [
      {
        anchor: "gamificacao.cabecalho.criar-campanha",
        title: "Criar campanha",
        body: "Daqui você já pode abrir o compositor de campanhas para falar com os jogadores desta tela.",
        articleSection: "cabecalho",
      },
      {
        anchor: "gamificacao.cabecalho.atualizar",
        title: "Atualizar dados",
        body: "Busca de novo os níveis, os VIPs parados e o ranking, sem recarregar a página.",
        articleSection: "cabecalho",
      },
      {
        anchor: "gamificacao.niveis.ver-jogadores",
        title: "Níveis dos jogadores",
        body: "Cada cartão mostra quantos jogadores estão em cada nível (Novato a Black VIP) e a faixa de depósito dele. Clique em \"Ver jogadores\" para abrir a lista completa (hoje sem filtrar por este nível).",
        articleSection: "niveis",
      },
      {
        anchor: "gamificacao.ranking.busca",
        title: "Buscar jogador",
        body: "Encontre um jogador específico no ranking por nome, telefone ou ID.",
        articleSection: "ranking",
      },
      {
        anchor: "gamificacao.ranking.nivel",
        title: "Filtrar por nível",
        body: "Veja só os jogadores de um nível específico no ranking.",
        articleSection: "ranking",
      },
      {
        anchor: "gamificacao.ranking.ordenar",
        title: "Ordenar o ranking",
        body: "Troque entre quem mais depositou, quem está mais tempo parado ou ordem alfabética.",
        articleSection: "ranking",
      },
      {
        anchor: "gamificacao.ranking.so-parou",
        title: "Só quem parou",
        body: "Mostra só os jogadores que não estão ativos — já esfriaram ou já dormiram.",
        articleSection: "ranking",
      },
      {
        anchor: "gamificacao.regras.salvar",
        title: "Faixas e regras",
        body: "Ao lado, você define os limites de cada nível e as regras de Esfriando, Dormindo e VIP. Salve aqui depois de ajustar.",
        articleSection: "regras",
      },
    ],
  },
};

export default screen;
