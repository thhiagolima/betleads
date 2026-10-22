import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { canSubmitReason } from "./billing-admin-ui";

/**
 * Shared shell for every super admin billing action (brief step 1: "o diálogo não envia com
 * motivo vazio"). Each action supplies its own extra fields via `children` (a render prop that
 * also receives whether the dialog's own extra-fields validity gate is open) and its own submit
 * handler. The reason textarea and the disabled-submit-until-valid rule live here once, so every
 * one of the 11 action buttons in `tenant-actions.tsx` gets it for free.
 */
export function ReasonActionDialog({
  triggerLabel,
  title,
  description,
  disabledTrigger,
  triggerVariant = "outline",
  extraFieldsValid = true,
  onSubmit,
  pending,
  submitLabel = "Confirmar",
  children,
}: {
  triggerLabel: string;
  title: string;
  description?: string;
  disabledTrigger?: boolean;
  triggerVariant?: "default" | "outline" | "destructive" | "ghost" | "secondary";
  /** Whether the action's own extra fields (days, value, date...) are currently valid. */
  extraFieldsValid?: boolean;
  onSubmit: (reason: string) => Promise<void> | void;
  pending?: boolean;
  submitLabel?: string;
  /** The action's own extra fields, rendered above the reason textarea. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const canSubmit = canSubmitReason(reason) && extraFieldsValid && !pending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReason("");
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant={triggerVariant} disabled={disabledTrigger}>
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-3">
          {children}
          <div className="space-y-2">
            <Label htmlFor={`reason-${title}`}>Motivo (obrigatório, mín. 5 caracteres)</Label>
            <Textarea
              id={`reason-${title}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explique o motivo desta ação"
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={async () => {
              await onSubmit(reason.trim());
              setOpen(false);
              setReason("");
            }}
          >
            {pending ? "Enviando…" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
