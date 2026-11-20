// MCP financeiro, Task 9: super admin screen listing who may have MCP access
// (super admins, admin/owner/gestor, finance viewers, group managers), their
// current level and their active connections — with a "Desconectar" per
// connection. Style follows src/components/billing/admin/* (Card + Table).
//
// MCP do grupo (spec 2026-11-17 §4.3): two checkboxes per user, Financeiro
// and Operação, saved to mcp_access.areas (adminSetMcpAreas, audited). They
// are off while the user has no level; Operação is off for users who can't
// receive it (only super admin, admin of a house or group manager), unless
// it is already on, so it can still be turned off.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bot } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
  adminSetMcpAreas,
  type McpAccessRow,
} from "@/lib/mcp/mcp.functions";

export const MCP_ACCESS_QUERY_KEY = ["admin", "mcp-access"];

const LEVEL_LABEL: Record<McpAccessRow["level"], string> = {
  none: "Sem acesso",
  read: "Leitura",
  write: "Leitura e escrita",
};

type McpAreaName = McpAccessRow["areas"][number];
type SetAreasVars = { userId: string; areas: McpAreaName[] };

const AREA_LABEL: Record<McpAreaName, string> = {
  financeiro: "Financeiro",
  operacao: "Operação",
};
const AREA_ORDER: McpAreaName[] = ["financeiro", "operacao"];

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

/**
 * What an area checkbox does on change, as a plain function (same reason as
 * createLevelChangeHandler). Never sends an empty list: unchecking the last
 * area is ignored (the server would refuse it anyway).
 */
export function createAreaToggleHandler(
  row: Pick<McpAccessRow, "userId" | "areas">,
  area: McpAreaName,
  setAreas: (vars: SetAreasVars) => void,
) {
  return (checked: boolean | "indeterminate") => {
    const on = checked === true;
    const areas = AREA_ORDER.filter((a) => (a === area ? on : row.areas.includes(a)));
    if (areas.length === 0) return;
    setAreas({ userId: row.userId, areas });
  };
}

/** Whether an area checkbox can be clicked for this row. */
export function areaCheckboxDisabled(
  row: Pick<McpAccessRow, "level" | "areas" | "operacaoElegivel">,
  area: McpAreaName,
): boolean {
  if (row.level === "none") return true;
  if (area === "operacao" && !row.operacaoElegivel && !row.areas.includes("operacao")) return true;
  return false;
}

function McpAccessRowView({
  row,
  onSetAccess,
  onSetAreas,
  onRevokeConnection,
}: {
  row: McpAccessRow;
  onSetAccess: (vars: { userId: string; level: McpAccessRow["level"] }) => void;
  onSetAreas: (vars: SetAreasVars) => void;
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
        <div className="flex flex-col gap-1.5">
          {AREA_ORDER.map((area) => {
            const id = `mcp-area-${row.userId}-${area}`;
            return (
              <label key={area} htmlFor={id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={id}
                  checked={row.level !== "none" && row.areas.includes(area)}
                  disabled={areaCheckboxDisabled(row, area)}
                  onCheckedChange={createAreaToggleHandler(row, area, onSetAreas)}
                />
                {AREA_LABEL[area]}
              </label>
            );
          })}
          {!row.operacaoElegivel && (
            <span className="text-meta text-muted-foreground">
              Operação: só super admin, admin de casa ou gestor de grupo.
            </span>
          )}
        </div>
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
  const setAreasFn = useServerFn(adminSetMcpAreas);
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
  const setAreas = (vars: SetAreasVars) => {
    void setAreasFn({ data: vars }).then(invalidate);
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
        <p className="text-sm text-muted-foreground">
          O mesmo acesso vale para a API de dados: a pessoa pode criar chaves que veem as mesmas
          casas e áreas, sempre só leitura. Tirar o acesso derruba as conexões e as chaves dela.
        </p>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Usuário</TableHead>
              <TableHead>Nível</TableHead>
              <TableHead>Áreas</TableHead>
              <TableHead>Conexões</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <McpAccessRowView
                key={row.userId}
                row={row}
                onSetAccess={setAccess}
                onSetAreas={setAreas}
                onRevokeConnection={revokeConn}
              />
            ))}
            {rows.length === 0 && !isLoading && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
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
