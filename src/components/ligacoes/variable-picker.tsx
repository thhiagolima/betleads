import { Badge } from "@/components/ui/badge";
import { SCRIPT_VARIABLES } from "./shared";

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
          <Badge
            key={v.key}
            variant="secondary"
            className="cursor-pointer font-mono text-[11px] hover:bg-primary hover:text-primary-foreground"
            onClick={() => onInsert(`{${v.key}}`)}
            title={v.label}
          >
            {`{${v.key}}`}
          </Badge>
        ))}
      </div>
    </div>
  );
}