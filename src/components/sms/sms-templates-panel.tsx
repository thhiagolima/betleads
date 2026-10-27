import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Archive,
  ArchiveRestore,
  Copy,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Plus,
  Save,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { HomeCard } from "@/components/home/home-cards";
import { COMPOSER_OPTIONS_QUERY_KEY } from "@/components/house-config/house-config-query";
import { LinkInsertMenu } from "@/components/house-config/link-insert-menu";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { getComposerOptions } from "@/lib/house-config.functions";
import { estimateSms } from "@/lib/link-tracking-preview";
import {
  archiveSmsTemplate,
  duplicateSmsTemplate,
  listSmsTemplates,
  saveSmsTemplate,
} from "@/lib/sms-templates.functions";
import { cn } from "@/lib/utils";

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

const EMPTY_TEMPLATE: Template = {
  id: "",
  name: "",
  content: "",
  category: "Geral",
  tags: [],
  isActive: true,
  version: 1,
};

/** The SMS "Templates" tab: reusable messages for campaigns and journeys. */
export function SmsTemplatesPanel() {
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
    onSuccess: (_result, input) => {
      toast.success(
        input.type === "duplicate"
          ? "Template duplicado"
          : input.item.isActive
            ? "Template arquivado"
            : "Template reativado",
      );
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const items = (templates.data?.items ?? []) as Template[];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-body text-muted-foreground">
          Mensagens reutilizáveis para campanhas e jornadas.
        </p>
        <Button className="h-9" onClick={() => setEditing(toDraft(EMPTY_TEMPLATE))}>
          <Plus className="size-4" aria-hidden="true" />
          Novo template
        </Button>
      </div>

      {editing && (
        <HomeCard key={editing.id || "new"} className="p-4 sm:p-5">
          <h2 className="text-[15px] font-semibold">
            {editing.id ? "Editar template" : "Novo template"}
          </h2>
          <form
            className="mt-4 grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              saveMutation.mutate(editing);
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sms-template-name">Nome</Label>
                <Input
                  id="sms-template-name"
                  name="name"
                  value={editing.name}
                  onChange={(event) => patch({ name: event.target.value })}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sms-template-category">Categoria</Label>
                <Input
                  id="sms-template-category"
                  name="category"
                  value={editing.category}
                  onChange={(event) => patch({ category: event.target.value })}
                  required
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sms-template-tags">Etiquetas</Label>
              <Input
                id="sms-template-tags"
                name="tags"
                value={editing.tagsText}
                onChange={(event) => patch({ tagsText: event.target.value })}
                placeholder="reativação, vip"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sms-template-content">Mensagem</Label>
              <Textarea
                id="sms-template-content"
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
              <p className="text-xs text-muted-foreground">
                {estimate.characters} caracteres · {estimate.encoding} · {estimate.parts} parte(s)
              </p>
            </div>
            <div className="flex gap-2">
              <Button type="submit" className="h-9" disabled={saveMutation.isPending}>
                <Save className="size-4" aria-hidden="true" />
                Salvar
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-9"
                onClick={() => setEditing(null)}
              >
                Cancelar
              </Button>
            </div>
          </form>
        </HomeCard>
      )}

      {templates.isLoading ? (
        <div className="grid gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-40 rounded-2xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <HomeCard className="flex flex-col items-center gap-3 p-10 text-center">
          <MessageSquareText className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">Nenhum template ainda</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Salve aqui as mensagens que você usa sempre, para escolher na hora de montar uma
            campanha.
          </p>
          <Button className="h-9" onClick={() => setEditing(toDraft(EMPTY_TEMPLATE))}>
            <Plus className="size-4" aria-hidden="true" />
            Novo template
          </Button>
        </HomeCard>
      ) : (
        <div className="grid gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <HomeCard
              key={item.id}
              className={cn("flex flex-col p-4 sm:p-5", !item.isActive && "opacity-60")}
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 truncate text-[15px] font-semibold">{item.name}</h3>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {item.isActive ? `v${item.version}` : "arquivado"}
                </span>
              </div>
              <p className="mt-2 line-clamp-4 min-h-16 whitespace-pre-wrap text-sm text-foreground/90">
                {item.content}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {item.category}
                {item.tags.length ? ` · ${item.tags.join(", ")}` : ""}
              </p>
              <div className="mt-4 flex items-center gap-2 pt-1 lg:mt-auto">
                <Button variant="outline" className="h-9" onClick={() => setEditing(toDraft(item))}>
                  <Pencil className="size-3.5" aria-hidden="true" />
                  Editar
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      label={`Mais ações de ${item.name}`}
                      icon={<MoreHorizontal className="size-4" />}
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onSelect={() => action.mutate({ type: "duplicate", item })}>
                      <Copy className="size-4" aria-hidden="true" />
                      Duplicar
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => action.mutate({ type: "archive", item })}>
                      {item.isActive ? (
                        <Archive className="size-4" aria-hidden="true" />
                      ) : (
                        <ArchiveRestore className="size-4" aria-hidden="true" />
                      )}
                      {item.isActive ? "Arquivar" : "Reativar"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </HomeCard>
          ))}
        </div>
      )}
    </div>
  );
}
