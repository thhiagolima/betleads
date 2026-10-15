// Browser Sentry setup (OBS-03).
//
// - Initialized once, only in the browser, only when VITE_SENTRY_DSN is set.
// - No session replay (LGPD): only error + tracing integrations are installed.
// - Everything leaving the browser goes through the shared PII scrubbers.

import * as Sentry from "@sentry/react";

import {
  IGNORED_ERROR_MESSAGES,
  isExpectedControlFlowError,
  RESTRICTED_DATA_COLLECTION,
  scrubEvent,
  scrubSpan,
} from "./scrub";

let initialized = false;

function parseSampleRate(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/**
 * Initializes Sentry in the browser. Safe to call multiple times and on the
 * server (no-op there). Pass the TanStack router to get route-aware tracing.
 */
export function initClientSentry(router?: unknown): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  const dsn = String(import.meta.env.VITE_SENTRY_DSN ?? "").trim();
  if (!dsn) return;

  try {
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE,
      // Release is injected at build time by @sentry/vite-plugin when source
      // map upload is configured; otherwise events have no release.
      tracesSampleRate: parseSampleRate(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE, 0.1),
      // SDK v11 replaced sendDefaultPii with dataCollection (defaults collect a lot).
      dataCollection: RESTRICTED_DATA_COLLECTION,
      // Explicit list: no replayIntegration / feedback (PII).
      integrations: router ? [Sentry.tanstackRouterBrowserTracingIntegration(router)] : [],
      ignoreErrors: IGNORED_ERROR_MESSAGES,
      beforeSend(event, hint) {
        try {
          if (isExpectedControlFlowError(hint?.originalException)) return null;
          return scrubEvent(event);
        } catch {
          return null;
        }
      },
      beforeSendSpan(span) {
        try {
          return scrubSpan(span);
        } catch {
          return { ...span, name: "[Filtered]", attributes: {} };
        }
      },
      beforeBreadcrumb(breadcrumb) {
        try {
          // UI click breadcrumbs may carry typed text/labels; keep only the category.
          if (breadcrumb.category?.startsWith("ui.")) {
            return { ...breadcrumb, message: undefined, data: undefined };
          }
          scrubEvent({ breadcrumbs: [breadcrumb] });
          return breadcrumb;
        } catch {
          return null;
        }
      },
    });
  } catch (error) {
    console.error("[sentry] init failed", error);
  }
}

/** Reports an error caught by a React error boundary / route errorComponent. */
export function captureClientException(
  error: unknown,
  context?: { tags?: Record<string, string>; componentStack?: string },
): void {
  try {
    if (typeof window === "undefined" || !Sentry.getClient()) return;
    if (isExpectedControlFlowError(error)) return;
    Sentry.withScope((scope) => {
      if (context?.tags) scope.setTags(context.tags);
      if (context?.componentStack) {
        scope.setContext("react", { componentStack: context.componentStack });
      }
      Sentry.captureException(error);
    });
  } catch {
    // never throw from error reporting
  }
}
