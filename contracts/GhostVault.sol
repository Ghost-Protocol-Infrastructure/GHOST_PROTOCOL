// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract GhostVault is Ownable, ReentrancyGuard {
    uint256 public constant FEE_BASIS_POINTS = 250; // 2.5%
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 public maxTVL;
    uint256 public totalLiability;
    uint256 public accruedFees;

    address public treasury;
    mapping(address => uint256) public balances;

    event Deposited(address indexed agent, address indexed payer, uint256 amount, uint256 fee);
    event Withdrawn(address indexed agent, uint256 amount);
    event FeesClaimed(address indexed recipient, uint256 amount);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event MaxTVLUpdated(uint256 previousCap, uint256 newCap);

    error InvalidAddress();
    error InvalidAmount();
    error TransferFailed();
    error NoBalance();
    error NoFees();

    constructor(address treasuryWallet) Ownable(msg.sender) {
        if (treasuryWallet == address(0)) revert InvalidAddress();
        treasury = treasuryWallet;
        maxTVL = 5 ether;
    }

    function depositCredit(address agent) external payable nonReentrant {
        if (agent == address(0)) revert InvalidAddress();
        if (msg.value == 0) revert InvalidAmount();

        uint256 fee = (msg.value * FEE_BASIS_POINTS) / BPS_DENOMINATOR;
        uint256 netAmount = msg.value - fee;
        uint256 nextLiability = totalLiability + netAmount;
        require(nextLiability <= maxTVL, "Global Cap Reached");

        accruedFees += fee;
        totalLiability = nextLiability;
        balances[agent] += netAmount;
        emit Deposited(agent, msg.sender, msg.value, fee);
    }

    function setMaxTVL(uint256 _newCap) external onlyOwner {
        uint256 previousCap = maxTVL;
        maxTVL = _newCap;
        emit MaxTVLUpdated(previousCap, _newCap);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidAddress();

        address previousTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(previousTreasury, newTreasury);
    }

    function claimFees(address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();

        uint256 amount = accruedFees;
        if (amount == 0) revert NoFees();

        accruedFees = 0;

        (bool payoutOk, ) = payable(recipient).call{value: amount}("");
        if (!payoutOk) revert TransferFailed();

        emit FeesClaimed(recipient, amount);
    }

    function withdraw() external nonReentrant {
        _withdrawTo(msg.sender, msg.sender);
    }

    function withdrawTo(address recipient) external nonReentrant {
        _withdrawTo(msg.sender, recipient);
    }

    function _withdrawTo(address agent, address recipient) internal {
        if (recipient == address(0)) revert InvalidAddress();

        uint256 amount = balances[agent];
        if (amount == 0) revert NoBalance();

        balances[agent] -= amount;
        totalLiability -= amount;

        (bool payoutOk, ) = payable(recipient).call{value: amount}("");
        if (!payoutOk) revert TransferFailed();

        emit Withdrawn(agent, amount);
    }
}
