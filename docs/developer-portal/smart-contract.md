# GhostVault Smart Contract (Brief Reference)

Contract: `contracts/GhostVault.sol`

## Purpose

GhostVault stores consumer deposits, tracks merchant-attributed withdrawal balances, and separates protocol fees.

## Core state variables

| Variable | Type | Description |
|---|---|---|
| `maxTVL` | `uint256` | Global liability cap. Initialized to `5 ether`. |
| `totalLiability` | `uint256` | Total merchant-attributed balances pending owner withdrawal. |
| `accruedFees` | `uint256` | Protocol fees pending claim. |
| `treasury` | `address` | Stored treasury address (admin-managed). |
| `balances` | `mapping(address => uint256)` | Per-agent merchant withdrawal balances. |

## Merchant-facing functions

### `depositCredit(address agent) external payable`

- Splits deposit into fee + net.
- Adds fee to `accruedFees`.
- Adds net to `balances[agent]` and `totalLiability`.
- Enforces: `totalLiability <= maxTVL`.

Consumer note:
- This contract records merchant-attributed payout balances.
- Consumer spendable Ghost Credits are maintained off-chain after sync and are currently non-refundable.

Revert message on cap breach:

```text
Global Cap Reached
```

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
