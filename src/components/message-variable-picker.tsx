import { Badge } from "@/components/ui/badge";
import { SCRIPT_VARIABLES } from "@/components/ligacoes/shared";
import type { RefObject } from "react";

interface Props {
  /** Insere o token na posição do cursor do textarea referenciado. */
  textareaRef?: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  /** Valor atual do campo (necessário com textareaRef + onChange). */
  value?: string;
  /** Atualiza o valor do campo após inserir. */
  onChange?: (next: string) => void;
  /** Modo callback puro — recebe o token (`{primeiro_nome}`). */
  onInsert?: (token: string) => void;
  className?: string;
  label?: string;
}

export function MessageVariablePicker({
  textareaRef,
  value,
  onChange,
  onInsert,
  className,
  label = "Variáveis disponíveis — clique para inserir",
}: Props) {
  function insert(key: string) {
    const token = `{${key}}`;
    if (onInsert) {
      onInsert(token);
      return;
    }
    const el = textareaRef?.current;
    if (el && onChange && typeof value === "string") {
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? value.length;
      const next = value.slice(0, start) + token + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
      return;
    }
    if (onChange && typeof value === "string") {
      onChange(value + token);
    }
  }

  return (
    <div className={`rounded-md border border-border/60 bg-muted/30 p-2 ${className ?? ""}`}>
      <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1">
        {SCRIPT_VARIABLES.map((v) => (
          <Badge
            key={v.key}
            variant="outline"
            className="cursor-pointer font-mono text-[10px] hover:bg-primary hover:text-primary-foreground"
            onClick={() => insert(v.key)}
            title={v.label}
          >
            {`{${v.key}}`}
          </Badge>
        ))}
      </div>
    </div>
  );
}