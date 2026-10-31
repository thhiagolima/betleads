import { KeyRound, Loader2, MoreHorizontal, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { ConnectionCard as ConnectionCardModel } from "@/components/integrations/meta-connection-model";
import { cn } from "@/lib/utils";
import { ToneBadge } from "./meta-badges";
import { expiryLabel, legacyBadge } from "./meta-copy";
import { plural } from "./meta-format";

const LABEL_MAX = 60;

const HEALTH_LABEL = { ok: "ok", attention: "atenção", error: "erro" } as const;

export type ConnectionCardActions = {
  onValidate: (connectionId: string) => void;
  validatingConnectionId: string | null;
  onRename: (connectionId: string, label: string) => Promise<unknown>;
  renamePending: boolean;
  onReplaceKey: (card: ConnectionCardModel) => void;
  onDisconnect: (connectionId: string) => void;
};

/** Uma chave (conexão): o que alcança, validade, status e ações (MB3-01, MB3-07). */
export function ConnectionCard({
  card,
  readOnly,
  isDemo,
  actions,
}: {
  card: ConnectionCardModel;
  readOnly: boolean;
  isDemo: boolean;
  actions: ConnectionCardActions;
}) {
  const { connection } = card;
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(card.title);
  // "Renomear" veio do menu: o menu não devolve o foco ao gatilho, o campo recebe.
  const renameRequested = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renaming) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renaming]);
  const trimmed = label.trim();
  const labelValid = trimmed.length >= 1 && trimmed.length <= LABEL_MAX;
  const validating = actions.validatingConnectionId === connection.id;
  const locked = readOnly || isDemo;
  // "Trocar chave" só resolve problema da chave (erro ou validade), não erro de
  // sincronização de conta.
  const keyProblem = connection.status !== "connected" || card.expiry.soon;
  const legacy = connection.auth_type === "legacy_oauth";

  return (
    <article
      aria-label={`Chave ${card.title}`}
      className={cn(
        "min-w-0 rounded-xl border p-4",
        card.health === "error"
          ? "border-danger/30 bg-danger/5"
          : card.health === "attention"
            ? "border-warning/30 bg-warning/5"
            : "border-border/60 bg-background/40",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!labelValid) return;
                try {
                  await actions.onRename(connection.id, trimmed);
                  setRenaming(false);
                } catch {
                  // A mutation mostra o erro; o campo fica aberto.
                }
              }}
            >
              <Input
                ref={renameInputRef}
                aria-label="Nome da chave"
                maxLength={LABEL_MAX}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setRenaming(false);
                }}
                className="h-8 min-w-0 flex-1 sm:max-w-64"
              />
              <Button type="submit" size="sm" disabled={!labelValid || actions.renamePending}>
                {actions.renamePending && (
                  <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                )}
                Salvar
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)}>
                Cancelar
              </Button>
            </form>
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <p className="min-w-0 truncate font-semibold">Chave “{card.title}”</p>
              {legacy && (
                <Badge
                  variant="outline"
                  className="border-warning/30 bg-warning/10 text-meta font-medium text-warning"
                >
                  {legacyBadge}
                </Badge>
              )}
            </div>
          )}
          <p className="mt-1 text-meta text-muted-foreground">
            App {connection.app_name ?? connection.app_id ?? "identificado"} · chave{" "}
            {connection.token_hint ?? "protegida"}
          </p>
          <p className="mt-1 text-meta text-muted-foreground">
            Usuário do Sistema: {connection.meta_user_name ?? "não identificado"}
          </p>
          <p className="mt-1 text-meta text-muted-foreground">
            Alcança {plural(card.businesses, "BM", "BMs")} ·{" "}
            {plural(card.accounts, "conta", "contas")}
            {card.selectedAccounts > 0 &&
              ` (${plural(card.selectedAccounts, "marcada", "marcadas")})`}
          </p>
          <p
            className={cn(
              "mt-1 text-meta",
              card.expiry.soon ? "font-semibold text-warning" : "text-muted-foreground",
            )}
          >
            {expiryLabel(card.expiry)}
          </p>
        </div>
        <ToneBadge tone={card.health}>{HEALTH_LABEL[card.health]}</ToneBadge>
      </div>

      {card.healthText && (
        <div
          role="status"
          className={cn(
            "mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2 text-meta",
            card.health === "error" ? "bg-danger/10 text-danger" : "bg-warning/10 text-warning",
          )}
        >
          <span className="min-w-0">{card.healthText}</span>
          {!readOnly && keyProblem && (
            <DemoDisabledTooltip active={isDemo}>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1"
                disabled={locked}
                onClick={() => actions.onReplaceKey(card)}
              >
                <KeyRound aria-hidden className="h-3.5 w-3.5" /> Trocar chave
              </Button>
            </DemoDisabledTooltip>
          )}
        </div>
      )}
      {connection.last_error && (
        <p className="mt-2 break-words rounded-md bg-danger/10 px-3 py-2 text-meta text-danger">
          {connection.last_error}
        </p>
      )}

      {!readOnly && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <DemoDisabledTooltip active={isDemo}>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={locked || validating}
              onClick={() => actions.onValidate(connection.id)}
            >
              {validating ? (
                <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw aria-hidden className="h-3.5 w-3.5" />
              )}
              Testar acesso
            </Button>
          </DemoDisabledTooltip>
          <DemoDisabledTooltip active={isDemo}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={locked}
                  aria-label={`Mais ações da chave ${card.title}`}
                >
                  <MoreHorizontal aria-hidden className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onCloseAutoFocus={(event) => {
                  if (!renameRequested.current) return;
                  renameRequested.current = false;
                  event.preventDefault();
                  renameInputRef.current?.focus();
                }}
              >
                <DropdownMenuItem
                  onSelect={() => {
                    renameRequested.current = true;
                    setLabel(card.title);
                    setRenaming(true);
                  }}
                >
                  <Pencil aria-hidden className="h-3.5 w-3.5" /> Renomear
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => actions.onReplaceKey(card)}>
                  <KeyRound aria-hidden className="h-3.5 w-3.5" /> Trocar chave
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-danger focus:text-danger"
                  onSelect={() => actions.onDisconnect(connection.id)}
                >
                  <Trash2 aria-hidden className="h-3.5 w-3.5" /> Desconectar
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </DemoDisabledTooltip>
        </div>
      )}
    </article>
  );
}
