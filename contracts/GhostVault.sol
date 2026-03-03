// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract GhostVault is Ownable, ReentrancyGuard {
    uint256 public immutable creditPriceWei;

    uint256 public maxTVL;
    uint256 public totalCreditBacking;
    uint256 public totalMerchantLiability;
    uint256 public accruedFees;

    address public treasury;
    bool public depositsPaused;
    bool public allocationsPaused;

    mapping(address => uint256) public balances;
    mapping(bytes32 => bool) public processedSettlementIds;
    mapping(address => bool) public settlementOperators;

    event Deposited(
        address indexed payer,
        uint256 amount,
        uint256 creditsPurchased
    );
    event MerchantEarningsAllocated(
        address indexed merchant,
        bytes32 indexed settlementId,
        uint256 grossAmount,
        uint256 feeAmount,
        uint256 netAmount
    );
    event Withdrawn(
        address indexed merchant,
        address indexed recipient,
        uint256 amount
    );
    event FeesClaimed(address indexed recipient, uint256 amount);
    event ExcessSwept(address indexed recipient, uint256 amount);
    event SettlementOperatorUpdated(address indexed operator, bool allowed);
    event TreasuryUpdated(
        address indexed previousTreasury,
        address indexed newTreasury
    );
    event MaxTVLUpdated(uint256 previousCap, uint256 newCap);
    event DepositsPauseUpdated(bool paused);
    event AllocationsPauseUpdated(bool paused);

    error InvalidAddress();
    error InvalidAmount();
    error InvalidFeeAmount();
    error InvalidSettlementId();
    error ArrayLengthMismatch();
    error SettlementAlreadyProcessed();
    error AllocationExceedsBacking();
    error TransferFailed();
    error NoBalance();
    error NoFees();
    error NoExcessBalance();
    error UnauthorizedOperator();
    error DepositsPaused();
    error AllocationsPaused();
    error DepositNotExactCreditMultiple();
    error GlobalCapReached();

    modifier onlySettlementOperator() {
        if (msg.sender != owner() && !settlementOperators[msg.sender]) {
            revert UnauthorizedOperator();
        }
        _;
    }

    constructor(
        address treasuryWallet,
        uint256 initialMaxTVL,
        uint256 fixedCreditPriceWei
    ) Ownable(msg.sender) {
        if (treasuryWallet == address(0)) revert InvalidAddress();
        if (initialMaxTVL == 0 || fixedCreditPriceWei == 0) {
            revert InvalidAmount();
        }

        treasury = treasuryWallet;
        maxTVL = initialMaxTVL;
        creditPriceWei = fixedCreditPriceWei;
    }

    function merchantBalances(address merchant) external view returns (uint256) {
        return balances[merchant];
    }

    function totalLiability() external view returns (uint256) {
        return totalMerchantLiability;
    }

    function depositCredit() external payable nonReentrant {
        if (depositsPaused) revert DepositsPaused();
        if (msg.value == 0) revert InvalidAmount();
        if (msg.value % creditPriceWei != 0) {
            revert DepositNotExactCreditMultiple();
        }

        uint256 nextBacking = totalCreditBacking + msg.value;
        if (nextBacking > maxTVL) revert GlobalCapReached();

        totalCreditBacking = nextBacking;

        emit Deposited(msg.sender, msg.value, msg.value / creditPriceWei);
    }

    function allocateMerchantEarnings(
        address merchant,
        uint256 grossAmount,
        uint256 feeAmount,
        bytes32 settlementId
    ) external onlySettlementOperator nonReentrant {
        if (allocationsPaused) revert AllocationsPaused();

        address[] memory merchants = new address[](1);
        merchants[0] = merchant;

        uint256[] memory grossAmounts = new uint256[](1);
        grossAmounts[0] = grossAmount;

        uint256[] memory feeAmounts = new uint256[](1);
        feeAmounts[0] = feeAmount;

        bytes32[] memory settlementIds = new bytes32[](1);
        settlementIds[0] = settlementId;

        _allocateMerchantEarningsBatch(
            merchants,
            grossAmounts,
            feeAmounts,
            settlementIds
        );
    }

    function allocateMerchantEarningsBatch(
        address[] calldata merchants,
        uint256[] calldata grossAmounts,
        uint256[] calldata feeAmounts,
        bytes32[] calldata settlementIds
    ) external onlySettlementOperator nonReentrant {
        if (allocationsPaused) revert AllocationsPaused();

        _allocateMerchantEarningsBatch(
            merchants,
            grossAmounts,
            feeAmounts,
            settlementIds
        );
    }

    function withdraw() external nonReentrant {
        _withdrawTo(msg.sender, msg.sender);
    }

    function withdrawTo(address recipient) external nonReentrant {
        _withdrawTo(msg.sender, recipient);
    }

    function claimFees() external onlyOwner nonReentrant {
        _claimFeesTo(treasury);
    }

    function claimFees(address recipient) external onlyOwner nonReentrant {
        _claimFeesTo(recipient);
    }

    function sweepExcess(address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();

        uint256 contractBalance = address(this).balance;
        if (contractBalance <= totalCreditBacking) revert NoExcessBalance();
        uint256 excess = contractBalance - totalCreditBacking;

        (bool payoutOk, ) = payable(recipient).call{value: excess}("");
        if (!payoutOk) revert TransferFailed();

        emit ExcessSwept(recipient, excess);
    }

    function setSettlementOperator(
        address operator,
        bool allowed
    ) external onlyOwner {
        if (operator == address(0)) revert InvalidAddress();

        settlementOperators[operator] = allowed;
        emit SettlementOperatorUpdated(operator, allowed);
    }

    function setMaxTVL(uint256 newCap) external onlyOwner {
        if (newCap < totalCreditBacking) revert InvalidAmount();
        uint256 previousCap = maxTVL;
        maxTVL = newCap;
        emit MaxTVLUpdated(previousCap, newCap);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidAddress();

        address previousTreasury = treasury;
        treasury = newTreasury;

        emit TreasuryUpdated(previousTreasury, newTreasury);
    }

    function pauseDeposits(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPauseUpdated(paused);
    }

    function pauseAllocations(bool paused) external onlyOwner {
        allocationsPaused = paused;
        emit AllocationsPauseUpdated(paused);
    }

    function _allocateMerchantEarningsBatch(
        address[] memory merchants,
        uint256[] memory grossAmounts,
        uint256[] memory feeAmounts,
        bytes32[] memory settlementIds
    ) internal {
        uint256 length = merchants.length;
        if (
            length == 0 ||
            length != grossAmounts.length ||
            length != feeAmounts.length ||
            length != settlementIds.length
        ) {
            revert ArrayLengthMismatch();
        }

        uint256 batchNetTotal = 0;
        uint256 batchFeeTotal = 0;

        for (uint256 i = 0; i < length; i++) {
            address merchant = merchants[i];
            uint256 grossAmount = grossAmounts[i];
            uint256 feeAmount = feeAmounts[i];
            bytes32 settlementId = settlementIds[i];

            if (merchant == address(0)) revert InvalidAddress();
            if (grossAmount == 0) revert InvalidAmount();
            if (feeAmount > grossAmount) revert InvalidFeeAmount();
            if (settlementId == bytes32(0)) revert InvalidSettlementId();
            if (processedSettlementIds[settlementId]) {
                revert SettlementAlreadyProcessed();
            }

            for (uint256 j = 0; j < i; j++) {
                if (settlementIds[j] == settlementId) {
                    revert SettlementAlreadyProcessed();
                }
            }

            batchNetTotal += grossAmount - feeAmount;
            batchFeeTotal += feeAmount;
        }

        uint256 nextMerchantLiability = totalMerchantLiability + batchNetTotal;
        uint256 nextAccruedFees = accruedFees + batchFeeTotal;
        if (nextMerchantLiability + nextAccruedFees > totalCreditBacking) {
            revert AllocationExceedsBacking();
        }

        totalMerchantLiability = nextMerchantLiability;
        accruedFees = nextAccruedFees;

        for (uint256 i = 0; i < length; i++) {
            bytes32 settlementId = settlementIds[i];
            processedSettlementIds[settlementId] = true;

            uint256 netAmount = grossAmounts[i] - feeAmounts[i];
            balances[merchants[i]] += netAmount;

            emit MerchantEarningsAllocated(
                merchants[i],
                settlementId,
                grossAmounts[i],
                feeAmounts[i],
                netAmount
            );
        }
    }

    function _withdrawTo(address merchant, address recipient) internal {
        if (recipient == address(0)) revert InvalidAddress();

        uint256 amount = balances[merchant];
        if (amount == 0) revert NoBalance();

        balances[merchant] = 0;
        totalMerchantLiability -= amount;
        totalCreditBacking -= amount;

        (bool payoutOk, ) = payable(recipient).call{value: amount}("");
        if (!payoutOk) revert TransferFailed();

        emit Withdrawn(merchant, recipient, amount);
    }

    function _claimFeesTo(address recipient) internal {
        if (recipient == address(0)) revert InvalidAddress();

        uint256 amount = accruedFees;
        if (amount == 0) revert NoFees();

        accruedFees = 0;
        totalCreditBacking -= amount;

        (bool payoutOk, ) = payable(recipient).call{value: amount}("");
        if (!payoutOk) revert TransferFailed();

        emit FeesClaimed(recipient, amount);
    }
}
