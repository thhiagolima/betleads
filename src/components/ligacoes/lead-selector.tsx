import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, ChevronsUpDown, User, Sparkles } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { listPlayersForCalls } from "@/lib/calls.functions";
import { cn } from "@/lib/utils";

export interface SelectedLead {
  id: string | null;
  nome: string;
  telefone?: string | null;
  fake?: boolean;
}

interface Props {
  value: SelectedLead | null;
  onChange: (l: SelectedLead | null) => void;
}

export function LeadSelector({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const listFn = useServerFn(listPlayersForCalls);
  const { data, isLoading } = useQuery({
    queryKey: ["players-for-calls", search],
    queryFn: () => listFn({ data: { search, limit: 20 } }),
    enabled: open && !value?.fake,
  });

  const useFake = value?.fake === true;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <Label htmlFor="fake-lead" className="cursor-pointer text-sm">
            Usar lead de teste (Pedro Silva)
          </Label>
        </div>
        <Switch
          id="fake-lead"
          checked={useFake}
          onCheckedChange={(c) =>
            onChange(
              c
                ? { id: null, nome: "Pedro Silva (teste)", telefone: "+5511999990000", fake: true }
                : null,
            )
          }
        />
      </div>

      {!useFake && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              className="w-full justify-between"
            >
              <span className="flex items-center gap-2 truncate">
                <User className="h-4 w-4" />
                {value && !value.fake
                  ? `${value.nome}${value.telefone ? ` — ${value.telefone}` : ""}`
                  : "Selecionar lead real..."}
              </span>
              <ChevronsUpDown className="h-4 w-4 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[380px] p-0" align="start">
            <div className="border-b border-border p-2">
              <Input
                placeholder="Buscar por nome ou telefone..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="max-h-72 overflow-y-auto">
              {isLoading && (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">Buscando...</p>
              )}
              {!isLoading && (data?.players ?? []).length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                  Nenhum lead encontrado
                </p>
              )}
              {(data?.players ?? []).map((p: any) => {
                const selected = value?.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      onChange({ id: p.id, nome: p.nome, telefone: p.telefone });
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted",
                      selected && "bg-muted",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">{p.nome}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {p.telefone ?? "sem telefone"} ·{" "}
                        {p.vip ? "VIP" : (p.status ?? "ativo")}
                      </p>
                    </div>
                    {selected && <Check className="h-4 w-4 text-primary" />}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}