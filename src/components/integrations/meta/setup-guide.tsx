import { AlertTriangle, ChevronDown, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

import { Term } from "@/components/help/term";
import { tourAnchor } from "@/help/anchor";

// Guia de preparação (MB3-08): passo a passo completo, do app à chave, com link direto
// na Meta. Os nomes dos botões seguem a Meta em português.
type Step = { text: ReactNode; detail?: ReactNode; href?: string; linkLabel?: string };
type Part = { title: string; intro?: ReactNode; steps: Step[] };

const PARTS: Part[] = [
  {
    title: "Parte 1 — Criar o app da operação",
    intro:
      "O app é só por onde a Meta gera a chave: não precisa ser publicado nem passar por revisão. Se a operação já tem um app na BM, pule para a Parte 2.",
    steps: [
      {
        text: "Abra o painel de desenvolvedores da Meta e clique em “Criar app”.",
        detail:
          "No primeiro acesso, a Meta pede para registrar sua conta de desenvolvedor: aceite os termos e confirme o celular.",
        href: "https://developers.facebook.com/apps/creation/",
        linkLabel: "Abrir Criar app",
      },
      {
        text: "Dê um nome ao app (por exemplo, “Relatórios” + nome da casa) e informe o e-mail de contato.",
      },
      {
        text: "No caso de uso, escolha “Outro”. No tipo de app, escolha “Empresa”.",
      },
      {
        text: "Em “Portfólio empresarial”, escolha a BM da operação e conclua a criação.",
        detail:
          "Se o app já existia em outra BM: nas Configurações do negócio, abra Contas → Apps → Adicionar → “Conectar um ID de app” e cole o ID do app.",
        href: "https://business.facebook.com/settings/apps",
        linkLabel: "Abrir Apps da BM",
      },
      {
        text: "No painel do app, em “Adicionar produtos”, adicione a “API de Marketing”.",
      },
    ],
  },
  {
    title: "Parte 2 — Criar o Usuário do Sistema e dar acesso",
    steps: [
      {
        text: (
          <>
            Nas Configurações do negócio, abra Usuários → Usuários do sistema → Adicionar. Dê um
            nome (por exemplo, “CRM relatórios”) e escolha a função “Administrador”.
          </>
        ),
        detail:
          "Não aparece o botão Adicionar? Você precisa ser administrador da BM, e a BM precisa ter um app (Parte 1).",
        href: "https://business.facebook.com/settings/system-users",
        linkLabel: "Abrir Usuários do sistema",
      },
      {
        text: "Com o Usuário do Sistema selecionado, clique em “Atribuir ativos” → “Contas de anúncio”, marque as contas que devem entrar nos relatórios, ative “Ver desempenho” e salve.",
        detail: "“Ver desempenho” basta: o CRM só lê gastos e resultados, não mexe nos anúncios.",
      },
      {
        text: "Clique de novo em “Atribuir ativos” → “Apps”, marque o app da Parte 1, ative “Gerenciar app” e salve.",
        detail: "Sem isso, o app não aparece na hora de gerar a chave.",
      },
    ],
  },
  {
    title: "Parte 3 — Gerar a chave e colar aqui",
    steps: [
      {
        text: "Ainda na tela do Usuário do Sistema, clique em “Gerar novo token” e escolha o app da Parte 1.",
        detail: "A Meta pode pedir sua senha ou o código de verificação em duas etapas.",
      },
      { text: "Em validade do token, escolha “Nunca”." },
      {
        text: (
          <>
            Nas permissões, marque só <Term id="ads-read">ads_read</Term>. Nenhuma outra é
            necessária.
          </>
        ),
      },
      {
        text: "Clique em “Gerar token”, copie a chave (começa com EAA) e cole no campo abaixo.",
        detail: "Ela só aparece uma vez na Meta. Se perder, gere outra do mesmo jeito.",
      },
    ],
  },
];

// Mensagens que a validação devolve (meta.functions.ts) e o que fazer em cada uma.
const TROUBLESHOOTING: { error: string; fix: string }[] = [
  {
    error: "Use a chave de um Usuário do Sistema",
    fix: "A chave foi gerada no seu perfil pessoal (por exemplo, no Explorador da Graph API). Gere pela tela do Usuário do Sistema, como na Parte 3.",
  },
  {
    error: "O token não possui a permissão ads_read",
    fix: "Gere a chave de novo e marque ads_read nas permissões.",
  },
  {
    error: "O usuário do sistema não possui contas de anúncios atribuídas",
    fix: "Faça o passo de “Atribuir ativos” → “Contas de anúncio” da Parte 2 e gere a chave de novo.",
  },
  {
    error: "O app da Meta não tem o nível de acesso necessário",
    fix: "No painel do app, abra Revisão do app → Permissões e recursos e peça o “Ads Management Standard Access”.",
  },
  {
    error: "A chave de acesso é inválida ou expirou",
    fix: "Confira se copiou a chave inteira, sem espaços. Se não resolver, gere uma nova.",
  },
];

export function MetaSetupGuide() {
  let stepNumber = 0;
  return (
    <div className="space-y-3" {...tourAnchor("webhooks.meta.guia")}>
      <div className="rounded-lg border border-border/60 p-3 text-meta text-muted-foreground">
        <p className="font-semibold text-foreground">Antes de começar</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>
            Você precisa ser administrador da <Term id="bm">BM</Term> da operação.
          </li>
          <li>Faça pelo computador. Leva uns 10 minutos.</li>
          <li>
            Já tem um <Term id="usuario-do-sistema">Usuário do Sistema</Term> com acesso às contas?
            Vá direto para a Parte 3.
          </li>
        </ul>
      </div>
      {PARTS.map((part) => (
        <details key={part.title} open className="group rounded-lg border border-border/60">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-3 text-meta font-semibold text-foreground">
            {part.title}
            <ChevronDown
              aria-hidden
              className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="space-y-2 px-3 pb-3">
            {part.intro && <p className="text-meta text-muted-foreground">{part.intro}</p>}
            <ol className="space-y-2 text-meta text-muted-foreground">
              {part.steps.map((step) => {
                stepNumber += 1;
                return (
                  <li key={stepNumber} className="flex gap-2 rounded-lg bg-muted/40 p-3">
                    <span className="font-bold text-primary">{stepNumber}</span>
                    <span className="min-w-0">
                      {step.text}
                      {step.detail && (
                        <span className="mt-1 block text-muted-foreground/80">{step.detail}</span>
                      )}
                      {step.href && (
                        <a
                          href={step.href}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 flex w-fit items-center gap-1 font-semibold text-primary hover:underline"
                        >
                          {step.linkLabel} <ExternalLink aria-hidden className="h-3 w-3" />
                        </a>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        </details>
      ))}
      <div className="rounded-lg border border-border/60 p-3 text-meta text-muted-foreground">
        <p className="font-semibold text-foreground">Tem mais de uma BM?</p>
        <p className="mt-1">
          Crie um Usuário do Sistema em cada BM e conecte uma chave por BM. Outra opção: atribua as
          contas das BMs parceiras a um só Usuário do Sistema; uma chave alcança todas.
        </p>
      </div>
      <details className="group rounded-lg border border-border/60">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-3 text-meta font-semibold text-foreground">
          Deu erro ao validar a chave?
          <ChevronDown
            aria-hidden
            className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          />
        </summary>
        <ul className="space-y-2 px-3 pb-3 text-meta text-muted-foreground">
          {TROUBLESHOOTING.map((item) => (
            <li key={item.error}>
              <span className="font-semibold text-foreground">“{item.error}”</span>
              <span className="block">{item.fix}</span>
            </li>
          ))}
        </ul>
      </details>
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
