import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useLocation,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";

import appCss from "../styles.css?url";
import { AppLayout } from "@/components/app-layout";
import { Toaster } from "@/components/ui/sonner";
import { AuthGate } from "@/components/auth-gate";
import { OnboardingGate } from "@/components/onboarding/onboarding-gate";
import { SystemDialogHost } from "@/components/system-dialog-host";
import { createClientOnlyFn } from "@tanstack/react-start";
import { captureClientException } from "@/lib/observability/sentry.client";
import { SIDEBAR_BOOT_SCRIPT } from "@/components/shell/sidebar-collapse";

// Compiled away on the server (import protection forbids *.client.ts there).
const reportBoundaryError = createClientOnlyFn(
  (error: unknown, componentStack: string | undefined) =>
    captureClientException(error, {
      tags: { boundary: "root_error_component" },
      componentStack,
    }),
);

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Página não encontrada</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          A página que você procura não existe ou mudou de endereço.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Voltar ao início
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({
  error,
  reset,
  info,
}: {
  error: unknown;
  reset: () => void;
  info?: { componentStack: string };
}) {
  console.error(error);
  const router = useRouter();

  // Effects only run in the browser; SSR errors are reported by the server.
  useEffect(() => {
    reportBoundaryError(error, info?.componentStack);
  }, [error, info]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Esta página não carregou
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Algo deu errado do nosso lado. Tente novamente ou volte ao início.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Tentar novamente
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Voltar ao início
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "BETLEADS — Inteligência de Players" },
      {
        name: "description",
        content: "Painel premium de inteligência de players para casas de apostas.",
      },
      { name: "author", content: "BETLEADS" },
      { property: "og:title", content: "BETLEADS — Inteligência de Players" },
      {
        property: "og:description",
        content: "Painel premium de inteligência de players para casas de apostas.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "BETLEADS — Inteligência de Players" },
      {
        name: "twitter:description",
        content: "Painel premium de inteligência de players para casas de apostas.",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className="dark" suppressHydrationWarning>
      <head>
        {/* Applies the saved sidebar width before the first paint. */}
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="bg-background text-foreground antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const pathname = useLocation({ select: (l) => l.pathname });
  // Rotas públicas (sem auth, sem layout do app): página de descadastro.
  const isPublic = pathname.startsWith("/u/");

  if (isPublic) {
    return (
      <QueryClientProvider client={queryClient}>
        <Outlet />
        <Toaster />
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <AppLayout>
          <OnboardingGate>
            <Outlet />
          </OnboardingGate>
        </AppLayout>
      </AuthGate>
      <SystemDialogHost />
      <Toaster />
    </QueryClientProvider>
  );
}
