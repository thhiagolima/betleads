// Área do Expert (Fase 2, Task 8): "Modelos de mensagem" — o expert mantém
// seus próprios modelos de WhatsApp e pode copiar, só para leitura, os
// `sms_templates` ativos da casa (`listExpertTemplates`, `saveExpertTemplate`,
// `deleteExpertTemplate`, `copyHouseTemplate`, Task 4). A ajuda de variáveis
// lista só as que `renderExpertMessage` de fato preenche a partir do lead
// (`leadToPlayerVars` -> `buildPlayerVariables`, `template-vars.server.ts`):
// nome/telefone/depósitos/categoria/cashback, mais `{link}` — tratado aqui
// à parte porque não vem de `buildPlayerVariables`, e sim do link gerado na
// ficha do lead.
import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Page, PageHeader } from "@/components/ui-premium/page-header";
import { requestConfirmation } from "@/components/system-dialog-host";
import { actionErrorMessage } from "@/components/expert/sheet-format";
import { expertAccessErrorMessage } from "@/lib/expert-access-message";
import {
  copyHouseTemplate,
  deleteExpertTemplate,
  listExpertTemplates,
  saveExpertTemplate,
  type ExpertTemplate,
} from "@/lib/expert-templates.functions";
import { variablesForChannel } from "@/lib/message-variables";

export const Route = createFileRoute("/expert/modelos")({
  component: ExpertTemplatesPage,
});

const TEMPLATES_QUERY_KEY = ["expert-templates"];

const NOME_MIN = 2;
const NOME_MAX = 60;
const CONTEUDO_MAX = 1000;

/** Chaves que `buildPlayerVariables` de fato preenche a partir do que
 * `leadToPlayerVars` envia (nome, telefone, depósitos, saque, vip/risco e
 * cashback) — as demais variáveis do catálogo (saldo, e-mail, último login,
 * último jogo, status, expert, IDs de push, variáveis de ligação) ficam
 * sempre no valor padrão genérico porque a ficha do lead do expert nunca
 * carrega esses dados. `link_login`/`link_deposito` entram aqui também:
 * `renderExpertMessage` passa `loadHouseLinks(expert.tenantId)` para
 * `buildPlayerVariables`, então os dois sempre renderizam uma URL real da
 * casa — mas, diferente de `{link}`, não são o link gerado nesta sessão, e
 * por isso o clique neles não é rastreado para o expert. */
const FILLED_VARIABLE_KEYS = new Set([
  "primeiro_nome",
  "nome",
  "telefone",
  "ultimo_deposito",
  "dias_sem_depositar",
  "total_depositado",
  "total_sacado",
  "lucro",
  "categoria",
  "cashback_valor",
  "cashback_amount",
  "cashback_pago_em",
  "link_login",
  "link_deposito",
]);

/** Variáveis preenchidas com um link da casa, não com o link rastreado
 * gerado na ficha — mostradas com o aviso de que o clique não conta para o
 * expert, para que ele prefira `{link}`. */
const HOUSE_LINK_VARIABLE_KEYS = new Set(["link_login", "link_deposito"]);
const HOUSE_LINK_NOTE = "link da casa — não conta clique para você";

function nomeError(nome: string): string | null {
  const trimmed = nome.trim();
  if (!trimmed) return null; // vazio só desabilita Salvar, sem dica ainda
  if (trimmed.length < NOME_MIN) return "O nome precisa ter pelo menos 2 caracteres.";
  if (trimmed.length > NOME_MAX) return "O nome pode ter até 60 caracteres.";
  return null;
}

function conteudoError(conteudo: string): string | null {
  if (!conteudo) return null; // vazio só desabilita Salvar, sem dica ainda
  if (!conteudo.trim() || conteudo.trim().length > CONTEUDO_MAX) {
    return "O texto precisa ter de 1 a 1000 caracteres.";
  }
  return null;
}

