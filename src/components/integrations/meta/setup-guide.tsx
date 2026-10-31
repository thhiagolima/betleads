import { AlertTriangle, ExternalLink } from "lucide-react";

// Guia de preparação (MB3-08): passos com link direto no Business Manager.
const STEPS: { text: string; href?: string; linkLabel?: string }[] = [
  {
    text: "Nas Configurações do negócio, abra Usuários → Usuários do sistema e crie um Usuário do Sistema (função Administrador ou Funcionário) para esta operação.",
    href: "https://business.facebook.com/settings/system-users",
    linkLabel: "Abrir Usuários do sistema",
  },
  {
    text: "Em Atribuir ativos, dê a esse Usuário do Sistema acesso às contas de anúncio que devem entrar nos relatórios.",
    href: "https://business.facebook.com/settings/ad-accounts",
    linkLabel: "Abrir Contas de anúncio",
  },
  {
    text: "Clique em Gerar token, escolha o app da operação, marque a permissão ads_read e deixe a validade como “Nunca”.",
  },
  { text: "Copie a chave gerada e cole aqui. Ela só aparece uma vez na Meta." },
];

export function MetaSetupGuide() {
  return (
    <div className="space-y-3">
      <ol className="space-y-2 text-meta text-muted-foreground">
        {STEPS.map((step, index) => (
          <li key={step.text} className="flex gap-2 rounded-lg bg-muted/40 p-3">
            <span className="font-bold text-primary">{index + 1}</span>
            <span className="min-w-0">
              {step.text}
              {step.href && (
                <a
                  href={step.href}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 flex items-center gap-1 font-semibold text-primary hover:underline"
                >
                  {step.linkLabel} <ExternalLink aria-hidden className="h-3 w-3" />
                </a>
              )}
            </span>
          </li>
        ))}
      </ol>
      <div className="rounded-lg border border-border/60 p-3 text-meta text-muted-foreground">
        <p className="font-semibold text-foreground">Tem mais de uma BM?</p>
        <p className="mt-1">
          Crie um Usuário do Sistema em cada BM e conecte uma chave por BM. Outra opção: atribua as
          contas das BMs parceiras a um só Usuário do Sistema; uma chave alcança todas.
        </p>
      </div>
      <p className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-meta text-warning">
        <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Use a chave do Usuário do Sistema. A chave de um usuário comum expira em poucas semanas e
          é recusada.
        </span>
      </p>
    </div>
  );
}
