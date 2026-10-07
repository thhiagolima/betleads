import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Copy, Pencil, Plus, Save, ArchiveRestore, Archive } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  archiveSmsTemplate,
  duplicateSmsTemplate,
  listSmsTemplates,
  saveSmsTemplate,
} from "@/lib/sms-templates.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChannelWorkspaceNav } from "@/components/channels/channel-workspace-nav";

export const Route = createFileRoute("/sms/templates")({ component: SmsTemplatesPage });

type Template = {
  id: string;
  name: string;
  content: string;
  category: string;
  tags: string[];
  isActive: boolean;
  version: number;
};

function SmsTemplatesPage() {
  const queryClient = useQueryClient();
  const list = useServerFn(listSmsTemplates);
  const save = useServerFn(saveSmsTemplate);
  const duplicate = useServerFn(duplicateSmsTemplate);
  const archive = useServerFn(archiveSmsTemplate);
  const templates = useQuery({ queryKey: ["sms-templates"], queryFn: () => list() });
  const [editing, setEditing] = useState<Template | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["sms-templates"] });
  const saveMutation = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const fields = new FormData(form);
      return save({
        data: {
          id: editing?.id,
          name: String(fields.get("name") ?? ""),
          content: String(fields.get("content") ?? ""),
          category: String(fields.get("category") ?? "Geral"),
          tags: String(fields.get("tags") ?? "")
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
          isActive: editing?.isActive ?? true,
        },
      });
    },
    onSuccess: () => {
      toast.success("Template salvo");
      setEditing(null);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const action = useMutation({
    mutationFn: async (input: { type: "duplicate" | "archive"; item: Template }) =>
      input.type === "duplicate"
        ? duplicate({ data: { id: input.item.id } })
        : archive({ data: { id: input.item.id, isActive: !input.item.isActive } }),
    onSuccess: () => {
      toast.success("Biblioteca atualizada");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const items = (templates.data?.items ?? []) as Template[];
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Templates SMS</h1>
          <p className="text-sm text-muted-foreground">
            Mensagens reutilizáveis, isoladas por tenant.
          </p>
        </div>
        <Button
          onClick={() =>
            setEditing({
              id: "",
              name: "",
              content: "",
              category: "Geral",
              tags: [],
              isActive: true,
              version: 1,
            })
          }
        >
          <Plus className="mr-2 h-4 w-4" />
          Novo template
        </Button>
      </div>
      <ChannelWorkspaceNav channel="sms" />
      {editing && (
        <Card>
          <CardHeader>
            <CardTitle>{editing.id ? "Editar template" : "Novo template"}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                saveMutation.mutate(event.currentTarget);
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label>Nome</Label>
                  <Input name="name" defaultValue={editing.name} required />
                </div>
                <div>
                  <Label>Categoria</Label>
                  <Input name="category" defaultValue={editing.category} required />
                </div>
              </div>
              <div>
                <Label>Tags</Label>
                <Input
                  name="tags"
                  defaultValue={editing.tags.join(", ")}
                  placeholder="reativação, vip"
                />
              </div>
              <div>
                <Label>Mensagem</Label>
                <Textarea
                  name="content"
                  rows={5}
                  defaultValue={editing.content}
                  maxLength={480}
                  required
                />
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={saveMutation.isPending}>
                  <Save className="mr-2 h-4 w-4" />
                  Salvar
                </Button>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  Cancelar
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <Card key={item.id} className={!item.isActive ? "opacity-60" : ""}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2 text-base">
                <span className="truncate">{item.name}</span>
                <span className="text-xs font-normal text-muted-foreground">v{item.version}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="min-h-16 whitespace-pre-wrap text-sm">{item.content}</p>
              <p className="text-xs text-muted-foreground">
                {item.category}
                {item.tags.length ? ` · ${item.tags.join(", ")}` : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(item)}>
                  <Pencil className="mr-1 h-3.5 w-3.5" />
                  Editar
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => action.mutate({ type: "duplicate", item })}
                >
                  <Copy className="mr-1 h-3.5 w-3.5" />
                  Duplicar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => action.mutate({ type: "archive", item })}
                >
                  {item.isActive ? (
                    <Archive className="mr-1 h-3.5 w-3.5" />
                  ) : (
                    <ArchiveRestore className="mr-1 h-3.5 w-3.5" />
                  )}
                  {item.isActive ? "Arquivar" : "Reativar"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
