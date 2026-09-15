export type WebhookEvent = {
  slug: string;
  label: string;
  categoria: "Usuário" | "Depósito" | "Saque" | "Jogo" | "Bônus";
  descricao: string;
};

export const WEBHOOK_EVENTS: WebhookEvent[] = [
  { slug: "cadastro", label: "Cadastro", categoria: "Usuário", descricao: "Novo player se cadastrou" },
  { slug: "login", label: "Login", categoria: "Usuário", descricao: "Player entrou na plataforma" },
  { slug: "logout", label: "Logout", categoria: "Usuário", descricao: "Player saiu da plataforma" },
  { slug: "deposito-pendente", label: "Depósito Pendente", categoria: "Depósito", descricao: "Depósito iniciado" },
  { slug: "deposito-aprovado", label: "Depósito Aprovado", categoria: "Depósito", descricao: "Depósito confirmado" },
  { slug: "deposito-falhou", label: "Depósito Falhou", categoria: "Depósito", descricao: "Depósito recusado" },
  { slug: "saque-pendente", label: "Saque Pendente", categoria: "Saque", descricao: "Saque solicitado" },
  { slug: "saque-aprovado", label: "Saque Aprovado", categoria: "Saque", descricao: "Saque pago" },
  { slug: "saque-falhou", label: "Saque Falhou", categoria: "Saque", descricao: "Saque recusado" },
  { slug: "saque-concluido", label: "Saque Concluído", categoria: "Saque", descricao: "payment.withdrawal.completed" },
  { slug: "jogo-iniciado", label: "Jogo Iniciado", categoria: "Jogo", descricao: "Player iniciou uma partida" },
  { slug: "bonus-ativado", label: "Bônus Ativado", categoria: "Bônus", descricao: "Player ativou bônus" },
  { slug: "cashback-pago", label: "Cashback Pago", categoria: "Bônus", descricao: "Cashback creditado" },
];