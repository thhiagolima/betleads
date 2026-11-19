// "Conectar ao Claude" (spec §9): own MCP status (level, connection URL,
// active connections) plus copy-paste instructions for claude.ai, Claude
// Desktop and Claude Code. Hidden when MCP is disabled in this environment,
// or wired per sidebar rules (feature off, or the user has no mcp_access
// row at all) — this route still renders the "off" note either way, since a
// direct visit shouldn't 404.
//
// The top of the page is a step-by-step for non-technical users (copy the
// URL, add the connector, authorize, ask the first question), with each step
// ticked from real data (connections, first tool call), example questions per
// granted area, how write confirmations work, what Claude never sees and the
// common problems. Help article: src/help/screens/mcp.ts.
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bot, Check, Copy, Monitor, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui-premium/empty-state";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { Term } from "@/components/help/term";
import { tourAnchor } from "@/help/anchor";
import { getMyMcpStatus, revokeMyConnection } from "@/lib/mcp/mcp.functions";
import { copyToClipboard } from "@/lib/clipboard";
import { requestConfirmation } from "@/components/system-dialog-host";
import { useIsMobile } from "@/hooks/use-mobile";

export const Route = createFileRoute("/mcp")({
  component: McpPage,
});

const LEVEL_LABEL: Record<"none" | "read" | "write", string> = {
  none: "Sem acesso",
  read: "Leitura",
  write: "Leitura e escrita",
};

type Exemplo = { titulo: string; perguntas: string[] };

const EXEMPLOS_FINANCEIRO: Exemplo = {
  titulo: "Financeiro",
  perguntas: [
    "Quais casas eu consigo ver no Betleads?",
    "Como está o financeiro das minhas casas neste mês?",
    "Qual casa deu mais lucro ontem? Compare com o mesmo dia da semana passada.",
    "Quais dias deste mês ainda estão sem lançamento de anúncios ou GGR?",
    "Como estamos em relação às metas do mês?",
  ],
};

const EXEMPLOS_ALTERACOES: Exemplo = {
  titulo: "Alterações no financeiro",
  perguntas: [
    "Lance R$ 2.500 de anúncios no dia de ontem da casa {nome da casa}.",
    "O GGR de outubro da casa {nome da casa} fechou em R$ 120.000. Lance para mim.",
    "Cadastre um custo de R$ 3.000 de equipe na casa {nome da casa}, repetindo todo mês.",
    "Coloque a meta diária de FTDs da casa {nome da casa} em 40 a partir de amanhã.",
  ],
};

const EXEMPLOS_OPERACAO: Exemplo = {
  titulo: "Operação",
  perguntas: [
    "Como foi a semana das casas do meu grupo? Cadastros, FTDs e depósitos por casa.",
    "Quais experts trouxeram mais depósito em outubro?",
    "O que o afiliado 4512 trouxe neste mês?",
    "Como foram as campanhas de SMS dos últimos 7 dias?",
    "Tem alguma coisa nas minhas casas que precisa de atenção hoje?",
  ],
};

function fmtDate(d: string | null) {
  if (!d) return "nunca";
  return new Date(d).toLocaleString("pt-BR");
}

async function copiar(texto: string, aviso: string) {
  if (await copyToClipboard(texto)) toast.success(aviso);
  else toast.error("Não foi possível copiar. Selecione o texto e copie à mão.");
}

