import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Save } from "lucide-react";
import { toast } from "sonner";

import { MessageVariablePicker } from "@/components/message-variable-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { tenantSafeChannelError } from "@/lib/channel-error";
import { saveSmsTemplate } from "@/lib/sms-templates.functions";

export type CreatedSmsTemplate = { id: string; name: string; content: string };

export function SmsTemplateDialog({
  open,
  onOpenChange,
  initialContent = "",
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialContent?: string;
  onCreated: (template: CreatedSmsTemplate) => void;
}) {
  const saveTemplate = useServerFn(saveSmsTemplate);
  const queryClient = useQueryClient();
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState(initialContent);

  useEffect(() => {
    if (!open) return;
    setName("");
    setContent(initialContent);
  }, [open, initialContent]);

  const save = useMutation({
    mutationFn: () =>
      saveTemplate({
        data: { name, content, category: "Geral", tags: [], isActive: true },
      }),
    onSuccess: ({ item }) => {
      queryClient.invalidateQueries({ queryKey: ["sms-templates"] });
      onCreated(item);
      onOpenChange(false);
      toast.success("Template SMS criado e selecionado");
    },
    onError: (error: Error) => toast.error(tenantSafeChannelError(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Novo template SMS</DialogTitle>
          <DialogDescription>
            Crie um conteúdo reutilizável. Ao salvar, ele será selecionado no fluxo anterior.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sms-template-name">Nome do template</Label>
            <Input
              id="sms-template-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ex.: Bônus de retorno"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="sms-template-content">Mensagem</Label>
              <span className="text-xs text-muted-foreground">{content.length}/480 caracteres</span>
            </div>
            <Textarea
              ref={contentRef}
              id="sms-template-content"
              rows={6}
              maxLength={480}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="Olá {primeiro_nome}, temos uma novidade para você."
            />
            <MessageVariablePicker
              channel="sms"
              textareaRef={contentRef}
              value={content}
              onChange={setContent}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            type="button"
            disabled={!name.trim() || !content.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            <Save className="mr-2 size-4" />
            {save.isPending ? "Salvando…" : "Criar e selecionar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
