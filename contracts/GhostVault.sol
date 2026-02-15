// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract GhostVault is Ownable, ReentrancyGuard {
    uint256 public constant FEE_BASIS_POINTS = 250; // 2.5%
    uint256 private constant BPS_DENOMINATOR = 10_000;

    address public treasury;
    mapping(address => uint256) public balances;

    event Deposited(address indexed agent, address indexed payer, uint256 amount, uint256 fee);
    event Withdrawn(address indexed agent, uint256 amount);

    error InvalidAddress();
    error InvalidAmount();
    error TransferFailed();
    error NoBalance();

    constructor(address treasuryWallet) Ownable(msg.sender) {
        if (treasuryWallet == address(0)) revert InvalidAddress();
        treasury = treasuryWallet;
    }

    function depositCredit(address agent) external payable nonReentrant {
        if (agent == address(0)) revert InvalidAddress();
        if (msg.value == 0) revert InvalidAmount();

        uint256 fee = (msg.value * FEE_BASIS_POINTS) / BPS_DENOMINATOR;
        uint256 agentShare = msg.value - fee;

        if (fee > 0) {
            (bool feeTransferOk, ) = payable(treasury).call{value: fee}("");
            if (!feeTransferOk) revert TransferFailed();
        }

        balances[agent] += agentShare;
        emit Deposited(agent, msg.sender, msg.value, fee);
    }

    function withdraw() external nonReentrant {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NoBalance();

        balances[msg.sender] = 0;

        (bool payoutOk, ) = payable(msg.sender).call{value: amount}("");
        if (!payoutOk) revert TransferFailed();

        emit Withdrawn(msg.sender, amount);
    }
}
