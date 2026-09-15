// Catálogo de mensagens curtas, humanas, por filtro/situação do lead.
const TEMPLATES: Record<string, string[]> = {
  recorrentes: [
    "Fala {nome}, vi que você tá ativo por aqui esses dias 👊 Qualquer coisa que precisar é só chamar.",
    "Oi {nome}, tudo certo? Tô passando rapidinho só pra te avisar que tem movimento bom rolando hoje.",
    "{nome}, percebi que tu tá jogando direto. Se quiser, te aviso os horários melhores hoje.",
  ],
  em_risco: [
    "Fala {nome}, sumiu esses dias 😅 Tua conta segue ativa por aqui, vale dar uma olhada.",
    "Oi {nome}, tudo bem? Notei que faz um tempinho que tu não entra. Hoje tá com movimento bom.",
    "{nome}, senti tua falta por aqui. Se quiser eu te conto o que tá pegando agora.",
  ],
  risco_inicial: [
    "Fala {nome}, sumiu esses dias 😅 Vi que tua conta ainda tá ativa, dá uma olhada lá.",
    "Oi {nome}, tudo certo? Percebi que você ficou alguns dias sem acessar. Hoje tem movimento bom acontecendo.",
    "{nome}, tu ficou uns dias fora bem na hora que a casa voltou a movimentar forte 😂",
    "Fala {nome}, senti tua falta por aqui. Tua conta continua ativa e hoje tá interessante.",
    "{nome}, vi que tu tá há alguns dias sem entrar. Passando só pra avisar que o movimento voltou forte.",
  ],
  risco_moderado: [
    "Fala {nome}, faz mais de 15 dias que não te vejo por aqui. Tá tudo certo?",
    "Oi {nome}, sumiu hein 😅 Quis dar um alô pra saber se tá tudo bem com tua conta.",
    "{nome}, tu sumiu faz um tempinho. Hoje tem bastante coisa rolando, vale uma passada.",
    "Fala {nome}, lembrei de ti agora. Faz quase 3 semanas que não te vejo, dá um sinal.",
  ],
  risco_alto: [
    "{nome}, faz quase um mês que tu não aparece. Tá tudo certo aí?",
    "Oi {nome}, tô passando só pra saber se tá tudo bem. Tua conta tá te esperando.",
    "Fala {nome}, senti tua falta. Se rolou algum problema pra acessar, me chama que eu te ajudo.",
  ],
  quase_perdido: [
    "{nome}, faz mais de um mês sem te ver. Posso te ajudar com alguma coisa?",
    "Oi {nome}, tudo bem por aí? Tô passando só pra retomar contato.",
    "Fala {nome}, tu sumiu de vez 😅 Me dá um oi pra eu saber que tá tudo certo.",
  ],
  recuperacao_dificil: [
    "{nome}, tá fazendo falta por aqui. Tudo bem contigo?",
    "Oi {nome}, faz tempo hein. Quis só te mandar um alô e ver se tá tudo certo.",
    "Fala {nome}, posso te ajudar com algo? Se quiser voltar, é só me chamar.",
  ],
  perdidos: [
    "{nome}, tudo bem? Faz bastante tempo que não te vejo. Se quiser retomar, me avisa.",
    "Oi {nome}, tô passando só pra te mandar um oi. Qualquer dúvida, é só chamar.",
    "Fala {nome}, lembrei de ti hoje. Se quiser voltar a jogar, eu te ajudo no que precisar.",
  ],
  vip: [
    "Fala {nome}, tudo certo? Como VIP, qualquer coisa que precisar é só me chamar direto.",
    "Oi {nome}, passando pra te dar um alô. Tô à disposição pro que precisar.",
  ],
  vip_em_risco: [
    "Fala {nome}, senti tua falta. Como VIP tu tem prioridade aqui, qualquer coisa me chama direto.",
    "Oi {nome}, tudo bem? Faz uns dias que não te vejo, quis dar um alô.",
    "{nome}, posso te ajudar em algo? Tô aqui pra te dar atenção especial sempre que precisar.",
  ],
  quase_vip: [
    "Fala {nome}, tu tá quase virando VIP por aqui 👀 Falta pouco mesmo.",
    "Oi {nome}, vi que tu tá perto de bater VIP. Se quiser, te explico os benefícios.",
    "{nome}, falta pouquinho pra tu virar VIP. Qualquer dúvida, me chama.",
  ],
  leads_quentes: [
    "Fala {nome}, tu tá num momento bom! Qualquer coisa que precisar, é só chamar.",
    "Oi {nome}, tô passando só pra deixar meu contato direto. Tá indo bem.",
    "{nome}, tu tá ativo e depositando legal. Se quiser dicas dos jogos do dia, me avisa.",
  ],
  saldo_parado: [
    "Fala {nome}, vi que tu tem saldo aqui esperando. Quer que eu te mostre o que tá pagando bem hoje?",
    "Oi {nome}, tu tem saldo na conta e faz uns dias que não entra. Tá tudo certo?",
    "{nome}, tua conta tem saldo te esperando. Qualquer coisa que precisar, me chama.",
  ],
  deposito_hoje: [
    "Fala {nome}, vi teu depósito hoje 👊 Qualquer coisa que precisar, é só chamar.",
    "Oi {nome}, tudo certo com o depósito? Tô por aqui pra qualquer dúvida.",
    "{nome}, boa! Se precisar de alguma orientação, me chama direto.",
  ],
  nao_converteram: [
    "Fala {nome}, vi que tu se cadastrou mas ainda não jogou. Posso te ajudar a começar?",
    "Oi {nome}, tudo bem? Qualquer dúvida pra dar o primeiro passo, é só me chamar.",
    "{nome}, tô à disposição pra te ajudar a começar. Me chama quando puder.",
  ],
  todos: [
    "Fala {nome}, tudo certo? Tô por aqui pra qualquer coisa que precisar.",
    "Oi {nome}, passando só pra dar um alô. Qualquer dúvida, me chama.",
  ],
};

function primeiroNome(nome: string | null | undefined): string {
  const n = (nome ?? "").trim().split(/\s+/)[0];
  return n || "tudo bem";
}

/** Sorteia uma mensagem para a situação (filtro) atual do player. */
export function mensagemParaFiltro(filtroId: string, nome: string | null | undefined): string {
  const lista = TEMPLATES[filtroId] ?? TEMPLATES.todos;
  const idx = Math.floor(Math.random() * lista.length);
  return lista[idx].replaceAll("{nome}", primeiroNome(nome)).replaceAll("{primeiro_nome}", primeiroNome(nome));
}

export function buildWhatsappLinkContextual(
  telefone: string | null | undefined,
  nome: string | null | undefined,
  filtroId: string,
): string | null {
  if (!telefone) return null;
  const digits = telefone.replace(/\D/g, "");
  if (!digits) return null;
  const msg = encodeURIComponent(mensagemParaFiltro(filtroId, nome));
  return `https://wa.me/${digits}?text=${msg}`;
}
