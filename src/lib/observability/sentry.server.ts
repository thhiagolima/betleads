// Server-side Sentry reporting helpers (OBS-02).
//
// Sentry itself is initialized by /instrument.mjs (loaded with
// `node --import ./instrument.mjs`), outside of the Vite/Nitro bundle. This
// module only talks to the already-initialized client through @sentry/core's
// global carrier, which is keyed by SDK version — @sentry/core and
// @sentry/node are pinned to the same exact version in package.json.
//
// When Sentry is not initialized (no SENTRY_DSN, `vite dev`, tests) every
// function here is a cheap no-op. None of them ever throws.

import { captureException, captureMessage, getClient, withScope } from "@sentry/core";

import { isExpectedControlFlowError, scrubValue } from "./scrub";

type TagValue = string | number | boolean | null | undefined;

export type ServerCaptureContext = {
  job?: string;
  tenantId?: string | null;
  tags?: Record<string, TagValue>;
  extra?: Record<string, unknown>;
};

function isSentryActive(): boolean {
  try {
    return getClient() !== undefined;
  } catch {
    return false;
  }
}

type ScopeLike = {
  setTag: (key: string, value: string | number | boolean) => unknown;
  setExtras: (extras: Record<string, unknown>) => unknown;
};

function applyContext(scope: ScopeLike, context: ServerCaptureContext | undefined): void {
  if (!context) return;
  if (context.job) scope.setTag("job", context.job);
  if (context.tenantId) scope.setTag("tenant_id", context.tenantId);
  if (context.tags) {
    for (const [key, value] of Object.entries(context.tags)) {
      if (value === null || value === undefined) continue;
      scope.setTag(key, value);
    }
  }
  if (context.extra) {
    // beforeSend scrubs again, but never hand raw payloads to the SDK.
    scope.setExtras(scrubValue(context.extra));
  }
}

export function captureServerException(error: unknown, context?: ServerCaptureContext): void {
  try {
    if (!isSentryActive() || isExpectedControlFlowError(error)) return;
    withScope((scope) => {
      applyContext(scope, context);
      captureException(error);
    });
  } catch {
    // Observability must never break the request/job that is reporting.
  }
}

export function captureServerMessage(
  message: string,
  level: "info" | "warning" | "error",
  context?: ServerCaptureContext,
): void {
  try {
    if (!isSentryActive()) return;
    withScope((scope) => {
      applyContext(scope, context);
      captureMessage(message, level);
    });
  } catch {
    // Observability must never break the request/job that is reporting.
  }
}
