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
];
