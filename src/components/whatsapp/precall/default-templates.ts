// 10 mensagens padrão para a campanha "Pré-call VIP sem login".
// Tom humano, sem pressionar depósito; objetivo é só pedir permissão pra ligar.
export const DEFAULT_PRECALL_VIP_TEMPLATES: string[] = [
  "Oi, {primeiro_nome}, tudo bem? Aqui é da equipe PixReals. Vi um ponto importante sobre sua conta VIP e queria te explicar rapidinho, sem compromisso. Posso te ligar 2 min?",
  "Oi, {primeiro_nome}. Aqui é da PixReals. Notei que sua conta VIP ficou um tempo sem acesso e queria entender se aconteceu algo ou se foi só uma pausa. Posso te ligar rapidinho?",
  "Fala, {primeiro_nome}, tudo certo? Aqui é da equipe PixReals. Tenho uma informação sobre sua conta que pode fazer sentido para você. Posso te ligar 2 min e te explicar?",
  "Oi, {primeiro_nome}. Vi que sua conta tem perfil VIP e ficou sem movimentação nos últimos dias. Queria entender se teve algum problema ou se posso te ajudar com alguma condição. Posso te ligar rápido?",
  "{primeiro_nome}, tudo bem? Aqui é da PixReals. Estou fazendo um contato rápido com alguns players VIP para pegar feedback e ver se tem algo que podemos melhorar. Posso te ligar 2 min?",
  "Oi, {primeiro_nome}. Vi que você ficou {dias_sem_login} dias sem acessar sua conta. Como seu perfil é VIP, queria falar com você de forma mais direta e entender se está tudo certo. Posso te ligar rapidinho?",
  "Fala, {primeiro_nome}. Aqui é da equipe PixReals. Queria te passar uma condição/ajuste disponível para o seu perfil VIP, mas prefiro explicar em 2 min por ligação. Posso te ligar?",
  "Oi, {primeiro_nome}. Tudo certo? Vi que sua conta VIP ficou parada e queria entender se foi falta de tempo, algum problema ou só uma pausa mesmo. Posso te ligar 2 min?",
  "{primeiro_nome}, aqui é da PixReals. Não é cobrança nem telemarketing. Só queria entender seu feedback sobre a plataforma e ver se faz sentido liberar uma condição de retorno para sua conta. Posso te ligar rápido?",
  "Oi, {primeiro_nome}, tudo bem? Sua conta aparece aqui como perfil VIP, mas sem login recente. Queria confirmar se está tudo certo e te explicar uma condição disponível. Posso te ligar por 2 min?",
];

export const PRECALL_FILTERS = [
  {
    id: "vip_sem_login",
    label: "VIP sem login (7+ dias)",
    description: "vip=true OU total_depositado≥1000, E último login há mais de 7 dias.",
  },
] as const;

export type PrecallFilterId = (typeof PRECALL_FILTERS)[number]["id"];