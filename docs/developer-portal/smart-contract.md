# GhostVault Smart Contract (Brief Reference)

Contract: `contracts/GhostVault.sol`
Base Mainnet: `0x1D66Ae12b5fAe1C61EA81fD5F9550C1C0EB8Db55`

## Purpose

GhostVault stores pooled consumer backing, tracks merchant-earned withdrawal balances, and separates protocol fees.

## Core state variables

| Variable | Type | Description |
|---|---|---|
| `maxTVL` | `uint256` | Global liability cap. Initialized to `5 ether`. |
| `totalCreditBacking` | `uint256` | Total ETH backing universal Ghost Credits and unsettled balances. |
| `totalMerchantLiability` | `uint256` | Total merchant-earned balances pending owner withdrawal. |
| `accruedFees` | `uint256` | Protocol fees pending claim. |
| `treasury` | `address` | Stored treasury address (admin-managed). |
| `balances` | `mapping(address => uint256)` | Per-owner merchant withdrawal balances. |
| `processedSettlementIds` | `mapping(bytes32 => bool)` | Replay protection for settlement batches. |
| `settlementOperators` | `mapping(address => bool)` | Allowed operator accounts for allocation. |

Read aliases:
- `totalLiability()` returns current `totalMerchantLiability`
- `merchantBalances(address)` returns current per-merchant withdrawable balance

## Merchant-facing functions

### `depositCredit() external payable`

- Requires deposits to be exact multiples of the fixed credit price.
- Adds deposited ETH to pooled backing only.
- Does not create merchant balances at deposit time.
- Enforces the contract-wide backing cap.

### `allocateMerchantEarningsBatch(...) external`

- Accepts spend-attributed merchant earnings in bounded batches.
- Adds fee amounts to `accruedFees`.
- Adds net amounts to merchant `balances[owner]` and `totalMerchantLiability`.
- Rejects duplicate `settlementId` values and any batch that would exceed current backing.

### `allocateMerchantEarnings(...) external`

- Single-row settlement helper for the operator path.
- Enforces the same replay and backing guarantees as batch allocation.

Consumer note:
- This contract records pooled consumer backing and spend-attributed merchant payout balances.
- Consumer spendable Ghost Credits are maintained off-chain after sync and are currently non-refundable.

### `withdraw() external`

Withdraw caller balance to caller address.

### `withdrawTo(address recipient) external`

Withdraw caller balance to specific recipient.

## Admin functions

### `claimFees(address recipient) external onlyOwner`

Transfers all `accruedFees` to recipient.

### `claimFees() external onlyOwner`

Transfers all `accruedFees` to the configured `treasury`.

### `setSettlementOperator(address operator, bool allowed) external onlyOwner`

Grants or revokes operator authority for settlement allocation.

### `setMaxTVL(uint256 _newCap) external onlyOwner`

Updates global liability cap.

### `setTreasury(address newTreasury) external onlyOwner`

Updates stored treasury address.

### `sweepExcess(address recipient) external onlyOwner`

Sweeps ETH that reached the contract outside normal credit-backing accounting.

## Security posture

- Uses `ReentrancyGuard` on value-transfer paths.
- Updates accounting state before external ETH transfers.
- Uses explicit custom errors for invalid states.
- Settlement allocation is replay-protected by `processedSettlementIds`.
- Forced ETH does not increase backing or merchant liability automatically.
