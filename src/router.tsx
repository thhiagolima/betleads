import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { createClientOnlyFn } from "@tanstack/react-start";
import { routeTree } from "./routeTree.gen";
import { initClientSentry } from "./lib/observability/sentry.client";

// Compiled away on the server (import protection forbids *.client.ts there).
const initSentryInBrowser = createClientOnlyFn((router: unknown) => initClientSentry(router));

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
    // No MutationCache-level demo-blocked toast (R13): DemoTenantBlockedError's
    // message is now the clean user copy itself, so each mutation's existing
    // `onError: (e) => toast.error(e.message)` already shows it exactly once.
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  // Browser-only; no-op on the server and when VITE_SENTRY_DSN is empty.
  if (typeof window !== "undefined") initSentryInBrowser(router);

  return router;
};
