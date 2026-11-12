// Common base for every Pix gateway client error (Upper, SpacePay), so the
// charge state machine can branch on `status`/`retryable` without knowing
// which gateway created the charge. Kept in its own file (no imports) so the
// gateway clients and pix-gateway.server.ts can all depend on it without a
// cycle.

export type PixProvider = "upper" | "spacepay";

export class PixGatewayError extends Error {
  provider: PixProvider;
  status: number;
  code: string | null;
  retryable: boolean;

  constructor(
    message: string,
    options: {
      provider: PixProvider;
      status: number;
      code: string | null;
      retryable: boolean;
      cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "PixGatewayError";
    this.provider = options.provider;
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

/**
 * The gateway has never heard of this charge (HTTP 404). A SpacePay 404 for
 * an unknown X-Platform-Id (code PLATFORM_NOT_FOUND) is a config problem, not
 * a missing charge: it must never make reconcile give up on a charge.
 */
export function isPixNotFound(error: unknown): boolean {
  return (
    error instanceof PixGatewayError &&
    error.status === 404 &&
    error.code !== "PLATFORM_NOT_FOUND"
  );
}

/** Short `CODE (status)` text stored in `payment_charges.last_error`. Never a secret or body. */
export function pixErrorSummary(error: unknown): string {
  if (error instanceof PixGatewayError) return `${error.code ?? "UNKNOWN"} (${error.status})`;
  return "UNKNOWN_ERROR (0)";
}
