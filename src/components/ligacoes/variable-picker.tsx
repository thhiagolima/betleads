import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { variablesForChannel } from "@/lib/message-variables";

const SCRIPT_VARIABLES = variablesForChannel("voice");

interface Props {
  onInsert: (token: string) => void;
}

export function VariablePicker({ onInsert }: Props) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        Variáveis disponíveis — clique para inserir
      </p>
      <div className="flex flex-wrap gap-1.5">
        {SCRIPT_VARIABLES.map((v) => (
          <button
            key={v.key}
            type="button"
            className={cn(
              badgeVariants({ variant: "secondary" }),
              "h-8 cursor-pointer font-mono text-meta hover:bg-primary hover:text-primary-foreground",
            )}
            onClick={() => onInsert(`{${v.key}}`)}
            title={v.label}
          >
            {`{${v.key}}`}
          </button>
        ))}
      </div>
    </div>
  );
}
