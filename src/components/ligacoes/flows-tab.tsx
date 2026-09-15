import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Workflow, Layers, RefreshCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  deleteCallFlow,
  listCallFlows,
  toggleCallFlow,
} from "@/lib/call-flows.functions";
import { TRIGGER_OPTIONS } from "./shared";
import { FlowFormDialog } from "./flow-form-dialog";

const triggerLabel = (v?: string | null) =>
  TRIGGER_OPTIONS.find((t) => t.value === v)?.label ?? v ?? "—";

export function FlowsTab() {
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);

  const delFn = useServerFn(deleteCallFlow);
  const listFn = useServerFn(listCallFlows);
  const toggleFn = useServerFn(toggleCallFlow);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["call-flows"],
    queryFn: () => listFn(),
    retry: 1,
  });

  const delMut = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Fluxo excluído");
      qc.invalidateQueries({ queryKey: ["call-flows"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Erro ao excluir"),
  });
  const toggleMut = useMutation({
    mutationFn: (v: { id: string; is_active: boolean }) => toggleFn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["call-flows"] }),
    onError: (e: any) => toast.error(e?.message ?? "Erro ao atualizar"),
  });

  const flows = data?.flows ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Workflow className="h-5 w-5 text-primary" />
            Fluxos de ligação
          </CardTitle>
          <CardDescription>
            Gatilho → roteiros → áudio → ligação → SMS opcional. Simples e rápido.
          </CardDescription>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" /> Novo fluxo
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Carregando...</p>
        ) : isError ? (
          <div className="py-12 text-center">
            <Workflow className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">Não foi possível carregar os fluxos.</p>
            <p className="mx-auto mt-1 max-w-xl text-xs text-muted-foreground">
              {(error as Error)?.message ?? "Erro desconhecido ao buscar os fluxos de ligação."}
            </p>
            <Button variant="outline" className="mt-4" onClick={() => refetch()}>
              <RefreshCw className="mr-2 h-4 w-4" /> Tentar novamente
            </Button>
          </div>
        ) : flows.length === 0 ? (
          <div className="py-12 text-center">
            <Workflow className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Nenhum fluxo criado. Clique em "Novo fluxo" para começar.
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {flows.map((f: any) => {
              const blocks = ((f.call_flow_blocks ?? []) as any[]).sort(
                (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0),
              );
              const callBlocks = blocks.filter((b) => b.block_type === "call");
              const delayBlocks = blocks.filter((b) => b.block_type === "delay");
              const smsCount = callBlocks.reduce(
                (acc, b) => acc + ((b.call_flow_block_sms ?? []) as any[]).length,
                0,
              );
              return (
                <div
                  key={f.id}
                  className="flex items-center gap-4 rounded-lg border border-border bg-card/40 p-4 transition-colors hover:bg-card/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <p className="truncate font-medium text-foreground">{f.name}</p>
                      {f.is_active ? (
                        <Badge variant="default" className="text-[10px]">ativo</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">pausado</Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        Gatilho:{" "}
                        <span className="font-medium text-foreground">
                          {triggerLabel(f.trigger_name)}
                        </span>
                      </span>
                      <span className="flex items-center gap-1">
                        <Layers className="h-3 w-3" />
                        {callBlocks.length} ligaç{callBlocks.length === 1 ? "ão" : "ões"} ·{" "}
                        {delayBlocks.length} delay{delayBlocks.length === 1 ? "" : "s"} ·{" "}
                        {smsCount} SMS
                      </span>
                    </div>
                  </div>

                  <Switch
                    checked={!!f.is_active}
                    onCheckedChange={(c) => toggleMut.mutate({ id: f.id, is_active: c })}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                      setEditing(f);
                      setDialogOpen(true);
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                      if (confirm(`Excluir fluxo "${f.name}"?`)) delMut.mutate(f.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <FlowFormDialog open={dialogOpen} onOpenChange={setDialogOpen} initial={editing} />
    </Card>
  );
}