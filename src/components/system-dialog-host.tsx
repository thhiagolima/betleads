import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type ConfirmOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type PromptOptions = {
  title: string;
  description: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  inputType?: "text" | "email";
};

type ConfirmRequest = {
  kind: "confirm";
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
};

type PromptRequest = {
  kind: "prompt";
  options: PromptOptions;
  resolve: (value: string | null) => void;
};

type SystemDialogRequest = ConfirmRequest | PromptRequest;

const queue: SystemDialogRequest[] = [];
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

function enqueue(request: SystemDialogRequest) {
  queue.push(request);
  notify();
}

export function requestConfirmation(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => enqueue({ kind: "confirm", options, resolve }));
}

export function requestTextInput(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => enqueue({ kind: "prompt", options, resolve }));
}

function finish(request: SystemDialogRequest, value: boolean | string | null) {
  if (queue[0] !== request) return;
  queue.shift();
  if (request.kind === "confirm") request.resolve(Boolean(value));
  else request.resolve(typeof value === "string" ? value : null);
  notify();
}

export function SystemDialogHost() {
  const [, render] = useState(0);
  const current = queue[0];
  const [input, setInput] = useState("");

  useEffect(() => {
    const listener = () => render((version) => version + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (current?.kind === "prompt") setInput(current.options.initialValue ?? "");
  }, [current]);

  if (!current) return null;

  if (current.kind === "confirm") {
    const options = current.options;
    return (
      <AlertDialog open onOpenChange={(open) => { if (!open) finish(current, false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options.title}</AlertDialogTitle>
            <AlertDialogDescription>{options.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => finish(current, false)}>
              {options.cancelLabel ?? "Cancelar"}
            </AlertDialogCancel>
            <AlertDialogAction
              className={cn(options.destructive && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
              onClick={() => finish(current, true)}
            >
              {options.confirmLabel ?? "Confirmar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  const options = current.options;
  const valid = input.trim().length > 0 && (options.inputType !== "email" || /^\S+@\S+\.\S+$/.test(input.trim()));
  return (
    <Dialog open onOpenChange={(open) => { if (!open) finish(current, null); }}>
      <DialogContent>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) finish(current, input.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>{options.title}</DialogTitle>
            <DialogDescription>{options.description}</DialogDescription>
          </DialogHeader>
          <label className="block space-y-2 text-sm font-medium">
            <span>{options.label}</span>
            <Input
              autoFocus
              type={options.inputType ?? "text"}
              value={input}
              placeholder={options.placeholder}
              onChange={(event) => setInput(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(current, null)}>Cancelar</Button>
            <Button type="submit" disabled={!valid}>{options.confirmLabel ?? "Continuar"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
