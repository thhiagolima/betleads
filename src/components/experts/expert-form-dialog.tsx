// "Novo expert" / "Editar expert" dialog (Área do Expert, Fase 1, Task 8):
// name, type, affiliate-id chips (with suggestions from the house's
// unassigned affiliate ids), send mode, monthly cap and claim deadline.
// Saves through `saveExpert` (Task 6); the demo tenant's refusal reaches the
// caller as a toast via the mutation's `onError`.
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveExpert } from "@/lib/experts-admin.functions";
import type { ExpertAdminRow } from "@/lib/experts-admin.functions";
import { EXPERTS_QUERY_KEY, UNASSIGNED_AFFILIATES_QUERY_KEY } from "@/components/experts/experts-query";

type ExpertTipo = "restrito" | "total";
type ExpertEnvioModo = "livre" | "aprovacao";

type UnassignedAffiliate = { affiliateId: string; leads: number };

const AFFILIATE_ID_MAX_LENGTH = 64;
const AFFILIATE_IDS_MAX_COUNT = 20;
const NOME_MIN_LENGTH = 2;
const NOME_MAX_LENGTH = 80;
const PRAZO_MIN = 1;
const PRAZO_MAX = 30;

/** Mirrors `saveExpertInput` (src/lib/experts-admin.functions.ts) so an
 * invalid value never reaches the server and surfaces its raw English Zod
 * message in a toast — every rejection here gets a short pt-BR hint instead. */
function nomeError(nome: string): string | null {
  const trimmed = nome.trim();
  if (!trimmed) return null; // empty just disables Salvar, no hint needed yet
  if (trimmed.length < NOME_MIN_LENGTH) return "O nome precisa ter pelo menos 2 caracteres.";
  if (trimmed.length > NOME_MAX_LENGTH) return "O nome pode ter até 80 caracteres.";
  return null;
}

function tetoMensalError(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null; // empty = sem teto, valid
  const value = Number(trimmed.replace(",", "."));
  if (!Number.isFinite(value) || value < 0) {
    return "Informe um valor válido (ou deixe vazio para sem teto).";
  }
  return null;
}

function assumirPrazoDiasError(raw: string): string | null {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!trimmed || !Number.isInteger(value) || value < PRAZO_MIN || value > PRAZO_MAX) {
    return "Use um número inteiro de 1 a 30.";
  }
  return null;
}

