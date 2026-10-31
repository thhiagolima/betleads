import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { useRef, useState, type Ref } from "react";

import { DemoDisabledTooltip } from "@/components/demo-disabled-tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { connectKeyCopy, replaceCreatedNewWarning, type ConnectKeyMode } from "./meta-copy";
import { MetaSetupGuide } from "./setup-guide";

const MIN_TOKEN_LENGTH = 40;

/** O servidor criou uma conexão nova em vez de trocar a chave da existente. */
function createdNewConnection(result: unknown) {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { created?: unknown }).created === true
  );
}

/** Guia + campo da chave. Usado no painel lateral e, sem conexão, direto na tela. */
export function ConnectKeyForm({
  locked,
  isDemo,
  pending,
  onConnect,
  inputRef,
  showGuide = true,
}: {
  locked: boolean;
  isDemo: boolean;
  pending: boolean;
  onConnect: (token: string) => Promise<unknown>;
  inputRef?: Ref<HTMLInputElement>;
  showGuide?: boolean;
}) {
  const [token, setToken] = useState("");
  return (
    <div className="space-y-4">
      {showGuide && <MetaSetupGuide />}
      <form
        className="space-y-2"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await onConnect(token.trim());
            setToken("");
          } catch {
            // A mutation mostra o erro; a chave fica no campo para tentar de novo.
          }
        }}
      >
        <Label htmlFor="meta-system-token">Chave de acesso do Usuário do Sistema</Label>
        <Input
          id="meta-system-token"
          ref={inputRef}
          type="password"
          autoComplete="off"
          placeholder="EAAG..."
          value={token}
          disabled={locked}
          onChange={(event) => setToken(event.target.value)}
        />
        <p className="text-meta text-muted-foreground">
          A chave fica guardada de forma criptografada e não volta a aparecer.
        </p>
        <DemoDisabledTooltip active={isDemo}>
          <Button
            type="submit"
            className="w-full gap-2 sm:w-auto"
            disabled={locked || pending || token.trim().length < MIN_TOKEN_LENGTH}
          >
            {pending ? (
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck aria-hidden className="h-4 w-4" />
            )}
            Validar acesso e buscar contas
          </Button>
        </DemoDisabledTooltip>
      </form>
    </div>
  );
}

/** Painel lateral: as conexões continuam visíveis atrás dele (MB3-01, UX-07). */
export function ConnectKeySheet({
  mode,
  onOpenChange,
  locked,
  isDemo,
  pending,
  onConnect,
}: {
  mode: ConnectKeyMode | null;
  onOpenChange: (open: boolean) => void;
  locked: boolean;
  isDemo: boolean;
  pending: boolean;
  onConnect: (token: string) => Promise<unknown>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const copy = mode ? connectKeyCopy(mode) : null;
  // "Trocar chave" com chave de outro Usuário do Sistema/app: o painel fica aberto
  // e explica que a chave antiga continua (não é um sucesso silencioso).
  const [createdWarning, setCreatedWarning] = useState(false);
  const [warningFor, setWarningFor] = useState(mode);
  if (warningFor !== mode) {
    setWarningFor(mode);
    setCreatedWarning(false);
  }
  return (
    <Sheet open={mode !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-md"
        onOpenAutoFocus={(event) => {
          // Foco direto no campo da chave (MB3-10).
          if (!inputRef.current) return;
          event.preventDefault();
          inputRef.current.focus();
        }}
      >
        {copy && (
          <>
            <SheetHeader className="pr-6">
              <SheetTitle>{copy.title}</SheetTitle>
              <SheetDescription>{copy.description}</SheetDescription>
            </SheetHeader>
            <div className="mt-5 space-y-4">
              {createdWarning && <ReplaceCreatedNewNotice />}
              <ConnectKeyForm
                locked={locked}
                isDemo={isDemo}
                pending={pending}
                inputRef={inputRef}
                showGuide={mode?.kind === "add"}
                onConnect={async (token) => {
                  const result = await onConnect(token);
                  if (mode?.kind === "replace" && createdNewConnection(result)) {
                    setCreatedWarning(true);
                    return;
                  }
                  onOpenChange(false);
                }}
              />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function ReplaceCreatedNewNotice() {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-meta text-warning"
    >
      <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {replaceCreatedNewWarning}
    </p>
  );
}
