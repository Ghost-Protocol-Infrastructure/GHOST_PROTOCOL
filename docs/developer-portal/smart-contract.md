# GhostVault Smart Contract (Brief Reference)

Contract: `contracts/GhostVault.sol`

## Purpose

GhostVault stores pooled consumer backing, tracks merchant-earned withdrawal balances, and separates protocol fees.

## Core state variables

| Variable | Type | Description |
|---|---|---|
| `maxTVL` | `uint256` | Global liability cap. Initialized to `5 ether`. |
| `totalCreditBacking` | `uint256` | Total ETH backing universal Ghost Credits and unsettled balances. |
| `totalLiability` | `uint256` | Total merchant-earned balances pending owner withdrawal. |
| `accruedFees` | `uint256` | Protocol fees pending claim. |
| `treasury` | `address` | Stored treasury address (admin-managed). |
| `balances` | `mapping(address => uint256)` | Per-owner merchant withdrawal balances. |

## Merchant-facing functions

### `depositCredit() external payable`

- Requires deposits to be exact multiples of the fixed credit price.
- Adds deposited ETH to pooled backing only.
- Does not create merchant balances at deposit time.
- Enforces the contract-wide backing cap.

### `allocateMerchantEarningsBatch(...) external`

- Accepts spend-attributed merchant earnings in bounded batches.
- Adds fee amounts to `accruedFees`.
- Adds net amounts to merchant `balances[owner]` and `totalLiability`.
- Rejects duplicate `settlementId` values and any batch that would exceed current backing.

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

### `setMaxTVL(uint256 _newCap) external onlyOwner`

Updates global liability cap.

### `setTreasury(address newTreasury) external onlyOwner`

Updates stored treasury address.

## Security posture

- Uses `ReentrancyGuard` on value-transfer paths.
- Updates accounting state before external ETH transfers.
- Uses explicit custom errors for invalid states.
