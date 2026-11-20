// Shared step of the "Claude e API" screens (/mcp and /api-dados): a numbered
// step that turns into a ✓ when done. Helpers in ./copiar.ts.
import { Check } from "lucide-react";

export function Passo({
  numero,
  titulo,
  feito,
  children,
}: {
  numero: number;
  titulo: string;
  feito: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-sm font-medium ${
          feito ? "border-primary bg-primary text-primary-foreground" : "bg-muted/30"
        }`}
      >
        {feito ? <Check className="h-4 w-4" /> : numero}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5 text-sm">
        <div className="font-medium">
          {titulo}
          {feito ? <span className="ml-2 text-meta text-primary">feito</span> : null}
        </div>
        <div className="space-y-1.5 text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}
