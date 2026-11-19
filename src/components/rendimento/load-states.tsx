// Shared "failed to load" and "no active house" blocks of the expert and
// rendimento screens: the message plus "Tentar novamente", so a failed query
// never looks like an empty list.
import { Button } from "@/components/ui/button";

export const NO_ACTIVE_TENANT_MESSAGE =
  "Escolha uma casa no seletor do topo da tela para ver os dados.";

export function LoadError({
  message = "Não foi possível carregar os dados.",
  onRetry,
  className = "py-6",
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={`flex flex-col items-center gap-2 text-center ${className}`}>
      <p className="text-body text-destructive">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Tentar novamente
        </Button>
      )}
    </div>
  );
}
