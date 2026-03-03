# Architecture: Gate, Vault, and Fulfillment

Ghost Protocol is split into two safety domains:

- `The Gate` (authorization and metering)
- `The Vault` (fund custody and accounting)
- `The Fulfillment state machine` (ticketed direct merchant execution + capture)

This separation keeps request authorization fast and keeps value transfer isolated.

## System map

```mermaid
flowchart LR
    A[Client SDK<br/>Node or Python] --> B[Ghost Gate API<br/>/api/gate/[service]]
    B --> C[(Postgres / Prisma<br/>CreditBalance)]
    A --> G[/api/fulfillment/ticket]
    G --> H[Merchant Runtime<br/>/ask]
    H --> I[/api/fulfillment/capture]
    I --> C
    A --> D[GhostVault.sol<br/>depositCredit]
    D --> E[(On-chain ETH)]
    F[/api/sync-credits] --> E
    F --> C
```

## The Gate

Ghost Gate is a signed access layer that validates:

- EIP-712 typed payload (`Access`)
- Signature freshness (replay window)
- Service slug match
- Credit balance before request authorization

### Gate authorization fields

- `service` (string)
- `timestamp` (uint256)
- `nonce` (string)

### EIP-712 domain

- `name`: `GhostGate`
- `version`: `1`
- `chainId`: `8453` (Base)

## The Vault

GhostVault is the ETH credit rail. It tracks:

- live Base mainnet vault: `0x1D66Ae12b5fAe1C61EA81fD5F9550C1C0EB8Db55`
- `totalLiability()`: read alias for merchant-attributed balances pending owner withdrawal
- `accruedFees`: protocol fees pending owner claim
- `totalCreditBacking`: pooled ETH backing universal Ghost Credits
- `maxTVL`: global backing cap (initialized to `5 ETH`)

## Pull-based fee model

GhostVault uses pull over push:

1. `depositCredit()` increases pooled credit backing and does not credit any merchant directly.
2. Merchant earnings are allocated later from successful spend events and create withdrawable owner balances.
3. Owner later claims fees with `claimFees(recipient)`.
4. Settlement operators batch merchant earnings on-chain through `allocateMerchantEarningsBatch(...)`.

This reduces external-call risk on deposit and isolates treasury failure from user crediting.

## Security invariants

1. `totalCreditBacking <= maxTVL` (global cap)
2. `totalMerchantLiability + accruedFees <= totalCreditBacking`
3. Withdrawals reduce liability before external transfer
4. Fees are segregated from user balances (`accruedFees` vs `balances`)
5. Sensitive functions protected with `onlyOwner`, `onlySettlementOperator`, and `nonReentrant`

> [!IMPORTANT]
> `maxTVL` is enforced against `totalCreditBacking`, not `address(this).balance`, so forced ETH transfers do not bypass cap logic.

## Data flow summary

1. User signs Gate payload in SDK.
2. User can top up by depositing ETH into GhostVault as pooled backing for universal credits.
3. `/api/sync-credits` reads `Deposited` logs and converts deposit history into a wallet-level off-chain credit balance.
4. Gate and fulfillment flows verify signatures and deduct credits in Postgres.

## Current settlement attribution model

- Consumer spend is tracked off-chain by wallet in `CreditBalance`.
- Usage is attributed per service in off-chain rows such as `CreditLedger.service` and `FulfillmentHold.serviceSlug`.
- Merchant payout is now attributed from successful gate debits and fulfillment captures, then allocated on-chain through settlement batches.
- Ghost Credits are currently prepaid and non-refundable once converted into off-chain credits.

This means usage tracking and payout attribution are reconciled by post-spend settlement. Consumer deposits fund universal credits, while merchant payout follows actual successful usage.

## Settlement operator

The hosted Ghost deployment runs the settlement operator, not the merchant:

1. spend creates `MerchantEarning` rows
2. `/api/admin/settlement/allocate` batches and submits pending earnings
3. `/api/admin/settlement/reconcile` confirms submitted rows against on-chain state
4. merchants withdraw only settled balances

## Fulfillment

Fulfillment introduces a bounded hold/capture lifecycle for direct merchant calls:

1. Consumer requests ticket (`/api/fulfillment/ticket`)
   - Checks `LIVE` readiness and authoritative pricing.
   - Reserves credits: `available -= cost`, `held += cost`.
   - Creates `FulfillmentHold(state=HELD)` and returns signed ticket.
2. Merchant verifies ticket bindings and executes request.
3. Merchant captures completion (`/api/fulfillment/capture`)
   - Verifies delegated signer authorization.
   - Finalizes hold on success: `held -= cost`, state -> `CAPTURED`.
   - Idempotent replay supported for same `deliveryProofId`.
4. If capture does not happen before TTL:
   - `/api/fulfillment/expire-sweep` marks hold `EXPIRED`
   - Restores credits: `available += cost`, `held -= cost`.

### Fulfillment invariants

- No double settlement for replayed captures.
- Terminal holds (`CAPTURED`/`EXPIRED`/`RELEASED`) cannot be recaptured.
- `availableCreditsDelta` and `heldCreditsDelta` are written for fulfillment ledger rows.
- `heldCredits` is transactionally maintained and reconciled against active held tickets.

### Merchant readiness gating

- Gateway must be `LIVE` (canary verified) for ticket issuance.
- Delegated capture signer must be `ACTIVE` under the gateway config.
