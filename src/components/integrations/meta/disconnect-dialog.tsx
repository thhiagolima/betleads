import { Loader2 } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DisconnectImpact } from "@/components/integrations/meta-connection-model";
import { canConfirmDisconnect, disconnectImpactLines } from "./meta-copy";

/** Corpo do diálogo, separado para o teste de markup estático (o diálogo usa portal). */
export function DisconnectImpactBody({
  impact,
  connectionTitle,
  confirmText,
  onConfirmTextChange,
}: {
  impact: DisconnectImpact;
  connectionTitle: string;
  confirmText: string;
  onConfirmTextChange: (value: string) => void;
}) {
  return (
    <div className="space-y-3 text-sm">
      <ul className="space-y-1 text-muted-foreground">
        {disconnectImpactLines(impact).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {impact.requiresTypedConfirmation && (
        <div className="space-y-2">
          <Label htmlFor="meta-disconnect-confirm">
            Para confirmar, digite o nome da chave: <strong>{connectionTitle}</strong>
          </Label>
          <Input
            id="meta-disconnect-confirm"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={confirmText}
            onChange={(event) => onConfirmTextChange(event.target.value)}
          />
        </div>
      )}
    </div>
  );
}

export function DisconnectDialog({
  target,
  pending,
  onClose,
  onConfirm,
}: {
  target: { connectionId: string; title: string; impact: DisconnectImpact } | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: (connectionId: string) => Promise<unknown>;
}) {
  const [confirmText, setConfirmText] = useState("");
  // Outra chave no diálogo: o que foi digitado para a anterior não vale.
  const targetId = target?.connectionId ?? null;
  const [typedFor, setTypedFor] = useState(targetId);
  if (typedFor !== targetId) {
    setTypedFor(targetId);
    setConfirmText("");
  }
  const enabled = target ? canConfirmDisconnect(target.impact, target.title, confirmText) : false;
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (open || pending) return;
        setConfirmText("");
        onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Desconectar a chave “{target?.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            A chave de acesso guardada será removida desta casa.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {target && (
          <DisconnectImpactBody
            impact={target.impact}
            connectionTitle={target.title}
            confirmText={confirmText}
            onConfirmTextChange={setConfirmText}
          />
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || !enabled}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={async (event) => {
              event.preventDefault();
              if (!target || !enabled) return;
              try {
                await onConfirm(target.connectionId);
                setConfirmText("");
                onClose();
              } catch {
                // O diálogo fica aberto e a mutation informa o erro.
              }
            }}
          >
            {pending && <Loader2 aria-hidden className="mr-2 h-4 w-4 animate-spin" />}
            Desconectar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
