// Help article for "Consentimentos" (/consentimentos), quatro abas: Base,
// Registrar, Histórico e Limites de voz (esta última some quando a casa não
// tem o canal Voz ligado). Fonte: src/routes/consentimentos.tsx,
// src/lib/consent.functions.ts (listChannelConsents, saveChannelConsent,
// importChannelConsents, exportChannelConsents, saveVoiceContactPolicy) e
// src/lib/consent.server.ts (normalizeConsentSubject, syncLegacySuppression).
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "consentimentos",
  route: "/consentimentos",
  defaultTab: "base",
  title: "Consentimentos",
  purpose:
    "Quem pediu para não receber SMS, e-mail ou ligação (ou foi autorizado de volta), o histórico de cada decisão, a importação em lote por CSV e os limites de frequência das ligações. Um bloqueio aqui vale para todas as campanhas e automações da casa, em qualquer canal.",
  roles: ["admin", "gestor", "member", "expert"],
  terms: ["lgpd"],
  sections: [
    // ---------------------------------------------------------------
    // Cabeçalho — aparece em todas as abas
    // ---------------------------------------------------------------
    {
      id: "cabecalho",
      title: "Cabeçalho (aparece em todas as abas)",
      intro:
        "Fica acima das abas e não muda quando você troca de aba.",
      items: [
        {
          anchor: "consentimentos.cabecalho.exportar",
          label: "Exportar CSV",
          what: "Baixa um arquivo CSV com a base inteira de consentimentos da casa (não só os registros mostrados na tela), com as colunas channel, subject, status, reason, legal_basis, source e updated_at. O nome do arquivo é consentimentos-AAAA-MM-DD.csv.",
          notes:
            'Fica desabilitado enquanto exporta ("Exportando…") e também quando a aba Base não tem nenhum registro e a busca está vazia (nada para exportar). O limite é de 100.000 linhas: passando disso, a exportação traz as primeiras 100.000 e avisa "Exportação limitada a N registros. Fale com o suporte para a base completa." Dentro do limite, o aviso é "N registros exportados".',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Base
    // ---------------------------------------------------------------
    {
      id: "base",
      title: "Base",
      tab: "base",
      intro:
        "Todos os bloqueios e autorizações já registrados na casa, com busca. A busca olha a base inteira, não só os registros mostrados.",
      items: [
        {
          anchor: "consentimentos.abas",
          label: "Abas Base / Registrar / Histórico / Limites de voz",
          what: 'Alternam entre a lista de consentimentos, o formulário de registrar/importar, o histórico de alterações e os limites de ligação. A aba "Limites de voz" só aparece quando a casa tem o canal Voz ligado.',
        },
        {
          anchor: "consentimentos.base.buscar",
          label: "Buscar por telefone ou e-mail",
          what: "Filtra a lista por um telefone (com ou sem DDD/formatação) ou e-mail. A busca é feita no servidor, sobre toda a base da casa, não só nos registros já carregados na tela.",
          notes:
            'Um telefone é comparado só pelos números digitados (sem parênteses, espaço ou "-"); um e-mail é comparado como texto. Resultado "Nenhum destinatário encontrado" quando nada bate.',
        },
        {
          anchor: "consentimentos.base.lista",
          label: "Lista de consentimentos",
          what: "Uma linha por contato com uma decisão registrada: Canal (SMS, E-mail ou Voz), Destinatário (telefone ou e-mail), Situação (\"Bloqueado\" ou \"Autorizado\"), Motivo, Origem (\"Equipe\" quando foi a sua equipe que registrou, \"Importação\" quando veio de um CSV, \"Link de descadastro\" quando o próprio jogador se descadastrou pelo link do e-mail) e quando foi a última atualização.",
          notes:
            'A tela mostra no máximo os 1.000 registros mais recentes. Com mais do que isso na base, aparece o aviso "Mostrando os 1.000 mais recentes de N. Use a busca ou exporte o CSV para ver todos." Um motivo sem tradução conhecida aparece do jeito que foi digitado (sem os sublinhados "_"), em vez de ficar em branco.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Registrar
    // ---------------------------------------------------------------
    {
      id: "registrar",
      title: "Registrar",
      tab: "registrar",
      intro:
        "Dois jeitos de registrar decisões: uma de cada vez, no formulário, ou em lote, por um CSV colado na caixa de texto.",
      items: [
        {
          anchor: "consentimentos.registrar.canal",
          label: "Canal",
          what: "Em qual canal a decisão vale — SMS, E-mail ou Voz. A lista só mostra os canais que a casa tem ligados.",
        },
        {
          anchor: "consentimentos.registrar.destinatario",
          label: "Telefone ou e-mail",
          what: 'O contato que vai ser bloqueado ou autorizado. Para SMS e Voz, digite o telefone com DDD (ex.: 11999999999); para E-mail, o endereço completo. O campo de texto muda a dica conforme o canal escolhido.',
          notes:
            'O CRM guarda o telefone só com os números (sem "+55", parênteses ou espaço) e, se vier com 10 ou 11 dígitos, completa com o "55" do Brasil na frente antes de salvar — por isso um número já cadastrado com ou sem o "55" é reconhecido como o mesmo contato.',
        },
        {
          anchor: "consentimentos.registrar.decisao",
          label: "Decisão",
          what: '"Bloquear" impede novos envios/ligações para esse contato nesse canal; "Autorizar" libera de novo um contato que estava bloqueado.',
        },
        {
          anchor: "consentimentos.registrar.base-legal",
          label: "Base legal (opcional)",
          what: "Um texto livre para anotar, por motivo de conformidade com a LGPD (a lei brasileira de proteção de dados), qual é a base legal dessa decisão — por exemplo \"Consentimento\" (o próprio titular pediu) ou \"Execução de contrato\". O CRM não valida nem limita o que você escreve aqui; é só um registro para consulta futura.",
          notes: "Pode deixar em branco. Não interfere em nada do funcionamento — é só documentação.",
        },
        {
          anchor: "consentimentos.registrar.motivo",
          label: "Motivo",
          what: 'Por que a decisão está sendo tomada, por exemplo "Pedido do titular" (o texto que já vem preenchido) ou "Bloqueio manual". Aparece depois na coluna Motivo da lista e do histórico.',
        },
        {
          anchor: "consentimentos.registrar.salvar",
          label: "Salvar decisão",
          what: 'Grava a decisão. Ao salvar com sucesso, mostra "Decisão registrada", limpa o campo de telefone/e-mail e atualiza a lista da aba Base.',
          notes:
            'Fica desabilitado até o telefone/e-mail ter pelo menos 3 caracteres e o motivo não estar vazio. Se já existir uma decisão para o mesmo canal + contato, essa nova decisão substitui a anterior (não cria uma segunda linha) — a troca fica registrada no Histórico. Um erro ao salvar aparece como aviso com o texto do próprio erro: "Falha ao auditar consentimento: <detalhe>" quando a decisão foi gravada, mas o registro no histórico falhou; "Falha ao sincronizar supressao de SMS: <detalhe>" ou "Falha ao sincronizar supressao de e-mail: <detalhe>" quando a decisão foi gravada, mas a sincronização com a lista de supressão antiga (SMS/e-mail) falhou. Nos três casos a decisão em si já está salva (a lista da aba Base já reflete a mudança) — tente salvar de novo em alguns instantes; se o aviso persistir, fale com o suporte.',
        },
        {
          anchor: "consentimentos.importar.csv",
          label: "Conteúdo do CSV",
          what: 'Uma caixa de texto para colar até 5.000 linhas de um arquivo CSV. A primeira linha é sempre o cabeçalho, com os nomes das colunas em inglês, nessa ordem ou em qualquer ordem: channel,subject,status,reason — essas quatro são obrigatórias — e, se quiser, legal_basis e source. A caixa já vem com o cabeçalho completo "channel,subject,status,reason,legal_basis,source" pronto para você preencher embaixo.',
          notes:
            'Os valores aceitos: channel é "sms", "email" ou "voice"; status é "revoked" para bloquear ou "granted" para autorizar. reason é um texto livre (por exemplo "Pedido do titular"). legal_basis e source são opcionais — quando source fica em branco, é gravado como "csv". Exemplo de duas linhas:\n\nchannel,subject,status,reason\nsms,11999999999,revoked,Pedido do titular\nemail,jogador@exemplo.com,granted,Pedido do titular',
        },
        {
          anchor: "consentimentos.importar.enviar",
          label: "Importar",
          what: 'Lê o CSV colado e grava uma decisão por linha, do mesmo jeito que "Salvar decisão" faria uma a uma. Ao concluir, mostra "N registros importados" e atualiza a lista da aba Base.',
          notes:
            'Erros de formato impedem a importação inteira (nenhuma linha é gravada) e aparecem como aviso:\n\n"Informe o cabeçalho e ao menos uma linha" — a caixa só tem o cabeçalho, ou está vazia.\n"Cabeçalho obrigatório: channel,subject,status,reason" — falta uma dessas quatro colunas na primeira linha.\n"Canal inválido: <valor> (use sms, email ou voice)" — a coluna channel de alguma linha tem outro valor.\n"Situação inválida: <valor> (use granted ou revoked)" — a coluna status de alguma linha tem outro valor.\n\nJá com a importação em andamento, um erro no meio do processo aparece do mesmo jeito, mas as linhas anteriores já podem ter sido gravadas: "Falha ao auditar importacao: <detalhe>" (as decisões foram gravadas, só o registro no histórico falhou); "Falha ao sincronizar supressao de SMS: <detalhe>" ou "Falha ao sincronizar supressao de e-mail: <detalhe>" (a decisão daquela linha foi gravada, mas a sincronização com a lista de supressão antiga falhou). Confira a aba Base/Histórico para ver até onde a importação chegou antes de repetir.',
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
      intro: "As 100 alterações de consentimento mais recentes da casa, mais novas primeiro.",
      items: [
        {
          anchor: "consentimentos.historico.lista",
          label: "Lista do histórico",
          what: "Uma linha por alteração: Data, Canal, Destinatário, Alteração (a situação anterior — ou \"Novo\", na primeira decisão para aquele contato — seguida da nova situação), Motivo e Origem.",
          notes:
            'Uma importação em lote aparece com a Origem "Importação" junto do nome de quem importou (prefixo "import:" na origem original), uma linha por contato importado.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Aba Limites de voz
    // ---------------------------------------------------------------
    {
      id: "voz",
      title: "Limites de voz",
      tab: "voz",
      intro:
        "Quantas vezes o mesmo número pode receber ligação, para não incomodar quem já foi chamado recentemente. Vale além da janela de envio da casa (Configurações), que já impede ligações fora do horário permitido mesmo com esses limites desligados.",
      items: [
        {
          anchor: "consentimentos.voz.aplicar",
          label: "Aplicar os limites",
          what: "Liga ou desliga os dois limites abaixo. Desligado, a casa pode ligar para o mesmo número quantas vezes as automações mandarem, sem intervalo mínimo.",
        },
        {
          anchor: "consentimentos.voz.intervalo",
          label: "Intervalo mínimo entre ligações (horas)",
          what: "Quantas horas o CRM espera depois de uma ligação antes de permitir outra para o mesmo número. Aceita de 0 a 720 horas (30 dias).",
        },
        {
          anchor: "consentimentos.voz.limite",
          label: "Máximo de ligações em 24 h",
          what: "Quantas ligações, no total, o mesmo número pode receber num período de 24 horas. Aceita de 1 a 100.",
        },
        {
          anchor: "consentimentos.voz.salvar",
          label: "Salvar limites",
          what: 'Grava os limites. Ao salvar, mostra "Limites de voz salvos".',
          notes: "Um erro ao salvar aparece como aviso com o texto do próprio erro.",
        },
      ],
    },
  ],

  states: [
    {
      id: "carregando",
      title: "Carregando",
      what: 'Enquanto a lista (aba Base) ou o histórico (aba Histórico) ainda não chegou, a tela mostra algumas barras cinzas no lugar das linhas.',
    },
    {
      id: "erro-lista",
      title: "Não foi possível carregar os consentimentos",
      what: 'Aparece na aba Base quando a busca/listagem falha. O texto completo é "Não foi possível carregar os consentimentos" com a descrição "Tente novamente em instantes." e o botão "Tentar novamente".',
      action: 'Clique em "Tentar novamente".',
    },
    {
      id: "vazio-sem-busca",
      title: "Nenhum bloqueio registrado",
      what: 'Aparece na aba Base quando a casa ainda não tem nenhum consentimento registrado e o campo de busca está vazio. A descrição explica: "Descadastros pelo link do e-mail e decisões da equipe aparecem aqui." Junto, o botão "Registrar decisão" leva direto para a aba Registrar.',
      action: 'Clique em "Registrar decisão" ou registre o primeiro bloqueio/autorização na aba Registrar.',
    },
    {
      id: "vazio-busca",
      title: "Nenhum destinatário encontrado",
      what: 'Aparece na aba Base quando a busca não encontra nenhum contato. A descrição sugere: "Confira o número (com DDD) ou o e-mail."',
      action: "Revise o telefone (com DDD) ou o e-mail digitado na busca.",
    },
    {
      id: "historico-vazio",
      title: "Nenhuma alteração ainda",
      what: "Aparece na aba Histórico quando a casa nunca registrou nenhuma decisão de consentimento.",
    },
    {
      id: "exportacao-limitada",
      title: "Exportação limitada a N registros. Fale com o suporte para a base completa.",
      what: 'Aviso mostrado depois de clicar em "Exportar CSV" quando a base (ou o resultado da busca) passa de 100.000 registros — o arquivo baixado traz só os primeiros 100.000.',
      action: "Para a base completa, fale com o suporte.",
    },
  ],

  tours: {
    base: [
      {
        anchor: "consentimentos.abas",
        title: "Quatro abas",
        body: "Base (a lista), Registrar, Histórico e Limites de voz (quando o canal Voz está ligado).",
        articleSection: "base",
      },
      {
        anchor: "consentimentos.base.buscar",
        title: "Buscar",
        body: "Procura por telefone ou e-mail em toda a base da casa, não só no que já está na tela.",
        articleSection: "base",
      },
      {
        anchor: "consentimentos.base.lista",
        title: "Lista de consentimentos",
        body: "Canal, destinatário, situação (Bloqueado/Autorizado), motivo, origem e quando foi atualizado.",
        articleSection: "base",
      },
      {
        anchor: "consentimentos.cabecalho.exportar",
        title: "Exportar CSV",
        body: "Baixa a base inteira de consentimentos da casa, não só os registros mostrados aqui.",
        articleSection: "cabecalho",
      },
    ],
    registrar: [
      {
        anchor: "consentimentos.registrar.canal",
        title: "Canal",
        body: "SMS, E-mail ou Voz — só aparecem os canais que a casa tem ligados.",
        articleSection: "registrar",
      },
      {
        anchor: "consentimentos.registrar.destinatario",
        title: "Telefone ou e-mail",
        body: "O contato que vai ser bloqueado ou autorizado.",
        articleSection: "registrar",
      },
      {
        anchor: "consentimentos.registrar.decisao",
        title: "Decisão",
        body: "Bloquear impede novos envios/ligações; Autorizar libera de novo.",
        articleSection: "registrar",
      },
      {
        anchor: "consentimentos.registrar.base-legal",
        title: "Base legal",
        body: "Opcional: anota, para a LGPD, qual é a base legal dessa decisão.",
        articleSection: "registrar",
      },
      {
        anchor: "consentimentos.registrar.motivo",
        title: "Motivo",
        body: "Por que a decisão está sendo tomada. Aparece depois no histórico.",
        articleSection: "registrar",
      },
      {
        anchor: "consentimentos.registrar.salvar",
        title: "Salvar decisão",
        body: "Grava a decisão. Se já existir uma para esse canal + contato, ela é substituída.",
        articleSection: "registrar",
      },
      {
        anchor: "consentimentos.importar.csv",
        title: "Importar em lote",
        body: "Cole um CSV com o cabeçalho channel,subject,status,reason (e, se quiser, legal_basis,source).",
        articleSection: "registrar",
      },
      {
        anchor: "consentimentos.importar.enviar",
        title: "Importar",
        body: "Grava uma decisão por linha do CSV colado.",
        articleSection: "registrar",
      },
    ],
    historico: [
      {
        anchor: "consentimentos.abas",
        title: "Você está em Histórico",
        body: "As 100 alterações de consentimento mais recentes da casa.",
        articleSection: "historico",
      },
      {
        anchor: "consentimentos.historico.lista",
        title: "Lista do histórico",
        body: "Data, canal, destinatário, a mudança de situação, motivo e origem de cada alteração.",
        articleSection: "historico",
      },
    ],
    voz: [
      {
        anchor: "consentimentos.voz.aplicar",
        title: "Aplicar os limites",
        body: "Liga ou desliga os dois limites de frequência de ligação abaixo.",
        articleSection: "voz",
      },
      {
        anchor: "consentimentos.voz.intervalo",
        title: "Intervalo mínimo",
        body: "Quantas horas esperar entre duas ligações para o mesmo número.",
        articleSection: "voz",
      },
      {
        anchor: "consentimentos.voz.limite",
        title: "Máximo em 24 h",
        body: "O total de ligações que o mesmo número pode receber num período de 24 horas.",
        articleSection: "voz",
      },
      {
        anchor: "consentimentos.voz.salvar",
        title: "Salvar limites",
        body: "Grava os dois limites.",
        articleSection: "voz",
      },
    ],
  },
};

export default screen;
