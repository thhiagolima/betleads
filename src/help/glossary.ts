import { FINANCE_TERMS } from "@/components/finance/definitions";
import type { GlossaryTerm } from "./types";

/**
 * One definition per term, reused everywhere (`<Term id>`, help articles).
 * The Financeiro and Resultados entries below reuse the exact texts already
 * shown in the product (spec §4.1) — `short` is the label/sentence already
 * on screen, `long` is the fuller "como calculamos"/"como ler" text.
 * Swapping those screens' own components to import from here (instead of
 * `FINANCE_TERMS` / the Resultados "Como ler" sheet) is deferred to when
 * phases 3/4 touch those screens.
 */
export const GLOSSARY: GlossaryTerm[] = [
  // --- Financeiro (src/components/finance/definitions.ts) ---
  {
    id: "lucro-liquido",
    term: FINANCE_TERMS.cashResult.label,
    short: FINANCE_TERMS.cashResult.how,
  },
  { id: "net", term: FINANCE_TERMS.net.label, short: FINANCE_TERMS.net.how },
  { id: "ggr", term: FINANCE_TERMS.ggr.label, short: FINANCE_TERMS.ggr.how },
  { id: "taxa-de-ggr", term: FINANCE_TERMS.ggrFee.label, short: FINANCE_TERMS.ggrFee.how },
  {
    id: "taxa-de-movimentacao",
    term: FINANCE_TERMS.movementFee.label,
    short: FINANCE_TERMS.movementFee.how,
  },
  { id: "envios", term: FINANCE_TERMS.sends.label, short: FINANCE_TERMS.sends.how },
  { id: "mensalidade", term: FINANCE_TERMS.fee.label, short: FINANCE_TERMS.fee.how },
  {
    id: "outros-custos",
    term: FINANCE_TERMS.otherCosts.label,
    short: FINANCE_TERMS.otherCosts.how,
  },
  { id: "roi", term: FINANCE_TERMS.roi.label, short: FINANCE_TERMS.roi.how },
  { id: "margem", term: FINANCE_TERMS.margin.label, short: FINANCE_TERMS.margin.how },

  // --- "Como ler" de Resultados (src/components/crm-results/central-results.tsx) ---
  {
    id: "recuperado-pelo-crm",
    term: "Recuperado pelo CRM",
    short:
      "Jogador que clicou no link do SMS e depositou em até 7 dias, e o valor depositado. É a medida principal, a mesma do Início (conversão por clique). Conta jogadores, não depósitos: quem deposita 3 vezes conta 1.",
  },
  { id: "taxa-de-clique", term: "Taxa de clique", short: "Cliques no link ÷ SMS enviados." },
  {
    id: "custo-por-jogador-convertido",
    term: "Custo por jogador que voltou",
    short: "Custo em SMS ÷ jogadores que voltaram pelo link.",
  },
  {
    id: "retorno-do-envio",
    term: "Cada R$ 1 em SMS trouxe",
    short:
      "Recuperado pelo CRM ÷ custo em SMS, em reais (ex.: R$ 7,90 para cada R$ 1). Verde quando paga o envio (R$ 1 ou mais), vermelho quando não paga. Com menos de 5 jogadores que voltaram pelo link aparece como “amostra pequena” e não entra em comparações.",
  },
  {
    id: "recuperados-visao-ampla",
    term: "Reativações após SMS",
    short:
      "Jogadores que estavam há 2 dias ou mais sem depositar (ou que nunca depositaram), receberam um SMS e voltaram a depositar em até 3 dias, mesmo sem clicar no link. O valor é tudo o que depositaram nesses 3 dias. Já inclui o Recuperado pelo CRM (quem clicou), por isso é sempre igual ou maior: não some os dois.",
  },
  {
    id: "ultimos-7-dias",
    term: "Últimos 7 dias",
    short:
      "Conversões chegam até 7 dias depois do clique. O custo entra no dia do envio, o clique no dia do clique e a conversão no dia do depósito; por isso os últimos 7 dias ainda crescem.",
  },
  {
    id: "teste-de-controle",
    term: "Teste de controle",
    short:
      "Voltar depois do SMS não prova que foi por causa dele. O teste compara com um grupo sorteado que não recebe mensagens e mostra o efeito real.",
  },
  {
    id: "custo-do-envio",
    term: "Custo",
    short: "Só SMS. WhatsApp, e-mail e voz ainda não têm preço cadastrado.",
  },

  // --- New terms (fase 1) ---
  {
    id: "dns",
    term: "DNS",
    short:
      "A agenda que traduz um nome (como mail.suacasa.bet.br) para o endereço real de um servidor. É nela que você cadastra o domínio para liberar o encurtador ou o e-mail.",
  },
  {
    id: "subdominio",
    term: "Subdomínio",
    short:
      "Um nome extra na frente do seu domínio, como mail em mail.suacasa.bet.br. Cada parte usada (encurtador, e-mail) costuma pedir o seu próprio.",
  },
  {
    id: "registro-dns",
    term: "Registro DNS",
    short:
      "Uma linha que você cadastra no painel do seu domínio (Registro.br, Cloudflare, GoDaddy, Hostinger...) para provar que o domínio é seu e apontar para onde ele deve funcionar. Depois de colado, a verificação é automática.",
  },
  {
    id: "remetente",
    term: "Remetente",
    short:
      "O endereço que aparece como quem enviou o e-mail, por exemplo contato@suacasa.bet.br. Só pode ser criado depois que o domínio de e-mail estiver verificado.",
  },
  {
    id: "encurtador",
    term: "Encurtador",
    short:
      "O serviço que transforma um link longo num link curto com o seu domínio, para caber na mensagem e para você acompanhar quem clicou.",
  },
  {
    id: "ftd",
    term: "FTD",
    short: 'Sigla de "first time deposit": o primeiro depósito que um jogador faz na casa.',
  },
  {
    id: "grupo-de-controle",
    term: "Grupo de controle",
    short:
      "Uma parte dos jogadores sorteada para não receber a mensagem. Serve para comparar e mostrar o efeito real do envio, não só uma coincidência.",
  },
  {
    id: "reentrada",
    term: "Reentrada",
    short:
      "Se um jogador que já passou pela jornada pode entrar nela de novo, e depois de quanto tempo.",
  },
  {
    id: "gatilho",
    term: "Gatilho",
    short:
      'O evento que faz um jogador entrar numa jornada, por exemplo "ficou 3 dias sem depositar".',
  },
  {
    id: "segmento-sms",
    term: "Segmento de SMS",
    short:
      "Cada bloco de até 160 caracteres de uma mensagem. Uma mensagem maior é cobrada em mais de um segmento.",
  },

  // --- SMS (fase 2, Task 4) ---
  {
    id: "gsm-7",
    term: "GSM-7",
    short:
      "O alfabeto padrão do SMS: até 160 caracteres cabem em 1 segmento (153 quando a mensagem passa de um segmento). Acentos comuns do português (á, ã, ç, ü...) continuam nele e não mudam a codificação.",
  },
  {
    id: "ucs-2",
    term: "UCS-2",
    short:
      "Codificação usada quando a mensagem tem um caractere fora do alfabeto padrão do SMS — como um emoji ou aspas curvas. Cabe só 70 caracteres por segmento (67 quando passa de um), por isso o custo pode dobrar mesmo numa mensagem curta.",
  },

  // --- Web Push (merge de origin/main, canal OneSignal) ---
  {
    id: "web-push",
    term: "Web Push",
    short:
      "Um canal de mensagem que aparece como notificação no navegador (Chrome, Edge, Firefox...) de quem aceitou receber avisos do site da casa. Não precisa de telefone nem e-mail: chega mesmo com o site fechado, enquanto o navegador estiver aberto.",
  },
  {
    id: "notificacao-push",
    term: "Notificação push",
    short:
      "A mensagem curta (título, texto e, se quiser, uma imagem) que surge no canto da tela ou na central de notificações do aparelho. Ao clicar, a pessoa vai para o link da campanha.",
  },
  {
    id: "inscricao-push",
    term: "Inscrição (inscrito)",
    short:
      "Um navegador que aceitou receber notificações do site da casa. Uma mesma pessoa pode ter várias inscrições (um computador e um celular, por exemplo), e uma inscrição pode ser anônima, sem jogador ligado. Se a pessoa bloquear as notificações ou limpar o navegador, a inscrição deixa de valer.",
  },

  // --- Email (Task 11) ---
  {
    id: "cta",
    term: "CTA",
    short:
      'Sigla de "call to action" (chamada para ação): o botão principal do e-mail, como "Acessar agora", que leva o jogador para o link combinado.',
  },
  {
    id: "preheader",
    term: "Preheader",
    short:
      "O trecho de texto que aparece ao lado ou abaixo do assunto na caixa de entrada, antes de abrir o e-mail. Serve para completar o assunto e aumentar a chance de abertura.",
  },
  {
    id: "hero",
    term: "Hero",
    short:
      'A imagem grande de destaque logo abaixo da logo, no topo do corpo do e-mail — também chamada de "banner principal".',
  },
  {
    id: "alt-text",
    term: "Alt text",
    short:
      "O texto alternativo de uma imagem: o que aparece no lugar dela quando a imagem não carrega, e o que leitores de tela leem em voz alta.",
  },

  // --- Automações (Task 13) ---
  {
    id: "leads-mortos",
    term: "Leads mortos",
    short:
      "Jogador que recebeu várias mensagens de jornada (SMS, e-mail ou voz) seguidas sem fazer nenhuma ação na casa. Sai de todas as jornadas até voltar a agir ou ser reativado manualmente.",
  },
  {
    id: "envio-imediato",
    term: "Envio imediato",
    short:
      "Faz a jornada furar a fila: ignora o intervalo entre jornadas e os limites globais de mensagens por pessoa, e envia assim que o jogador entra. Use só em jornadas urgentes.",
  },
  {
    id: "conflito-entre-jornadas",
    term: "Conflito entre jornadas",
    short:
      "Quando o mesmo jogador cumpre o gatilho de duas jornadas ao mesmo tempo, só a de maior prioridade envia; a outra fica pausada até a primeira liberar o jogador.",
  },

  // --- Editor e relatório de jornada (Task 14) ---
  {
    id: "familia-de-jornadas",
    term: "Família",
    short:
      "Um grupo de jornadas que nunca devem rodar juntas para o mesmo jogador — por exemplo, as jornadas de cada nível de gamificação. Jornadas sem família não competem por família, só por gatilho e prioridade.",
  },
  {
    id: "prioridade-de-jornada",
    term: "Prioridade",
    short:
      "Um número de 1 a 100 que decide quem vence quando duas jornadas disputam o mesmo jogador no mesmo canal: o menor número vence.",
  },

  // --- Início e Eventos (fase 2, Task 1) ---
  {
    id: "pix-gerado-pago",
    term: "PIX gerado/pago",
    short:
      "PIX gerado é o QR Code/código Pix que a casa emitiu para o jogador pagar; PIX pago é quando esse código foi de fato pago e virou depósito. \"PIX pagos\" é a fração dos gerados que foram pagos; \"PIX não pagos\" é quantos ficaram sem pagamento no período.",
  },
  // --- Jogadores e ficha do jogador (fase 2, Task 2) ---
  {
    id: "utm",
    term: "UTM",
    short:
      "Um jeito padrão de marcar de onde veio o clique de um anúncio (meio, campanha, criativo, ID do anúncio). O CRM lê esses parâmetros do link que o jogador clicou e grava na ficha dele.",
  },
  {
    id: "pp",
    term: "p.p.",
    short:
      "Sigla de \"pontos percentuais\": a diferença entre duas taxas (ex.: de 20% para 21% é +1,0 p.p.), não a variação relativa entre elas. Usado na variação da Conversão cadastro → FTD, que já é uma taxa.",
  },

  // --- Ligações / Voz (fase 2, Task 5) ---
  {
    id: "estabilidade-voz",
    term: "Estabilidade",
    short:
      "Controla o quanto a voz gerada varia a entonação. Baixa deixa a fala mais expressiva (e mais imprevisível); alta deixa a fala mais uniforme e monótona, mas mais consistente entre uma ligação e outra.",
  },
  {
    id: "similaridade-voz",
    term: "Similaridade",
    short:
      "O quanto a voz gerada tenta se manter fiel ao timbre original da voz escolhida. Alta deixa o som mais parecido com a voz original; valores muito altos podem deixar a fala com pequenos ruídos ou artefatos.",
  },
  {
    id: "estilo-voz",
    term: "Estilo",
    short:
      "O quanto a voz exagera a expressão/emoção ao falar. Baixo deixa a fala mais neutra e previsível; alto deixa a fala mais dramática ou exagerada, mas pode ficar menos estável.",
  },
  {
    id: "velocidade-voz",
    term: "Velocidade",
    short: "A velocidade da fala: menor que 1 fala mais devagar, maior que 1 fala mais rápido.",
  },
  {
    id: "speaker-boost",
    term: "Speaker boost",
    short:
      "Um reforço que deixa a voz gerada mais parecida com a voz original e mais clara ao telefone, ao custo de um processamento um pouco mais lento para gerar o áudio.",
  },

  // --- New terms (fase 2, Task 6) ---
  {
    id: "lgpd",
    term: "LGPD",
    short:
      "Sigla de \"Lei Geral de Proteção de Dados\", a lei brasileira sobre uso de dados pessoais. A \"Base legal\" de uma decisão de consentimento é o motivo, previsto na lei, que autoriza a casa a usar aquele contato — por exemplo \"Consentimento\" (o titular autorizou) ou \"Execução de contrato\" (é preciso para prestar o serviço).",
    long:
      "O campo é só um texto livre, para registro — o CRM não valida nem restringe o que você escrever. Se não souber o que colocar, deixe em branco ou escreva \"Consentimento\", que é a base mais comum para contato de marketing.",
  },
  {
    id: "fuso-horario",
    term: "Fuso horário",
    short:
      "O fuso em que os horários de início e fim da janela de envio são interpretados, no formato Continente/Cidade (ex.: America/Sao_Paulo). Mude só se a casa opera fora do horário de Brasília.",
    long:
      "Exemplos comuns no Brasil: America/Sao_Paulo (horário de Brasília, usado por quase todas as casas), America/Manaus (Amazonas e Rondônia), America/Rio_Branco (Acre e parte do Amazonas) e America/Noronha (Fernando de Noronha). O campo aceita qualquer texto — um nome errado não mostra erro na hora de salvar, mas os horários calculados ficam errados até corrigir. Digite exatamente como nos exemplos, sem espaços.",
  },

  // --- Conta e equipe / Plano e créditos (fase 2, Task 7) ---
  {
    id: "pix-copia-cola",
    term: "Pix Copia e Cola",
    short:
      "Um código de texto que representa o mesmo pagamento Pix do QR Code. Copie e cole no aplicativo do seu banco (em vez de escanear a câmera) para pagar.",
    long:
      "É útil quando você está pagando do mesmo aparelho onde o CRM está aberto (sem outro celular à mão para escanear o QR Code): copie o código com o botão ao lado do campo e cole no app do banco, na opção de pagar com Pix via código/\"Copia e Cola\".",
  },
  {
    id: "franquia-mensal",
    term: "Franquia mensal",
    short:
      "Uma quantidade de unidades de um canal (hoje, e-mail) que a casa pode usar todo mês sem ser cobrada, antes de o preço por unidade passar a valer.",
    long:
      "Cada canal tem sua própria franquia (ou nenhuma — SMS e Voz não têm). Ela reinicia a cada mês: o que não foi usado não acumula para o mês seguinte. Em \"Consumo do mês\", o texto \"X de Y grátis\" mostra quanto da franquia já foi usado; em \"Preços vigentes\", a coluna \"Franquia mensal\" mostra o tamanho dela (\"-\" quando o canal não tem).",
  },

  // --- Integrações: Plataforma, Meta Ads, Web push (fase 2, Task 9) ---
  {
    id: "bm",
    term: "BM",
    short:
      "Sigla de \"Business Manager\", o painel da Meta (Facebook/Instagram) onde a operação administra contas de anúncio, usuários e permissões. É nele que você cria o Usuário do Sistema e dá a ele acesso às contas de anúncio.",
  },
  {
    id: "usuario-do-sistema",
    term: "Usuário do Sistema",
    short:
      "Um tipo de usuário da Meta feito para integrações automáticas (não é uma pessoa). A chave de acesso dele não expira em poucas semanas como a de um usuário comum, por isso é a chave certa para conectar o CRM.",
  },
  {
    id: "ads-read",
    term: "ads_read",
    short:
      "A permissão que a chave de acesso do Usuário do Sistema precisa ter para o CRM funcionar: só deixa ler o desempenho dos anúncios (gastos, resultados). Ela não permite publicar, pausar ou alterar nada nos anúncios.",
  },
];
