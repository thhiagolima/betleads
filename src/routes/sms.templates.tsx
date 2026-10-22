import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Copy, Pencil, Plus, Save, ArchiveRestore, Archive } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  archiveSmsTemplate,
  duplicateSmsTemplate,
  listSmsTemplates,
  saveSmsTemplate,
} from "@/lib/sms-templates.functions";
import { getComposerOptions } from "@/lib/house-config.functions";
import { COMPOSER_OPTIONS_QUERY_KEY } from "@/components/house-config/house-config-query";
import { LinkInsertMenu } from "@/components/house-config/link-insert-menu";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { estimateSms } from "@/lib/link-tracking-preview";

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

// Rascunho controlado do formulário. `tagsText` guarda o texto cru das tags
// para a digitação com vírgulas não ser reescrita a cada tecla.
type Draft = Template & { tagsText: string };

const toDraft = (template: Template): Draft => ({
  ...template,
  tagsText: template.tags.join(", "),
});

const parseTags = (text: string) =>
  text
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

function SmsTemplatesPage() {
  const queryClient = useQueryClient();
  const list = useServerFn(listSmsTemplates);
  const save = useServerFn(saveSmsTemplate);
  const duplicate = useServerFn(duplicateSmsTemplate);
  const archive = useServerFn(archiveSmsTemplate);
  const templates = useQuery({ queryKey: ["sms-templates"], queryFn: () => list() });
  const getComposerOpts = useServerFn(getComposerOptions);
  const composerOptions = useQuery({
    queryKey: COMPOSER_OPTIONS_QUERY_KEY,
    queryFn: () => getComposerOpts(),
  });
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const patch = (fields: Partial<Draft>) =>
    setEditing((current) => (current ? { ...current, ...fields } : current));
  const estimate = estimateSms(editing?.content ?? "");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["sms-templates"] });
  const saveMutation = useMutation({
    // Lê do estado controlado (não do DOM): nunca grava campos de outro template.
    mutationFn: (draft: Draft) =>
      save({
        data: {
          // Template novo tem id "" — o servidor espera UUID ou ausência.
          id: draft.id || undefined,
          name: draft.name.trim(),
          content: draft.content,
          category: draft.category.trim() || "Geral",
          tags: parseTags(draft.tagsText),
          isActive: draft.isActive,
        },
      }),
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
            setEditing(
              toDraft({
                id: "",
                name: "",
                content: "",
                category: "Geral",
                tags: [],
                isActive: true,
                version: 1,
              }),
            )
          }
        >
          <Plus className="mr-2 h-4 w-4" />
          Novo template
        </Button>
      </div>
      {editing && (
        <Card key={editing.id || "new"}>
          <CardHeader>
            <CardTitle>{editing.id ? "Editar template" : "Novo template"}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                saveMutation.mutate(editing);
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label>Nome</Label>
                  <Input
                    name="name"
                    value={editing.name}
                    onChange={(event) => patch({ name: event.target.value })}
                    required
                  />
                </div>
                <div>
                  <Label>Categoria</Label>
                  <Input
                    name="category"
                    value={editing.category}
                    onChange={(event) => patch({ category: event.target.value })}
                    required
                  />
                </div>
              </div>
              <div>
                <Label>Tags</Label>
                <Input
                  name="tags"
                  value={editing.tagsText}
                  onChange={(event) => patch({ tagsText: event.target.value })}
                  placeholder="reativação, vip"
                />
              </div>
              <div>
                <Label>Mensagem</Label>
                <Textarea
                  ref={contentRef}
                  name="content"
                  rows={5}
                  value={editing.content}
                  maxLength={480}
                  required
                  onChange={(event) => patch({ content: event.target.value })}
                />
                <LinkInsertMenu
                  siteUrl={composerOptions.data?.siteUrl ?? null}
                  quickLinks={composerOptions.data?.quickLinks ?? []}
                  textareaRef={contentRef}
                  value={editing.content}
                  onChange={(content) => patch({ content })}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {estimate.characters} caracteres · {estimate.encoding} · {estimate.parts} parte(s)
                </p>
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
                <Button size="sm" variant="outline" onClick={() => setEditing(toDraft(item))}>
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
