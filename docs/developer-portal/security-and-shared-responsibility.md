# Security and Shared Responsibility

This page is blunt on purpose: Ghost Protocol secures the settlement rail, but it does not run your infrastructure for you.

## What Ghost Protocol is responsible for

1. Securing the on-chain vault contract (`contracts/GhostVault.sol`) and settlement allocation controls.
2. Guaranteeing the integrity of the fulfillment hold lifecycle (`HELD -> CAPTURED` and `HELD -> EXPIRED`) in backend state transitions.
3. Shipping SDK verification logic that validates EIP-712 signatures and ticket bindings correctly (Node and Python surfaces documented in this portal).

## What you (merchant/operator) are responsible for

1. Network-layer DDoS and origin protection.
   - Ghost Gate rejects unauthorized app-layer requests quickly.
   - It is still an L7 protocol layer, not a full network firewall.
   - Put your merchant API behind a provider such as Cloudflare.
2. Upstream compute spend and vendor billing.
   - Ghost Protocol can ensure credit accounting and merchant payout attribution.
   - It cannot control your OpenAI/Anthropic/other upstream model bill.
   - You must monitor your own API usage, latency, and cost anomalies.
3. Key and secret management.
   - Do not leak delegated signer keys, settlement operator keys, or support secrets.
   - If private keys are compromised, captured settlements are not reversible by Ghost Protocol.

## Why settlement is asynchronous

Ghost Protocol is intentionally split into two phases:

1. Fast fulfillment capture (`HELD -> CAPTURED`) in the backend ledger for low-latency agent responses.
2. Batched on-chain merchant settlement after capture, processed by the settlement operator.

This architecture exists so merchants are paid for completed work while keeping request latency and gas costs practical:

- A request does not wait for chain confirmation in the hot path.
- Failed or expired holds can be released cleanly without on-chain clawback logic.
- Multiple captured spends can be batched into fewer settlement transactions.

Operationally, this means merchant balances can briefly appear as `PENDING`/`IN-FLIGHT` before becoming withdrawable on-chain.

## Legal boundary

- Ghost SDK packages and repository code are distributed under the MIT License.
- The MIT "AS IS" warranty disclaimer applies to software usage.
- Merchant/legal terms are hosted separately at:
  - `https://ghostprotocol.cc/terms`

## Practical baseline checklist

Before production traffic:

1. Protect merchant origin with edge controls (WAF/rate limiting/bot rules).
2. Store keys/secrets only in runtime secret managers (never in frontend or git).
3. Configure settlement operator and support secrets in hosted runtime + CI.
4. Set alerts for API spend, gateway failures, and settlement operator health.
