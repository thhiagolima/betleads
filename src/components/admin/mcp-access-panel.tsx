// MCP financeiro, Task 9: super admin screen listing who may have MCP access
// (super admins, admin/owner/gestor, finance viewers, group managers), their
// current level and their active connections — with a "Desconectar" per
// connection. Style follows src/components/billing/admin/* (Card + Table).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bot } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  adminListMcpAccess,
  adminRevokeConnection,
  adminSetMcpAccess,
  type McpAccessRow,
} from "@/lib/mcp/mcp.functions";

export const MCP_ACCESS_QUERY_KEY = ["admin", "mcp-access"];

const LEVEL_LABEL: Record<McpAccessRow["level"], string> = {
  none: "Sem acesso",
  read: "Leitura",
  write: "Leitura e escrita",
};

function fmtDate(d: string | null) {
  if (!d) return "nunca";
  return new Date(d).toLocaleString("pt-BR");
}

/**
 * The exact thing the row's Select does on change — a plain function so it
 * can be tested without simulating a DOM event (this repo has no
 * @testing-library/react / jsdom; see link-domain-dialog.test.tsx).
 */
export function createLevelChangeHandler(
  userId: string,
  setAccess: (vars: { userId: string; level: McpAccessRow["level"] }) => void,
) {
  return (value: string) => {
    setAccess({ userId, level: value as McpAccessRow["level"] });
  };
}

function McpAccessRowView({
  row,
  onSetAccess,
  onRevokeConnection,
}: {
  row: McpAccessRow;
  onSetAccess: (vars: { userId: string; level: McpAccessRow["level"] }) => void;
  onRevokeConnection: (connectionId: string) => void;
}) {
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{row.nome}</div>
        <div className="text-meta text-muted-foreground">{row.email}</div>
      </TableCell>
      <TableCell>
        <Select value={row.level} onValueChange={createLevelChangeHandler(row.userId, onSetAccess)}>
          <SelectTrigger className="w-44">
            <SelectValue>{LEVEL_LABEL[row.level]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{LEVEL_LABEL.none}</SelectItem>
            <SelectItem value="read">{LEVEL_LABEL.read}</SelectItem>
            <SelectItem value="write">{LEVEL_LABEL.write}</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        {row.connections.length === 0 ? (
          <span className="text-meta text-muted-foreground">nenhuma conexão</span>
        ) : (
          <div className="flex flex-col gap-1.5">
            {row.connections.map((conn) => (
              <div key={conn.id} className="flex items-center justify-between gap-2">
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
                  onClick={() => onRevokeConnection(conn.id)}
                >
                  Desconectar
                </Button>
              </div>
            ))}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

export function McpAccessPanel({ mcpEnabled }: { mcpEnabled: boolean }) {
  const qc = useQueryClient();
  const listFn = useServerFn(adminListMcpAccess);
  const setAccessFn = useServerFn(adminSetMcpAccess);
  const revokeFn = useServerFn(adminRevokeConnection);

  const { data, isLoading } = useQuery({
    queryKey: MCP_ACCESS_QUERY_KEY,
    queryFn: () => listFn(),
    enabled: mcpEnabled,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: MCP_ACCESS_QUERY_KEY });

  const setAccess = (vars: { userId: string; level: McpAccessRow["level"] }) => {
    void setAccessFn({ data: vars }).then(invalidate);
  };
  const revokeConn = (connectionId: string) => {
    void revokeFn({ data: { connectionId } }).then(invalidate);
  };

  if (!mcpEnabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" /> MCP
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          MCP desligado neste ambiente.
        </CardContent>
      </Card>
    );
  }

  const rows = data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5" /> Acesso ao MCP
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Usuário</TableHead>
              <TableHead>Nível</TableHead>
              <TableHead>Conexões</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <McpAccessRowView
                key={row.userId}
                row={row}
                onSetAccess={setAccess}
                onRevokeConnection={revokeConn}
              />
            ))}
            {rows.length === 0 && !isLoading && (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                  Nenhum candidato a acesso MCP encontrado.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