function Passo({
  numero,
  titulo,
  feito,
  children,
}: {
  numero: number;
  titulo: string;
  feito: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-sm font-medium ${
          feito ? "border-primary bg-primary text-primary-foreground" : "bg-muted/30"
        }`}
      >
        {feito ? <Check className="h-4 w-4" /> : numero}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5 text-sm">
        <div className="font-medium">
          {titulo}
          {feito ? <span className="ml-2 text-meta text-primary">feito</span> : null}
        </div>
        <div className="space-y-1.5 text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

function McpPage() {
  const qc = useQueryClient();
  const statusFn = useServerFn(getMyMcpStatus);
  const revokeFn = useServerFn(revokeMyConnection);

  const isMobile = useIsMobile();

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["mcp", "my-status"],
    queryFn: () => statusFn(),
  });

  const revoke = useMutation({
    mutationFn: (connectionId: string) => revokeFn({ data: { connectionId } }),
    onSuccess: () => {
      toast.success("Conexão desconectada");
      void qc.invalidateQueries({ queryKey: ["mcp", "my-status"] });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error && error.message
          ? `Não foi possível desconectar: ${error.message}`
          : "Não foi possível desconectar. Tente de novo.",
      );
    },
  });

  async function desconectar(connectionId: string, clientName: string) {
    const confirmed = await requestConfirmation({
      title: "Desconectar do Claude?",
      description: `${clientName} perde o acesso ao Betleads na hora. Para usar de novo, será preciso conectar outra vez.`,
      confirmLabel: "Desconectar",
      destructive: true,
    });
    if (confirmed) revoke.mutate(connectionId);
  }

  if (isLoading) {
    return (
      <Page>
        <PageHeader title="Conectar ao Claude" subtitle="Carregando…" />
      </Page>
    );
  }

  if (isError || !data) {
    return (
      <Page>
        <PageHeader title="Conectar ao Claude" />
        <Card>
          <EmptyState
            title="Não foi possível carregar a sua conexão com o Claude"
            description="Confira a internet e tente de novo."
            action={
              <Button variant="outline" disabled={isFetching} onClick={() => void refetch()}>
                <RefreshCw className="mr-2 size-4" aria-hidden="true" />
                Tentar novamente
              </Button>
            }
          />
        </Card>
      </Page>
    );
  }

  if (!data.enabled) {
    return (
      <Page>
        <PageHeader title="Conectar ao Claude" />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            <Term id="mcp">MCP</Term> desligado neste ambiente.
          </CardContent>
        </Card>
      </Page>
    );
  }

  if (data.level === "none") {
    return (
      <Page>
        <PageHeader title="Conectar ao Claude" />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Seu usuário não tem acesso ao <Term id="mcp">MCP</Term>. Peça ao super admin.
          </CardContent>
        </Card>
      </Page>
    );
  }

  const claudeCodeCommand = `claude mcp add --transport http betleads ${data.mcpUrl}`;
  const conectado = data.connections.length > 0;
  const perguntou = data.hasUsedTools;
  const temFinanceiro = data.areas.includes("financeiro");
  const temOperacao = data.areas.includes("operacao");
  const podeAlterar = temFinanceiro && data.level === "write";
  const origem = new URL(data.mcpUrl).origin;
  const exemplos = [
    ...(temFinanceiro ? [EXEMPLOS_FINANCEIRO] : []),
    ...(podeAlterar ? [EXEMPLOS_ALTERACOES] : []),
    ...(temOperacao ? [EXEMPLOS_OPERACAO] : []),
  ];

  return (
    <Page>
      <PageHeader
        title="Conectar ao Claude"
        subtitle={`Nível de acesso: ${LEVEL_LABEL[data.level]}.`}
      />

      <Card {...tourAnchor("mcp.passos.card")}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" /> Passo a passo
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isMobile ? (
            <div className="flex items-start gap-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-sm">
              <Monitor className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
              <p>
                Estes passos são feitos no computador, no site claude.ai ou no app Claude Desktop.
                Abra esta tela no computador para seguir junto.
              </p>
            </div>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Depois de conectar, você pergunta ao Claude sobre as suas casas em português, como numa
            conversa, e ele responde com os mesmos números do Betleads. Leva uns 5 minutos e só
            precisa ser feito uma vez. Funciona no site claude.ai e no app Claude Desktop.
          </p>
          <ol className="space-y-4">
            <Passo numero={1} titulo="Copie o endereço do Betleads" feito={conectado}>
              <p>Clique no botão abaixo. O endereço fica guardado para você colar no Claude.</p>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                {...tourAnchor("mcp.passos.copiar")}
                onClick={() => void copiar(data.mcpUrl, "URL copiada")}
              >
                <Copy className="h-4 w-4" /> Copiar endereço
              </Button>
            </Passo>
            <Passo numero={2} titulo="Adicione o Betleads no Claude" feito={conectado}>
              <p>
                Abra o Claude (claude.ai ou Claude Desktop) com a sua conta. Clique no seu nome, no
                canto de baixo à esquerda, e depois em <strong>Configurações</strong> →{" "}
                <strong>Conectores</strong>.
              </p>
              <p>
                Clique em <strong>Adicionar conector personalizado</strong>. Em nome, escreva{" "}
                <strong>Betleads</strong>. No campo de URL, cole o endereço copiado (Ctrl+V). Clique
                em <strong>Adicionar</strong>.
              </p>
            </Passo>
            <Passo numero={3} titulo="Autorize o acesso" feito={conectado}>
              <p>
                Na lista de conectores, clique em <strong>Conectar</strong> ao lado do Betleads.
                Abre uma página do Betleads: confira que o endereço começa com{" "}
                <strong>{origem}</strong>. Se pedir, entre com o seu e-mail e senha do Betleads.
              </p>
              <p>
                Confira as casas listadas e clique em <strong>Permitir</strong>. Você volta para o
                Claude e a conexão aparece em "Conexões ativas", no fim desta tela.
              </p>
            </Passo>
            <Passo numero={4} titulo="Faça a primeira pergunta" feito={perguntou}>
              <p>
                Abra uma conversa nova no Claude. No botão <strong>+</strong> do campo de mensagem,
                em Conectores, confira que o Betleads está ligado. Pergunte, por exemplo:{" "}
                <em>"Quais casas eu consigo ver no Betleads?"</em>
              </p>
              <p>
                Na primeira vez, o Claude pede licença para usar o Betleads: clique em{" "}
                <strong>Permitir</strong> (ou "Sempre permitir").
              </p>
            </Passo>
          </ol>
        </CardContent>
      </Card>

      <Card {...tourAnchor("mcp.exemplos.card")}>
        <CardHeader>
          <CardTitle>O que perguntar</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            Escreva como falaria com uma pessoa. Diga a casa, o grupo ou "todas as minhas casas" e o
            período (ontem, últimos 7 dias, este mês, outubro…). Clique numa pergunta para copiar.
          </p>
          {exemplos.map((grupo) => (
            <div key={grupo.titulo} className="space-y-1.5">
              <div className="font-medium">{grupo.titulo}</div>
              <ul className="space-y-1">
                {grupo.perguntas.map((pergunta) => (
                  <li key={pergunta}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left hover:bg-muted/40"
                      onClick={() => void copiar(pergunta, "Pergunta copiada")}
                    >
                      <Copy className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span>{pergunta}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>

      {podeAlterar ? (
        <Card {...tourAnchor("mcp.alteracoes.card")}>
          <CardHeader>
            <CardTitle>Como o Claude altera o financeiro</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>O Claude nunca grava nada direto. Toda alteração tem duas etapas:</p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Você pede (ex.: "lance o GGR de outubro da casa X").</li>
              <li>O Claude mostra uma prévia do que vai mudar: o valor de antes e o de depois.</li>
              <li>
                Só quando você responde algo como <strong>"pode confirmar"</strong> ele grava. Se
                algo estiver errado, diga o que corrigir e ele faz uma nova prévia.
              </li>
            </ol>
            <p>
              A prévia vale por 10 minutos. Toda alteração fica registrada com o seu usuário, como
              se você tivesse feito pelo painel. Casas suspensas ou bloqueadas não aceitam
              alteração.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card {...tourAnchor("mcp.seguranca.card")}>
        <CardHeader>
          <CardTitle>O que o Claude vê</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <ul className="list-disc space-y-1 pl-5">
            <li>Só as casas e as áreas liberadas para você, nunca as de outras pessoas.</li>
            <li>
              Nenhum dado de jogador: nada de nome, telefone, e-mail ou CPF. Só números somados.
            </li>
            {temOperacao ? (
              <li>A parte de operação é só leitura: o Claude não altera nada nela.</li>
            ) : null}
            <li>
              Os números vêm do mesmo lugar do painel, mas o Claude pode se confundir ao explicar.
              Antes de uma decisão importante, confira no Betleads.
            </li>
            <li>Perdeu o computador ou não usa mais? Clique em Desconectar, no fim desta tela.</li>
          </ul>
        </CardContent>
      </Card>

      <Card {...tourAnchor("mcp.problemas.card")}>
        <CardHeader>
          <CardTitle>Problemas comuns</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {[
            {
              q: 'Não aparece "Adicionar conector personalizado"',
              a: "Em contas de empresa do Claude (Team ou Enterprise), só o dono da conta pode adicionar conectores: peça a ele. Em algumas contas há um limite de conectores personalizados.",
            },
            {
              q: 'A página do Betleads diz "Seu usuário não tem acesso ao MCP"',
              a: "O acesso é liberado por pessoa pelo super admin. Peça a ele e tente conectar de novo.",
            },
            {
              q: "O Claude responde sem usar o Betleads",
              a: 'Confira, no botão + do campo de mensagem, se o Betleads está ligado nesta conversa. Você também pode pedir: "use o Betleads para responder".',
            },
            {
              q: "O Claude diz que não tem acesso a uma casa ou à operação",
              a: "A casa ou a área não está liberada para o seu usuário. Peça ao super admin.",
            },
            {
              q: "Parou de funcionar",
              a: "Depois de 30 dias sem uso, a conexão expira. No Claude, em Configurações → Conectores, desconecte e conecte o Betleads de novo.",
            },
          ].map((item) => (
            <details key={item.q} className="rounded-md border px-3 py-2">
              <summary className="cursor-pointer font-medium">{item.q}</summary>
              <p className="mt-1.5 text-muted-foreground">{item.a}</p>
            </details>
          ))}
        </CardContent>
      </Card>

      <Card {...tourAnchor("mcp.url.card")}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" /> URL de conexão
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input
              readOnly
              aria-label="URL de conexão"
              value={data.mcpUrl}
              className="min-w-0 flex-1 bg-muted/30 font-mono"
            />
            <Button
              variant="outline"
              className="gap-2"
              {...tourAnchor("mcp.url.copiar")}
              onClick={() => void copiar(data.mcpUrl, "URL copiada")}
            >
              <Copy className="h-4 w-4" /> Copiar
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card {...tourAnchor("mcp.claudeai.card")}>
        <CardHeader>
          <CardTitle>claude.ai</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Configurações → Conectores → Adicionar conector personalizado → colar a URL acima.
        </CardContent>
      </Card>

      <Card {...tourAnchor("mcp.desktop.card")}>
        <CardHeader>
          <CardTitle>Claude Desktop</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Mesmo caminho: Configurações → Conectores → Adicionar conector personalizado → colar a URL
          acima.
        </CardContent>
      </Card>

      <Card {...tourAnchor("mcp.code.card")}>
        <CardHeader>
          <CardTitle>Claude Code</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input
              readOnly
              aria-label="Comando do Claude Code"
              value={claudeCodeCommand}
              className="min-w-0 flex-1 bg-muted/30 font-mono"
            />
            <Button
              variant="outline"
              className="gap-2"
              {...tourAnchor("mcp.code.copiar")}
              onClick={() => void copiar(claudeCodeCommand, "Comando copiado")}
            >
              <Copy className="h-4 w-4" /> Copiar
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card {...tourAnchor("mcp.conexoes.card")}>
        <CardHeader>
          <CardTitle>Conexões ativas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.connections.length === 0 && (
            <p className="text-sm text-muted-foreground">Nenhuma conexão ativa.</p>
          )}
          {data.connections.map((conn, index) => (
            <div
              key={conn.id}
              className="flex items-center justify-between gap-2 border-b border-border/40 pb-2 last:border-0 last:pb-0"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{conn.clientName}</div>
                <div className="text-meta text-muted-foreground">
                  criada em {fmtDate(conn.createdAt)} · último uso: {fmtDate(conn.lastUsedAt)}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0"
                {...(index === 0 ? tourAnchor("mcp.conexoes.desconectar") : {})}
                disabled={revoke.isPending && revoke.variables === conn.id}
                onClick={() => void desconectar(conn.id, conn.clientName)}
              >
                {revoke.isPending && revoke.variables === conn.id
                  ? "Desconectando…"
                  : "Desconectar"}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </Page>
  );
}
