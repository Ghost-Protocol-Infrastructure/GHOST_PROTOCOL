import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { toHex, zeroAddress } from "viem";

const CREDIT_PRICE_WEI = 10_000_000_000_000n;
const INITIAL_MAX_TVL = 5n * 10n ** 18n;
const DEPOSIT_AMOUNT = CREDIT_PRICE_WEI * 10n;

const deployVault = async (viem, treasury) =>
  viem.deployContract("GhostVault", [treasury, INITIAL_MAX_TVL, CREDIT_PRICE_WEI]);

const waitForWrite = async (publicClient, writePromise) => {
  const hash = await writePromise;
  return publicClient.waitForTransactionReceipt({ hash });
};

const expectRejection = async (action, pattern) => {
  await assert.rejects(action, pattern);
};

describe("GhostVault", async () => {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [owner, operator, merchant, merchantTwo, recipient, treasury] = await viem.getWalletClients();

  const forceEthIntoVault = async (address, amount) => {
    const currentBalance = await publicClient.getBalance({ address });
    await provider.request({
      method: "hardhat_setBalance",
      params: [address, toHex(currentBalance + amount)],
    });
  };

  it("stores the fixed credit price and only accepts exact-multiple pooled deposits", async () => {
    const vault = await deployVault(viem, treasury.account.address);
    assert.equal(await vault.read.creditPriceWei(), CREDIT_PRICE_WEI);

    await expectRejection(
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: 1n,
      }),
      /DepositNotExactCreditMultiple|InvalidAmount|deposit/i,
    );

    const beforeBlock = await publicClient.getBlockNumber();
    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: CREDIT_PRICE_WEI * 2n,
      }),
    );

    const events = await publicClient.getContractEvents({
      address: vault.address,
      abi: vault.abi,
      eventName: "Deposited",
      fromBlock: beforeBlock,
      strict: true,
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].args.payer.toLowerCase(), owner.account.address.toLowerCase());
    assert.equal(events[0].args.amount, CREDIT_PRICE_WEI * 2n);
    assert.equal(events[0].args.creditsPurchased, 2n);
  });

  it("does not credit merchant balances on deposit", async () => {
    const vault = await deployVault(viem, treasury.account.address);

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: DEPOSIT_AMOUNT,
      }),
    );

    assert.equal(await vault.read.balances([merchant.account.address]), 0n);
    assert.equal(await vault.read.merchantBalances([merchant.account.address]), 0n);
    assert.equal(await vault.read.totalMerchantLiability(), 0n);
    assert.equal(await vault.read.totalCreditBacking(), DEPOSIT_AMOUNT);
  });

  it("rejects unauthorized or insolvent merchant allocations", async () => {
    const vault = await deployVault(viem, treasury.account.address);
    const settlementId = `0x${"11".repeat(32)}`;

    await expectRejection(
      operator.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "allocateMerchantEarnings",
        args: [merchant.account.address, CREDIT_PRICE_WEI, 0n, settlementId],
      }),
      /UnauthorizedOperator|unauthorized/i,
    );

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "setSettlementOperator",
        args: [operator.account.address, true],
      }),
    );

    await expectRejection(
      operator.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "allocateMerchantEarnings",
        args: [merchant.account.address, CREDIT_PRICE_WEI, 0n, settlementId],
      }),
      /AllocationExceedsBacking|backing/i,
    );
  });

  it("allocates merchant balances and accrued fees from a batch", async () => {
    const vault = await deployVault(viem, treasury.account.address);
    const grossOne = CREDIT_PRICE_WEI * 2n;
    const feeOne = CREDIT_PRICE_WEI / 10n;
    const grossTwo = CREDIT_PRICE_WEI;
    const feeTwo = 0n;

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: DEPOSIT_AMOUNT,
      }),
    );

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "allocateMerchantEarningsBatch",
        args: [
          [merchant.account.address, merchantTwo.account.address],
          [grossOne, grossTwo],
          [feeOne, feeTwo],
          [`0x${"21".repeat(32)}`, `0x${"22".repeat(32)}`],
        ],
      }),
    );

    assert.equal(await vault.read.balances([merchant.account.address]), grossOne - feeOne);
    assert.equal(await vault.read.balances([merchantTwo.account.address]), grossTwo);
    assert.equal(await vault.read.merchantBalances([merchant.account.address]), grossOne - feeOne);
    assert.equal(await vault.read.totalMerchantLiability(), grossOne - feeOne + grossTwo);
    assert.equal(await vault.read.accruedFees(), feeOne);
    assert.equal(await vault.read.totalCreditBacking(), DEPOSIT_AMOUNT);
    assert.equal(await vault.read.processedSettlementIds([`0x${"21".repeat(32)}`]), true);
    assert.equal(await vault.read.processedSettlementIds([`0x${"22".repeat(32)}`]), true);
  });

  it("reverts batch allocations atomically on invalid input", async () => {
    const vault = await deployVault(viem, treasury.account.address);

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: DEPOSIT_AMOUNT,
      }),
    );

    await expectRejection(
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "allocateMerchantEarningsBatch",
        args: [
          [merchant.account.address, zeroAddress],
          [CREDIT_PRICE_WEI, CREDIT_PRICE_WEI],
          [0n, 0n],
          [`0x${"31".repeat(32)}`, `0x${"32".repeat(32)}`],
        ],
      }),
      /InvalidAddress|address/i,
    );

    assert.equal(await vault.read.balances([merchant.account.address]), 0n);
    assert.equal(await vault.read.totalMerchantLiability(), 0n);
    assert.equal(await vault.read.accruedFees(), 0n);
    assert.equal(await vault.read.processedSettlementIds([`0x${"31".repeat(32)}`]), false);
  });

  it("rejects duplicate settlement ids", async () => {
    const vault = await deployVault(viem, treasury.account.address);
    const settlementId = `0x${"41".repeat(32)}`;

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: DEPOSIT_AMOUNT,
      }),
    );

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "allocateMerchantEarnings",
        args: [merchant.account.address, CREDIT_PRICE_WEI, 0n, settlementId],
      }),
    );

    await expectRejection(
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "allocateMerchantEarnings",
        args: [merchant.account.address, CREDIT_PRICE_WEI, 0n, settlementId],
      }),
      /SettlementAlreadyProcessed|processed/i,
    );
  });

  it("rejects duplicate settlement ids inside the same batch before accounting mutates", async () => {
    const vault = await deployVault(viem, treasury.account.address);
    const settlementId = `0x${"42".repeat(32)}`;

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: DEPOSIT_AMOUNT,
      }),
    );

    await expectRejection(
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "allocateMerchantEarningsBatch",
        args: [
          [merchant.account.address, merchantTwo.account.address],
          [CREDIT_PRICE_WEI, CREDIT_PRICE_WEI],
          [0n, 0n],
          [settlementId, settlementId],
        ],
      }),
      /SettlementAlreadyProcessed|processed/i,
    );

    assert.equal(await vault.read.totalMerchantLiability(), 0n);
    assert.equal(await vault.read.accruedFees(), 0n);
    assert.equal(await vault.read.balances([merchant.account.address]), 0n);
    assert.equal(await vault.read.balances([merchantTwo.account.address]), 0n);
  });

  it("does not allow maxTVL to be reduced below current backing", async () => {
    const vault = await deployVault(viem, treasury.account.address);

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: DEPOSIT_AMOUNT,
      }),
    );

    await expectRejection(
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "setMaxTVL",
        args: [DEPOSIT_AMOUNT - 1n],
      }),
      /InvalidAmount|amount/i,
    );

    assert.equal(await vault.read.maxTVL(), INITIAL_MAX_TVL);
  });

  it("supports withdrawTo and reduces backing by the payout amount", async () => {
    const vault = await deployVault(viem, treasury.account.address);
    const gross = CREDIT_PRICE_WEI * 3n;
    const fee = CREDIT_PRICE_WEI / 10n;
    const net = gross - fee;
    const beforeRecipientBalance = await publicClient.getBalance({ address: recipient.account.address });

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: DEPOSIT_AMOUNT,
      }),
    );

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "allocateMerchantEarnings",
        args: [merchant.account.address, gross, fee, `0x${"51".repeat(32)}`],
      }),
    );

    await waitForWrite(
      publicClient,
      merchant.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "withdrawTo",
        args: [recipient.account.address],
      }),
    );

    const afterRecipientBalance = await publicClient.getBalance({ address: recipient.account.address });
    assert.equal(afterRecipientBalance - beforeRecipientBalance, net);
    assert.equal(await vault.read.balances([merchant.account.address]), 0n);
    assert.equal(await vault.read.totalMerchantLiability(), 0n);
    assert.equal(await vault.read.totalCreditBacking(), DEPOSIT_AMOUNT - net);
  });

  it("supports self-withdraw and fee claims", async () => {
    const vault = await deployVault(viem, treasury.account.address);
    const gross = CREDIT_PRICE_WEI * 2n;
    const fee = CREDIT_PRICE_WEI / 5n;
    const net = gross - fee;
    const beforeTreasuryBalance = await publicClient.getBalance({ address: treasury.account.address });

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: DEPOSIT_AMOUNT,
      }),
    );

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "allocateMerchantEarnings",
        args: [merchant.account.address, gross, fee, `0x${"61".repeat(32)}`],
      }),
    );

    await waitForWrite(
      publicClient,
      merchant.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "withdraw",
        args: [],
      }),
    );

    assert.equal(await vault.read.balances([merchant.account.address]), 0n);
    assert.equal(await vault.read.totalCreditBacking(), DEPOSIT_AMOUNT - net);

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "claimFees",
        args: [],
      }),
    );

    const afterTreasuryBalance = await publicClient.getBalance({ address: treasury.account.address });
    assert.equal(afterTreasuryBalance - beforeTreasuryBalance, fee);
    assert.equal(await vault.read.accruedFees(), 0n);
    assert.equal(await vault.read.totalCreditBacking(), DEPOSIT_AMOUNT - net - fee);
  });

  it("still supports explicit fee recipient overrides", async () => {
    const vault = await deployVault(viem, treasury.account.address);
    const gross = CREDIT_PRICE_WEI * 2n;
    const fee = CREDIT_PRICE_WEI / 5n;
    const beforeRecipientBalance = await publicClient.getBalance({ address: recipient.account.address });

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: DEPOSIT_AMOUNT,
      }),
    );

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "allocateMerchantEarnings",
        args: [merchant.account.address, gross, fee, `0x${"62".repeat(32)}`],
      }),
    );

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "claimFees",
        args: [recipient.account.address],
      }),
    );

    const afterRecipientBalance = await publicClient.getBalance({ address: recipient.account.address });
    assert.equal(afterRecipientBalance - beforeRecipientBalance, fee);
    assert.equal(await vault.read.accruedFees(), 0n);
  });

  it("can sweep forced excess ETH without touching tracked backing", async () => {
    const vault = await deployVault(viem, treasury.account.address);
    const forcedAmount = CREDIT_PRICE_WEI;

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: DEPOSIT_AMOUNT,
      }),
    );

    const beforeRecipientBalance = await publicClient.getBalance({ address: recipient.account.address });
    await forceEthIntoVault(vault.address, forcedAmount);

    assert.equal(await publicClient.getBalance({ address: vault.address }), DEPOSIT_AMOUNT + forcedAmount);
    assert.equal(await vault.read.totalCreditBacking(), DEPOSIT_AMOUNT);

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "sweepExcess",
        args: [recipient.account.address],
      }),
    );

    const afterRecipientBalance = await publicClient.getBalance({ address: recipient.account.address });
    assert.equal(afterRecipientBalance - beforeRecipientBalance, forcedAmount);
    assert.equal(await publicClient.getBalance({ address: vault.address }), DEPOSIT_AMOUNT);
    assert.equal(await vault.read.totalCreditBacking(), DEPOSIT_AMOUNT);
  });

  it("rejects excess sweep when no forced ETH exists", async () => {
    const vault = await deployVault(viem, treasury.account.address);

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: DEPOSIT_AMOUNT,
      }),
    );

    await expectRejection(
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "sweepExcess",
        args: [recipient.account.address],
      }),
      /NoExcessBalance|excess/i,
    );
  });

  it("enforces independent deposit and allocation pause controls", async () => {
    const vault = await deployVault(viem, treasury.account.address);

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "pauseDeposits",
        args: [true],
      }),
    );

    await expectRejection(
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: CREDIT_PRICE_WEI,
      }),
      /DepositsPaused|paused/i,
    );

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "pauseDeposits",
        args: [false],
      }),
    );

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "depositCredit",
        args: [],
        value: DEPOSIT_AMOUNT,
      }),
    );

    await waitForWrite(
      publicClient,
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "pauseAllocations",
        args: [true],
      }),
    );

    await expectRejection(
      owner.writeContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "allocateMerchantEarnings",
        args: [merchant.account.address, CREDIT_PRICE_WEI, 0n, `0x${"71".repeat(32)}`],
      }),
      /AllocationsPaused|paused/i,
    );
  });
});
