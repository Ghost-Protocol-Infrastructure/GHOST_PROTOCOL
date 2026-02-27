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

- `totalLiability`: sum of user-withdrawable balances
- `accruedFees`: protocol fees pending owner claim
- `maxTVL`: global liability cap (initialized to `5 ETH`)

## Pull-based fee model

GhostVault uses pull over push:

1. `depositCredit(agent)` records fee in `accruedFees` and net in `balances[agent]`.
2. No external transfer to treasury occurs during user deposit.
3. Owner later claims fees with `claimFees(recipient)`.

This reduces external-call risk on deposit and isolates treasury failure from user crediting.

## Security invariants

1. `totalLiability <= maxTVL` (global cap)
2. Withdrawals reduce liability before external transfer
3. Fees are segregated from user balances (`accruedFees` vs `balances`)
4. Sensitive functions protected with `onlyOwner` and `nonReentrant`

> [!IMPORTANT]
> `maxTVL` is enforced against `totalLiability`, not `address(this).balance`, so forced ETH transfers do not bypass cap logic.

## Data flow summary

1. User signs Gate payload in SDK.
2. Gate verifies signature and deducts credits in Postgres.
3. User can top up by depositing ETH into GhostVault.
4. `/api/sync-credits` reads `Deposited` logs and converts deposits into credits.

## Phase C Fulfillment

Phase C introduces a bounded hold/capture lifecycle for direct merchant calls:

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
