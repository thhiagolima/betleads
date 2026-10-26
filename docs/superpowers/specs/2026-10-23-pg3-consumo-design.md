# PG3 — Charging voice and e-mail, low balance, and billing e-mail adjustments

Date: 2026-10-23. Base: main fe49674. Source scope: `docs/ESCOPO_GATEWAY_PAGAMENTO_UPPER_2026-10-21.md`, PG3 phase (decisions D4, D6 and D7). The user delegated every decision that did not need them ("faça tudo o que não precisa da minha decisão ou que você pode decidir"). The decisions below are Claude's and are marked as such.

## Intent

Voice calls and e-mails will draw on the house's single wallet, the same way SMS already does. A house that runs out of balance stops only its own sends. Today it stops SMS for every house (a production bug). The house is warned before the balance runs out. Billing e-mails become clearer.

## Fixed prices and rules (user decisions in the scope document)

- Voice: R$ 0,09 per 30 s block. Only answered calls are charged (duration > 0), with a minimum of 1 block. An unanswered call is free for now (pending confirmation from Infobip, PG0-05), so this rule must be configurable without code.
- E-mail: 100,000 free per month per house, then R$ 0,002 each.
- Houses on the `interno` plan are exempt: charged R$ 0, but usage is still counted.
- Credits never expire.

## What already exists (PG1, in production)

- `wallet_reserve(_tenant,_item,_units,_reference_type,_reference_id,_idempotency_key)` and `wallet_refund(_tenant,_reference_id,_idempotency_key,_reason)` (`20261022100100_billing_wallet.sql`).
- In TS, `reserveUsage`/`refundUsage` (`src/lib/billing/wallet.server.ts`).
- The franchise is counted atomically inside `wallet_reserve` (FOR UPDATE on the wallet).
- The price book already has `voice_30s` = 0,09 and `email` = 0,002 with `free_monthly_units = 100000`.
- SMS reserves when it sends, and refunds on any failure. Its keys are `delivery:<key>[:gen]`, `sms-reserve:<ref>` and `sms-refund:<ref>`.
- PG3-01 (a locked house does not send) is already covered by the monthly billing send guards.

## Decisions (Claude's calls, delegated by the user)

1. **Unanswered call:** free. A new column `charge_unanswered_blocks` (default 0) in the price book lets the superadmin change this without code.
2. **Cap reserved before the call:** `ceil((maxSeconds + 10) / 30)` blocks. `maxSeconds` is the audio duration (journeys), `max_call_seconds` (call flows), or `VOICE_MAX_CALL_SECONDS` (default 120). If the call runs longer than the cap, we charge the cap and absorb the rest.
3. **Answered call with no duration in the callback:** charge the cap.
4. **Reserved call with no final callback after 24 h:**
   - If the CML was never fetched, the call was not answered: settle as unanswered.
   - If the CML was fetched (answered), keep the cap.
5. **Provider timeout or unknown error:** refund, same as SMS today.
6. **Journey step without balance:** the step is skipped with the reason `saldo_insuficiente` and the journey continues. No retry and no attempt consumed.
7. **E-mail or SMS campaign without balance:** the run stops at the first `insufficient_balance`. It does not resume automatically after a top-up; the house reruns it.
8. **SMS and e-mail flows (automations) without balance:** the house's item is skipped. The channel is never paused globally.
9. **"No balance" alert:** at most 1 per hour per house, by e-mail to the admins/gestores. **"Low balance" alert:** at most 1 per 24 h.
10. **Low balance threshold:** per house, default R$ 200, editable by the house admin and the superadmin. Exempt and demo houses never get alerts.
11. **Test e-mail:** charged and counts towards the franchise, like any send.
12. **Ledger:** one row per e-mail, including free ones. Batching is left for later.
13. **Settlement:** never reprices. Settling returns the unused share of what was reserved, using the price in force at reservation time.
14. **Billing e-mails (spec §5 of the monthly billing design):**
    - `paid` includes the date, the period and the endToEndId (or "baixa manual").
    - `due_today` mentions the grace period ("até DD/MM").
    - `locked` says what stopped and what keeps coming in.
    - An upfront invoice issued today sends only `issued` (with "vence hoje"), not `due_today` in the same day.
15. **Manual settlement with a payment date:** an optional `paidAt` field. A future date is clamped to now, and the cycle is counted from it.

## Non-goals

- Batching ledger rows.
- Resuming a campaign automatically after a top-up.
- Sending `maxDuration` to Infobip. This depends on confirming the API, so it gets asked together with PG0-05.
- Billing the platform's own e-mails (billing, DNS); these never charge the house.

## Constraints

- Every production write needs explicit authorization from the user. New migrations must be applied in production BEFORE deploying the code that calls them.
- Never delete rows that carry money.
- Supplier cost is visible to the superadmin only.
- Copy in pt-BR. Dark UI. Never a literal NBSP in source.
- The SMS refactor must not change SMS behaviour: the existing tests stay green.
