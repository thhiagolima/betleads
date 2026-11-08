// Help article for "Conta e equipe" (/tenants), só a visão de quem NÃO é
// super admin: a tela mostra a casa atual (a do cabeçalho), em 7 abas
// (hash na URL: #visao-geral, #equipe, #saldo, #cobranca, #relatorios,
// #historico, #configuracao). As partes só de super admin (lista de casas à
// esquerda, "Nova casa", "Ajustar saldo", "Preço SMS", os cartões de
// cobrança da aba Cobrança e a opção "Admin" no papel) não entram aqui.
// Fonte: src/routes/tenants.tsx (TenantWorkspace e as 7 abas),
// src/lib/tenants.functions.ts (erros do servidor), src/lib/house-member-roles.ts
// (EXPERT_MEMBER_GUARD), src/components/billing/wallet-usage-panels.tsx
// (MonthUsageCard/CurrentPricesCard, âncoras "carteira.*" compartilhadas com
// /plano-e-creditos — veja plano-creditos.ts), src/components/demo-disabled-tooltip.tsx.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "conta-equipe",
  route: "/tenants",
  defaultTab: "visao-geral",
  title: "Conta e equipe",
  purpose:
    "Os dados da sua casa, quem faz parte da equipe e o papel de cada um, o saldo de créditos, a cobrança, alguns números de uso e o histórico de alterações administrativas.",
  roles: ["admin", "gestor", "member"],
  sections: [
    // ---------------------------------------------------------------
    // Topo — aparece em toda aba
    // ---------------------------------------------------------------
    {
      id: "resumo",
      title: "Topo da tela (aparece em todas as abas)",
      intro:
        "Fica acima das abas e não muda quando você troca de aba: o botão de atualizar, os 4 números-resumo e as próprias abas.",
      items: [
        {
          anchor: "conta.header.atualizar",
          label: "Atualizar",
          what: "Busca de novo os dados desta tela (equipe, saldo, relatórios e histórico) no servidor.",
          notes:
            "Útil depois de uma mudança feita por outra pessoa, ou depois de pedir um ajuste à equipe da plataforma (saldo, cobrança), para ver o resultado sem precisar recarregar a página inteira.",
        },
        {
          anchor: "conta.resumo.cartoes",
          label: "Os 4 cartões (Equipe, Saldo, Jogadores, Comprado)",
          what: '"Equipe" é quantas pessoas têm acesso à casa; "Saldo" é o saldo de créditos disponível agora (e mostra "Isenta ·" antes do consumido quando a casa não paga por uso); "Jogadores" é o total na base da casa; "Comprado" é o total histórico comprado em créditos, desde o início.',
          notes:
            'O saldo e o comprado aqui são os mesmos números da aba "Saldo SMS" e da tela "Plano e créditos" — é a mesma carteira, mostrada em lugares diferentes.',
        },
        {
          anchor: "conta.abas",
          label: "Abas",
          what: "Visão geral, Equipe, Saldo SMS, Cobrança, Relatórios, Histórico e Configuração. A aba escolhida fica na URL (depois do #), então um link direto para uma aba funciona.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Visão geral
    // ---------------------------------------------------------------
    {
      id: "visao-geral",
      title: "Visão geral",
      tab: "visao-geral",
      intro: "Um resumo só de leitura dos dados da casa e da saúde operacional dela.",
      items: [
        {
          anchor: "conta.visao.dados",
          label: "Dados da casa",
          what: 'Nome, Status (badge "ativa"/"teste"/"suspensa"/"cancelada"), Plano (Starter/Pro/Enterprise/Interno), Modelo CRM (CRM Plataforma ou, em casas antigas, CRM Expert) e Criada em.',
        },
        {
          anchor: "conta.visao.saude",
          label: "Saúde operacional",
          what: 'Quatro linhas "ok"/"atenção": Saldo disponível (saldo de créditos maior que zero), Administrador na equipe (existe pelo menos uma pessoa com o papel admin), Meta conectada (pelo menos uma conta do Meta/Facebook ligada) e Eventos da casa chegando (a casa recebeu algum evento de depósito/saque/cadastro nos últimos 30 dias).',
          notes:
            'No lugar da "Margem estimada por SMS" (só do super admin), você vê o texto "Mudanças de status, plano e valores da casa são feitas pela equipe da plataforma."',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Equipe
    // ---------------------------------------------------------------
    {
      id: "equipe",
      title: "Equipe",
      tab: "equipe",
      intro:
        'Quem tem acesso a esta casa e o papel de cada um. Só quem é administrador desta casa (ou gestor do grupo da casa, quando a casa pertence a um grupo) pode adicionar, trocar papel e remover — gestor e membro só veem a lista.',
      items: [
        {
          label: "Tabela da equipe",
          what: 'Colunas Pessoa (e-mail, ou "Sem e-mail cadastrado" se o login não tiver um), Papel, Último acesso, Status ("ativo" ou "bloqueado", quando a conta está suspensa no login) e Ações.',
          notes: 'Lista vazia mostra "Ninguém na equipe ainda."',
        },
        {
          anchor: "conta.equipe.adicionar",
          label: "Adicionar pessoa",
          what: 'Abre o diálogo "Adicionar pessoa à equipe": campos E-mail, Papel (Membro ou Gestor — "Admin" só aparece para o super admin) e "Senha inicial opcional" (mínimo 8 caracteres), com os botões "Cancelar" e "Adicionar".',
          roles: ["admin"],
          notes:
            'Se o e-mail ainda não tem login, um é criado: sem senha, a pessoa recebe um convite por e-mail; com senha, o login já fica pronto (a pessoa troca a senha no primeiro acesso). Erros possíveis: um administrador comum (não super admin) que preencher a senha recebe "Convites de tenant devem ser enviados por email, sem senha manual" — a senha manual é só para o super admin; se o e-mail já for de um expert desta casa, o erro é "Esta pessoa é expert desta casa. Gerencie o acesso dela em Experts." Dá sucesso com "Pessoa adicionada à equipe".',
        },
        {
          anchor: "conta.equipe.papel",
          label: "Papel (seletor por linha)",
          what: "Membro ou Gestor (o admin comum não pode promover ninguém a Admin nem trocar o papel de outro admin — essas ações ficam travadas para a equipe da plataforma ou o gestor do grupo). Repete-se em cada pessoa; a âncora marca só a primeira linha.",
          roles: ["admin"],
          notes:
            'Numa pessoa com o papel expert, este seletor é trocado por um texto travado com "Gerencie em Experts" embaixo — o papel de um expert nunca é alterado por aqui. Troca com sucesso mostra "Papel atualizado".',
        },
        {
          anchor: "conta.equipe.remover",
          label: "Remover (ícone de lixeira, por linha)",
          what: 'Pede confirmação: "Remover pessoa da equipe?", com o texto "<pessoa> perde o acesso a esta casa imediatamente. O login continua existindo e a pessoa pode ser convidada de novo depois." e os botões "Cancelar" e "Remover". Repete-se em cada linha; a âncora marca só a primeira.',
          roles: ["admin"],
          notes:
            'Erros possíveis: "Não é permitido remover o último usuário do tenant" (a casa ficaria sem ninguém); "Você não pode remover seu próprio acesso por aqui" (tentou remover a própria linha); "Apenas o super admin ou o gestor do grupo pode remover o admin da casa" (tentou remover outro administrador). Numa pessoa expert, este botão aparece desabilitado com "Gerencie em Experts" embaixo. Sucesso mostra "Pessoa removida da equipe".',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Saldo SMS
    // ---------------------------------------------------------------
    {
      id: "saldo",
      title: "Saldo SMS",
      tab: "saldo",
      intro:
        "O preço por SMS da casa e o mesmo resumo de consumo/preços/extrato da tela \"Plano e créditos\" — veja o artigo dessa tela para o detalhe de cada número.",
      items: [
        {
          label: "Preço por SMS",
          what: "O preço cobrado por SMS enviado por esta casa.",
          notes:
            "Ajustar o saldo manualmente ou definir um preço individual para a casa são ações só do super admin; no lugar delas você vê \"Ajustes de saldo e preço individual são feitos pela equipe da plataforma.\"",
        },
        {
          anchor: "carteira.consumo-mes",
          label: "Consumo do mês",
          what: "Unidades usadas em SMS, Voz, E-mail e Web Push neste mês, com o valor já cobrado de cada canal (e a franquia mensal grátis, quando o canal tiver uma).",
        },
        {
          anchor: "carteira.precos-vigentes",
          label: "Preços vigentes",
          what: "Uma linha por canal com o preço unitário e a franquia mensal (\"-\" quando o canal não tem franquia).",
        },
        {
          anchor: "conta.saldo.extrato",
          label: "Extrato",
          what: 'Até 50 movimentações mais recentes da carteira: Quando, Tipo (Compra, Ajuste, Consumo, Estorno ou Conversão de créditos), Canal, Valor (verde quando soma saldo, vermelho quando consome) e Saldo (depois daquela movimentação).',
          notes: 'Sem nenhuma movimentação ainda, mostra "Nenhuma movimentação ainda."',
        },
        {
          anchor: "conta.saldo.pedidos",
          label: "Pedidos de compra",
          what: 'Cada pedido de compra de créditos por Pix: identificador, data, Status (Pago, Pendente, Em aberto, Processando, Cancelado, Falhou, Expirado ou Reembolsado), Créditos e Valor.',
          notes: 'Sem nenhum pedido ainda, mostra "Nenhum pedido de crédito."',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Cobrança
    // ---------------------------------------------------------------
    {
      id: "cobranca",
      title: "Cobrança",
      tab: "cobranca",
      intro: "Gerenciar a cobrança da casa (mensalidade, vencimento, descontos) é uma ação só do super admin.",
      items: [
        {
          label: "Aviso da aba",
          what: '"A cobrança desta casa é gerenciada pela equipe da plataforma." — a mensalidade em si você paga e acompanha em "Plano e créditos", não aqui.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Relatórios
    // ---------------------------------------------------------------
    {
      id: "relatorios",
      title: "Relatórios",
      tab: "relatorios",
      intro: "Alguns números de uso da casa nos últimos 30 dias, só para consulta.",
      items: [
        {
          anchor: "conta.relatorios.cartoes",
          label: "Os 5 cartões",
          what: "SMS enviados em 30 dias, E-mails enviados em 30 dias, Ligações em 30 dias, Eventos recebidos em 30 dias (depósitos, saques, cadastros que a casa mandou para o CRM) e Contas Meta conectadas.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Histórico
    // ---------------------------------------------------------------
    {
      id: "historico",
      title: "Histórico",
      tab: "historico",
      intro: "O registro de alterações administrativas feitas nesta casa (por alguém da equipe, ou pela plataforma).",
      items: [
        {
          anchor: "conta.historico.tabela",
          label: "Tabela de histórico",
          what: 'Colunas Quando, Ação (por exemplo "Casa criada", "Pessoa adicionada à equipe", "Papel alterado", "Saldo ajustado", "Mensalidade personalizada"...), O que mudou (o tipo de registro afetado, como "Equipe" ou "Saldo"), Quem (o e-mail de quem fez, "Equipe da plataforma" quando foi o super admin, ou "Sistema" quando foi automático) e Detalhes.',
          notes: 'Sem nenhuma alteração registrada, mostra "Nenhuma alteração administrativa registrada."',
        },
        {
          anchor: "conta.historico.detalhes",
          label: '"ver detalhes" (por linha)',
          what: "Expande e mostra, em formato técnico (JSON), os dados de antes, de depois e o contexto daquela alteração. Repete-se em cada linha; a âncora marca só a primeira.",
          notes:
            "É um registro bruto, pensado para investigar um caso específico, não para leitura corrida — para o dia a dia, a coluna Ação já resume o que aconteceu.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Configuração
    // ---------------------------------------------------------------
    {
      id: "configuracao",
      title: "Configuração",
      tab: "configuracao",
      intro: 'Só o Nome da casa pode ser alterado por aqui; os demais campos ficam travados para a equipe da plataforma.',
      items: [
        {
          anchor: "conta.config.nome",
          label: "Nome",
          what: "O nome da casa, como aparece em toda a tela do CRM.",
          roles: ["admin"],
        },
        {
          label: "Status, Plano, Modelo CRM e Moeda (campos desabilitados)",
          what: 'Status ("Ativa"/"Teste"/"Suspensa"/"Cancelada"), Plano (Starter/Pro/Enterprise/Interno), Modelo CRM (CRM Plataforma; "CRM Expert (descontinuado)" só aparece, travado, numa casa que já estava nesse modelo) e Moeda — todos aparecem preenchidos, mas só o super admin pode alterá-los.',
        },
        {
          anchor: "conta.config.salvar",
          label: "Salvar configuração",
          what: "Grava o novo nome da casa.",
          roles: ["admin"],
          notes:
            'Fica desabilitado com o Nome em branco. Um gestor ou membro consegue digitar no campo Nome (ele não trava por papel), mas o servidor recusa a gravação com "Sem permissão para gerenciar esta casa" — só administrador da casa (ou super admin) pode de fato salvar. Sucesso mostra "Casa atualizada".',
        },
      ],
    },
  ],

  states: [
    {
      id: "sem-casa",
      title: "Nenhuma casa encontrada",
      what: 'Mostrado no lugar da tela quando sua conta ainda não está ligada a nenhuma casa ("Sua conta ainda não está ligada a nenhuma casa.").',
      action: "Peça para ser convidado para uma casa.",
    },
    {
      id: "equipe-vazia",
      title: "Ninguém na equipe ainda.",
      what: "Texto mostrado na tabela de Equipe quando a casa não tem nenhuma pessoa cadastrada.",
    },
    {
      id: "extrato-vazio",
      title: "Nenhuma movimentação ainda.",
      what: "Texto mostrado no Extrato da aba Saldo SMS quando a carteira nunca teve uma movimentação.",
    },
    {
      id: "pedidos-vazio",
      title: "Nenhum pedido de crédito.",
      what: "Texto mostrado em Pedidos de compra quando a casa nunca comprou créditos.",
    },
    {
      id: "historico-vazio",
      title: "Nenhuma alteração administrativa registrada.",
      what: "Texto mostrado no Histórico quando não há nenhum registro de alteração administrativa.",
    },
    {
      id: "pessoa-bloqueada",
      title: "bloqueado",
      what: "Badge na coluna Status da Equipe: o login dessa pessoa está suspenso (banido) no sistema de autenticação.",
    },
    {
      id: "pessoa-expert",
      title: "Gerencie em Experts",
      what: 'Mostrado embaixo do papel e do botão de remover, quando a pessoa da linha é um expert desta casa — o papel e o acesso de um expert nunca são alterados nesta tela, só na área "Experts".',
      action: 'Vá para a área "Experts" para trocar o acesso dessa pessoa.',
    },
  ],

  tours: {
    "visao-geral": [
      {
        anchor: "conta.header.atualizar",
        title: "Atualizar",
        body: "Busca de novo os dados da tela — útil depois de pedir um ajuste à equipe da plataforma.",
        articleSection: "resumo",
      },
      {
        anchor: "conta.resumo.cartoes",
        title: "Resumo",
        body: "Equipe, Saldo, Jogadores e Comprado — os mesmos números aparecem nas abas Equipe e Saldo SMS.",
        articleSection: "resumo",
      },
      {
        anchor: "conta.abas",
        title: "Abas",
        body: "Visão geral, Equipe, Saldo SMS, Cobrança, Relatórios, Histórico e Configuração.",
        articleSection: "resumo",
      },
      {
        anchor: "conta.visao.dados",
        title: "Dados da casa",
        body: "Nome, status, plano, modelo CRM e data de criação, só para consulta.",
        articleSection: "visao-geral",
      },
      {
        anchor: "conta.visao.saude",
        title: "Saúde operacional",
        body: "Saldo, administrador na equipe, Meta conectada e eventos chegando — um \"ok\"/\"atenção\" rápido.",
        articleSection: "visao-geral",
      },
    ],
    equipe: [
      {
        anchor: "conta.equipe.adicionar",
        title: "Adicionar pessoa",
        body: "Convida alguém por e-mail (ou cria um login com senha, se você for super admin) e escolhe o papel.",
        articleSection: "equipe",
      },
      {
        anchor: "conta.equipe.papel",
        title: "Papel",
        body: "Membro ou Gestor. Só a equipe da plataforma (ou o gestor do grupo) pode nomear/trocar um administrador.",
        articleSection: "equipe",
      },
      {
        anchor: "conta.equipe.remover",
        title: "Remover",
        body: "Tira o acesso dessa pessoa à casa, com confirmação antes.",
        articleSection: "equipe",
      },
    ],
    saldo: [
      {
        anchor: "carteira.consumo-mes",
        title: "Consumo do mês",
        body: "Quanto a casa já usou de cada canal este mês, e quanto foi cobrado.",
        articleSection: "saldo",
      },
      {
        anchor: "carteira.precos-vigentes",
        title: "Preços vigentes",
        body: "O preço unitário e a franquia mensal de cada canal.",
        articleSection: "saldo",
      },
      {
        anchor: "conta.saldo.extrato",
        title: "Extrato",
        body: "As movimentações mais recentes da carteira: compras, consumo, ajustes e estornos.",
        articleSection: "saldo",
      },
      {
        anchor: "conta.saldo.pedidos",
        title: "Pedidos de compra",
        body: "Cada pedido de compra de créditos por Pix, com o status de pagamento.",
        articleSection: "saldo",
      },
    ],
    relatorios: [
      {
        anchor: "conta.relatorios.cartoes",
        title: "Números dos últimos 30 dias",
        body: "SMS, e-mails, ligações e eventos recebidos, mais as contas Meta conectadas.",
        articleSection: "relatorios",
      },
    ],
    historico: [
      {
        anchor: "conta.historico.tabela",
        title: "Histórico de alterações",
        body: "Quem mudou o quê nesta casa, e quando.",
        articleSection: "historico",
      },
      {
        anchor: "conta.historico.detalhes",
        title: "Ver detalhes",
        body: "Abre os dados técnicos (antes/depois) daquela alteração, para investigar um caso específico.",
        articleSection: "historico",
      },
    ],
    configuracao: [
      {
        anchor: "conta.config.nome",
        title: "Nome da casa",
        body: "O único campo que um administrador da casa pode alterar por aqui.",
        articleSection: "configuracao",
      },
      {
        anchor: "conta.config.salvar",
        title: "Salvar configuração",
        body: "Grava o novo nome. Os demais campos ficam com a equipe da plataforma.",
        articleSection: "configuracao",
      },
    ],
  },
};

export default screen;
