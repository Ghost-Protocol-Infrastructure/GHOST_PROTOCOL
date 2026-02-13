// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract GhostCredits is Ownable, ReentrancyGuard {
    // State Variables
    uint256 public pricePerCredit; // e.g., 0.00001 ETH
    uint256 public platformFeeBps; // Basis points (e.g., 500 = 5%)

    // Mappings
    mapping(address => uint256) public credits;
    mapping(address => uint256) public earnings;

    // Events
    event CreditsPurchased(address indexed user, uint256 amount);
    event UsageSettled(address indexed user, address indexed provider, uint256 amount);
    event EarningsClaimed(address indexed provider, uint256 netAmount, uint256 fee);
    event ConfigUpdated(uint256 newPrice, uint256 newFee);

    constructor(uint256 _pricePerCredit, uint256 _platformFeeBps) Ownable(msg.sender) {
        pricePerCredit = _pricePerCredit;
        platformFeeBps = _platformFeeBps;
    }

    // 1. User Buys Credits
    function buyCredits() external payable nonReentrant {
        require(msg.value >= pricePerCredit, "Insufficient payment");
        uint256 amount = msg.value / pricePerCredit;
        credits[msg.sender] += amount;
        emit CreditsPurchased(msg.sender, amount);
    }

    // 2. Admin Settles Usage (Off-chain usage -> On-chain earnings)
    function settleUsage(address user, uint256 amountSpent, address provider, uint256 amountEarned) external onlyOwner {
        require(credits[user] >= amountSpent, "User insufficient credits");
        credits[user] -= amountSpent;
        earnings[provider] += amountEarned;
        emit UsageSettled(user, provider, amountSpent);
    }

    // 3. Provider Claims Earnings
    function claimEarnings() external nonReentrant {
        uint256 totalEarned = earnings[msg.sender];
        require(totalEarned > 0, "No earnings to claim");

        // Reset earnings first (Checks-Effects-Interactions)
        earnings[msg.sender] = 0;

        // Calculate Fee
        uint256 fee = (totalEarned * platformFeeBps) / 10000;
        uint256 payout = totalEarned - fee;

        // Transfer Payout
        (bool success, ) = payable(msg.sender).call{value: payout}("");
        require(success, "Transfer failed");

        emit EarningsClaimed(msg.sender, payout, fee);
    }

    // 4. Admin Withdraws Platform Fees
    function withdrawFees() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No fees to withdraw");
        (bool success, ) = payable(owner()).call{value: balance}("");
        require(success, "Withdraw failed");
    }

    // Configuration
    function updateConfig(uint256 _pricePerCredit, uint256 _platformFeeBps) external onlyOwner {
        pricePerCredit = _pricePerCredit;
        platformFeeBps = _platformFeeBps;
        emit ConfigUpdated(_pricePerCredit, _platformFeeBps);
    }

    // Receive fallback
    receive() external payable {
        buyCredits();
    }
}