// Help article for "Campanhas" (/campanhas). Uma única tela sem abas: o hub
// de campanhas, o compositor "Nova campanha" (SMS/E-mail/Voz) e o diálogo
// "Envio de teste" — os dois últimos são diálogos, por isso o tour cobre só
// o hub (nunca abre um diálogo sozinho). Fonte: src/routes/campanhas.tsx,
// src/components/campaigns/campaigns-hub.tsx, channel-campaign-composer.tsx,
// individual-sms-dialog.tsx, src/lib/channel-operation-state.ts (selos de
// status), src/lib/campaign-recipients.ts (motivos de "não enviados"),
// src/lib/campaign-external-list.ts (lista de números), src/lib/sms-segments.ts
// (GSM-7/UCS-2) e src/components/house-config/{composer-notices,
// email-sender-select,short-domain-select,link-insert-menu,
// campaign-blocked-badge}.tsx. A tela do expert (expert-campaigns-hub.tsx) não
// é documentada aqui (fase 4).
import type { HelpScreen } from "../types";

const screen: HelpScreen = {
  id: "campanhas",
  route: "/campanhas",
  title: "Campanhas",
  purpose:
    "A lista de campanhas de SMS, e-mail e voz já enviadas, agendadas ou em andamento, o compositor para criar uma nova campanha e o envio de teste para um único número ou e-mail.",
  roles: ["admin", "gestor", "member"],
  terms: ["segmento-sms", "encurtador", "remetente", "grupo-de-controle"],
  sections: [
    // ---------------------------------------------------------------
    // Hub de campanhas
    // ---------------------------------------------------------------
    {
      id: "hub",
      title: "Lista de campanhas",
      intro:
        "Todas as campanhas de SMS, e-mail e voz dos últimos 30 dias (os indicadores no topo) e todas as campanhas da lista, sem limite de data. Atualiza sozinha a cada 30 segundos.",
      items: [
        {
          anchor: "campanhas.hub.envio-teste",
          label: "Envio de teste",
          what: "Abre o diálogo para mandar SMS, e-mail ou voz a um único número/e-mail, sem criar uma campanha.",
        },
        {
          anchor: "campanhas.hub.nova-campanha",
          label: "Nova campanha",
          what: "Abre o compositor para criar uma campanha de SMS, e-mail ou voz.",
        },
        {
          label: "Indicadores Enviados / Falhas / Em envio",
          what: 'Somam todas as campanhas (SMS, e-mail e voz) dos últimos 30 dias. "Enviados" e "Falhas" contam mensagens/ligações; "Em envio" conta campanhas (agendadas ou enviando agora), não mensagens.',
        },
        {
          anchor: "campanhas.hub.rascunho-continuar",
          label: "Continuar (rascunho)",
          what: "Reabre o compositor com o rascunho salvo, no ponto em que você parou de editar.",
          notes:
            "O cartão \"Rascunhos\" só aparece quando existe pelo menos um rascunho. Repete-se em cada rascunho; a âncora marca só o primeiro.",
        },
        {
          anchor: "campanhas.hub.rascunho-excluir",
          label: "Excluir rascunho (ícone de lixeira)",
          what: 'Pede confirmação ("Excluir rascunho?", botões "Cancelar" e "Excluir rascunho") e depois apaga o rascunho. Repete-se em cada rascunho; a âncora marca só o primeiro.',
        },
        {
          anchor: "campanhas.hub.status-filtro",
          label: "Status da campanha (filtro)",
          what: '"Todas", "Agendadas", "Enviando", "Pausadas" ou "Finalizadas". Cada opção mostra quantas campanhas tem, somando SMS, e-mail e voz.',
        },
        {
          anchor: "campanhas.hub.busca",
          label: "Buscar campanha",
          what: "Filtra a lista pelo nome da campanha, sem distinguir maiúsculas/minúsculas.",
        },
        {
          anchor: "campanhas.hub.selo-status",
          label: "Selo de status da campanha",
          what: "O estado atual da campanha; veja a lista completa de selos em \"Estados\", mais abaixo. Repete-se em cada campanha; a âncora marca só a primeira.",
        },
        {
          label: "Selo \"Bloqueada\"",
          what: 'Aparece ao lado do status quando o último envio de uma campanha de e-mail foi bloqueado — por exemplo porque o remetente escolhido perdeu a verificação do domínio. Passe o mouse (ou veja o rótulo para leitor de tela) para o motivo completo.',
        },
        {
          label: 'Selo "N não enviados"',
          what: "Quantos destinatários ficaram de fora da campanha (sem cadastro, telefone inválido, sem consentimento, no grupo de controle de uma jornada ou — na lista de números — já jogadores). O motivo de cada um está no relatório da campanha.",
        },
        {
          anchor: "campanhas.hub.relatorio",
          label: "Relatório",
          what: "Abre o relatório da campanha (resultado, funil, destinatários). Não aparece em campanhas de voz agrupadas (mais de uma ligação sem um relatório único) nem na tela do expert.",
          notes: "Repete-se em cada campanha com relatório; a âncora marca só a primeira.",
        },
        {
          anchor: "campanhas.hub.retomar",
          label: "Retomar",
          what: "Volta a enviar uma campanha de SMS ou e-mail pausada. No SMS, retoma direto; no e-mail, pede confirmação antes.",
          notes:
            'Confirmação do e-mail: "Retomar “<nome>”?" com o aviso "Os e-mails restantes serão enviados imediatamente. Quem já recebeu esta campanha não recebe de novo." Se ainda faltar saldo, a campanha pausa de novo sozinha. Só aparece em campanhas pausadas de SMS ou e-mail; repete-se em cada uma, a âncora marca só a primeira.',
        },
        {
          anchor: "campanhas.hub.ver-saldo",
          label: "Ver saldo",
          what: "Leva para Plano e créditos. Só aparece numa campanha de SMS pausada por falta de saldo.",
          notes: "Repete-se em cada campanha nesse estado; a âncora marca só a primeira.",
        },
        {
          anchor: "campanhas.hub.cancelar",
          label: "Cancelar",
          what: 'Pede confirmação ("Cancelar o envio desta campanha?", com os botões "Manter campanha" e "Cancelar envio") e, se confirmado, cancela os envios ainda não feitos — o que já foi enviado não é desfeito.',
          notes:
            "Só existe para campanhas de SMS agendadas ou pausadas. E-mail e voz nunca mostram este botão, mesmo agendados: não há como cancelar uma campanha de e-mail ou de voz a partir desta lista, nem antes do horário agendado. Repete-se em cada campanha de SMS cancelável; a âncora marca só a primeira.",
        },
      ],
    },

    // ---------------------------------------------------------------
    // Compositor "Nova campanha"
    // ---------------------------------------------------------------
    {
      id: "compositor",
      title: 'Compositor "Nova campanha"',
      intro:
        'Diálogo aberto por "Nova campanha" ou "Continuar" num rascunho. O rascunho é salvo automaticamente enquanto você edita (fica visível no cabeçalho: "Salvando rascunho…" / "Rascunho salvo" / "Não foi possível salvar o rascunho"); o botão de enviar fica desabilitado até o rascunho salvar.',
      items: [
        {
          anchor: "campanhas.compositor.canal",
          label: "Canal",
          what: "Escolhe entre SMS, E-mail ou Voz. Troca os campos de conteúdo mostrados abaixo.",
        },
        {
          anchor: "campanhas.compositor.nome",
          label: "Nome da campanha",
          what: "O nome interno da campanha, usado na lista e no relatório. Não é enviado ao destinatário.",
        },
        {
          anchor: "campanhas.compositor.publico",
          label: "Público",
          what: 'Escolhe quem recebe: um dos públicos automáticos, um nível, um público salvo ou — só em SMS — "Lista de números · quem ainda não é jogador".',
          notes:
            'Ao trocar o público (ou o canal), o número de destinatários elegíveis é recalculado ("Calculando o público…"). Num SMS agendado, o público é recalculado de novo na hora do envio: quem passou a se enquadrar entra e quem deixou de se enquadrar sai.',
        },
        {
          anchor: "campanhas.compositor.lista-numeros",
          label: "Números da lista (lista de números)",
          what: "Campo de texto para colar números de celular: um por linha, ou separados por vírgula ou ponto e vírgula. Aceita até 20.000 números por campanha.",
          notes:
            "Só aparece quando o público escolhido é a lista de números. Os números não são salvos como jogadores e quem já é jogador da casa fica de fora do envio — se essa pessoa clicar no link e se cadastrar com o mesmo telefone, o cadastro e os depósitos entram no relatório da campanha. Números inválidos são ignorados e contados; números repetidos recebem uma única vez — os dois avisos aparecem no bloco de avisos quando acontecem.",
        },
        {
          anchor: "campanhas.compositor.lista-arquivo",
          label: "Enviar arquivo (CSV, TXT, XLS)",
          what: "Lê números de celular de um arquivo e soma com o que já estiver colado no campo de texto.",
        },
        {
          anchor: "campanhas.compositor.sms-template",
          label: "Template de SMS",
          what: 'Escolhe um template salvo para preencher a mensagem, ou deixa em "Mensagem manual" para escrever direto.',
        },
        {
          anchor: "campanhas.compositor.sms-novo-template",
          label: "Novo template (SMS)",
          what: "Abre o diálogo para criar um template de SMS a partir do texto já escrito na Mensagem.",
        },
        {
          anchor: "campanhas.compositor.sms-mensagem",
          label: "Mensagem (SMS)",
          what: "O texto do SMS. Abaixo dele aparece a contagem de caracteres, a codificação (GSM-7 ou UCS-2), o número de segmentos e o custo.",
          notes:
            'GSM-7 é o alfabeto padrão do SMS: até 160 caracteres cabem em 1 segmento. Um caractere fora dele — like emoji, ou certas pontuações — muda a mensagem inteira para UCS-2, que cabe só 70 caracteres por segmento; por isso uma única emoji ou aspas "curvas" pode dobrar o custo mesmo numa mensagem curta. Acentos comuns do português (á, ã, ç, ü...) continuam em GSM-7 e não mudam a codificação.',
        },
        {
          anchor: "campanhas.compositor.sms-variaveis",
          label: "Variáveis aceitas no SMS (chips)",
          what: "Clique num chip para inserir a variável na posição do cursor da Mensagem — por exemplo {primeiro_nome}. No envio, cada variável é trocada pelo dado do jogador.",
        },
        {
          anchor: "campanhas.compositor.links",
          label: "Inserir link (chips)",
          what: 'Clique num chip ("URL da casa" ou uma das URLs rápidas) para inserir o link na posição do cursor da Mensagem. O link sai sempre encurtado e medido, com um link próprio por jogador, para contar cliques.',
          notes:
            'Sem a URL da casa cadastrada, o bloco mostra "Cadastre a URL da casa para inserir links na mensagem." em vez dos chips.',
        },
        {
          anchor: "campanhas.compositor.sms-dominio",
          label: "Domínio do encurtador (SMS)",
          what: 'Escolhe qual domínio verificado encurta os links deste SMS, ou deixa em "Padrão da casa".',
          notes:
            'Sem domínio próprio verificado, aparece o aviso "Seu domínio personalizado ainda não foi verificado — os links estão saindo pelo encurtador padrão do CRM." — o envio continua funcionando, só o domínio do link muda.',
        },
        {
          anchor: "campanhas.compositor.email-template",
          label: "Template de e-mail",
          what: "Escolhe o template publicado que será enviado. Obrigatório — não existe envio de e-mail sem template.",
        },
        {
          anchor: "campanhas.compositor.email-novo-template",
          label: "Novo template (e-mail)",
          what: "Abre o editor visual para criar um template de e-mail e selecioná-lo nesta campanha.",
        },
        {
          anchor: "campanhas.compositor.email-variaveis",
          label: "Variáveis aceitas nos templates de e-mail",
          what: "Lista de referência (não insere nada aqui): as variáveis que o template escolhido pode usar.",
        },
        {
          anchor: "campanhas.compositor.email-remetente",
          label: "Remetente (e-mail)",
          what: 'Escolhe quem envia o e-mail, ou deixa em "Padrão da casa".',
          notes:
            'Sem nenhum remetente verificado, aparece o aviso "Configure e verifique um domínio de e-mail da casa para enviar e-mails." com um link "Configurar" para Configurações → Casa, e o envio fica bloqueado até isso ser resolvido.',
        },
        {
          anchor: "campanhas.compositor.email-dominio",
          label: "Domínio do encurtador (e-mail)",
          what: "O mesmo seletor de domínio do SMS, aplicado aos links do e-mail.",
        },
        {
          anchor: "campanhas.compositor.voz-modo",
          label: "Conteúdo da ligação",
          what: '"Áudio gravado" (um arquivo da biblioteca) ou "Roteiro (voz gerada)" (um texto que o sistema transforma em voz na hora da ligação).',
        },
        {
          anchor: "campanhas.compositor.voz-fonte",
          label: "Áudio da biblioteca / Roteiro",
          what: "Escolhe o áudio ou o roteiro aprovado que será reproduzido na ligação.",
          notes:
            "Até 200 destinatários por campanha de voz. Um roteiro repetido reaproveita o áudio já gerado antes, em vez de gerar de novo.",
        },
        {
          anchor: "campanhas.compositor.voz-novo",
          label: "Enviar áudio / Novo roteiro",
          what: "Abre o diálogo para enviar um novo áudio ou criar um novo roteiro, já selecionado nesta campanha.",
        },
        {
          anchor: "campanhas.compositor.voz-variaveis",
          label: "Variáveis aceitas nos roteiros de voz",
          what: "Lista de referência das variáveis que um roteiro de voz pode usar. Só aparece com \"Roteiro\" escolhido.",
        },
        {
          anchor: "campanhas.compositor.quando",
          label: "Quando enviar",
          what: '"Agora" ou "Agendar".',
        },
        {
          anchor: "campanhas.compositor.agendamento",
          label: "Data e hora do agendamento",
          what: "Aparece só com \"Agendar\" escolhido. O horário é sempre o de Brasília, independente do fuso do seu computador.",
          notes:
            "Ligações de voz agendadas ficam preparadas na fila e saem quando o envio automático de voz estiver ativo.",
        },
        {
          anchor: "campanhas.compositor.avisos",
          label: 'Bloco de avisos ("Falta para enviar:" / "Para continuar, corrija:")',
          what: 'Antes de tentar enviar, o título é "Falta para enviar:"; depois de tentar (e ainda faltar algo), vira "Para continuar, corrija:". Lista tudo que falta para o botão de enviar funcionar.',
          notes:
            'Mensagens possíveis: "Informe o nome da campanha.", "Cole ou envie uma lista com números de celular válidos." (lista de números vazia), "Escolha um público com destinatários elegíveis." (outros públicos), "A lista aceita até 20.000 números por campanha.", o aviso de variáveis não aceitas na lista de números ("Campanhas para lista de números não aceitam variáveis de jogador (...); use apenas texto e links."), "Escreva ou selecione a mensagem de SMS.", "Selecione um template de e-mail.", "Selecione um roteiro."/"Selecione um áudio da biblioteca.", "Escolha a data e hora do agendamento.", "O agendamento deve ter pelo menos um minuto de antecedência.", "Variáveis não reconhecidas: ...", "Voz aceita até 200 destinatários por campanha.", e, quando nenhum destinatário puder receber, "Nenhum número da lista pode receber: todos já são jogadores ou foram bloqueados." (lista de números) ou "Nenhum destinatário deste público corresponde a um jogador cadastrado." (outros públicos). Abaixo da lista (sem travar o envio) aparecem os avisos de quem fica de fora: números inválidos ou repetidos da lista, jogadores fora do público por cadastro inválido/sem contato/sem consentimento, e — só em SMS para público normal — a verificação do cadastro de cada destinatário: "Verificando o cadastro dos destinatários…", ou, quando concluída, uma linha por motivo (\"sem cadastro não receberão\", \"com telefone inválido não receberão\", \"sem consentimento para SMS não receberão\", \"no grupo de controle de uma jornada não receberão\", \"já são jogadores da casa e não receberão\") seguida de \"Os demais recebem normalmente.\" (ou \"Nenhum destinatário desta lista pode receber.\") e \"A lista fica no relatório da campanha, em “Não enviados”.\"',
        },
        {
          anchor: "campanhas.compositor.resumo",
          label: "Resumo (destinatários, custo e conteúdo)",
          what: 'Painel lateral só de leitura: quantos destinatários vão receber, o custo estimado (segmentos e R$ no SMS; "Casa isenta" quando a casa não paga por SMS) e uma prévia do conteúdo selecionado.',
        },
        {
          anchor: "campanhas.compositor.cancelar",
          label: "Cancelar (compositor)",
          what: 'Fecha o compositor. Se o rascunho ainda estiver salvando, pergunta "Fechar a campanha?" — "Ainda há alterações sendo salvas. Se fechar agora, as últimas mudanças podem não entrar no rascunho." com os botões "Continuar editando" e "Fechar mesmo assim".',
        },
        {
          anchor: "campanhas.compositor.enviar",
          label: "Enviar / Agendar",
          what: 'O texto do botão muda com o canal, o público e o canal escolhidos: por exemplo "Enviar para 1.200 jogadores · 1 segmento · R$ 144,00" ou "Agendar para 40 jogadores · 1 chamada".',
          notes:
            'Acima de 1.000 destinatários, clicar aqui abre uma confirmação que pede para digitar a quantidade exata de destinatários antes de liberar o envio — texto exigido no formato "Digite 1.234 para confirmar" (aceita com ou sem ponto/espaço). Se a quantidade mudar depois dessa confirmação (por exemplo o público foi recalculado), o envio é recusado com "A quantidade de destinatários mudou depois da confirmação. Nada foi enviado; confirme de novo." e é preciso confirmar de novo. Uma vez iniciado, o envio não pode ser desfeito.',
        },
      ],
    },

    // ---------------------------------------------------------------
    // Envio de teste
    // ---------------------------------------------------------------
    {
      id: "teste",
      title: "Envio de teste",
      intro:
        "Diálogo aberto por \"Envio de teste\". Manda para um único número ou e-mail, sem criar campanha nem exigir que o número pertença a um jogador cadastrado. Respeita consentimento e janela de contato, e fica registrado no histórico do canal.",
      items: [
        {
          anchor: "campanhas.teste.canal",
          label: "Canal (SMS / E-mail / Voz)",
          what: "Escolhe o canal do envio de teste.",
        },
        {
          anchor: "campanhas.teste.telefone",
          label: "Telefone",
          what: "O número que recebe o SMS ou a ligação de teste.",
        },
        {
          anchor: "campanhas.teste.email",
          label: "E-mail",
          what: "O endereço que recebe o e-mail de teste.",
        },
        {
          anchor: "campanhas.teste.nome",
          label: "Nome (opcional)",
          what: "Usado para testar como a mensagem fica com {nome} e {primeiro_nome} preenchidos.",
        },
        {
          anchor: "campanhas.teste.email-template",
          label: "Template de e-mail (teste)",
          what: 'Escolhe um template para preencher Assunto e Mensagem, ou deixa em "Conteúdo manual".',
        },
        {
          anchor: "campanhas.teste.email-criar-template",
          label: "Criar template visual (teste)",
          what: "Abre o editor visual para criar um template e já usá-lo neste teste.",
        },
        {
          anchor: "campanhas.teste.assunto",
          label: "Assunto (teste de e-mail)",
          what: "O assunto do e-mail de teste.",
        },
        {
          anchor: "campanhas.teste.voz-modo",
          label: "Origem do áudio (teste de voz)",
          what: '"Roteiro (voz gerada)" ou "Áudio gravado".',
        },
        {
          anchor: "campanhas.teste.voz-fonte",
          label: "Roteiro aprovado / Áudio da biblioteca (teste)",
          what: "Escolhe o roteiro ou áudio que a ligação de teste vai reproduzir.",
        },
        {
          anchor: "campanhas.teste.voz-criar",
          label: "Criar novo script / Enviar novo áudio (teste)",
          what: "Abre o diálogo para criar um roteiro ou enviar um áudio, já selecionado neste teste.",
        },
        {
          anchor: "campanhas.teste.sms-origem",
          label: "Origem da mensagem (teste de SMS)",
          what: 'Escolhe um template de SMS para preencher a Mensagem, ou deixa em "Mensagem manual".',
          notes: "Alterar o texto depois de escolher o template personaliza só este teste; o template salvo não é modificado.",
        },
        {
          anchor: "campanhas.teste.sms-criar-template",
          label: "Criar template (teste de SMS)",
          what: "Abre o diálogo para criar um template de SMS a partir do texto já escrito.",
        },
        {
          anchor: "campanhas.teste.mensagem",
          label: "Mensagem (teste de SMS/e-mail)",
          what: "O texto enviado. No SMS mostra também caracteres, segmentos e custo, como no compositor.",
        },
        {
          anchor: "campanhas.teste.variaveis",
          label: "Variáveis (teste)",
          what: "Chips para inserir uma variável na Mensagem, como no compositor.",
        },
        {
          anchor: "campanhas.teste.rastreio",
          label: "Encurtar e medir os links",
          what: "Liga ou desliga o encurtamento e a medição dos links desta mensagem de teste (SMS ou e-mail).",
          notes:
            'Sem nenhuma URL na mensagem, mostra "Adicione uma URL à mensagem para que o encurtamento e a medição sejam aplicados no envio." Ligado, cada URL é trocada por um link curto no envio; desligado, as URLs originais são mantidas e nada é medido.',
        },
        {
          label: "Prévia para o celular (teste de SMS)",
          what: "Mostra como o SMS fica depois de trocar as variáveis pelo nome e telefone informados.",
        },
        {
          anchor: "campanhas.teste.enviar",
          label: "Enviar / Enviar teste",
          what: 'No SMS, o texto mostra o custo: "Enviar · 1 segmento" ou "Enviar · R$ 0,12", salvo em casa isenta. Nos outros canais, o botão diz "Enviar teste".',
        },
      ],
    },
  ],

  states: [
    {
      id: "selo-aguardando-aprovacao",
      title: "Aguardando aprovação",
      what: "A campanha foi enviada por um expert e só sai depois que o admin da casa aprovar.",
    },
    {
      id: "selo-recusada",
      title: "Recusada",
      what: "O admin da casa recusou a campanha do expert; nada foi enviado. O motivo aparece abaixo do nome da campanha.",
    },
    {
      id: "selo-pausada-teto",
      title: "Pausada pelo teto",
      what: "O teto mensal de envios do expert foi atingido durante o envio. Volta sozinha quando o mês virar ou o admin aumentar o teto.",
    },
    {
      id: "selo-enviando-lotes",
      title: "Enviando em lotes",
      what: "Campanha de e-mail enviada em lotes; o próximo lote sai automaticamente, sem precisar clicar em nada.",
    },
    {
      id: "selo-rascunho",
      title: "Rascunho",
      what: 'Campanha ainda não agendada nem enviada. Aparece no cartão "Rascunhos", não nesta lista.',
    },
    {
      id: "selo-agendada",
      title: "Agendada",
      what: "A campanha está revisada e aguarda o horário definido.",
    },
    {
      id: "selo-aguardando-provedor",
      title: "Aguardando provedor",
      what: "O conteúdo está na fila e depende da disponibilidade do canal (provedor de SMS, e-mail ou voz).",
    },
    {
      id: "selo-tentando-de-novo",
      title: "Tentando de novo",
      what: "Uma tentativa anterior não terminou e o sistema vai tentar de novo automaticamente.",
    },
    {
      id: "selo-pausada",
      title: "Pausada",
      what: 'SMS/e-mail: o envio foi interrompido para respeitar um limite de saldo, volume ou janela de contato — "Retomar" volta a enviar. Voz: "Pausada por limite" — respeita o intervalo entre contatos e o limite de ligações por jogador em 24 horas, e volta sozinha quando o limite permitir.',
    },
    {
      id: "selo-cancelada",
      title: "Cancelada",
      what: "A campanha foi cancelada antes do envio (ou de terminar); nenhuma mensagem a mais saiu depois disso.",
    },
    {
      id: "selo-falhou",
      title: "Falhou",
      what: "O envio não foi concluído e precisa de revisão (veja o motivo abaixo do nome da campanha) antes de uma nova tentativa.",
    },
    {
      id: "selo-enviando",
      title: "Enviando",
      what: "O provedor está processando os destinatários desta campanha agora.",
    },
    {
      id: "selo-concluida",
      title: "Concluída",
      what: "O processamento da campanha terminou. Consulte o relatório para o resultado completo.",
    },
    {
      id: "lista-vazia",
      title: "Nenhuma campanha ainda",
      what: "Não existe nenhuma campanha de SMS, e-mail ou voz nesta casa.",
      action: 'Clique em "Nova campanha" para criar a primeira.',
    },
    {
      id: "lista-sem-resultado",
      title: "Nenhuma campanha corresponde aos filtros",
      what: "Existem campanhas, mas nenhuma passa pelo status escolhido e/ou pelo texto buscado.",
      action: 'Clique em "Limpar filtros" ou ajuste a busca e o status.',
    },
    {
      id: "remetente-bloqueado",
      title: "Configure e verifique um domínio de e-mail da casa para enviar e-mails.",
      what: 'Aviso no compositor, na seção Remetente, quando a casa não tem nenhum remetente de e-mail verificado. O botão de enviar fica desabilitado para e-mail até isso ser resolvido.',
      action: 'Clique em "Configurar", em Configurações → Casa, para cadastrar e verificar um domínio e um remetente.',
    },
    {
      id: "encurtador-fallback",
      title:
        "Seu domínio personalizado ainda não foi verificado — os links estão saindo pelo encurtador padrão do CRM.",
      what: "Aviso no compositor quando a casa não tem domínio próprio do encurtador verificado. O envio continua funcionando; só o domínio do link encurtado muda.",
    },
  ],

  tours: {
    default: [
      {
        anchor: "campanhas.hub.nova-campanha",
        title: "Nova campanha",
        body: "Abre o compositor para criar uma campanha de SMS, e-mail ou voz, escolhendo o público e a mensagem.",
        articleSection: "hub",
      },
      {
        anchor: "campanhas.hub.envio-teste",
        title: "Envio de teste",
        body: "Manda um SMS, e-mail ou ligação de teste para um único número ou e-mail, sem criar campanha.",
        articleSection: "hub",
      },
      {
        anchor: "campanhas.hub.status-filtro",
        title: "Status da campanha",
        body: "Filtra a lista por Agendadas, Enviando, Pausadas ou Finalizadas.",
        articleSection: "hub",
      },
      {
        anchor: "campanhas.hub.busca",
        title: "Buscar campanha",
        body: "Encontre uma campanha pelo nome.",
        articleSection: "hub",
      },
      {
        anchor: "campanhas.hub.selo-status",
        title: "Status de cada campanha",
        body: "O selo mostra o estado atual: agendada, enviando, pausada, concluída e outros.",
        articleSection: "hub",
      },
      {
        anchor: "campanhas.hub.relatorio",
        title: "Relatório",
        body: "Veja o resultado completo da campanha: quem recebeu, clicou e depositou.",
        articleSection: "hub",
      },
      {
        anchor: "campanhas.hub.retomar",
        title: "Retomar",
        body: "Volta a enviar uma campanha de SMS ou e-mail que pausou.",
        articleSection: "hub",
      },
      {
        anchor: "campanhas.hub.cancelar",
        title: "Cancelar",
        body: "Cancela os envios ainda não feitos de uma campanha de SMS agendada ou pausada. E-mail e voz não têm este botão, mesmo agendados.",
        articleSection: "hub",
      },
    ],
  },
};

export default screen;
