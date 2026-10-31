// "Conectar ao Claude" (spec §9): own MCP status (level, connection URL,
// active connections) plus copy-paste instructions for claude.ai, Claude
// Desktop and Claude Code. Hidden when MCP is disabled in this environment,
// or wired per sidebar rules (feature off, or the user has no mcp_access
// row at all) — this route still renders the "off" note either way, since a
// direct visit shouldn't 404.
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bot, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { getMyMcpStatus, revokeMyConnection } from "@/lib/mcp/mcp.functions";

export const Route = createFileRoute("/mcp")({
  component: McpPage,
});

const LEVEL_LABEL: Record<"none" | "read" | "write", string> = {
  none: "Sem acesso",
  read: "Leitura",
  write: "Leitura e escrita",
};

function fmtDate(d: string | null) {
  if (!d) return "nunca";
  return new Date(d).toLocaleString("pt-BR");
}

function McpPage() {
  const qc = useQueryClient();
  const statusFn = useServerFn(getMyMcpStatus);
  const revokeFn = useServerFn(revokeMyConnection);

  const { data, isLoading } = useQuery({
    queryKey: ["mcp", "my-status"],
    queryFn: () => statusFn(),
  });

  if (isLoading || !data) {
    return (
      <Page>
        <PageHeader title="Conectar ao Claude" subtitle="Carregando…" />
      </Page>
    );
  }

  if (!data.enabled) {
    return (
      <Page>
        <PageHeader title="Conectar ao Claude" />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            MCP desligado neste ambiente.
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
            Seu usuário não tem acesso ao MCP. Peça ao super admin.
          </CardContent>
        </Card>
      </Page>
    );
  }

  const claudeCodeCommand = `claude mcp add --transport http financeiro ${data.mcpUrl}`;

  return (
    <Page>
      <PageHeader
        title="Conectar ao Claude"
        subtitle={`Nível de acesso: ${LEVEL_LABEL[data.level]}.`}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" /> URL de conexão
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <input
              readOnly
              value={data.mcpUrl}
              className="w-full h-9 text-sm px-3 rounded-md border bg-muted/30 font-mono"
            />
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => {
                navigator.clipboard.writeText(data.mcpUrl);
                toast.success("URL copiada");
              }}
            >
              <Copy className="h-4 w-4" /> Copiar
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>claude.ai</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Configurações → Conectores → Adicionar conector personalizado → colar a URL acima.
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Claude Desktop</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Mesmo caminho: Configurações → Conectores → Adicionar conector personalizado → colar a
          URL acima.
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Claude Code</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <input
              readOnly
              value={claudeCodeCommand}
              className="w-full h-9 text-sm px-3 rounded-md border bg-muted/30 font-mono"
            />
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => {
                navigator.clipboard.writeText(claudeCodeCommand);
                toast.success("Comando copiado");
              }}
            >
              <Copy className="h-4 w-4" /> Copiar
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Conexões ativas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.connections.length === 0 && (
            <p className="text-sm text-muted-foreground">Nenhuma conexão ativa.</p>
          )}
          {data.connections.map((conn) => (
            <div key={conn.id} className="flex items-center justify-between gap-2 border-b border-border/40 pb-2 last:border-0 last:pb-0">
              <div>
                <div className="text-sm font-medium">{conn.clientName}</div>
                <div className="text-meta text-muted-foreground">
                  criada em {fmtDate(conn.createdAt)} · último uso: {fmtDate(conn.lastUsedAt)}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void revokeFn({ data: { connectionId: conn.id } }).then(() => {
                    toast.success("Conexão desconectada");
                    qc.invalidateQueries({ queryKey: ["mcp", "my-status"] });
                  });
                }}
              >
                Desconectar
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </Page>
  );
}
