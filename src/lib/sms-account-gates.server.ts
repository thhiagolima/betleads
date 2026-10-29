// One dispatcher run's view of the SMS provider breakers, one per provider
// account (sms-provider-breaker.server.ts). A run handles houses on different
// accounts, so every SMS item is admitted against the breaker of ITS house's
// account:
//   closed : sent.
//   open   : handed back untouched (no attempt consumed) until the retry time.
//   probe  : this run holds the half-open probe of that account: exactly ONE
//            item is sent; the others of that account wait for its verdict.
// Houses on other accounts are never affected by an account that is down.

import {
  ProviderAccountUnavailableError,
  resolveSmsAccount,
} from "./provider-accounts.server";
import {
  acquireSmsSendGate,
  BREAKER_CACHE_MS,
  breakerRetryAt,
  cachedSmsBreaker,
  readSmsBreaker,
  releaseSmsProbe,
  smsBreakerKey,
  smsSuspendedMessage,
  type BreakerSnapshot,
} from "./sms-provider-breaker.server";

type Gate = {
  mode: "closed" | "open" | "probe";
  snapshot: BreakerSnapshot | null;
  checkedAt: number;
  /** Item sending the probe of this account right now. */
  probeItem: string | null;
  /** This run took the probe of this account at some point (released at the end). */
  heldProbe: boolean;
};

/**
 * Breaker key of the account that sends the house's SMS. null when the
 * house's own account is unavailable: there is nothing to gate, the send
 * itself fails as `misconfigured`.
 */
export async function smsBreakerKeyForTenant(
  tenantId: string | null | undefined,
): Promise<string | null> {
  try {
    return smsBreakerKey((await resolveSmsAccount(tenantId)).id);
  } catch (error) {
    if (error instanceof ProviderAccountUnavailableError) return null;
    throw error;
  }
}

export type SmsAdmission =
  | { mode: "closed" | "probe"; key: string | null }
  | {
      mode: "open";
      key: string;
      snapshot: BreakerSnapshot;
      message: string;
      /** Only waiting for this run's probe verdict (not refused): retry next tick. */
      probeInFlight: boolean;
    };

export class SmsAccountGates {
  private readonly gates = new Map<string, Gate>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(readonly holder: string) {}

  keyFor(tenantId: string | null | undefined): Promise<string | null> {
    return smsBreakerKeyForTenant(tenantId);
  }

  /**
   * Re-asks the breaker of `key` (another process may have opened/closed it).
   * Also called up front by a run so an account already down is excluded
   * from its first claim; it may take that account's half-open probe.
   */
  async refresh(key: string) {
    const gate = this.gates.get(key);
    // While our probe is in flight its verdict decides; nothing else may send.
    if (gate?.probeItem) return;
    if (gate && Date.now() - gate.checkedAt < BREAKER_CACHE_MS) return;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = (async () => {
        const decision = await acquireSmsSendGate(this.holder, key);
        const previous = this.gates.get(key);
        this.gates.set(key, {
          mode: decision.mode,
          snapshot: decision.mode === "closed" ? null : decision.snapshot,
          checkedAt: Date.now(),
          probeItem: previous?.probeItem ?? null,
          heldProbe: (previous?.heldProbe ?? false) || decision.mode === "probe",
        });
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    await pending;
  }

  /** Admission of one SMS item (`itemId` identifies it for the probe verdict). */
  async admit(tenantId: string | null | undefined, itemId: string): Promise<SmsAdmission> {
    const key = await this.keyFor(tenantId);
    if (key === null) return { mode: "closed", key };
    await this.refresh(key);
    const gate = this.gates.get(key)!;
    if (gate.mode === "closed") {
      // A send of this process just opened it (reportSmsProviderAccountFailure
      // updates the cache): stop now instead of at the next refresh.
      const latest = cachedSmsBreaker(key);
      if (latest.state !== "open") return { mode: "closed", key };
      gate.mode = "open";
      gate.snapshot = latest;
    }
    if (gate.mode === "probe" && gate.probeItem === null) {
      gate.probeItem = itemId;
      console.warn("[sms-gates] breaker half-open: probing with one item", {
        key,
        itemId,
        holder: this.holder,
      });
      return { mode: "probe", key };
    }
    const snapshot = gate.snapshot ?? cachedSmsBreaker(key);
    return {
      mode: "open",
      key,
      snapshot,
      message: smsSuspendedMessage(snapshot),
      probeInFlight: gate.mode === "probe",
    };
  }

  /** After the probe item: learn the verdict (closed / reopened / still ours). */
  async settle(itemId: string) {
    for (const [key, gate] of this.gates) {
      if (gate.probeItem !== itemId) continue;
      gate.probeItem = null;
      const snapshot = await readSmsBreaker({ force: true, key });
      gate.checkedAt = Date.now();
      if (snapshot.state === "closed") {
        gate.mode = "closed";
        gate.snapshot = null;
      } else if (snapshot.state === "open") {
        gate.mode = "open";
        gate.snapshot = snapshot;
      }
      // Still half_open: the probe never got a provider verdict (exit,
      // consent, per-lead error...): the next item of that account probes.
    }
  }

  /**
   * The provider refused the account of this house on a regular (non-probe)
   * send: no further item of that account is sent by this run.
   */
  async markOpen(tenantId: string | null | undefined, itemId: string) {
    const key = await this.keyFor(tenantId);
    if (key === null) return;
    const gate = this.gates.get(key);
    if (gate?.probeItem === itemId) return; // settle() reads the verdict
    this.gates.set(key, {
      mode: "open",
      snapshot: cachedSmsBreaker(key),
      checkedAt: Date.now(),
      probeItem: gate?.probeItem ?? null,
      heldProbe: gate?.heldProbe ?? false,
    });
  }

  /** When an item of this house held back by its breaker should come back. */
  async retryAt(tenantId: string | null | undefined, fallbackMs: number): Promise<string> {
    const key = await this.keyFor(tenantId);
    const snapshot = key === null ? null : cachedSmsBreaker(key);
    return breakerRetryAt(snapshot && snapshot.state !== "closed" ? snapshot : null, fallbackMs);
  }

  /** Breaker keys this run must not send through right now. */
  blockedKeys(): Set<string> {
    const blocked = new Set<string>();
    for (const [key, gate] of this.gates) {
      if (gate.mode === "open" || (gate.mode === "probe" && gate.probeItem !== null)) {
        blocked.add(key);
      }
    }
    return blocked;
  }

  /** Houses (of `tenantIds`) whose SMS account is blocked for this run. */
  async blockedTenants(tenantIds: readonly string[]): Promise<string[]> {
    const blocked = this.blockedKeys();
    if (blocked.size === 0) return [];
    const out: string[] = [];
    for (const tenantId of tenantIds) {
      const key = await this.keyFor(tenantId);
      if (key !== null && blocked.has(key)) out.push(tenantId);
    }
    return out;
  }

  /** Mode of the platform account's gate, for run metrics ("closed" if never asked). */
  modeOf(key: string): Gate["mode"] {
    return this.gates.get(key)?.mode ?? "closed";
  }

  /** Probes taken without a provider verdict go back to the next worker. */
  async release() {
    for (const [key, gate] of this.gates) {
      if (gate.heldProbe) await releaseSmsProbe(this.holder, key);
    }
  }
}
