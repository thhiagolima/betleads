// Pix gateway seam (server-only). Upper and SpacePay both sit behind this
// contract so the charge state machine (top-up, invoice, webhook, reconcile)
// never imports a gateway client directly.
//
// - New charges go to the ACTIVE provider (`BILLING_PIX_PROVIDER`, default
//   'upper'), one global choice for every house.
// - An existing charge is ALWAYS read/cancelled through the provider stored
//   on its own `payment_charges.provider` row — switching the active
//   provider never strands a charge created on the other one.
// - Every client normalizes its response to `PixCharge` (the original Upper
//   shape), so `recordChargeSnapshot` and the crediting checks are shared.

import { spacePayGateway } from "./spacepay-pix.server";
import {
  cancelUpperCharge,
  createUpperCharge,
  getUpperCharge,
  type UpperCharge,
} from "./upper-pix.server";
import type { PixProvider } from "./pix-gateway-error";

export type { PixProvider } from "./pix-gateway-error";
export { PixGatewayError, isPixNotFound, pixErrorSummary } from "./pix-gateway-error";

/** Normalized charge, shared by every gateway (amounts always in cents). */
export type PixCharge = UpperCharge;
export type PixChargeStatus = PixCharge["status"];

export type CreatePixChargeInput = {
  amountCents: number;
  description: string;
  /** Our `payment_charges.external_id`; the gateway's idempotency key. */
  externalId: string;
  /** Requested lifetime in seconds. A gateway that can't set it (SpacePay) ignores it. */
  expiresIn: number;
  metadata: Record<string, string>;
  /** End user's IP when the charge is created from a request (SpacePay forwards it). */
  requestIp?: string | null;
};

/** What a gateway needs to find a charge again. */
export type PixChargeRef = {
  externalId: string;
  providerChargeId: string | null;
};

export interface PixGateway {
  provider: PixProvider;
  /** Credentials present; checked before any payment_charges row is written. */
  isConfigured(): boolean;
  create(input: CreatePixChargeInput): Promise<PixCharge>;
  /** Fresh read from the gateway. Throws PixGatewayError with status 404 when unknown. */
  get(ref: PixChargeRef): Promise<PixCharge>;
  /**
   * Cancels on the gateway side. `null` = the gateway has no cancel
   * endpoint; the caller just closes the row locally (a late PAID is still
   * credited or flagged by the normal confirm path).
   */
  cancel(ref: PixChargeRef): Promise<PixCharge | null>;
}

export const upperGateway: PixGateway = {
  provider: "upper",
  isConfigured: () => Boolean(process.env.UPPER_API_KEY?.trim()),
  create: ({ requestIp: _requestIp, ...input }) => createUpperCharge(input),
  get: (ref) => getUpperCharge(ref.externalId),
  cancel: (ref) => cancelUpperCharge(ref.externalId),
};

const GATEWAYS: Record<PixProvider, PixGateway> = {
  upper: upperGateway,
  spacepay: spacePayGateway,
};

export function isPixProvider(value: unknown): value is PixProvider {
  return value === "upper" || value === "spacepay";
}

/** Gateway that owns an existing charge. An unknown provider value is a bug, never a fallback. */
export function getPixGateway(provider: string | null | undefined): PixGateway {
  if (!isPixProvider(provider)) throw new Error(`unknown_pix_provider: ${String(provider)}`);
  return GATEWAYS[provider];
}

/** Provider for NEW charges: `BILLING_PIX_PROVIDER` (upper | spacepay), default upper. */
export function activePixProvider(): PixProvider {
  const raw = process.env.BILLING_PIX_PROVIDER?.trim().toLowerCase();
  return isPixProvider(raw) ? raw : "upper";
}

export function activePixGateway(): PixGateway {
  return GATEWAYS[activePixProvider()];
}