export function ExpertFormDialog({
  open,
  onOpenChange,
  expert,
  initialAffiliateId,
  unassignedAffiliates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` creates a new expert. */
  expert: ExpertAdminRow | null;
  /** Prefills the affiliate-id chips when opened from "Criar expert" on a suggestion. */
  initialAffiliateId?: string | null;
  unassignedAffiliates: UnassignedAffiliate[];
}) {
  const qc = useQueryClient();
  const saveFn = useServerFn(saveExpert);

  const [nome, setNome] = useState("");
  const [tipo, setTipo] = useState<ExpertTipo>("restrito");
  const [affiliateIds, setAffiliateIds] = useState<string[]>([]);
  const [affiliateInput, setAffiliateInput] = useState("");
  const [affiliateHint, setAffiliateHint] = useState<string | null>(null);
  const [envioModo, setEnvioModo] = useState<ExpertEnvioModo>("livre");
  const [tetoMensal, setTetoMensal] = useState("");
  const [assumirPrazoDias, setAssumirPrazoDias] = useState("3");

  useEffect(() => {
    if (!open) return;
    setNome(expert?.nome ?? "");
    setTipo(expert?.tipo ?? "restrito");
    setAffiliateIds(expert?.affiliateIds ?? (initialAffiliateId ? [initialAffiliateId] : []));
    setAffiliateInput("");
    setAffiliateHint(null);
    setEnvioModo(expert?.envioModo ?? "livre");
    setTetoMensal(expert?.tetoMensal != null ? String(expert.tetoMensal) : "");
    setAssumirPrazoDias(String(expert?.assumirPrazoDias ?? 3));
  }, [open, expert, initialAffiliateId]);

  const nomeHint = nomeError(nome);
  const tetoHint = tetoMensalError(tetoMensal);
  const prazoHint = assumirPrazoDiasError(assumirPrazoDias);
  const canSave =
    !!nome.trim() &&
    !nomeHint &&
    !tetoHint &&
    !prazoHint &&
    affiliateIds.length <= AFFILIATE_IDS_MAX_COUNT;

  const save = useMutation({
    mutationFn: () => {
      const teto = tetoMensal.trim() ? Number(tetoMensal.trim().replace(",", ".")) : null;
      const prazo = Number(assumirPrazoDias.trim());
      return saveFn({
        data: {
          id: expert?.id,
          nome: nome.trim(),
          tipo,
          affiliateIds,
          envioModo,
          tetoMensal: teto,
          assumirPrazoDias: prazo,
        },
      });
    },
    onSuccess: () => {
      toast.success(expert ? "Expert atualizado" : "Expert cadastrado");
      qc.invalidateQueries({ queryKey: EXPERTS_QUERY_KEY });
      qc.invalidateQueries({ queryKey: UNASSIGNED_AFFILIATES_QUERY_KEY });
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function addAffiliateId(id: string) {
    const value = id.trim().slice(0, AFFILIATE_ID_MAX_LENGTH);
    if (!value) return;
    if (affiliateIds.includes(value)) {
      setAffiliateHint("Esse ID já foi adicionado.");
      return;
    }
    if (affiliateIds.length >= AFFILIATE_IDS_MAX_COUNT) {
      setAffiliateHint("Máximo de 20 IDs de afiliado.");
      return;
    }
    setAffiliateIds((prev) => [...prev, value]);
    setAffiliateInput("");
    setAffiliateHint(null);
  }

  function removeAffiliateId(id: string) {
    setAffiliateIds((prev) => prev.filter((existing) => existing !== id));
  }

  const suggestions = unassignedAffiliates.filter(
    (candidate) =>
      !affiliateIds.includes(candidate.affiliateId) &&
      candidate.affiliateId.toLowerCase().includes(affiliateInput.trim().toLowerCase()),
  );

  const tipoHelp =
    tipo === "restrito"
      ? "Restrito: vê só os leads que chegaram pelos IDs de afiliado dele."
      : "Acesso total: vê todos os leads da casa.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{expert ? "Editar expert" : "Novo expert"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="ex: Queiroz"
              maxLength={NOME_MAX_LENGTH}
            />
            {nomeHint && <p className="text-xs text-destructive">{nomeHint}</p>}
          </div>

          <div className="space-y-2">
            <Label>Tipo</Label>
            <Select value={tipo} onValueChange={(value) => setTipo(value as ExpertTipo)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="restrito">Restrito</SelectItem>
                <SelectItem value="total">Acesso total</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{tipoHelp}</p>
          </div>

          <div className="space-y-2">
            <Label>IDs de afiliado</Label>
            <div className="flex flex-wrap gap-1.5">
              {affiliateIds.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 font-mono text-xs"
                >
                  {id}
                  <button
                    type="button"
                    aria-label={`Remover ID ${id}`}
                    onClick={() => removeAffiliateId(id)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <Input
              value={affiliateInput}
              onChange={(e) => {
                setAffiliateInput(e.target.value.slice(0, AFFILIATE_ID_MAX_LENGTH));
                setAffiliateHint(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addAffiliateId(affiliateInput);
                }
              }}
              placeholder="digite o ID e pressione Enter"
              maxLength={AFFILIATE_ID_MAX_LENGTH}
              disabled={affiliateIds.length >= AFFILIATE_IDS_MAX_COUNT}
            />
            {affiliateHint ? (
              <p className="text-xs text-destructive">{affiliateHint}</p>
            ) : (
              affiliateIds.length >= AFFILIATE_IDS_MAX_COUNT && (
                <p className="text-xs text-muted-foreground">Máximo de 20 IDs de afiliado.</p>
              )
            )}
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {suggestions.slice(0, 8).map((s) => (
                  <button
                    key={s.affiliateId}
                    type="button"
                    onClick={() => addAffiliateId(s.affiliateId)}
                    className="rounded-md border border-dashed border-border/60 px-2 py-1 font-mono text-xs text-muted-foreground hover:border-border hover:text-foreground"
                  >
                    {s.affiliateId} · {s.leads} leads
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Envio de campanhas</Label>
              <Select
                value={envioModo}
                onValueChange={(value) => setEnvioModo(value as ExpertEnvioModo)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="livre">Livre</SelectItem>
                  <SelectItem value="aprovacao">Com aprovação</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Teto mensal (R$)</Label>
              <Input
                inputMode="decimal"
                value={tetoMensal}
                onChange={(e) => setTetoMensal(e.target.value)}
                placeholder="vazio = sem teto"
              />
              {tetoHint && <p className="text-xs text-destructive">{tetoHint}</p>}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Vale para as campanhas e fluxos do expert.
          </p>

          <div className="space-y-2">
            <Label>Prazo para assumir lead (dias)</Label>
            <Input
              type="number"
              min={PRAZO_MIN}
              max={PRAZO_MAX}
              value={assumirPrazoDias}
              onChange={(e) => setAssumirPrazoDias(e.target.value)}
            />
            {prazoHint && <p className="text-xs text-destructive">{prazoHint}</p>}
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
