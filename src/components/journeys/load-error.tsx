import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A list or panel that failed to load: says so (instead of looking empty) and
 * offers "Tentar novamente".
 */
export function LoadError({
  title,
  message,
  onRetry,
  retrying = false,
  className,
}: {
  title: string;
  message?: string;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-8 text-center",
        className,
      )}
    >
      <p className="text-body font-medium text-danger">{title}</p>
      {message && <p className="max-w-lg text-meta text-muted-foreground">{message}</p>}
      <Button variant="outline" onClick={onRetry} disabled={retrying}>
        <RefreshCw className={cn("mr-2 size-4", retrying && "animate-spin")} aria-hidden="true" />
        {retrying ? "Carregando…" : "Tentar novamente"}
      </Button>
    </div>
  );
}
