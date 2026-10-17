import { MutationCache, QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { createClientOnlyFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { routeTree } from "./routeTree.gen";
import { demoBlockedErrorText, isDemoBlockedError } from "./lib/demo-tenant";
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
    // Central place for the demo-tenant blocked-action toast: individual
    // mutations keep their own `onError` (unchanged, many call sites), this
    // just adds the demo copy on top whenever a mutation fails because the
    // server guard blocked it (Tasks 3-8), without touching every call site.
    mutationCache: new MutationCache({
      onError: (error) => {
        if (isDemoBlockedError(error)) toast.error(demoBlockedErrorText(error));
      },
    }),
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
