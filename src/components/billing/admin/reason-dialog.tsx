import { useId, useState, type ReactNode } from "react";
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
 * motivo vazio"). Each action supplies its own extra fields via `children` and its own submit
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
  onOpenChange,
  pending,
  submitLabel = "Confirmar",
  cancelLabel = "Cancelar",
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
  /**
   * Fires on every open/close transition, before this shell's own reason reset. Lets an action
   * reset its own extra fields on close (fix round 1, m5) or re-sync them from props on open
   * (m6) without this shell knowing what those fields are.
   */
  onOpenChange?: (open: boolean) => void;
  pending?: boolean;
  submitLabel?: string;
  /** The dismiss button's label — "Voltar" for the cancel-invoice dialog (m8), since "Cancelar"
   * there would read as cancelling the *invoice* rather than dismissing the dialog. */
  cancelLabel?: string;
  /** The action's own extra fields, rendered above the reason textarea. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  // m7: a static `id` built from `title` collides across rows (e.g. every "Bloquear casa"
  // dialog in the house list would share one DOM id) — useId() is unique per mounted instance.
  const reasonId = useId();

  const canSubmit = canSubmitReason(reason) && extraFieldsValid && !pending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setReason("");
          setSubmitError(null);
        }
        onOpenChange?.(next);
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
            <Label htmlFor={reasonId}>Motivo (obrigatório, mín. 5 caracteres)</Label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explique o motivo desta ação"
              rows={2}
            />
          </div>
          {submitError && <p className="text-sm text-destructive">{submitError}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={async () => {
              // m1: `onSubmit` can reject (the mutation's own `onError` already toasts it) —
              // catch it here so the dialog stays open for a retry instead of closing on a
              // throw, and so the click handler never leaves an unhandled rejection behind.
              try {
                setSubmitError(null);
                await onSubmit(reason.trim());
                setOpen(false);
                setReason("");
              } catch (err) {
                setSubmitError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            {pending ? "Enviando…" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