function TemplateFormDialog({
  open,
  onOpenChange,
  template,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` cria um modelo novo. */
  template: ExpertTemplate | null;
}) {
  const qc = useQueryClient();
  const saveFn = useServerFn(saveExpertTemplate);

  const [nome, setNome] = useState("");
  const [conteudo, setConteudo] = useState("");

  useEffect(() => {
    if (!open) return;
    setNome(template?.nome ?? "");
    setConteudo(template?.conteudo ?? "");
  }, [open, template]);

  const nomeHint = nomeError(nome);
  const conteudoHint = conteudoError(conteudo);
  const canSave =
    nome.trim().length >= NOME_MIN && !nomeHint && conteudo.trim().length > 0 && !conteudoHint;

  const save = useMutation({
    mutationFn: () =>
      saveFn({ data: { id: template?.id, nome: nome.trim(), conteudo: conteudo.trim() } }),
    onSuccess: () => {
      toast.success(template ? "Modelo atualizado." : "Modelo criado.");
      qc.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
      onOpenChange(false);
    },
    onError: (error) => toast.error(actionErrorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{template ? "Editar modelo" : "Novo modelo"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="expert-template-nome">Nome</Label>
            <Input
              id="expert-template-nome"
              value={nome}
              maxLength={NOME_MAX}
              onChange={(event) => setNome(event.target.value)}
              placeholder="Ex.: Lembrete de cashback"
            />
            {nomeHint && <p className="text-label text-destructive">{nomeHint}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="expert-template-conteudo">Texto</Label>
            <Textarea
              id="expert-template-conteudo"
              rows={6}
              maxLength={CONTEUDO_MAX}
              value={conteudo}
              onChange={(event) => setConteudo(event.target.value)}
              placeholder="Use {primeiro_nome}, {link} e outras variáveis da lista abaixo."
            />
            <div className="flex items-start justify-between gap-2">
              {conteudoHint ? (
                <p className="text-label text-destructive">{conteudoHint}</p>
              ) : (
                <span />
              )}
              <p className="shrink-0 text-label text-muted-foreground">
                {conteudo.length}/{CONTEUDO_MAX}
              </p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExpertTemplatesPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listExpertTemplates);
  const templatesQuery = useQuery({
    queryKey: TEMPLATES_QUERY_KEY,
    queryFn: () => listFn(),
  });

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ExpertTemplate | null>(null);

  function openNew() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(template: ExpertTemplate) {
    setEditing(template);
    setFormOpen(true);
  }

  const deleteFn = useServerFn(deleteExpertTemplate);
  const remove = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Modelo excluído.");
      qc.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
    },
    onError: (error) => toast.error(actionErrorMessage(error)),
  });

  async function confirmDelete(template: ExpertTemplate) {
    const confirmed = await requestConfirmation({
      title: `Excluir o modelo "${template.nome}"?`,
      description: "Esta ação não pode ser desfeita.",
      confirmLabel: "Excluir modelo",
      destructive: true,
    });
    if (confirmed) remove.mutate(template.id);
  }

  const copyFn = useServerFn(copyHouseTemplate);
  const copy = useMutation({
    mutationFn: (smsTemplateId: string) => copyFn({ data: { smsTemplateId } }),
    onSuccess: () => {
      toast.success("Modelo copiado para os seus.");
      qc.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
    },
    onError: (error) => toast.error(actionErrorMessage(error)),
  });

  if (templatesQuery.isError) {
    return (
      <Page>
        <PageHeader />
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {expertAccessErrorMessage(templatesQuery.error)}
          </CardContent>
        </Card>
      </Page>
    );
  }

  const meus = templatesQuery.data?.meus ?? [];
  const casa = templatesQuery.data?.casa ?? [];
  const variaveis = variablesForChannel("sms").filter((variable) =>
    FILLED_VARIABLE_KEYS.has(variable.key),
  );

  return (
    <Page>
      <PageHeader />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Meus modelos</CardTitle>
          <Button size="sm" onClick={openNew}>
            Novo modelo
          </Button>
        </CardHeader>
        <CardContent>
          {templatesQuery.isLoading ? (
            <p className="py-6 text-center text-muted-foreground">Carregando…</p>
          ) : meus.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">
              Você ainda não tem modelos. Crie um ou copie um dos modelos da casa abaixo.
            </p>
          ) : (
            <ul className="divide-y divide-border/70">
              {meus.map((template) => (
                <li key={template.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-body font-medium">{template.nome}</p>
                    <p className="mt-0.5 line-clamp-2 text-label text-muted-foreground">
                      {template.conteudo}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button variant="outline" size="sm" onClick={() => openEdit(template)}>
                      Editar
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      disabled={remove.isPending}
                      onClick={() => void confirmDelete(template)}
                    >
                      Excluir
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Modelos da casa</CardTitle>
        </CardHeader>
        <CardContent>
          {templatesQuery.isLoading ? (
            <p className="py-6 text-center text-muted-foreground">Carregando…</p>
          ) : casa.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">
              A casa ainda não tem modelos de SMS ativos.
            </p>
          ) : (
            <ul className="divide-y divide-border/70">
              {casa.map((template) => (
                <li key={template.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-body font-medium">{template.nome}</p>
                    <p className="mt-0.5 line-clamp-2 text-label text-muted-foreground">
                      {template.conteudo}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={copy.isPending}
                    onClick={() => copy.mutate(template.id)}
                  >
                    Copiar para os meus
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Variáveis disponíveis</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 sm:grid-cols-2">
            <li className="rounded-md border border-border/70 px-3 py-2">
              <code className="text-label font-medium">{"{link}"}</code>
              <p className="text-label text-muted-foreground">
                Link da oferta gerado na ficha do lead.
              </p>
            </li>
            {variaveis.map((variable) => (
              <li key={variable.key} className="rounded-md border border-border/70 px-3 py-2">
                <code className="text-label font-medium">{`{${variable.key}}`}</code>
                <p className="text-label text-muted-foreground">{variable.label}</p>
                {HOUSE_LINK_VARIABLE_KEYS.has(variable.key) && (
                  <p className="text-label text-muted-foreground">{HOUSE_LINK_NOTE}</p>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <TemplateFormDialog open={formOpen} onOpenChange={setFormOpen} template={editing} />
    </Page>
  );
}
