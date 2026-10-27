import { createContext, useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { changeInitialPassword } from "@/lib/auth.functions";
import type { Session } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { LogOut } from "lucide-react";

type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "error"; message: string }
  | { status: "authed"; session: Session };

const AuthSessionContext = createContext<Session | null>(null);

function isInvalidRefreshToken(error: unknown) {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("refresh token") || message.includes("refresh_token");
}

export function useAuthSession() {
  return useContext(AuthSessionContext);
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const queryClient = useQueryClient();
  const cachedSessionKey = useRef<string | null>(null);

  useEffect(() => {
    let mounted = true;

    // Timeout de segurança: se o backend não responder em 6s,
    // cai para a tela de login em vez de ficar preso em "Carregando…".
    const timeoutId = setTimeout(() => {
      if (!mounted) return;
      setState((prev) => (prev.status === "loading" ? { status: "signed-out" } : prev));
    }, 6000);

    // Hidrata o estado inicial a partir do storage para evitar
    // a corrida onde o INITIAL_SESSION chega antes da sessão ser restaurada.
    supabase.auth
      .getSession()
      .then(async ({ data, error }) => {
        if (!mounted) return;
        clearTimeout(timeoutId);
        if (error) {
          // Um refresh token revogado permanece no localStorage e faz toda nova
          // inicialização repetir o 400. Limpar apenas a sessão local permite
          // autenticar novamente sem depender de uma chamada ao token inválido.
          if (isInvalidRefreshToken(error)) {
            await supabase.auth.signOut({ scope: "local" }).catch(() => {});
          }
          if (!mounted) return;
          cachedSessionKey.current = null;
          queryClient.clear();
          setState({ status: "signed-out" });
          return;
        }
        if (data.session) {
          cachedSessionKey.current = `${data.session.user.id}:${data.session.access_token}`;
          setState({ status: "authed", session: data.session });
        } else setState({ status: "signed-out" });
      })
      .catch(() => {
        if (!mounted) return;
        clearTimeout(timeoutId);
        setState({ status: "signed-out" });
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      const nextSessionKey = session ? `${session.user.id}:${session.access_token}` : null;
      if (cachedSessionKey.current !== null && cachedSessionKey.current !== nextSessionKey) {
        queryClient.clear();
      }
      cachedSessionKey.current = nextSessionKey;
      if (session) setState({ status: "authed", session });
      else setState({ status: "signed-out" });
    });

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
      subscription.unsubscribe();
    };
  }, [queryClient]);

  if (state.status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Carregando…</div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-sm border-border/60 bg-card/80 backdrop-blur">
          <CardHeader>
            <CardTitle className="text-lg">Não foi possível entrar</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{state.message}</p>
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                className="gap-2"
                onClick={async () => {
                  await supabase.auth.signOut().catch(() => {});
                  setState({ status: "signed-out" });
                }}
              >
                <LogOut className="h-4 w-4" /> Sair e entrar de novo
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state.status === "signed-out") {
    return (
      <AuthScreen
        onAuthenticated={(session) => {
          cachedSessionKey.current = `${session.user.id}:${session.access_token}`;
          queryClient.clear();
          setState({ status: "authed", session });
        }}
      />
    );
  }

  // Demo users (Task 13, spec §11) never change their own e-mail/password —
  // the login is revoked/reissued by scripts/demo/create-demo-login.mjs
  // instead. force_password_change is never set for them, but this guard
  // keeps the screen hidden even if that ever changed.
  if (
    state.session.user.app_metadata.force_password_change === true &&
    state.session.user.app_metadata.is_demo_user !== true
  ) {
    return (
      <InitialPasswordScreen
        session={state.session}
        onPasswordChanged={(session) => {
          cachedSessionKey.current = `${session.user.id}:${session.access_token}`;
          queryClient.clear();
          setState({ status: "authed", session });
        }}
      />
    );
  }

  return (
    <AuthSessionContext.Provider value={state.session}>{children}</AuthSessionContext.Provider>
  );
}

function InitialPasswordScreen({
  session,
  onPasswordChanged,
}: {
  session: Session;
  onPasswordChanged: (session: Session) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const changePassword = useServerFn(changeInitialPassword);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirmation) {
      toast.error("As senhas não coincidem.");
      return;
    }

    setLoading(true);
    try {
      await changePassword({ data: { password } });
      // A troca de senha pela chave administrativa revoga todas as sessões do
      // usuário, então o refresh token atual deixa de existir. Entrar de novo
      // com a senha recém-criada gera uma sessão nova com o app_metadata atualizado.
      const email = session.user.email;
      if (!email) {
        await supabase.auth.signOut({ scope: "local" }).catch(() => {});
        throw new Error("Senha criada. Entre novamente com a nova senha.");
      }
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data.session) throw new Error("Não foi possível atualizar sua sessão.");
      onPasswordChanged(data.session);
      toast.success("Senha criada com sucesso.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Não foi possível atualizar a senha.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Crie sua nova senha</CardTitle>
          <p className="text-sm text-muted-foreground">
            Por segurança, defina uma senha pessoal antes de acessar o sistema.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-password">Nova senha</Label>
              <Input
                id="new-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                autoComplete="new-password"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-new-password">Confirme a nova senha</Label>
              <Input
                id="confirm-new-password"
                type="password"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                minLength={8}
                autoComplete="new-password"
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading || password.length < 8}>
              {loading ? "Salvando…" : "Salvar nova senha"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => supabase.auth.signOut()}
            >
              <LogOut className="mr-2 h-4 w-4" /> Sair
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

/** Supabase answers in English; the operator reads Portuguese. */
export function loginErrorMessage(err: unknown) {
  const raw = err instanceof Error ? err.message : "";
  const msg = raw.toLowerCase();
  if (msg.includes("invalid login credentials")) return "E-mail ou senha incorretos.";
  if (msg.includes("email not confirmed")) return "Este e-mail ainda não foi confirmado.";
  if (msg.includes("banned") || msg.includes("user is banned"))
    return "Este acesso foi desativado.";
  if (msg.includes("rate limit") || msg.includes("too many"))
    return "Muitas tentativas. Aguarde alguns minutos e tente de novo.";
  if (msg.includes("failed to fetch") || msg.includes("network"))
    return "Sem conexão com o servidor. Confira a internet e tente de novo.";
  return raw || "Não foi possível entrar. Tente de novo.";
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (session: Session) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data.session) throw new Error("A autenticação não retornou uma sessão válida.");
      onAuthenticated(data.session);
    } catch (err: unknown) {
      setError(loginErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <main className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2.5" aria-label="BETLEADS">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-base font-bold text-primary-foreground">
            B
          </span>
          <span>
            <span className="block text-section font-semibold leading-none">BETLEADS</span>
            <span className="mt-1 block text-[10px] uppercase leading-none tracking-[0.15em] text-muted-foreground">
              Player Intelligence
            </span>
          </span>
        </div>
        <section className="rounded-2xl border border-border bg-card/80 p-6">
          <h1 className="text-title">Entrar</h1>
          <p className="mt-1 text-body text-muted-foreground">
            Use o e-mail e a senha da sua casa.
          </p>
          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">E-mail</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="h-11"
                aria-invalid={error ? true : undefined}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Senha</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="current-password"
                className="h-11"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "login-error" : undefined}
              />
            </div>
            {error && (
              <p id="login-error" role="alert" className="text-label text-danger">
                {error}
              </p>
            )}
            <Button type="submit" disabled={loading} className="h-11 w-full">
              {loading ? "Entrando…" : "Entrar"}
            </Button>
          </form>
        </section>
      </main>
    </div>
  );
}
