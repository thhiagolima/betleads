// Help article for the "Relatório de rendimento" de uma pessoa, visto pelo
// admin (/rendimento/equipe/$expertId), aberto pelo nome na tela "Rendimento
// da equipe". Duas abas por um parâmetro de busca, não por hash (?aba=
// campanhas) — por isso este artigo não usa `HelpSection.tab`/`defaultTab`:
// as duas vistas (Rendimento e Campanhas) nunca aparecem juntas, então o tour
// (único, "default") cobre a vista Rendimento, que é a que abre por padrão.
// O `ReportView` é o mesmo de /rendimento e de /expert/rendimento (fase 4):
// os blocos dele usam aqui o mesmo prefixo neutro "rendimento." do artigo
// "rendimento" — ver aquele artigo para o detalhe de cada bloco (cartões,
// funil, gráfico, leads que mais depositaram, extrato, leads do período e o
// histórico do lead). Este artigo cobre só o que é específico do modo admin:
// Editar/Ativar/Desativar e a aba Campanhas (fila de aprovação). Fonte:
// src/routes/rendimento.equipe.$expertId.tsx,
// src/components/rendimento/report-view.tsx (AdminActions),
// src/components/experts/expert-campaigns-admin-view.tsx,
// src/components/experts/expert-campaigns-admin.tsx,
// src/components/experts/expert-campaigns-admin-model.ts e
// src/components/experts/expert-form-dialog.tsx.
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "rendimento-pessoa",
  route: "/rendimento/equipe/$expertId",
  title: "Relatório de rendimento",
  purpose:
    "O relatório de rendimento de uma pessoa específica da equipe, visto pelo admin: os mesmos blocos de \"Meu rendimento\", mais editar os dados da pessoa, ativar/desativar e, na aba Campanhas, revisar e aprovar os envios dela.",
  roles: ["admin"],
  terms: [
    "creditado",
    "janela-de-clique",
    "clique-x-afiliado",
    "ftd",
    "reativado",
    "redeposito",
    "teto",
    "id-de-afiliado",
  ],
  sections: [
    {
      id: "cabecalho",
      title: "Cabeçalho e ações",
      intro:
        'O nome da pessoa e o badge do tipo dela (ex.: "Expert restrito", "Expert total", "Equipe (Admin/Gestor/Membro)") ficam no título. Os blocos do relatório (cartões, funil, gráfico, leads que mais depositaram, extrato e leads do período) são os mesmos de "Meu rendimento" — ver o artigo "Meu rendimento" para o detalhe de cada um; aqui ficam só o período, o CSV e as ações do admin.',
      items: [
        {
          anchor: "rendimento.header.periodo",
          label: "Período",
          what: "Escolhe a janela do relatório desta pessoa (Hoje, Ontem, 7/30/90 dias, Este mês, Mês passado). Vale só para a aba Rendimento — a aba Campanhas não tem período.",
        },
        {
          anchor: "rendimento.header.csv",
          label: "Exportar CSV",
          what: 'Baixa o extrato de créditos completo desta pessoa no período, num arquivo "extrato-{nome da pessoa}-{de}-a-{até}.csv".',
        },
        {
          anchor: "pessoa.header.editar",
          label: "Editar",
          what: 'Abre o mesmo diálogo "Editar expert" usado na tela Experts, com os dados desta pessoa já preenchidos.',
          notes: "Desabilitado na casa demo.",
        },
        {
          anchor: "pessoa.tabs.rendimento",
          label: "Abas Rendimento / Campanhas",
          what: '"Rendimento" é a vista padrão (os blocos do relatório, descritos abaixo); "Campanhas" é a fila de aprovação desta pessoa (ver a seção "Aba Campanhas").',
        },
        {
          anchor: "pessoa.header.ativar",
          label: "Ativar / Desativar",
          what: 'Mostra "Desativar" quando a pessoa está ativa e "Ativar" quando está inativa; alterna o status ao clicar.',
          notes:
            'Desativar não apaga nenhum crédito já registrado nem some do ranking (continua lá com o badge "Inativo") — só impede novos créditos e, se for um expert com acesso, o login dele. Toast "Expert ativado" ou "Expert desativado". Desabilitado na casa demo.',
        },
      ],
    },
    {
      id: "editar",
      title: 'Diálogo "Editar expert"',
      intro: 'Aberto pelo botão "Editar" do cabeçalho, com os dados desta pessoa.',
      items: [
        {
          label: "Nome",
          what: "O nome da pessoa, mostrado no cabeçalho do relatório e no ranking da equipe.",
          notes:
            'Erros possíveis: "O nome precisa ter pelo menos 2 caracteres." e "O nome pode ter até 80 caracteres."',
        },
        {
          label: "Tipo",
          what: '"Restrito" vê só os leads que chegaram pelos IDs de afiliado dela; "Acesso total" vê todos os leads da casa. Só se aplica a quem tem login de expert — um perfil de equipe (admin/gestor/membro) continua vendo pelas regras de equipe, independente deste campo.',
        },
        {
          label: "IDs de afiliado",
          what: 'Os IDs de afiliado vinculados a esta pessoa, como chips removíveis (ícone "x" em cada um). Digite um ID e pressione Enter para adicionar; a lista de sugestões abaixo mostra IDs de afiliado da casa ainda sem expert, com a quantidade de leads de cada um.',
          notes:
            'Erros possíveis: "Esse ID já foi adicionado." e "Máximo de 20 IDs de afiliado." (limite de 20 por pessoa).',
        },
        {
          label: "Envio de campanhas",
          what: '"Livre": as campanhas desta pessoa disparam direto. "Com aprovação": cada campanha fica pendente até o admin aprovar ou recusar (aba Campanhas, abaixo).',
          notes:
            'Trocar de "Com aprovação" para "Livre" não libera sozinho as campanhas já pendentes: o aviso "N campanhas aguardando aprovação continuam pendentes: aprove ou recuse na aba Campanhas do expert." (singular "1 campanha aguardando aprovação continua pendente" com uma só) lembra que elas continuam na fila até serem decididas ali.',
        },
        {
          label: "Teto mensal",
          what: 'O limite de gasto mensal desta pessoa em campanhas (SMS, e-mail e voz somados, pelo preço cobrado da casa — ver o termo "Teto" no glossário). Vazio = sem limite; 0 = bloqueia todos os envios dela. "Vale para as campanhas do expert."',
          notes:
            'Erro possível: "Informe um valor como 1.500,00 (ou deixe vazio para sem teto)." O campo some o ponto de milhar/vírgula decimal ao perder o foco (ex.: digitar "1500" se torna "1.500,00"). Ao atingir o teto, os envios da pessoa param e ela é avisada; ver a aba Campanhas para o uso atual.',
        },
        {
          label: "Prazo para assumir lead (dias)",
          what: "Quantos dias esta pessoa tem para assumir um lead antes que ele volte a ficar disponível para outra pessoa assumir.",
          notes: 'Erro possível: "Use um número inteiro de 1 a 30."',
        },
        {
          label: "Cancelar / Salvar",
          what: 'Salvar grava as alterações (toast "Expert atualizado"); enquanto salva o botão mostra "Salvando…". Cancelar fecha sem salvar.',
          notes:
            'Fica desabilitado até o nome ser preenchido (e sem nenhum erro de validação nos outros campos).',
        },
      ],
    },
    {
      id: "campanhas",
      title: "Aba Campanhas",
      intro:
        'Acessada pela aba "Campanhas" (a aba "Rendimento" é a vista padrão, descrita acima). Mostra o modo de envio, o uso do teto mensal e a fila de campanhas desta pessoa, com aprovação, pausa e retomada. Não tem seletor de período: olha sempre os últimos 90 dias.',
      items: [
        {
          anchor: "pessoa.tabs.campanhas",
          label: "Abas Rendimento / Campanhas",
          what: 'Alterna entre o relatório de rendimento da pessoa e a fila de campanhas dela. Um número ao lado de "Campanhas" mostra quantas estão aguardando aprovação.',
        },
        {
          anchor: "pessoa.campanhas.envio",
          label: "Envio de campanhas",
          what: 'Mostra "Com aprovação" ou "Livre" (o modo atual) com uma explicação curta. "Mude em Editar, na aba Rendimento ou na tela Experts."',
        },
        {
          anchor: "pessoa.campanhas.teto",
          label: 'Uso do teto · {mês}',
          what: 'A barra de uso do teto mensal: "{usado} de {teto}" com uma barra de progresso, ou só "{usado} no mês" quando a pessoa não tem teto. O texto ao lado da barra mostra a situação: "Sem teto", "Envios bloqueados (teto R$ 0,00)", "Teto atingido" ou "X% do teto".',
          notes:
            'Com campanhas pendentes de aprovação, aparece abaixo "N campanhas aguardando aprovação, estimadas em R$ X." (singular "1 campanha aguardando"). Texto fixo: "Soma de SMS, e-mail e voz no mês, pelo preço cobrado da casa." Enquanto carrega mostra "Carregando…"; se falhar, "Não foi possível carregar o uso."',
        },
        {
          anchor: "pessoa.campanhas.fila",
          label: "Campanhas do expert (fila)",
          what: 'A tabela de campanhas desta pessoa nos últimos 90 dias: Campanha, Canal (SMS/E-mail/Voz), Status, Destinatários, Custo estimado, Criada em e Ações. As pendentes de aprovação aparecem primeiro (as mais antigas primeiro); o resto vem depois, da mais recente para a mais antiga.',
          notes:
            'Os status possíveis: Aguardando aprovação, Recusada, Rascunho, Agendada, Enfileirada, Enviando, Enviada, Concluída, Falhou, Cancelada, Pausada, Pausada pelo teto (pausada automaticamente por falta de saldo no teto) e Pausada pelo admin. Uma campanha recusada mostra o motivo abaixo do nome; uma pausada mostra o motivo da pausa. Sem nenhuma campanha, mostra "Nenhuma campanha deste expert nos últimos 90 dias."',
        },
        {
          label: "Revisar",
          what: 'Em campanhas aguardando aprovação, abre o diálogo de revisão para decidir (ver abaixo). Em campanhas já decididas sem outra ação disponível, o botão aparece como "Ver" (mesmo diálogo, sem os botões de decisão).',
          notes:
            'Erro possível, nesta ação e em Aprovar/Recusar/Pausar/Retomar: "Campanha não encontrada." — a campanha foi excluída ou é de outra casa entre a fila carregar e a ação ser feita; recarregue a fila. Numa falha sem mensagem própria do servidor, o texto genérico "Não foi possível concluir. Tente de novo." aparece no lugar.',
        },
        {
          label: "Pausar",
          what: "Pausa uma campanha de SMS/e-mail agendada ou enviando, ou de voz enfileirada. Toast \"Campanha pausada.\"",
          notes:
            'Erro possível: "Esta campanha não está em andamento ou agendada." — aparece se a campanha já tiver mudado de status (por exemplo, terminou de enviar ou já foi pausada) entre a tela carregar e você clicar; recarregue a fila para ver o status atual. Desabilitado na casa demo.',
        },
        {
          label: "Retomar",
          what: 'Retoma uma campanha pausada (inclusive pausada pelo teto, depois de o teto ser liberado ou aumentado). Toast "Campanha retomada."',
          notes:
            'Erros possíveis: "Esta campanha não está pausada." (ela já mudou de status — recarregue a fila); "O expert está desativado: a campanha não pode ser retomada." (ative a pessoa primeiro, em "Ativar" no cabeçalho); "O expert continua no teto mensal. Aumente o teto na tela Experts ou aguarde a virada do mês." (o teto mensal dela ainda não tem saldo — aumente o teto em Editar ou espere o mês virar). Desabilitado na casa demo.',
        },
      ],
    },
    {
      id: "revisao",
      title: "Diálogo de revisão da campanha",
      intro: 'Aberto por "Revisar" (ou "Ver") na fila de campanhas.',
      items: [
        {
          label: "Conteúdo da campanha",
          what: 'Mostra o canal, o status, quem criou ("por {nome}"), destinatários, custo estimado, quando envia ("Ao aprovar" ou a data/hora agendada) e o público. O conteúdo em si depende do canal: SMS mostra o texto e a quantidade de segmentos; E-mail mostra o assunto, o pré-cabeçalho e uma prévia do HTML dentro de um quadro isolado (sem rodar scripts); Voz mostra o roteiro (texto lido por voz sintética) ou o nome e a duração de um áudio gravado da biblioteca.',
          notes:
            'Numa campanha recusada, mostra o motivo da recusa; numa pausada (e não recusada), mostra o motivo da pausa.',
        },
        {
          label: "Aprovar",
          what: 'Aprova a campanha pendente: o CRM confere de novo o público, os links e o teto mensal da pessoa antes de liberar — a contagem de destinatários e o custo podem mudar em relação ao que foi visto antes. Toast "Campanha aprovada: N destinatários, custo estimado R$ X."',
          notes:
            'Erros possíveis: "Esta campanha não está aguardando aprovação." (alguém já decidiu), "A campanha mudou depois que você abriu. Recarregue e confira antes de aprovar." (o conteúdo foi editado depois que o diálogo abriu), "O expert está desativado: a campanha não pode ser aprovada.", "Nenhum jogador do seu público pode receber esta campanha." (ninguém elegível depois de reconferir) e o aviso de teto ("Esta campanha custaria cerca de R$ X, mas restam R$ Y do seu teto mensal de R$ Z. Reduza o público ou peça ao admin para aumentar o teto." — o texto fala "seu" porque é o mesmo aviso mostrado ao expert ao tentar enviar; aqui é o admin quem vê, ao tentar aprovar). Desabilitado na casa demo.',
        },
        {
          label: "Recusar",
          what: 'Abre o campo do motivo da recusa (dentro do próprio diálogo, sem navegar para outro lugar).',
          notes: 'Desabilitado na casa demo.',
        },
        {
          label: "Motivo da recusa",
          what: "Um texto livre, até 500 caracteres, que o expert vê e pode usar para corrigir e reenviar.",
          notes: 'Obrigatório — erro "Informe o motivo da recusa." em branco, ou "Use até 500 caracteres." passando do limite.',
        },
        {
          label: "Voltar / Recusar campanha",
          what: 'Voltar sai do modo de recusa sem recusar. "Recusar campanha" confirma, com o botão mostrando "Recusando…" enquanto processa. Toast "Campanha recusada. O expert vê o motivo."',
        },
        {
          label: "Cancelar / Fechar",
          what: 'Fecha o diálogo sem decidir. O botão é "Cancelar" quando a campanha ainda pode ser decidida, ou "Fechar" quando ela já foi decidida antes (revisão só para consulta).',
        },
      ],
    },
  ],

  states: [
    {
      id: "nao-admin",
      title: "Apenas o admin da casa gerencia experts.",
      what: 'Mensagem de erro mostrada no lugar do relatório (ou da aba Campanhas) quando quem acessa a URL não é admin da casa — mesmo que o id seja do próprio usuário.',
    },
    {
      id: "nao-encontrado",
      title: "Expert não encontrado.",
      what: "Mensagem de erro quando o id na URL não corresponde a nenhum perfil desta casa.",
    },
    {
      id: "carregando",
      title: "Carregando…",
      what: "Mostrado enquanto o relatório, o uso do teto ou a fila de campanhas ainda não voltaram do servidor.",
    },
  ],

  tours: {
    default: [
      {
        anchor: "rendimento.header.periodo",
        title: "Período",
        body: "Escolhe a janela do relatório desta pessoa.",
        articleSection: "cabecalho",
      },
      {
        anchor: "pessoa.header.editar",
        title: "Editar",
        body: "Abre o diálogo com os dados desta pessoa: nome, tipo, IDs de afiliado, envio de campanhas, teto mensal e prazo para assumir lead.",
        articleSection: "cabecalho",
      },
      {
        anchor: "pessoa.header.ativar",
        title: "Ativar / Desativar",
        body: "Liga ou desliga a pessoa, sem apagar o histórico de créditos já registrado.",
        articleSection: "cabecalho",
      },
      {
        anchor: "pessoa.tabs.campanhas",
        title: "Aba Campanhas",
        body: "Mostra o modo de envio, o uso do teto mensal e a fila de campanhas desta pessoa para aprovar, recusar, pausar ou retomar.",
        articleSection: "campanhas",
      },
      {
        anchor: "rendimento.cards",
        title: "Resultado do período",
        body: "Depositado creditado, FTDs, Redepósitos e Reativados desta pessoa.",
        articleSection: "cabecalho",
      },
      {
        anchor: "rendimento.funnel",
        title: "Do contato ao depósito",
        body: "Links gerados → leads que clicaram → depositaram dentro da janela de clique da casa.",
        articleSection: "cabecalho",
      },
      {
        anchor: "rendimento.chart",
        title: "Evolução por dia",
        body: "FTD e redepósito creditados por dia, e o número de depositantes distintos.",
        articleSection: "cabecalho",
      },
      {
        anchor: "rendimento.extrato",
        title: "Extrato de créditos",
        body: "A base da comissão desta pessoa, linha a linha.",
        articleSection: "cabecalho",
      },
    ],
  },
};

export default screen;
