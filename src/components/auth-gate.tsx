import { createContext, useContext, useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Session } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { LogOut } from "lucide-react";
import betleadsLogo from "@/assets/betleads-logo-v2.png.asset.json";

type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "error"; message: string }
  | { status: "authed"; session: Session };

const AuthSessionContext = createContext<Session | null>(null);

export function useAuthSession() {
  return useContext(AuthSessionContext);
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

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
      .then(({ data, error }) => {
        if (!mounted) return;
        clearTimeout(timeoutId);
        if (error) {
          setState({ status: "signed-out" });
          return;
        }
        if (data.session) setState({ status: "authed", session: data.session });
        else setState({ status: "signed-out" });
      })
      .catch(() => {
        if (!mounted) return;
        clearTimeout(timeoutId);
        setState({ status: "signed-out" });
      });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (!mounted) return;
        if (session) setState({ status: "authed", session });
        else setState({ status: "signed-out" });
      },
    );

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
      subscription.unsubscribe();
    };
  }, []);

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
    return <AuthScreen />;
  }

  return (
    <AuthSessionContext.Provider value={state.session}>
      {children}
    </AuthSessionContext.Provider>
  );
}

function AuthScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao autenticar";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-[#05070d] p-4">
      {/* Background gradient + glow */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(30,64,175,0.12),_transparent_65%)]" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#05070d] via-[#070b18] to-[#05070d]" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 -z-0 h-[380px] w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1d6fff]/10 blur-[100px]" />

      <Card className="relative z-10 w-full max-w-md border border-white/10 bg-[#0a0f1c]/80 backdrop-blur-xl shadow-[0_0_45px_-20px_rgba(29,111,255,0.35)] py-2">
        <CardHeader className="items-center text-center pt-6 pb-1">
          <img
            src={betleadsLogo.url}
            alt="BETLEADS"
            className="mx-auto h-auto w-[220px] md:w-[280px] select-none"
            draggable={false}
          />
          <CardTitle className="mt-5 text-lg font-semibold tracking-tight">Entrar</CardTitle>
        </CardHeader>
        <CardContent className="pt-2 pb-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">E-mail</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="h-11 bg-white/[0.03] border-white/10 focus-visible:ring-[#1d6fff]/60 focus-visible:border-[#1d6fff]/60"
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
                className="h-11 bg-white/[0.03] border-white/10 focus-visible:ring-[#1d6fff]/60 focus-visible:border-[#1d6fff]/60"
              />
            </div>
            <Button
              type="submit"
              disabled={loading}
              className="w-full h-11 mt-2 bg-gradient-to-r from-[#1d6fff] to-[#00b3ff] text-white font-semibold tracking-wide shadow-[0_0_25px_-5px_rgba(29,111,255,0.7)] hover:shadow-[0_0_35px_-3px_rgba(0,179,255,0.8)] hover:from-[#2a7bff] hover:to-[#1ec0ff] transition-all duration-300 border-0"
            >
              {loading ? "Aguarde…" : "Entrar"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

