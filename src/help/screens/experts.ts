// Help article for "Experts" (/experts, admin): cadastro e configuração dos
// perfis de expert/rendimento da casa — regras de crédito, novo/editar
// expert, aprovações pendentes de campanhas, a tabela, as ações de cada
// linha e os IDs de afiliado ainda sem expert. O relatório de rendimento de
// cada pessoa (período, cartões, funil, extrato, editar, ativar/desativar e
// a aba Campanhas de uma pessoa) tem artigo próprio ("Relatório de
// rendimento", rendimento-pessoa.ts) — aqui só o que é específico desta
// tela de cadastro. Fonte: src/routes/experts.tsx,
// src/components/experts/expert-form-dialog.tsx,
// src/components/experts/expert-invite-dialog.tsx,
// src/components/experts/expert-team-link-dialog.tsx,
// src/components/experts/expert-settings-dialog.tsx,
// src/components/experts/expert-access-fields.tsx,
// src/components/experts/expert-access-model.ts,
// src/components/experts/expert-badges.tsx,
// src/components/experts/expert-list-columns.tsx,
// src/components/experts/expert-campaigns-admin.tsx (fila/diálogo de
// revisão, compartilhado com a aba Campanhas de "Relatório de rendimento"),
// src/lib/experts-admin.functions.ts e src/lib/expert-metrics.functions.ts
// (regras de crédito).
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "experts",
  route: "/experts",
  title: "Experts",
  purpose:
    "Cadastrar quem acompanha os leads da casa por ID de afiliado ou com acesso total, dar ou tirar o acesso de cada pessoa, configurar a janela de crédito e decidir as campanhas que estão aguardando aprovação.",
  roles: ["admin"],
  terms: ["id-de-afiliado"],
  sections: [
    // ---------------------------------------------------------------
    // Cabeçalho
    // ---------------------------------------------------------------
    {
      id: "cabecalho",
      title: "Cabeçalho",
      intro:
        'Subtítulo fixo: "Cadastre quem acompanha os leads da casa, por ID de afiliado ou com acesso total."',
      items: [
        {
          anchor: "experts.header.regras-credito",
          label: "Regras de crédito",
          what: 'Abre o diálogo "Regras de crédito", que configura a janela de clique da casa — ver a seção "Diálogo Regras de crédito" abaixo.',
        },
        {
          anchor: "experts.header.novo",
          label: "Novo expert",
          what: 'Abre o diálogo "Novo expert" em branco (sem nenhum ID de afiliado pré-preenchido) — ver a seção "Diálogo Novo expert / Editar expert" abaixo.',
          notes: "Desabilitado na casa demo.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aprovações pendentes
    // ---------------------------------------------------------------
    {
      id: "aprovacoes",
      title: "Aprovações pendentes",
      intro:
        'Card que só aparece quando existe pelo menos uma campanha de algum expert aguardando aprovação — some sozinho quando a fila zera. O número ao lado do título (com o texto "N aguardando aprovação" para quem usa leitor de tela) soma as pendentes de todos os experts da casa.',
      items: [
        {
          anchor: "experts.aprovacoes.card",
          label: "Tabela de aprovações pendentes",
          what: 'A mesma tabela de campanhas da aba "Campanhas" de cada pessoa (ver "Relatório de rendimento"), mas juntando as pendentes de todos os experts da casa: Campanha, Expert, Canal (SMS/E-mail/Voz), Status, Destinatários, Custo estimado, Criada em e Ações — aqui sempre com status "Aguardando aprovação" e a única ação é "Revisar". Mais antiga primeiro.',
          notes:
            'Sem nenhuma pendente o card inteiro some (não aparece "Nenhuma campanha aguardando aprovação." aqui — esse texto só é usado nesta mesma tabela dentro da aba Campanhas de uma pessoa). Enquanto a lista ainda não voltou do servidor, a tabela mostra "Carregando…" no lugar das linhas; se a consulta falhar, mostra a mensagem de erro em vermelho (a do servidor, ou "Não foi possível concluir. Tente de novo." sem uma mensagem específica).',
        },
        {
          label: "Revisar",
          what: 'Abre o diálogo de revisão da campanha — ver "Diálogo de revisão da campanha" abaixo. É a mesma ação e o mesmo diálogo de dentro da aba Campanhas de cada pessoa.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Tabela de experts
    // ---------------------------------------------------------------
    {
      id: "tabela",
      title: "Tabela de experts",
      intro: 'Título "Experts (N)", com N sendo o total cadastrado nesta casa.',
      items: [
        {
          anchor: "experts.tabela.card",
          label: "Colunas da tabela",
          what: 'Expert (o nome, como link para o relatório de rendimento da pessoa), Tipo ("Restrito" ou "Acesso total"), IDs de afiliado (os códigos vinculados, em chips; "—" sem nenhum), Leads (quantos leads a pessoa vê hoje), Envio ("Livre" ou "Com aprovação", com um badge "N pendentes"/"1 pendente" linkando para a aba Campanhas da pessoa quando há alguma aguardando), Teto (o valor do teto mensal, "Sem teto", ou "R$ 0,00 (bloqueado)"), Uso do mês (barra de uso × teto do mês atual) e Acesso.',
          notes:
            'Leads conta pelo tipo: "Restrito" soma só os leads dos IDs de afiliado vinculados (0 sem nenhum ID); "Acesso total" conta todos os leads da casa.',
        },
        {
          label: "Acesso (badge)",
          what: '"Sem acesso" (perfil cadastrado, sem login nenhum), "Convite pendente" (convite enviado, a pessoa nunca entrou), "Ativo" (tem login e já entrou pelo menos uma vez), "Inativo" (foi desativado) ou "Equipe (Admin/Gestor/Membro)" (perfil vinculado a alguém que já é admin, gestor ou membro desta casa — ver "Vincular a alguém da equipe"). Um perfil de equipe desativado mostra os dois badges juntos: "Equipe (...)" e "Inativo".',
          notes:
            'Quando o Tipo é "Restrito" e o Acesso é "Equipe (...)", aparece abaixo o aviso "Vê a casa inteira: Restrito não vale para a equipe." — passar o mouse (ou, no teclado/leitor de tela, o título associado) mostra a explicação completa: "Restrito não limita quem é da equipe: a pessoa continua vendo a casa inteira com o papel dela. Para ela ver só os próprios leads, use Convidar em vez de vincular."',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Ações de cada linha
    // ---------------------------------------------------------------
    {
      id: "acoes-linha",
      title: "Ações de cada linha",
      intro:
        'Coluna "Ações", à direita da tabela. Quais botões aparecem depende do Acesso da linha; Editar e Ativar/Desativar aparecem sempre.',
      items: [
        {
          anchor: "experts.linha.editar",
          label: "Editar",
          what: 'Abre o diálogo "Editar expert" com os dados desta pessoa — ver "Diálogo Novo expert / Editar expert" abaixo.',
          notes: "Desabilitado na casa demo.",
        },
        {
          anchor: "experts.linha.convidar",
          label: "Convidar",
          what: 'Só aparece quando o Acesso é "Sem acesso". Abre o diálogo "Convidar" — ver abaixo.',
          notes: "Desabilitado na casa demo.",
        },
        {
          anchor: "experts.linha.vincular",
          label: "Vincular a alguém da equipe",
          what: 'Só aparece quando o Acesso é "Sem acesso". Abre o diálogo "Vincular a alguém da equipe" — ver abaixo.',
          notes: "Desabilitado na casa demo.",
        },
        {
          anchor: "experts.linha.desvincular",
          label: "Desvincular",
          what: 'Só aparece quando o Acesso é "Equipe (...)". Pede confirmação: "Desvincular o perfil {nome}?", com o texto "O perfil deixa de medir o rendimento dessa pessoa. O acesso dela à casa não muda, e o histórico do perfil continua." e os botões "Cancelar" e "Desvincular". Toast "Perfil desvinculado".',
          notes: "Desabilitado na casa demo.",
        },
        {
          anchor: "experts.linha.remover-acesso",
          label: "Remover acesso",
          what: 'Aparece quando o Acesso não é "Sem acesso" nem "Equipe (...)" (ou seja: Convite pendente, Ativo ou Inativo). Pede confirmação: "Remover o acesso de {nome}?", com o texto "A pessoa perde o acesso a esta casa imediatamente. O cadastro do expert continua existindo." e os botões "Cancelar" e "Remover acesso". Toast "Acesso removido".',
          notes:
            "Diferente de Desvincular: aqui a pessoa tinha um login de expert (criado por Convidar) e perde esse acesso — o cadastro do expert (nome, IDs de afiliado, teto...) continua, pronto para ser convidado de novo depois. Desabilitado na casa demo.",
        },
        {
          anchor: "experts.linha.ativar",
          label: "Ativar / Desativar",
          what: '"Desativar" quando a pessoa está ativa, "Ativar" quando está inativa. Toast "Expert ativado" ou "Expert desativado".',
          notes:
            'Desativar não apaga nenhum crédito já registrado nem some do ranking de rendimento — só impede novos créditos e, se for um expert com acesso, o login dele. Desabilitado na casa demo.',
        },
        {
          anchor: "experts.linha.excluir",
          label: "Excluir",
          what: 'Só aparece quando o Acesso é "Sem acesso". Pede confirmação: "Excluir o expert {nome}?", com o texto "O cadastro e os IDs de afiliado vinculados a ele deixam de existir. Esta ação não pode ser desfeita." e os botões "Cancelar" e "Excluir expert". Toast "Expert excluído".',
          notes:
            'Erros possíveis: "Remova o acesso do expert antes de excluir." (o perfil ainda tem login — o botão nem deveria aparecer nesse caso) e "Este perfil tem créditos registrados. Desative em vez de excluir, para manter o histórico." (há crédito gravado — desative a pessoa em vez disso). Desabilitado na casa demo.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // IDs de afiliado sem expert
    // ---------------------------------------------------------------
    {
      id: "sem-expert",
      title: "IDs de afiliado sem expert",
      intro:
        "Lista os IDs de afiliado que já têm leads na casa, mas ainda não foram vinculados a nenhum expert.",
      items: [
        {
          anchor: "experts.sem-expert.card",
          label: "Lista de IDs sem expert",
          what: "Cada linha mostra o ID de afiliado e quantos leads chegaram por ele.",
          notes: 'Vazia, mostra "Nenhum ID de afiliado sem expert."',
        },
        {
          anchor: "experts.sem-expert.criar",
          label: "Criar expert",
          what: 'Abre "Novo expert" já com este ID de afiliado preenchido nos chips.',
          notes: "Desabilitado na casa demo.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Diálogo "Novo expert" / "Editar expert"
    // ---------------------------------------------------------------
    {
      id: "form",
      title: 'Diálogo "Novo expert" / "Editar expert"',
      intro:
        'Aberto por "Novo expert" (em branco, ou com um ID de afiliado pré-preenchido vindo de "Criar expert"), por "Editar" de uma linha, ou por "Editar" no cabeçalho do relatório de rendimento da pessoa (mesmo diálogo).',
      items: [
        {
          label: "Nome",
          what: 'O nome da pessoa (ex.: "Queiroz"), mostrado na tabela e no relatório de rendimento.',
          notes:
            'Erros possíveis: "O nome precisa ter pelo menos 2 caracteres." e "O nome pode ter até 80 caracteres."; no servidor, "Já existe um expert com esse nome nesta casa." se o nome já estiver em uso nesta casa.',
        },
        {
          label: "Tipo",
          what: '"Restrito" (vê só os leads que chegaram pelos IDs de afiliado dela) ou "Acesso total" (vê todos os leads da casa) — a ajuda abaixo do campo muda conforme a escolha.',
        },
        {
          label: "IDs de afiliado",
          what: 'Os IDs vinculados, como chips removíveis (ícone "x" em cada um). Digite um ID e pressione Enter para adicionar; abaixo aparecem sugestões (até 8) dos IDs de afiliado da casa ainda sem expert, cada uma com a quantidade de leads — clicar numa sugestão adiciona o chip.',
          notes:
            'Erros possíveis: "Esse ID já foi adicionado." e "Máximo de 20 IDs de afiliado." (limite de 20 por pessoa — o campo de digitar trava ao chegar no limite); no servidor, se dois experts disputarem o mesmo ID ao salvar quase ao mesmo tempo: "O ID de afiliado {id} já pertence a outro expert desta casa." (ou, sem saber qual id, "Um dos IDs de afiliado já pertence a outro expert desta casa.").',
        },
        {
          label: "Acesso (opcional)",
          what: 'Só aparece ao criar (some ao editar). Os mesmos campos do diálogo "Convidar" (e-mail, "Enviar convite por e-mail" ou "Definir senha agora", senha temporária) — ver a seção "Diálogo Convidar" abaixo para o detalhe de cada campo e erro.',
          notes:
            'Deixar o e-mail em branco cadastra o expert sem acesso agora (dá para usar "Convidar" na lista depois) — texto de ajuda: "Deixe vazio para cadastrar sem acesso agora (dá para usar Convidar na lista depois)." Preenchendo o e-mail, o acesso é criado junto com o expert ao Salvar: se a criação do acesso falhar, o expert fica salvo mesmo assim e o toast de erro avisa "Expert salvo, mas o acesso não foi criado: {motivo}. Use Convidar na lista." — nunca é preciso recadastrar a pessoa.',
        },
        {
          label: "Envio de campanhas",
          what: '"Livre": as campanhas desta pessoa disparam direto. "Com aprovação": cada campanha fica pendente até o admin aprovar ou recusar, na aba Campanhas do relatório dela (ou no card "Aprovações pendentes" desta tela).',
          notes:
            'Trocar de "Com aprovação" para "Livre" (ao editar) não libera sozinho as campanhas já pendentes: aparece o aviso "N campanhas aguardando aprovação continuam pendentes: aprove ou recuse na aba Campanhas do expert." (singular "1 campanha aguardando aprovação continua pendente") lembrando que elas continuam na fila até serem decididas ali.',
        },
        {
          label: "Teto mensal",
          what: 'O limite de gasto mensal desta pessoa em campanhas (SMS, e-mail e voz somados, pelo preço cobrado da casa — ver o termo "Teto" no glossário, documentado em "Relatório de rendimento"). Vazio = sem limite; 0 = bloqueia todos os envios dela.',
          notes:
            'Erro possível: "Informe um valor como 1.500,00 (ou deixe vazio para sem teto)." O campo formata o milhar/decimal ao perder o foco (ex.: "1500" vira "1.500,00").',
        },
        {
          label: "Prazo para assumir lead (dias)",
          what: "Quantos dias esta pessoa tem para assumir um lead antes que ele volte a ficar disponível para outra pessoa assumir.",
          notes: 'Erro possível: "Use um número inteiro de 1 a 30."',
        },
        {
          label: "Cancelar / Salvar",
          what: 'Salvar grava o expert (toast "Expert cadastrado" ao criar, "Expert atualizado" ao editar — ou, criando com acesso, o toast do acesso: "Acesso criado", "Convite enviado" ou "Acesso vinculado à conta que já existia", ver "Diálogo Convidar"). Enquanto salva, o botão mostra "Salvando…". Cancelar fecha sem salvar.',
          notes:
            'Fica desabilitado até o nome ser preenchido e nenhum campo ter erro. Outros erros do servidor: "Expert não encontrado." (editando um perfil já excluído por outra aba) e "Informe o nome do expert." (nome vazio chegando ao servidor, não deveria acontecer pela validação do campo).',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Diálogo "Convidar"
    // ---------------------------------------------------------------
    {
      id: "convidar",
      title: 'Diálogo "Convidar"',
      intro: 'Aberto por "Convidar" numa linha "Sem acesso". Dá um login a um expert já cadastrado.',
      items: [
        {
          label: "Título e descrição",
          what: 'Título "Convidar {nome}". Descrição: "Enviamos um convite de acesso para o e-mail informado." (modo convite) ou "Criamos o login com o e-mail e a senha informados." (modo senha).',
        },
        {
          label: "E-mail",
          what: "O e-mail que vai receber o convite (ou que vai logar com a senha definida abaixo).",
          notes: 'Erro possível: "Informe um e-mail válido."',
        },
        {
          label: "Como dar o acesso",
          what: '"Enviar convite por e-mail" (a pessoa recebe um link para criar a própria senha) ou "Definir senha agora" (você digita uma senha temporária aqui, sem enviar e-mail).',
        },
        {
          label: "Senha temporária",
          what: 'Só aparece com "Definir senha agora" escolhido. Campo com o ícone de olho para mostrar/ocultar a senha.',
          notes:
            'Ajuda: "A pessoa troca a senha no primeiro acesso. Nenhum e-mail é enviado. Se o e-mail já tiver conta, a senha dele não é alterada." Erros possíveis: "A senha precisa ter pelo menos 8 caracteres." e "A senha pode ter até 200 caracteres."',
        },
        {
          label: "Cancelar / Convidar / Criar acesso",
          what: 'O botão de confirmar mostra "Convidar" (modo convite) ou "Criar acesso" (modo senha); enquanto processa, "Enviando…" ou "Criando…". Toast de sucesso: "Acesso criado" (senha), "Convite enviado" (e-mail sem conta ainda, ou convite anterior nunca aceito) ou "Acesso vinculado à conta que já existia" (o e-mail já tinha login nesta plataforma — só passa a apontar para este expert).',
          notes:
            'Se o e-mail já tinha conta e você escolheu "Definir senha agora", a senha dele NÃO é trocada: o toast muda para "Este e-mail já tinha conta: a senha dele não foi alterada. O acesso foi vinculado." (com o complemento " Como a pessoa nunca aceitou o convite anterior, enviamos um novo por e-mail." quando também havia um convite nunca aceito). Erros possíveis: "Este expert já tem acesso. Remova o acesso antes de convidar outra pessoa.", "Este e-mail já tem acesso a esta casa como {Admin/Gestor/Membro/Expert}. Uma pessoa não pode ter dois papéis na mesma casa.", "Este e-mail é de um super admin.", "Este e-mail pertence a um usuário de demonstração e não pode ser expert." e "Este perfil já tem créditos de outra pessoa. Crie um perfil novo para quem vai entrar." (o cadastro já foi usado por outra pessoa antes).',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Diálogo "Vincular a alguém da equipe"
    // ---------------------------------------------------------------
    {
      id: "vincular",
      title: 'Diálogo "Vincular a alguém da equipe"',
      intro:
        'Aberto por "Vincular a alguém da equipe" numa linha "Sem acesso". Liga um cadastro de expert (os IDs de afiliado e o teto) ao login de alguém que já é admin, gestor ou membro desta casa — a pessoa passa a ter um perfil de rendimento, mas continua com o próprio papel e vendo a casa pelas regras normais dele.',
      items: [
        {
          label: "Título e descrição",
          what: 'Título "Vincular {nome} a alguém da equipe". Descrição: "O perfil passa a medir o rendimento dessa pessoa. O acesso dela à casa não muda."',
        },
        {
          label: 'Aviso "Restrito"',
          what: 'Quando o Tipo deste expert é "Restrito", aparece o aviso: "Restrito não limita quem é da equipe: a pessoa continua vendo a casa inteira com o papel dela. Para ela ver só os próprios leads, use Convidar em vez de vincular."',
        },
        {
          label: "Pessoa da equipe",
          what: 'Lista quem é admin, gestor ou membro desta casa e ainda não tem perfil de rendimento, como "{e-mail} · {Admin/Gestor/Membro}". Enquanto carrega, mostra "Carregando equipe…"; sem ninguém disponível, "Escolha uma pessoa" continua no seletor e aparece "Ninguém da equipe sem perfil." na lista.',
          notes: "Uma falha ao carregar mostra a mensagem de erro do servidor abaixo do campo.",
        },
        {
          label: "Cancelar / Vincular",
          what: 'Vincular grava o vínculo (toast "Perfil vinculado"); enquanto processa, "Vinculando…".',
          notes:
            'Erros possíveis: "Escolha alguém da equipe desta casa." (a pessoa deixou de ser admin/gestor/membro entre abrir a lista e vincular), "Este perfil já está vinculado." (alguém já vinculou este expert antes de você confirmar), "Esta pessoa já tem um perfil de rendimento." (ela já tem outro expert vinculado) e "Este perfil já tem créditos de outra pessoa. Crie um perfil novo para quem vai entrar."',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Diálogo "Regras de crédito"
    // ---------------------------------------------------------------
    {
      id: "regras-credito",
      title: 'Diálogo "Regras de crédito"',
      intro: 'Aberto por "Regras de crédito" no cabeçalho. Configura a janela de clique da casa.',
      items: [
        {
          label: "Janela de clique (horas)",
          what: "Quantas horas depois do clique num link um depósito ainda conta como creditado por clique para o expert — ver o termo \"Janela de clique\" no glossário, documentado em \"Relatório de rendimento\". Ajuda fixa: \"Padrão 72h. Vale para os próximos cálculos e recalcula os últimos 8 dias.\"",
          notes:
            'Erros possíveis: "Informe a janela em horas." (vazio) e "A janela precisa ser um número inteiro entre 1 e 720 horas." (fora da faixa ou não inteiro). Enquanto a janela salva ainda não carregou, o campo mostra "Carregando…" e fica desabilitado.',
        },
        {
          label: "Cancelar / Salvar",
          what: 'Salvar grava a nova janela e recalcula os créditos dos últimos 8 dias no servidor (toast "Janela de clique atualizada.").',
          notes: "Desabilitado na casa demo (o botão Regras de crédito continua clicável, mas salvar é bloqueado).",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Diálogo de revisão da campanha
    // ---------------------------------------------------------------
    {
      id: "revisao",
      title: "Diálogo de revisão da campanha",
      intro:
        'Aberto por "Revisar" no card "Aprovações pendentes". É o mesmo diálogo (e as mesmas regras) da aba Campanhas de cada pessoa, no relatório de rendimento — ver "Relatório de rendimento" → "Diálogo de revisão da campanha" para o detalhe completo de cada campo e erro. Resumo:',
      items: [
        {
          label: "Conteúdo, Aprovar e Recusar",
          what: 'Mostra o canal, destinatários, custo estimado, quando envia e o público, mais o conteúdo em si (texto do SMS, assunto + prévia do HTML do e-mail, ou roteiro/áudio da voz). "Aprovar" confere tudo de novo e libera a campanha (toast "Campanha aprovada: N destinatários, custo estimado R$ X."); "Recusar" abre o campo do motivo (obrigatório, até 500 caracteres) e "Recusar campanha" confirma (toast "Campanha recusada. O expert vê o motivo.").',
          notes:
            'Erros possíveis: "Esta campanha não está aguardando aprovação.", "A campanha mudou depois que você abriu. Recarregue e confira antes de aprovar.", "O expert está desativado: a campanha não pode ser aprovada.", "Nenhum jogador do seu público pode receber esta campanha." e o aviso de teto ("Esta campanha custaria cerca de R$ X, mas restam R$ Y do seu teto mensal de R$ Z. Reduza o público ou peça ao admin para aumentar o teto."). Desabilitado na casa demo.',
        },
      ],
    },
  ],

  states: [
    {
      id: "experts-vazio",
      title: "Nenhum expert cadastrado.",
      what: "Texto mostrado na tabela quando a casa ainda não tem nenhum expert cadastrado.",
      action: 'Cadastre o primeiro em "Novo expert".',
    },
    {
      id: "sem-expert-vazio",
      title: "Nenhum ID de afiliado sem expert.",
      what: 'Texto mostrado no card "IDs de afiliado sem expert" quando não existe nenhum ID de afiliado com leads que ainda não tenha sido vinculado a um expert.',
    },
  ],

  tours: {
    default: [
      {
        anchor: "experts.header.novo",
        title: "Novo expert",
        body: "Cadastra uma pessoa para acompanhar leads por ID de afiliado ou com acesso total à casa.",
        articleSection: "cabecalho",
      },
      {
        anchor: "experts.header.regras-credito",
        title: "Regras de crédito",
        body: "Configura a janela de clique: quantas horas depois do clique num link um depósito ainda conta como creditado.",
        articleSection: "cabecalho",
      },
      {
        anchor: "experts.aprovacoes.card",
        title: "Aprovações pendentes",
        body: "As campanhas de qualquer expert que estão aguardando sua aprovação, juntas aqui — some sozinho quando a fila zera.",
        articleSection: "aprovacoes",
      },
      {
        anchor: "experts.tabela.card",
        title: "Tabela de experts",
        body: "Tipo, IDs de afiliado, leads, modo de envio, teto e uso do mês de cada pessoa, com o acesso dela a esta casa.",
        articleSection: "tabela",
      },
      {
        anchor: "experts.linha.editar",
        title: "Editar",
        body: "Nome, tipo, IDs de afiliado, envio de campanhas, teto mensal e prazo para assumir lead desta pessoa.",
        articleSection: "acoes-linha",
      },
      {
        anchor: "experts.linha.ativar",
        title: "Ativar / Desativar",
        body: "Liga ou desliga a pessoa, sem apagar o histórico de créditos já registrado.",
        articleSection: "acoes-linha",
      },
      {
        anchor: "experts.sem-expert.card",
        title: "IDs de afiliado sem expert",
        body: "IDs de afiliado que já trouxeram leads, mas ainda não foram vinculados a nenhum expert.",
        articleSection: "sem-expert",
      },
    ],
  },
};

export default screen;
