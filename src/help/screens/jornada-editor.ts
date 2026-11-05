// Help article for the journey editor, registered under BOTH
// /jornadas/nova (new journey) and /jornadas/$journeyId (editing an
// existing one) — same component, same content. Fonte:
// src/routes/jornadas.nova.tsx, src/routes/jornadas.$journeyId.tsx,
// src/components/journeys/journey-editor.tsx (+ journey-editor-config.ts),
// src/components/journeys/journey-status-control.tsx (os 3 diálogos) e
// src/lib/journey-policy.ts / src/lib/journey-map.ts (filtros de entrada e
// avisos de conflito). Sem abas — um único tour "default".
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "jornada-editor",
  route: "/jornadas/nova",
  title: "Jornada",
  purpose:
    "Monta uma jornada automática: o gatilho que coloca o jogador dentro, quem pode entrar, as etapas de espera e mensagem, quando ela termina para o jogador e os limites que protegem a operação.",
  roles: ["admin", "gestor", "member"],
  terms: ["gatilho", "reentrada", "grupo-de-controle", "encurtador", "ftd", "familia-de-jornadas", "prioridade-de-jornada"],
  sections: [
    // ---------------------------------------------------------------
    // Cabeçalho e barra de ações
    // ---------------------------------------------------------------
    {
      id: "cabecalho",
      title: "Cabeçalho e barra de ações",
      intro:
        'O título mostra "Nova jornada" ou o nome salvo; o subtítulo mostra o status (Rascunho/Ativa/Pausada/Arquivada), o gatilho e, quando há mudanças não salvas, "· alterações não salvas".',
      items: [
        {
          anchor: "jornada.voltar",
          label: "Automações",
          what: "Volta para a aba Jornadas de Automações, sem salvar nada que ainda não tenha sido salvo.",
        },
        {
          anchor: "jornada.relatorio-link",
          label: "Relatório",
          what: "Abre o relatório desta jornada (só aparece depois da jornada já ter sido salva pelo menos uma vez).",
        },
        {
          anchor: "jornada.rodape.ativar-pausar",
          label: "Ativar / Salvar e ativar / Pausar",
          what: '"Pausar" aparece numa jornada ativa e abre o diálogo de confirmação de pausa. "Ativar" aparece numa jornada pausada ou recém-criada. Numa jornada em rascunho com alterações não salvas, o texto muda para "Salvar e ativar": salva antes de abrir o diálogo de ativação. Não aparece em jornadas arquivadas nem antes da jornada ser salva pela primeira vez.',
          notes:
            'Numa jornada ativa ou pausada com alterações não salvas, clicar em "Ativar" sem salvar antes abre a confirmação "Ativar sem as alterações?" — ver os diálogos, mais abaixo.',
        },
        {
          anchor: "jornada.rodape.salvar",
          label: "Salvar",
          what: 'Grava a jornada. Numa jornada nova mostra "Jornada criada como rascunho. Ela só envia depois de ativada."; numa jornada em rascunho mostra "Rascunho salvo"; numa jornada ativa ou pausada, salvar não altera a versão em uso — cria uma revisão em rascunho e mostra "Alterações salvas numa revisão em rascunho. A versão ativa/pausada continua igual."',
          notes:
            "Durante o salvamento o texto muda para \"Salvando…\" e o botão fica desabilitado. Erros de validação (veja Erros ao salvar, nos estados) impedem o salvamento e aparecem como aviso.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Gatilho de entrada
    // ---------------------------------------------------------------
    {
      id: "gatilho",
      title: "Gatilho de entrada",
      intro:
        "O que coloca o jogador na jornada. Ele só entra de fato se também fizer parte do público escolhido em Público, mais abaixo.",
      items: [
        {
          anchor: "jornada.gatilho.tipo",
          label: "Quando o jogador entra",
          what: 'Lista agrupada em "Quando algo acontece" (23 eventos), "Quando nada acontece" (Tempo sem atividade) e "Sem gatilho" (Entrada manual ou API).',
        },
        {
          label: "Lead cadastrado",
          what: "Quando usar: para abordar o lead assim que ele é cadastrado pelo link de um expert (CRM Expert), antes mesmo de se tornar jogador.",
        },
        {
          label: "Recuperação VIP",
          what: "Quando usar: para tentar trazer de volta um VIP que já passou 7 dias ou mais sem fazer login.",
        },
        {
          label: "VIP esfriando",
          what: "Quando usar: para agir rápido com um VIP que parou de jogar há 2 dias ou mais, antes que ele esfrie de verdade.",
        },
        {
          label: "Receita em queda",
          what: "Quando usar: para reagir a uma queda de 50% ou mais nos depósitos de quem já depositava pelo menos R$ 200.",
        },
        {
          label: "Lead quente esfriando",
          what: "Quando usar: para reengajar quem depositava 5 dias seguidos e parou de repente, entre 3 e 7 dias atrás.",
        },
        {
          label: "Quase VIP",
          what: "Quando usar: para incentivar quem já depositou entre R$ 800 e R$ 999 no total a cruzar o próximo nível.",
        },
        {
          label: "Alto potencial",
          what: "Quando usar: para investir em quem já tem 10 ou mais logins, depósitos crescendo e login recente.",
        },
        {
          label: "Reativação em curso",
          what: "Quando usar: para dar continuidade a quem voltou a depositar depois de 14 dias ou mais parado, reforçando a reativação enquanto ela está fresca.",
        },
        {
          label: "Dinheiro parado",
          what: "Quando usar: para avisar quem tem saldo de R$ 50 ou mais na conta e está parado (sem jogar) há 5 dias ou mais.",
        },
        {
          label: "Engajado sem converter",
          what: "Quando usar: para converter quem entra bastante (8 ou mais logins em 30 dias) mas não deposita há 14 dias ou mais.",
        },
        {
          label: "Frequência de queda",
          what: "Quando usar: quando a frequência de login de alguém cair 50% ou mais, antes que ele pare de vez.",
        },
        {
          label: "Cadastrados sem depósito",
          what: "Quando usar: para converter quem se cadastrou e nunca fez o primeiro depósito; a jornada encerra sozinha quando ele depositar.",
          notes: 'Aceita o campo "Só entra quem se cadastrou nas últimas (horas)" — ver Campos condicionais.',
        },
        {
          label: "7 a 14 dias sem login",
          what: "Quando usar: para reativar quem está sem login entre 7 e 14 dias — a janela mais recente de ausência.",
        },
        {
          label: "15 a 24 dias sem login",
          what: "Quando usar: para quem está sem login entre 15 e 24 dias.",
        },
        {
          label: "25 a 34 dias sem login",
          what: "Quando usar: para quem está sem login entre 25 e 34 dias.",
        },
        {
          label: "35 a 44 dias sem login",
          what: "Quando usar: para quem está sem login entre 35 e 44 dias.",
        },
        {
          label: "45 a 59 dias sem login",
          what: "Quando usar: para quem está sem login entre 45 e 59 dias.",
        },
        {
          label: "60+ dias sem login",
          what: "Quando usar: para quem já está sem login há 60 dias ou mais — a faixa mais fria de reativação.",
        },
        {
          label: "Cashback pago",
          what: "Quando usar: para engajar no mesmo dia quem recebeu um cashback (avisado por webhook).",
        },
        {
          label: "PIX gerado e não pago",
          what: "Quando usar: para lembrar quem gerou um PIX e ainda não pagou, antes que ele esqueça do depósito.",
          notes: 'Aceita o campo "Só entra PIX gerado nas últimas (horas)" — ver Campos condicionais.',
        },
        {
          label: "Primeiro depósito",
          what: "Quando usar: para dar as boas-vindas e orientar os próximos passos logo depois do primeiro depósito aprovado (FTD).",
          notes: 'Aceita o campo "Só entra quem fez o 1º depósito nas últimas (horas)" — ver Campos condicionais.',
        },
        {
          label: "Saque pago",
          what: "Quando usar: para conversar com quem teve um saque aprovado — por exemplo, para incentivá-lo a continuar jogando.",
          notes: 'Aceita o campo "Só entra saque pago nas últimas (horas)" — ver Campos condicionais.',
        },
        {
          label: "Mudou de nível",
          what: "Quando usar: para parabenizar e orientar o jogador assim que ele sobe de nível de gamificação.",
          notes:
            'Ao escolher este gatilho, o editor já marca sozinho a família "Progressão de níveis", a política "Manter apenas esta família" e a prioridade 4, e liga a saída "Mudou de nível" — ver Campos condicionais e Conflitos. Ao entrar aqui, o jogador sai automaticamente da jornada do nível anterior.',
        },
        {
          label: "Tempo sem atividade",
          what: 'Gatilho de "quando nada acontece": o jogador entra quando passa um tempo sem a atividade escolhida. Quando usar: para agir depois de um período de silêncio (sem login, sem jogo ou sem depósito) que não se encaixa nas faixas fixas de dias sem login.',
          notes: "Mostra os campos Sem atividade em / Horas sem atividade — ver Campos condicionais.",
        },
        {
          label: "Entrada manual ou API",
          what: 'Sem gatilho automático: ninguém entra pelo evento. Quando usar: para jornadas que só recebem jogadores colocados manualmente ou por integração externa (API).',
        },
        {
          anchor: "jornada.gatilho.atividade",
          label: "Sem atividade em",
          what: 'Campo condicional (só com "Tempo sem atividade"): Login, Jogo ou Depósito — a atividade que a jornada observa.',
        },
        {
          anchor: "jornada.gatilho.horas",
          label: "Horas sem atividade",
          what: 'Campo condicional (só com "Tempo sem atividade"): depois de quantas horas sem essa atividade o jogador entra. De 1 a 8.760 (1 ano).',
        },
        {
          anchor: "jornada.gatilho.nivel",
          label: "Nível de destino",
          what: 'Campo condicional (só com "Mudou de nível"): Bronze, Prata, Ouro, Diamante ou Black VIP — o nível que dispara a entrada.',
        },
        {
          anchor: "jornada.gatilho.idade-maxima",
          label:
            "Só entra quem se cadastrou / fez o 1º depósito / saque pago nas últimas (horas)",
          what: "Campo condicional, só nos gatilhos Cadastrados sem depósito, Primeiro depósito e Saque pago: evita tratar um evento antigo da base como se fosse novo ao ativar a jornada. 0 tira o limite.",
          notes: "De 0 a 8.760 horas (1 ano).",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Identificação
    // ---------------------------------------------------------------
    {
      id: "identificacao",
      title: "Identificação",
      items: [
        {
          anchor: "jornada.identificacao.nome",
          label: "Nome",
          what: "Identifica a jornada para a equipe (na lista de Automações, no relatório, nos avisos de conflito). Obrigatório.",
          notes: 'Sem nome, salvar mostra o erro "Dê um nome para a jornada."',
        },
        {
          anchor: "jornada.identificacao.descricao",
          label: "Descrição (opcional)",
          what: "Registra o objetivo da jornada para a equipe. Nunca é enviada ao jogador.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Público e reentrada
    // ---------------------------------------------------------------
    {
      id: "publico",
      title: "Público",
      intro:
        "Quem pode entrar depois de cumprir o gatilho. Consentimento e canal disponível são verificados em cada envio, à parte destes filtros.",
      items: [
        {
          anchor: "jornada.publico.quem-entra",
          label: "Quem entra",
          what: '"Todos os jogadores da casa" (qualquer um que cumprir o gatilho, ativo ou não), "Só jogadores ativos" ou "Só VIP".',
        },
        {
          anchor: "jornada.publico.reentrada",
          label: "Reentrada",
          what: 'As 4 opções: "Uma única vez" (entra uma vez na vida), "A cada ocorrência" (entra toda vez que cumprir o gatilho de novo, sem espera mínima), "Depois do intervalo entre jornadas" (só reentra depois do número de horas do campo "Intervalo entre jornadas (horas)", em Limites e duração) e "Nunca reentrar" (quem já passou pela jornada nunca mais entra, mesmo cumprindo o gatilho de novo).',
          notes:
            'A opção "Depois do intervalo entre jornadas" não tem um campo de horas próprio: ela usa o mesmo número do campo "Intervalo entre jornadas (horas)" de Limites e duração. Esse campo serve a dois propósitos ao mesmo tempo — o intervalo mínimo entre uma reentrada e outra nesta jornada, e o intervalo mínimo antes de outra jornada enviar no mesmo canal (ver Limites e duração).',
        },
        {
          anchor: "jornada.publico.ftd",
          label: "Só quem já fez o primeiro depósito",
          what: 'Filtro de entrada (opcional). Caixa de marcar: exige que o jogador já tenha feito o primeiro depósito (FTD) para entrar e para continuar na jornada.',
        },
        {
          anchor: "jornada.publico.filtros",
          label:
            "Total depositado mínimo / máximo (R$), Fora quem depositou nas últimas (horas), Só quem depositou nos últimos (dias)",
          what: 'Filtros de entrada (opcionais), todos em R$ ou em tempo. "Total depositado mínimo": ex. 200, para focar em quem já tem valor. "Total depositado máximo": ex. 999, para deixar de fora os maiores jogadores. "Fora quem depositou nas últimas (horas)": ex. 48, para não mandar para quem já está ativo. "Só quem depositou nos últimos (dias)": ex. 30, para não insistir em quem sumiu há muito tempo.',
          notes:
            "Valem na entrada e antes de cada envio: quem deixar de cumprir um filtro sai da jornada. Campo vazio não filtra; só aceita números (0 ou mais).",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Etapas
    // ---------------------------------------------------------------
    {
      id: "etapas",
      title: "Etapas",
      intro:
        "Cada etapa acontece depois que a anterior termina. SMS e e-mail usam templates ativos, e a jornada guarda uma cópia (template_snapshot) da versão usada, para não mudar depois de ativada.",
      items: [
        {
          anchor: "jornada.etapas.remover",
          label: "Remover a etapa N (ícone de lixeira)",
          what: "Apaga essa etapa da lista. Repete-se em cada etapa; a âncora marca só a primeira.",
        },
        {
          anchor: "jornada.etapas.espera-tempo",
          label: "Tempo de espera (etapa Aguardar)",
          what: "Quanto tempo a jornada aguarda antes de seguir para a próxima etapa. Aceita vírgula (ex.: 1,5).",
          notes: 'Menos de 1 minuto é salvo como 1 minuto ("O mínimo é 1 minuto; menos que isso é salvo como 1 minuto."). Vazio ou zero impede salvar: "Informe o tempo de espera da etapa N."',
        },
        {
          anchor: "jornada.etapas.espera-unidade",
          label: "Unidade da espera",
          what: "Minutos, horas ou dias.",
        },
        {
          anchor: "jornada.etapas.sms-template",
          label: "Template de SMS (etapa Enviar SMS)",
          what: "Escolhe o template de SMS ativo que esta etapa envia. O conteúdo aparece abaixo, só para leitura.",
          notes:
            'Quando o template sorteia entre várias variações, aparece o aviso "Esta etapa sorteia entre N variações a cada envio; o texto acima é a primeira. Escolher um template substitui todas." Sem domínio do encurtador verificado, aparece o aviso do encurtador padrão (ver estados).',
        },
        {
          anchor: "jornada.etapas.sms-dominio",
          label: "Domínio do encurtador (etapa SMS)",
          what: 'Escolhe, entre os domínios do encurtador verificados da casa, qual hospeda os links curtos desta etapa, ou "Padrão da casa" para seguir sempre o domínio padrão atual.',
        },
        {
          anchor: "jornada.etapas.email-template",
          label: "Template de e-mail (etapa Enviar e-mail)",
          what: "Escolhe o template de e-mail ativo que esta etapa envia.",
          notes: "Sem remetente de e-mail verificado, aparece o aviso de e-mail bloqueado (ver estados).",
        },
        {
          anchor: "jornada.etapas.email-remetente",
          label: "Remetente de e-mail (etapa e-mail)",
          what: 'Escolhe, entre os remetentes verificados da casa, quem envia esta etapa, ou "Padrão da casa" para seguir sempre o remetente padrão atual.',
        },
        {
          anchor: "jornada.etapas.email-dominio",
          label: "Domínio do encurtador (etapa e-mail)",
          what: "O mesmo seletor de domínio do encurtador da etapa de SMS, aplicado aos links do e-mail desta etapa.",
        },
        {
          anchor: "jornada.etapas.voz-audio",
          label: "Áudio da ligação (etapa Fazer ligação)",
          what: "Escolhe, entre os áudios já enviados para esta casa, qual é tocado na ligação desta etapa.",
        },
        {
          anchor: "jornada.etapas.voz-upload",
          label: "Enviar novo áudio",
          what: "Envia um arquivo de áudio novo (MP3, WAV, M4A ou OGG) para usar nesta ou em outras etapas de ligação.",
          notes: 'Mostra "Enviando…" durante o envio.',
        },
        {
          anchor: "jornada.etapas.adicionar",
          label: "Adicionar etapa",
          what: "Abre o menu para escolher o tipo da nova etapa: Espera, SMS, E-mail ou Ligação (voz) — os 4 tipos de etapa da jornada.",
        },
        {
          anchor: "jornada.etapas.loop-maximo",
          label: "Repetir o loop no máximo",
          what: 'Campo condicional: só aparece quando a jornada já termina em loop (volta a repetir as últimas etapas). Depois do número de repetições escolhido, a jornada termina de vez para o jogador.',
          notes: "Limite máximo definido pelo sistema (MAX_LOOPS_LIMIT).",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Saída
    // ---------------------------------------------------------------
    {
      id: "saida",
      title: "Saída",
      intro:
        "A jornada encerra para o jogador quando um destes eventos acontece, para evitar mensagens fora de contexto.",
      items: [
        {
          anchor: "jornada.saida.regra",
          label: "Realizou depósito / Fez o primeiro depósito / Fez login / Voltou a jogar",
          what: "Cada caixinha marcada encerra a jornada para o jogador assim que esse evento acontecer. Repetem a mesma estrutura; a âncora marca só a primeira.",
          notes:
            'Jornadas de "Mudou de nível" sempre encerram sozinhas quando o jogador muda de nível (independente destas caixinhas), e ele entra direto na jornada do novo nível a partir da primeira etapa.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Janela de envio
    // ---------------------------------------------------------------
    {
      id: "janela",
      title: "Janela de envio",
      intro: "Mensagens fora deste horário aguardam a próxima abertura, no horário de Brasília.",
      items: [
        {
          anchor: "jornada.janela.inicio",
          label: "De",
          what: "Horário em que a janela de envio abre, todos os dias da semana.",
        },
        {
          anchor: "jornada.janela.fim",
          label: "Até",
          what: "Horário em que a janela de envio fecha.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Limites e duração
    // ---------------------------------------------------------------
    {
      id: "limites",
      title: "Limites e duração",
      intro:
        "Protegem a operação contra envios em excesso. O intervalo entre jornadas não muda as esperas desta jornada.",
      items: [
        {
          anchor: "jornada.limites.diario",
          label: "Limite diário de mensagens",
          what: "Quantas mensagens esta jornada pode enviar por dia, no total.",
        },
        {
          anchor: "jornada.limites.intervalo",
          label: "Intervalo entre jornadas (horas)",
          what: "Tempo mínimo antes de outra jornada enviar no mesmo canal para o mesmo jogador.",
          notes:
            'Este mesmo número também é usado pela opção de Reentrada "Depois do intervalo entre jornadas", em Público — não existe um segundo campo só para isso.',
        },
        {
          anchor: "jornada.limites.controle",
          label: "Grupo de controle",
          what: 'Desligado, 5% ou 10%: a fração dos jogadores que entrarem fica sem receber mensagens, de propósito, para medir o efeito real da jornada em Resultados do CRM.',
          notes: "Sem grupo de controle, a jornada não mede o efeito incremental — só o volume enviado.",
        },
        {
          anchor: "jornada.limites.termino",
          label: "Data de término (opcional)",
          what: "Horário de Brasília. Depois dessa data, ninguém novo entra e quem estiver na jornada sai.",
          notes: "Sem data, a jornada roda até ser pausada ou arquivada manualmente.",
        },
        {
          anchor: "jornada.limites.termino-limpar",
          label: "Limpar (data de término)",
          what: 'Só aparece quando há uma data preenchida. Remove a data de término, voltando a jornada a rodar sem prazo.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Conflitos entre jornadas
    // ---------------------------------------------------------------
    {
      id: "conflitos",
      title: "Conflitos entre jornadas",
      intro:
        "O que acontece quando outra jornada disputa o mesmo jogador. Na disputa, o menor número de prioridade vence.",
      items: [
        {
          label: "Aviso de conflito",
          what: 'Lista de avisos (aparece só quando há algum): por exemplo "A faixa desta jornada se sobrepõe a \'<nome>\' (<faixa>): o mesmo jogador estaria nas duas. Defina a saída por tempo para encerrar onde a outra começa.", "Já existe uma jornada ativa para este nível: \'<nome>\'." ou "\'<nome>\' usa o mesmo gatilho com a mesma prioridade: quando as duas tiverem mensagem no mesmo momento, não há uma vencedora definida."',
          notes: "São avisos, não bloqueios: a jornada pode ser salva e ativada mesmo com um aviso de conflito.",
        },
        {
          anchor: "jornada.conflitos.familia",
          label: "Família",
          what: '"Sem família" ou "Progressão de níveis". Jornadas da mesma família não rodam juntas para o mesmo jogador — a política abaixo decide o que acontece.',
        },
        {
          anchor: "jornada.conflitos.prioridade",
          label: "Prioridade (1 é a maior)",
          what: "Número de 1 a 100. Quando duas jornadas ativas disputam o mesmo canal para o mesmo jogador, a de menor número vence.",
        },
        {
          anchor: "jornada.conflitos.ao-competir",
          label: "Ao competir",
          what: '"Permitir coexistência" (as duas enviam, sem controle entre si), "Pausar a menor prioridade" (no mesmo canal, a de maior prioridade segue; a outra aguarda) ou "Manter apenas esta família" (só a jornada da família ativa continua).',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Diálogos
    // ---------------------------------------------------------------
    {
      id: "dialogos",
      title: "Diálogos",
      intro:
        "Os 3 diálogos do editor. Nenhum deles tem elementos marcados para o tour — o tour nunca abre um diálogo sozinho.",
      items: [
        {
          label: 'Diálogo "Pausar [nome]?"',
          what: 'Mostra quantos jogadores estão na jornada agora. Com pelo menos um jogador dentro, oferece a escolha "Manter os jogadores" (ao ativar de novo, cada um continua de onde parou) ou "Encerrar a participação de todos" (todos saem agora; ao ativar de novo, só entra quem cumprir o gatilho de novo). Botões "Cancelar" e "Pausar" (ou "Pausar e encerrar", escolhendo a segunda opção).',
          notes:
            'Sem ninguém na jornada, mostra só "Ninguém está nesta jornada agora. Enquanto ela estiver pausada, ninguém novo entra." e não oferece a escolha. Ao confirmar, aparece um aviso de sucesso: "Jornada pausada" (manteve os jogadores) ou "Jornada pausada · N jogador(es) saíram da jornada" (encerrou a participação de todos).',
        },
        {
          label: 'Diálogo "Ativar [nome]"',
          what: 'Pergunta "Quem pode entrar nesta jornada?": "Só casos novos, a partir de agora" (ninguém da base atual entra; quem já estava sai na próxima verificação) ou "Incluir a base atual" (jogadores que já cumprem o gatilho entram nos próximos minutos, com uma estimativa de quantos e do custo do 1º envio e da jornada completa). Botões "Cancelar" e "Ativar".',
          notes:
            'Só aparece para gatilhos que fazem sentido perguntar isso (todos, exceto "Mudou de nível" e "Entrada manual ou API") — os outros ativam direto, sem este diálogo. A estimativa mostra "Calculando o impacto…" enquanto carrega. Ao confirmar, aparece o aviso de sucesso "Jornada ativada".',
        },
        {
          label: 'Confirmação "Ativar sem as alterações?"',
          what: 'Aparece ao clicar em Ativar numa jornada ativa ou pausada com alterações não salvas no editor: "As alterações que você fez aqui ainda não foram salvas e não entram na jornada. Para usá-las, salve (isso cria uma revisão em rascunho) e ative a revisão." Botões "Cancelar" e "Ativar versão salva".',
        },
      ],
    },
  ],

  states: [
    {
      id: "revisao-em-rascunho",
      title:
        "Esta jornada está ativa/pausada. Salvar cria uma revisão em rascunho; a versão ativa/pausada continua como está até você ativar a revisão.",
      what: "Aviso fixo no topo do editor, só em jornadas ativas ou pausadas: qualquer alteração feita aqui não afeta a versão em uso até a revisão em rascunho ser ativada.",
    },
    {
      id: "alteracoes-nao-salvas",
      title: "· alterações não salvas",
      what: "Acrescentado ao subtítulo do cabeçalho sempre que há uma mudança no formulário ainda não salva.",
    },
    {
      id: "sem-etapas",
      title: "Nenhuma etapa ainda. Comece por uma espera ou por uma mensagem.",
      what: "Texto mostrado quando a jornada ainda não tem nenhuma etapa cadastrada.",
      action: 'Clique em "Adicionar etapa".',
    },
    {
      id: "encurtador-padrao-aviso",
      title:
        "Seu domínio personalizado ainda não foi verificado — os links estão saindo pelo encurtador padrão do CRM.",
      what: "Aviso dentro de uma etapa de SMS ou e-mail, quando a casa não tem (ainda) um domínio do encurtador verificado.",
      action: "Verifique um domínio do encurtador em Configurações → Casa → Encurtador.",
    },
    {
      id: "email-bloqueado-aviso",
      title: "Configure e verifique um domínio de e-mail da casa para enviar e-mails.",
      what: "Aviso dentro de uma etapa de e-mail, quando a casa ainda não tem nenhum remetente de e-mail verificado.",
      action: 'Clique em "Configurar" (dentro do aviso) para ir a Configurações → Casa → E-mail.',
    },
    {
      id: "opcoes-de-envio-erro",
      title: "Não foi possível carregar as opções de envio.",
      what: 'Aviso dentro de uma etapa de SMS ou e-mail, quando a busca dos domínios do encurtador e dos remetentes falhou (erro de rede ou do servidor) — aparece no lugar dos avisos de "domínio não verificado", porque enquanto a busca não funcionar o editor não sabe se há ou não um domínio/remetente verificado.',
      action: "Atualize a página para tentar carregar de novo; a etapa pode ser salva mesmo assim, mas confira o remetente e o domínio antes de ativar a jornada.",
    },
    {
      id: "erros-ao-salvar",
      title: "Mensagens de erro ao salvar",
      what: '"Dê um nome para a jornada." (nome vazio); "Selecione o nível que inicia esta jornada." (gatilho Mudou de nível sem nível escolhido); "Escolha a atividade que a jornada observa." e "Informe as horas sem atividade (de 1 a 8760)." (gatilho Tempo sem atividade incompleto); "Informe o tempo de espera da etapa N." (uma etapa Aguardar sem tempo válido).',
      action: "Corrija o campo indicado e clique em Salvar de novo.",
    },
    {
      id: "barra-fixa-celular",
      title: "Barra fixa no celular",
      what: "No celular, os botões Ativar/Pausar e Salvar ficam numa barra fixa na parte de baixo da tela, acima da barra de abas, sempre à mão enquanto você rola o formulário.",
    },
  ],

  tours: {
    default: [
      {
        anchor: "jornada.gatilho.tipo",
        title: "O gatilho de entrada",
        body: "Escolha o que coloca o jogador na jornada: um evento, um tempo sem atividade ou nenhum gatilho (entrada manual).",
        articleSection: "gatilho",
      },
      {
        anchor: "jornada.identificacao.nome",
        title: "Nome da jornada",
        body: "Dê um nome para identificar esta jornada na lista de Automações e no relatório.",
        articleSection: "identificacao",
      },
      {
        anchor: "jornada.publico.quem-entra",
        title: "Quem entra",
        body: "Todos os jogadores, só ativos ou só VIP — além de cumprir o gatilho.",
        articleSection: "publico",
      },
      {
        anchor: "jornada.publico.reentrada",
        title: "Reentrada",
        body: "Se o mesmo jogador pode voltar à jornada depois de sair dela, e quando.",
        articleSection: "publico",
      },
      {
        anchor: "jornada.etapas.adicionar",
        title: "Adicionar etapa",
        body: "Monte a sequência da jornada: espera, SMS, e-mail ou ligação.",
        articleSection: "etapas",
      },
      {
        anchor: "jornada.saida.regra",
        title: "Saída",
        body: "Marque os eventos que encerram a jornada para o jogador, para evitar mensagens fora de contexto.",
        articleSection: "saida",
      },
      {
        anchor: "jornada.limites.controle",
        title: "Grupo de controle",
        body: "Deixe uma fração dos jogadores sem mensagem para medir o efeito real da jornada.",
        articleSection: "limites",
      },
      {
        anchor: "jornada.rodape.salvar",
        title: "Salvar",
        body: "Grava a jornada como rascunho. Ela só passa a enviar mensagens depois de ativada.",
        articleSection: "cabecalho",
      },
    ],
  },
};

export default screen;

/** The same article for /jornadas/$journeyId (editing an existing journey):
 * HelpProvider only shows an article whose `route` equals the resolved
 * registry key, so the edit route needs its own `route` (registry.ts). Same
 * `id`, so search indexes the article once (search.ts dedupes by id). */
export const editScreen: HelpScreen = { ...screen, route: "/jornadas/$journeyId" };
