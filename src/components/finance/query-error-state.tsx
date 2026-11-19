import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Error state for a failed query: what failed in plain words plus "Tentar
 * novamente". Replaces the old `isLoading || !data` skeleton that spun forever
 * when the request failed.
 */
export function QueryErrorState({
  title,
  onRetry,
  retrying = false,
  className,
}: {
  /** "Não foi possível carregar …" */
  title: string;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-border/40 px-4 py-8 text-center",
        className,
      )}
    >
      <p className="text-sm font-medium">{title}</p>
      <p className="text-meta text-muted-foreground">Confira a internet e tente de novo.</p>
      <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
        <RefreshCw className={cn("mr-2 size-4", retrying && "animate-spin")} aria-hidden="true" />
        Tentar novamente
      </Button>
    </div>
  );
}
