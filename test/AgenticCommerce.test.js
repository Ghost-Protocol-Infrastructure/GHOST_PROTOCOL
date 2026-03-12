import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

const ONE_USDC = 1_000_000n;
const DAY = 24n * 60n * 60n;
const MIN_EXPIRY = 5n * 60n;
const MAX_EXPIRY_WINDOW = 90n * DAY;
const SUBMITTED_EVALUATION_GRACE = 15n * 60n;

const waitForWrite = async (publicClient, writePromise) => {
  const hash = await writePromise;
  return publicClient.waitForTransactionReceipt({ hash });
};

const expectRejection = async (action, pattern) => {
  await assert.rejects(action, pattern);
};

const increaseTimeTo = async (provider, timestamp) => {
  await provider.request({
    method: "evm_setNextBlockTimestamp",
    params: [Number(timestamp)],
  });
  await provider.request({
    method: "evm_mine",
    params: [],
  });
};

describe("AgenticCommerce hardening", async () => {
  const { viem, provider } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [admin, clientWallet, providerWallet, evaluatorWallet, treasuryWallet, outsiderWallet] =
    await viem.getWalletClients();

  const deployFixture = async () => {
    const token = await viem.deployContract("MockUSDC", []);
    const commerce = await viem.deployContract("AgenticCommerce", [token.address, treasuryWallet.account.address]);
    return { token, commerce };
  };

  const mintAndApprove = async (token, commerce, amount) => {
    await waitForWrite(
      publicClient,
      admin.writeContract({
        address: token.address,
        abi: token.abi,
        functionName: "mint",
        args: [clientWallet.account.address, amount],
      }),
    );

    await waitForWrite(
      publicClient,
      clientWallet.writeContract({
        address: token.address,
        abi: token.abi,
        functionName: "approve",
        args: [commerce.address, amount],
      }),
    );
  };

  const createFundedJob = async (ctx, budget = 100n * ONE_USDC, expiryOffset = DAY) => {
    const { commerce } = ctx;
    const currentBlock = await publicClient.getBlock();
    const expiredAt = currentBlock.timestamp + expiryOffset;

    await waitForWrite(
      publicClient,
      clientWallet.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "createJob",
        args: [providerWallet.account.address, evaluatorWallet.account.address, expiredAt, "security-test-job"],
      }),
    );

    const jobId = await commerce.read.jobCounter();

    await waitForWrite(
      publicClient,
      clientWallet.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "setBudget",
        args: [jobId, budget],
      }),
    );

    await mintAndApprove(ctx.token, commerce, budget);

    await waitForWrite(
      publicClient,
      clientWallet.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "fund",
        args: [jobId, budget],
      }),
    );

    return { jobId, budget, expiredAt };
  };

  it("caps platform fee at 10% and emits no revert for allowed value", async () => {
    const { commerce } = await deployFixture();

    await expectRejection(
      admin.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "setPlatformFee",
        args: [1001n, treasuryWallet.account.address],
      }),
      /InvalidFeeBasisPoints|fee|basis/i,
    );

    await waitForWrite(
      publicClient,
      admin.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "setPlatformFee",
        args: [1000n, treasuryWallet.account.address],
      }),
    );

    assert.equal(await commerce.read.platformFeeBP(), 1000n);
  });

  it("rejects job expiries longer than 90 days", async () => {
    const { commerce } = await deployFixture();
    const currentBlock = await publicClient.getBlock();
    const tooLongExpiry = currentBlock.timestamp + MAX_EXPIRY_WINDOW + DAY;

    await expectRejection(
      clientWallet.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "createJob",
        args: [providerWallet.account.address, evaluatorWallet.account.address, tooLongExpiry, "too-long-expiry"],
      }),
      /ExpiryTooLong|expiry/i,
    );
  });

  it("snapshots fee at funding time even if admin updates fee later", async () => {
    const ctx = await deployFixture();
    const { commerce, token } = ctx;

    await waitForWrite(
      publicClient,
      admin.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "setPlatformFee",
        args: [500n, treasuryWallet.account.address], // 5%
      }),
    );

    const { jobId, budget } = await createFundedJob(ctx, 200n * ONE_USDC, DAY);

    await waitForWrite(
      publicClient,
      admin.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "setPlatformFee",
        args: [1000n, treasuryWallet.account.address], // 10% after funding
      }),
    );

    await waitForWrite(
      publicClient,
      providerWallet.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "submit",
        args: [jobId, `0x${"11".repeat(32)}`],
      }),
    );

    const treasuryBefore = await token.read.balanceOf([treasuryWallet.account.address]);
    const providerBefore = await token.read.balanceOf([providerWallet.account.address]);

    await waitForWrite(
      publicClient,
      evaluatorWallet.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "complete",
        args: [jobId, `0x${"22".repeat(32)}`],
      }),
    );

    const expectedFee = (budget * 500n) / 10_000n;
    const expectedNet = budget - expectedFee;
    const treasuryAfter = await token.read.balanceOf([treasuryWallet.account.address]);
    const providerAfter = await token.read.balanceOf([providerWallet.account.address]);

    assert.equal(treasuryAfter - treasuryBefore, expectedFee);
    assert.equal(providerAfter - providerBefore, expectedNet);
  });

  it("prevents evaluator from rejecting funded jobs before submission", async () => {
    const ctx = await deployFixture();
    const { commerce } = ctx;
    const { jobId } = await createFundedJob(ctx, 50n * ONE_USDC, DAY);

    await expectRejection(
      evaluatorWallet.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "reject",
        args: [jobId, `0x${"33".repeat(32)}`],
      }),
      /WrongStatus|status/i,
    );
  });

  it("allows completion during submitted grace and delays submitted refunds until grace ends", async () => {
    const ctx = await deployFixture();
    const { commerce } = ctx;
    const { jobId, expiredAt } = await createFundedJob(ctx, 75n * ONE_USDC, MIN_EXPIRY + 120n);

    await waitForWrite(
      publicClient,
      providerWallet.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "submit",
        args: [jobId, `0x${"44".repeat(32)}`],
      }),
    );

    const beforeGraceTs = expiredAt + SUBMITTED_EVALUATION_GRACE - 10n;
    await increaseTimeTo(provider, beforeGraceTs);

    await waitForWrite(
      publicClient,
      evaluatorWallet.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "complete",
        args: [jobId, `0x${"55".repeat(32)}`],
      }),
    );

    const completedJob = await commerce.read.getJob([jobId]);
    assert.equal(Number(completedJob.status), 3); // Completed
  });

  it("blocks submitted refunds until grace elapses, then allows refund", async () => {
    const ctx = await deployFixture();
    const { commerce, token } = ctx;
    const { jobId, budget, expiredAt } = await createFundedJob(ctx, 80n * ONE_USDC, MIN_EXPIRY + 120n);

    await waitForWrite(
      publicClient,
      providerWallet.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "submit",
        args: [jobId, `0x${"66".repeat(32)}`],
      }),
    );

    await increaseTimeTo(provider, expiredAt + 1n);

    await expectRejection(
      clientWallet.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "claimRefund",
        args: [jobId],
      }),
      /JobNotExpired|expired/i,
    );

    const clientBefore = await token.read.balanceOf([clientWallet.account.address]);
    await increaseTimeTo(provider, expiredAt + SUBMITTED_EVALUATION_GRACE);

    await waitForWrite(
      publicClient,
      clientWallet.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "claimRefund",
        args: [jobId],
      }),
    );

    const clientAfter = await token.read.balanceOf([clientWallet.account.address]);
    const expiredJob = await commerce.read.getJob([jobId]);

    assert.equal(clientAfter - clientBefore, budget);
    assert.equal(Number(expiredJob.status), 5); // Expired
  });

  it("keeps claimRefund access restricted from random callers", async () => {
    const ctx = await deployFixture();
    const { commerce } = ctx;
    const { jobId, expiredAt } = await createFundedJob(ctx, 30n * ONE_USDC, MIN_EXPIRY + 120n);

    await increaseTimeTo(provider, expiredAt + 1n);

    await expectRejection(
      outsiderWallet.writeContract({
        address: commerce.address,
        abi: commerce.abi,
        functionName: "claimRefund",
        args: [jobId],
      }),
      /Unauthorized|access|role/i,
    );
  });
});
